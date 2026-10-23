/**
 * dsh-openai-gateway — Host half.
 *
 * Exposes every model of every provider registered with the host `llm`
 * service through an OpenAI-compatible HTTP surface:
 *
 *   GET  /v1/models                           catalog across all providers
 *   GET  /v1/models/<provider>/<model>        one model
 *   POST /v1/chat/completions                 completions (streaming or not)
 *   OPTIONS /v1/*                             CORS preflight
 *   GET  /plugins/dsh-openai-gateway/status   loopback-only badge feed
 *
 * Routing goes through `ctx.llm`, so every adapter the profile already
 * registered keeps working — including the WorkBuddy CN/global adapters and
 * their upstream header stack, opencode2dsh, and local pi-ai providers. This
 * plugin never talks to a vendor itself and never stores credentials: it
 * forwards to whatever the host already uses.
 *
 * Only `node:` builtins are imported, so the package resolves from any
 * installation layout (linked checkout or packed tarball).
 */
import { Buffer } from 'node:buffer'
import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto'
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import http from 'node:http'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'

const PLUGIN_ID = 'dsh-openai-gateway'
const STATUS_PATH = `/plugins/${PLUGIN_ID}/status`
const API_PREFIX = '/v1'
const DEFAULT_BODY_LIMIT = 8 * 1024 * 1024
const CATALOG_TTL_MS = 60_000
/** How often the boot warm loop re-reads the catalog while adapters bind. */
const WARM_INTERVAL_MS = 1_000
/** Watch window before the warm loop accepts a settled provider set. */
const WARM_SETTLE_MS = 6_000
/** Hard stop, so a profile whose providers never answer still boots. */
const WARM_ATTEMPTS = 30
/**
 * Retry policy for transient adapter failures.
 *
 * These are the host's own defaults (`@deepseek-ai/dsh-llm`): the agent loop
 * retries RATE_LIMIT/SERVER/TIMEOUT/TRANSPORT/EMPTY_RESPONSE up to five times
 * with 500 ms → 10 s exponential backoff and honours the wait the upstream
 * itself asks for. A gateway that skips this layer is strictly more fragile
 * than the same profile talking to the same provider in DSH — a single 14003
 * or 6004 becomes a failed HTTP request here while the host would have waited
 * and answered.
 */
const RETRY_MAX_RETRIES = 5
const RETRY_INITIAL_MS = 500
const RETRY_MAX_MS = 10_000
const RETRY_JITTER = 0.1
/** The codes the host retries by default, same set, same spelling. */
const RETRYABLE_CODES = new Set(['EMPTY_RESPONSE', 'RATE_LIMIT', 'SERVER', 'TIMEOUT', 'TRANSPORT'])
/** Quiet time before a streaming response commits its headers and pings. */
const SILENT_FLUSH_MS = 10_000
/** Interval between SSE comments once the stream is committed and quiet. */
const KEEPALIVE_MS = 15_000
/** How many finished requests the status document keeps for diagnosis. */
const RECENT_LIMIT = 20
const KEY_PREFIX = 'sk-dsh-'
/** Service keys for the HTTP surface, newest name first. */
const WEB_SERVER_KEYS = ['webServer', 'httpServer']
/** Plugin-owned directory inside the Harness home. */
const KEY_DIRNAME = 'openai-gateway'
/** Legacy per-key file, still read once so an existing client keeps working. */
const KEY_FILENAME = 'api-key'
/** Persisted settings: the listen port and the bearer key. */
const SETTINGS_FILENAME = 'settings.json'
/** Shortest key this gateway will honour, whether stored or generated. */
const MIN_KEY_LENGTH = 16
/** Port the gateway prefers; a busy port falls back to an ephemeral one. */
const DEFAULT_PORT = 8787
/** Loopback only: an external network can never reach the gateway. */
const LISTEN_HOST = '127.0.0.1'
/** Control routes for the sidebar page, mounted on the harness web server. */
const SETTINGS_ROUTE = `/plugins/${PLUGIN_ID}/settings`
const KEY_ROUTE = `/plugins/${PLUGIN_ID}/key`

/** Cordis plugin name, surfaced in diagnostics. */
export const name = PLUGIN_ID

/** Model routing is required; the control surface is mounted when available. */
export const inject = ['llm']

/**
 * Mount the gateway: its own loopback listener on a fixed port, plus the
 * loopback-gated control routes the sidebar page drives.
 *
 * Supported `config` keys (all optional):
 *   enabled        — `false` keeps the gateway inert
 *   port           — preferred listen port (overrides the stored one)
 *   apiKey         — pin the bearer key instead of the stored one
 *   bodyLimitBytes — request body cap (default 8 MiB)
 *   catalogTtlMs   — `/v1/models` cache lifetime (default 60 s)
 *   retryMaxRetries, retryInitialDelayMs, retryMaxDelayMs
 *                  — transient-failure retry policy (defaults are the host's:
 *                    5 retries, 500 ms → 10 s exponential backoff)
 *   silentFlushMs, keepAliveMs
 *                  — how long a quiet stream may stay silent before the
 *                    response commits and pings (defaults 10 s / 15 s)
 *   maxInputTokens — refuse a request whose estimated input exceeds this
 *                    (default 0 = off; otherwise the model's context window
 *                    is used when the provider publishes one)
 *   maxMessages    — drop the oldest turns beyond this many, always keeping
 *                    the history starting at a `user` message (default 0 = off)
 */
export function apply(ctx, config) {
  const settings = config ?? {}
  const bodyLimit = Number.isFinite(settings.bodyLimitBytes)
    ? settings.bodyLimitBytes
    : DEFAULT_BODY_LIMIT
  const catalogTtl = Number.isFinite(settings.catalogTtlMs)
    ? settings.catalogTtlMs
    : CATALOG_TTL_MS
  const enabled = settings.enabled !== false
  const retry = resolveRetryPolicy(settings)
  const keepAlive = {
    silentFlushMs: positiveOr(settings.silentFlushMs, SILENT_FLUSH_MS),
    keepAliveMs: positiveOr(settings.keepAliveMs, KEEPALIVE_MS),
  }
  // `0` / absent means off, so a profile that never sets these keeps the old
  // behaviour of forwarding whatever the caller sent.
  const inputGuard = {
    maxInputTokens: nonNegativeInteger(settings.maxInputTokens),
    maxMessages: nonNegativeInteger(settings.maxMessages),
  }

  // Persisted state lives in one plugin-owned file under the Harness home:
  // a configured external client then survives every restart.
  const store = loadStore(ctx, {
    portOverride: Number.isFinite(settings.port) ? clampPort(settings.port) : undefined,
    apiKeyPinned: typeof settings.apiKey === 'string' ? settings.apiKey.trim() : '',
  })

  const state = {
    store,
    apiKey: store.apiKey,
    settingsFile: store.path,
    enabled,
    startedAt: Date.now(),
    catalog: { at: 0, entries: [] },
    retry,
    keepAlive,
    inputGuard,
    requests: 0,
    failures: 0,
    recent: [],
    server: undefined,
    listenPort: undefined,
    portFallback: false,
    listenError: undefined,
  }

  // One dispatcher shared by the listener; `route` is a hoisted declaration.
  state.handler = (req, res) => {
    route(req, res).catch((error) => {
      fail(res, error)
    })
  }

  if (enabled) {
    // Model catalogs are served by the providing adapters, which bind their
    // own settings after plugin load. Keep warming until one pass sees models:
    // the page and the routing table should be usable before the first
    // external request arrives.
    warmCatalog(ctx, state, catalogTtl)
    startListener(ctx, state).catch((error) => {
      logWarn(ctx, `could not start the gateway listener: ${messageOf(error)}`)
    })
  }

  // `webServer` belongs to the web app entry, which under concurrent
  // activation can bind its service after this plugin. Try now and again on
  // every later service binding, so a webless profile simply mounts no
  // control routes instead of blocking boot.
  let mounted = false
  const mount = () => {
    if (mounted) return
    const webServer = ctx.get(WEB_SERVER_KEYS[0]) ?? ctx.get(WEB_SERVER_KEYS[1])
    if (webServer === undefined) return
    mounted = true
    const disposers = [
      webServer.register({
        kind: 'exact',
        path: STATUS_PATH,
        handler: (req, res) => {
          if (req.method !== 'GET' && req.method !== 'HEAD') {
            sendJson(res, 405, { error: 'method not allowed' })
            return
          }
          if (!loopbackOrigin(req)) {
            sendJson(res, 403, { error: 'origin-not-trusted' })
            return
          }
          // The page is the only caller. `?refresh=1` is what its Refresh
          // button sends: re-read the catalog even when the snapshot is
          // still inside the TTL, so the button does what it says.
          statusPayload(ctx, state, catalogTtl, refreshRequested(req.url))
            .then((payload) => sendJson(res, 200, payload, { 'Cache-Control': 'no-store' }))
            .catch((error) => fail(res, error))
        },
      }),
      webServer.register({
        kind: 'exact',
        path: SETTINGS_ROUTE,
        handler: (req, res) => {
          control(ctx, req, res, () => applyPort(ctx, state, req, res, bodyLimit))
        },
      }),
      webServer.register({
        kind: 'exact',
        path: KEY_ROUTE,
        handler: (req, res) => {
          control(ctx, req, res, () => rotateKey(ctx, state, req, res, bodyLimit))
        },
      }),
    ]

    ctx.effect(
      () => () => {
        mounted = false
        for (const dispose of disposers) dispose()
      },
      `${PLUGIN_ID}: control routes`,
    )
  }

  mount()
  ctx.on('internal/service', (serviceName) => {
    if (WEB_SERVER_KEYS.includes(serviceName)) mount()
  })

  ctx.effect(
    () => () => {
      closeListener(state)
    },
    `${PLUGIN_ID}: listener`,
  )

  /** Dispatch one `/v1/*` request on the gateway's own listener. */
  async function route(req, res) {
    const url = new URL(req.url ?? '/', 'http://localhost')
    const pathname = url.pathname

    // Preflight answers before authentication: a browser never attaches
    // Authorization to an OPTIONS probe.
    if (req.method === 'OPTIONS') {
      sendCors(res, 204)
      return
    }

    if (pathname !== API_PREFIX && !pathname.startsWith(`${API_PREFIX}/`)) {
      sendError(res, 404, 'invalid_request_error', `unknown route ${pathname}`)
      return
    }

    const relative = pathname.slice(API_PREFIX.length) || '/'

    if (relative === '/') {
      sendJson(res, 200, {
        object: 'api',
        enabled,
        endpoints: [`${API_PREFIX}/models`, `${API_PREFIX}/chat/completions`],
      })
      return
    }

    if (!enabled) {
      sendError(res, 503, 'service_unavailable', 'the gateway is disabled in its bundle configuration')
      return
    }

    if (!authorize(req, state.apiKey)) {
      sendError(res, 401, 'authentication_error', 'invalid API key', { code: 'invalid_api_key' })
      return
    }

    const method = req.method ?? 'GET'
    if (method === 'GET' || method === 'HEAD') {
      if (relative === '/models') {
        await handleModels(ctx, state, catalogTtl, url, res)
        return
      }
      if (relative.startsWith('/models/')) {
        await handleModel(ctx, state, catalogTtl, relative.slice('/models/'.length), res)
        return
      }
      sendError(res, 404, 'invalid_request_error', `unknown route ${pathname}`)
      return
    }

    if (method === 'POST') {
      if (relative === '/chat/completions' || relative === '/completions') {
        await handleChat(ctx, state, catalogTtl, req, res, bodyLimit)
        return
      }
      sendError(res, 404, 'invalid_request_error', `unknown route ${pathname}`)
      return
    }

    sendError(res, 405, 'invalid_request_error', `method ${method} is not allowed`)
  }
}

/* ------------------------------------------------------------------ routes */

async function handleModels(ctx, state, ttl, url, res) {
  const entries = await catalog(ctx, state, ttl, url.searchParams.get('refresh') === '1')
  sendJson(res, 200, {
    object: 'list',
    data: entries.map((entry) => ({
      id: modelKey(entry),
      object: 'model',
      created: 0,
      owned_by: entry.provider,
      ...(entry.model.name === entry.model.id ? {} : { name: entry.model.name }),
    })),
  })
}

async function handleModel(ctx, state, ttl, rest, res) {
  const wanted = decodeURIComponent(rest)
  const entries = await catalog(ctx, state, ttl, false)
  const found =
    entries.find((entry) => modelKey(entry) === wanted) ??
    entries.find((entry) => entry.model.id === wanted)
  if (found === undefined) {
    sendError(res, 404, 'invalid_request_error', `model ${wanted} is not registered`, {
      code: 'model_not_found',
    })
    return
  }
  sendJson(res, 200, { id: modelKey(found), object: 'model', created: 0, owned_by: found.provider })
}

/**
 * Translate an OpenAI chat request into one `ctx.llm` call and answer it.
 * Provider gates, pool selection, credentials, retries and the WorkBuddy
 * header stack all stay inside the adapters the profile already registered.
 */
async function handleChat(ctx, state, ttl, req, res, bodyLimit) {
  state.requests += 1

  let body
  try {
    body = await readBody(req, bodyLimit)
  } catch (error) {
    sendError(res, 400, 'invalid_request_error', messageOf(error))
    return
  }

  const requested = typeof body.model === 'string' ? body.model.trim() : ''
  if (requested.length === 0) {
    sendError(res, 400, 'invalid_request_error', 'missing "model"')
    return
  }

  // One record per request, from here on: a refused request is still a request,
  // and "it dropped again" is answered by the record, not by the counter.
  const trace = {
    at: Date.now(),
    model: requested,
    stream: body.stream === true || body.stream === 'true',
    attempts: 1,
    outcome: 'ok',
    textBytes: 0,
    reasoningBytes: 0,
  }

  try {
    let call
    try {
      const route = await resolveRoute(ctx, state, ttl, requested)
      if (route === undefined) {
        trace.outcome = 'rejected'
        trace.code = 'model_not_found'
        sendError(res, 404, 'invalid_request_error', `model ${requested} is not registered`, {
          code: 'model_not_found',
        })
        return
      }
      call = await translate(ctx, body, route, requested)
      call.trace = trace
      const refusal = await applyInputGuard(ctx, state, ttl, route, call, trace)
      if (refusal !== undefined) {
        state.failures += 1
        trace.outcome = 'error'
        trace.code = refusal.code
        trace.message = refusal.message
        sendFailure(res, refusal)
        return
      }
    } catch (error) {
      trace.outcome = 'error'
      trace.code = error?.code ?? 'INVALID_REQUEST'
      trace.message = messageOf(error)
      sendError(res, 400, 'invalid_request_error', messageOf(error))
      return
    }

    const controller = new AbortController()
    res.on('close', () => controller.abort())

  // The request shape, not just its outcome: an empty reply is usually the
  // client's own budget at work (a small max_tokens is spent on reasoning
  // before any text), and that is invisible from the response alone.
  trace.stream = call.wantsStream === true
  trace.maxTokens = call.config.maxTokens
  trace.effort = call.effort
  trace.tools = (call.io.tools ?? []).length
  trace.systemChars = (call.io.system ?? '').length
  trace.messages = call.io.messages.length
  trace.roles = call.io.messages.map((message) => message.role).join(',')
  trace.inputTokensEst = estimateInputTokens(call)
  call.trace = trace

  if (call.wantsStream) await streamCompletion(ctx, state, res, call, controller.signal)
  else await blockingCompletion(ctx, state, res, call, controller.signal)
  } catch (error) {
    trace.outcome = 'error'
    trace.code = error?.code
    trace.message = messageOf(error)
    throw error
  } finally {
    recordRequest(ctx, state, trace)
  }
}

/* --------------------------------------------------------- translation */

/**
 * Pair assistant tool calls with the tool results that answer them.
 *
 * OpenAI pairs the two by id. A client that omits the id on the assistant turn,
 * or invents a different one on the tool turn, hands the adapter a call with no
 * result — and the upstream answers that with an empty completion (measured:
 * reasoning only, `finish: stop`, zero content, which a UI shows as a dropped
 * connection). The tool result carries the id the rest of the conversation
 * refers to, so it wins whenever a positional result exists.
 *
 * @returns a map from message index to the ids of the results that follow it.
 */
function alignToolCallIds(rawMessages) {
  const byIndex = new Map()
  for (let index = 0; index < rawMessages.length; index += 1) {
    const raw = rawMessages[index]
    if (raw?.role !== 'assistant' || !Array.isArray(raw.tool_calls) || raw.tool_calls.length === 0) continue
    const resultIds = []
    for (let next = index + 1; next < rawMessages.length; next += 1) {
      const follower = rawMessages[next]
      if (follower?.role !== 'tool') break
      const id = typeof follower.tool_call_id === 'string' ? follower.tool_call_id.trim() : ''
      resultIds.push(id.length > 0 ? id : undefined)
    }
    if (resultIds.length > 0) byIndex.set(index, resultIds)
  }
  return byIndex
}

/** Build the adapter-agnostic request: call config plus per-dispatch options. */
async function translate(ctx, body, route, requested) {
  const systems = []
  const messages = []

  const rawMessages = Array.isArray(body.messages) ? body.messages : []
  const resultIdsByIndex = alignToolCallIds(rawMessages)
  for (const [rawIndex, raw] of rawMessages.entries()) {
    const role = typeof raw?.role === 'string' ? raw.role : ''
    if (role === 'system' || role === 'developer') {
      const text = textOf(raw.content)
      if (text.length > 0) systems.push(text)
      continue
    }
    if (role === 'user') {
      messages.push({ role: 'user', content: await userContent(ctx, raw.content) })
      continue
    }
    if (role === 'assistant') {
      const content = []
      const text = textOf(raw.content)
      if (text.length > 0) content.push({ type: 'text', text })
      const resultIds = resultIdsByIndex.get(rawIndex) ?? []
      for (const [callIndex, entry] of (Array.isArray(raw.tool_calls) ? raw.tool_calls : []).entries()) {
        const fn = entry?.function ?? {}
        const args =
          typeof fn.arguments === 'string' ? fn.arguments : JSON.stringify(fn.arguments ?? {})
        // The result's id wins: it is what the following tool message and the
        // rest of the conversation refer to, so pairing by it is what makes
        // the adapter see a call that actually has a result.
        const ownId = typeof entry?.id === 'string' && entry.id.length > 0 ? entry.id : undefined
        const alignedId = resultIds[callIndex]
        content.push({
          type: 'tool-call',
          id: alignedId ?? ownId ?? `call_${randomUUID()}`,
          name: typeof fn.name === 'string' && fn.name.length > 0 ? fn.name : 'unknown',
          arguments: args.length > 0 ? args : '{}',
        })
      }
      if (content.length === 0) content.push({ type: 'text', text: '' })
      messages.push({
        id: randomUUID(),
        role: 'assistant',
        content,
        source: { kind: 'model', provider: route.provider, model: route.model },
      })
      continue
    }
    if (role === 'tool') {
      const callId =
        typeof raw.tool_call_id === 'string' && raw.tool_call_id.length > 0
          ? raw.tool_call_id
          : undefined
      if (callId === undefined) throw new Error('a "tool" message requires "tool_call_id"')
      messages.push({
        id: randomUUID(),
        role: 'tool',
        source: { kind: 'tool', callId },
        toolCallId: callId,
        content: [{ type: 'text', text: textOf(raw.content) }],
      })
      continue
    }
    throw new Error(`unsupported message role "${role}"`)
  }

  if (messages.length === 0) throw new Error('"messages" must contain at least one entry')

  const tools = translateTools(body)
  const maxTokens = numberOrUndefined(body.max_tokens ?? body.max_completion_tokens)
  const temperature = numberOrUndefined(body.temperature)
  const stop = translateStop(body.stop)
  const effort = requestedEffort(body)

  return {
    requested,
    wantsStream: body.stream === true || body.stream === 'true',
    includeUsage: Boolean(body.stream_options?.include_usage),
    effort,
    stopRequested: stop !== undefined,
    config: {
      provider: route.provider,
      model: route.model,
      ...(temperature === undefined ? {} : { temperature }),
      ...(maxTokens === undefined ? {} : { maxTokens }),
      ...(stop === undefined ? {} : { stop }),
      ...(effort === undefined ? {} : { reasoningEffort: effort }),
    },
    io: {
      messages,
      ...(systems.length === 0 ? {} : { system: systems.join('\n\n') }),
      ...(tools.length === 0 ? {} : { tools }),
    },
  }
}

function translateTools(body) {
  if (body.tool_choice === 'none') return []
  const tools = []
  for (const entry of Array.isArray(body.tools) ? body.tools : []) {
    const fn = entry?.type === 'function' ? entry.function : entry
    if (typeof fn?.name !== 'string' || fn.name.length === 0) continue
    tools.push({
      name: fn.name,
      description: typeof fn.description === 'string' ? fn.description : '',
      parameters:
        typeof fn.parameters === 'object' && fn.parameters !== null && !Array.isArray(fn.parameters)
          ? fn.parameters
          : { type: 'object', properties: {} },
    })
  }
  return tools
}

function translateStop(value) {
  if (typeof value === 'string' && value.length > 0) return [value]
  if (!Array.isArray(value)) return undefined
  const stops = value.filter((entry) => typeof entry === 'string' && entry.length > 0)
  return stops.length === 0 ? undefined : stops
}

/** The reasoning effort a caller asked for, under any common spelling. */
function requestedEffort(body) {
  const direct = body.reasoning_effort ?? body.reasoningEffort ?? body.reasoning?.effort
  return typeof direct === 'string' && direct.length > 0 ? direct : undefined
}

/**
 * Flatten content that only has a text form here (system prompts, assistant
 * turns, tool results). User turns keep their non-text parts: see
 * {@link userContent}, which admits images and files into the attachment store
 * so adapters receive them as durable blocks.
 */
function textOf(content) {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  const parts = []
  for (const part of content) {
    if (typeof part === 'string') parts.push(part)
    else if (part !== null && typeof part === 'object' && typeof part.text === 'string') {
      parts.push(part.text)
    }
  }
  return parts.join('')
}

function numberOrUndefined(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

/**
 * The part of a streamed tool-call field that still has to be sent, given what
 * the caller has already received.
 *
 * Providers differ: one repeats the whole id/name on every delta, another sends
 * it in fragments. OpenAI clients append whatever arrives, so the correct
 * payload is the suffix — empty when nothing new came, the tail when the field
 * only grew, and the whole value when it changed shape entirely.
 */
function fieldDelta(previous, next) {
  if (typeof next !== 'string' || next.length === 0) return ''
  if (next === previous) return ''
  if (next.startsWith(previous)) return next.slice(previous.length)
  return next
}

/* --------------------------------------------------------- attachment input */

const MAX_REMOTE_BYTES = 25 * 1024 * 1024

/** Decode canonical base64 into the bytes the attachment store commits. */
function base64Bytes(data) {
  return new Uint8Array(Buffer.from(data, 'base64'))
}

/**
 * Split one OpenAI image part into a data URL payload, or fetch a remote one.
 *
 * The host stores attachments content-addressed (`sha256:…`) and every adapter
 * reads them back through `ctx.attachments`, so the bytes have to be durable
 * before the call is made — a URL that only the caller can reach would hand the
 * provider nothing.
 */
async function imagePayload(part) {
  const source = part?.image_url ?? part?.image ?? part?.url
  const url = typeof source === 'string' ? source : source?.url
  if (typeof url !== 'string' || url.length === 0) {
    throw new Error('an image part needs "image_url.url"')
  }
  if (url.startsWith('data:')) {
    const comma = url.indexOf(',')
    if (comma < 0) throw new Error('malformed image data URL')
    const header = url.slice(5, comma)
    const data = url.slice(comma + 1)
    const base64 = header.toLowerCase().includes(';base64')
    return {
      mediaType: header.split(';')[0].trim(),
      data: base64 ? data.replace(/\s/g, '') : Buffer.from(decodeURIComponent(data), 'utf8').toString('base64'),
    }
  }
  if (!/^https?:\/\//i.test(url)) {
    throw new Error(`image url is not fetchable: ${url.slice(0, 40)}`)
  }
  const response = await fetch(url, { signal: AbortSignal.timeout(30000) })
  if (!response.ok) throw new Error(`image fetch failed with HTTP ${response.status}`)
  const declared = Number(response.headers.get('content-length') ?? '0')
  if (declared > MAX_REMOTE_BYTES) throw new Error('remote image is too large to attach')
  const bytes = Buffer.from(await response.arrayBuffer())
  if (bytes.length > MAX_REMOTE_BYTES) throw new Error('remote image is too large to attach')
  const mediaType = (response.headers.get('content-type') ?? '').split(';')[0].trim()
  return { mediaType: mediaType.startsWith('image/') ? mediaType : 'image/png', data: bytes.toString('base64') }
}

/** Base64 payload of a `file` part, which OpenAI clients inline as a data URL. */
function filePayload(part) {
  const file = part?.file ?? part
  const inline = file?.file_data ?? file?.data
  if (typeof inline !== 'string' || inline.length === 0) {
    throw new Error(
      'a "file" part needs inline "file_data"; uploaded file ids live in the caller\'s account, not in this harness',
    )
  }
  const comma = inline.indexOf(',')
  const data = inline.startsWith('data:') && comma >= 0 ? inline.slice(comma + 1) : inline
  const name = typeof file?.filename === 'string' && file.filename.length > 0 ? file.filename : undefined
  const mediaType = inline.startsWith('data:') && comma >= 0 ? inline.slice(5, comma).split(';')[0].trim() : ''
  return { data: data.replace(/\s/g, ''), ...(name === undefined ? {} : { name }), mediaType }
}

const TEXTUAL_MEDIA = /^(text\/|application\/(json|xml|x-yaml|yaml|javascript|typescript|x-sh|x-ndjson|sql)\b)/i
const MAX_INLINE_TEXT_BYTES = 2 * 1024 * 1024

/**
 * Whether a file can simply be shown to the model as text.
 *
 * The host hands a stored file to a model as a read-only *path*, which is right
 * for a harness session whose model has file tools — but an outside OpenAI
 * client's model has none, so a path alone is a dead end. Text that decodes
 * cleanly is far more useful inlined, which is what a chat caller expects.
 */
function inlineTextOf(bytes, mediaType) {
  if (bytes.byteLength === 0 || bytes.byteLength > MAX_INLINE_TEXT_BYTES) return undefined
  if (bytes.includes(0)) return undefined
  if (mediaType.length > 0 && !TEXTUAL_MEDIA.test(mediaType)) return undefined
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  } catch {
    return undefined
  }
}

/**
 * Translate one user message into host content blocks.
 *
 * Text survives as text; images and files are committed to the attachment store
 * first (images in one batch, so the store's per-message limits apply) and
 * become durable `image` / `file` blocks, which is the only form adapters send.
 * A text file is inlined instead: a caller's model has no file tools, so a
 * stored path it cannot open would be worse than useless.
 */
async function userContent(ctx, content) {
  if (typeof content === 'string' || content === null || content === undefined) {
    return [{ type: 'text', text: textOf(content) }]
  }
  if (!Array.isArray(content)) return [{ type: 'text', text: textOf(content) }]

  const attachments = ctx.get('attachments')
  const slots = []
  const images = []
  const files = []
  for (const part of content) {
    if (typeof part === 'string') {
      slots.push({ kind: 'text', text: part })
      continue
    }
    if (part === null || typeof part !== 'object') continue
    const type = typeof part.type === 'string' ? part.type : ''
    if (type === 'image_url' || type === 'input_image' || (type === 'image' && !part.attachment)) {
      slots.push({ kind: 'image', at: images.length })
      images.push(await imagePayload(part))
      continue
    }
    if (type === 'file' || type === 'input_file') {
      const input = filePayload(part)
      // Text that decodes cleanly is inlined: the model can read it directly,
      // where a stored path would only be readable by a harness session's own
      // file tools — which a caller's model does not have.
      const text = inlineTextOf(base64Bytes(input.data), input.mediaType)
      if (text !== undefined) {
        slots.push({ kind: 'text', text: `[attached file: ${input.name ?? 'file'}]\n${text}` })
        continue
      }
      slots.push({ kind: 'file', at: files.length })
      files.push(input)
      continue
    }
    if (typeof part.text === 'string') {
      slots.push({ kind: 'text', text: part.text })
      continue
    }
    throw new Error(`unsupported content part type "${type || 'unknown'}"`)
  }

  if ((images.length > 0 || files.length > 0) && attachments === undefined) {
    throw new Error(
      'this profile has no attachment store, so image and file inputs cannot be forwarded; send text only',
    )
  }

  const imageRefs =
    images.length === 0
      ? []
      : await attachments.saveImages(
          images.map((image) => ({ data: base64Bytes(image.data), mediaType: image.mediaType })),
        )
  const fileRefs = []
  for (const input of files) {
    fileRefs.push(await attachments.saveFile({ data: base64Bytes(input.data), ...(input.name === undefined ? {} : { name: input.name }) }))
  }

  const blocks = []
  for (const slot of slots) {
    if (slot.kind === 'text') blocks.push({ type: 'text', text: slot.text })
    else if (slot.kind === 'image') blocks.push({ type: 'image', attachment: imageRefs[slot.at] })
    else blocks.push({ type: 'file', attachment: fileRefs[slot.at] })
  }
  if (blocks.length === 0) blocks.push({ type: 'text', text: '' })
  return blocks
}

/* ------------------------------------------------------------- catalog */

function modelKey(entry) {
  return `${entry.provider}/${entry.model.id}`
}

/** Resolve `provider/model`, or an unambiguous bare model id. */
async function resolveRoute(ctx, state, ttl, requested) {
  const providers = ctx.llm.listProviders().map((provider) => provider.id)
  const slash = requested.indexOf('/')
  if (slash > 0) {
    const provider = requested.slice(0, slash)
    const model = requested.slice(slash + 1)
    if (providers.includes(provider) && model.length > 0) return { provider, model }
  }
  if (providers.includes(requested)) return undefined

  const matches = (await catalog(ctx, state, ttl, false)).filter(
    (entry) => entry.model.id === requested,
  )
  if (matches.length === 1) return { provider: matches[0].provider, model: requested }
  if (matches.length > 1) {
    throw new Error(
      `model ${requested} exists on several providers (${matches
        .map((entry) => entry.provider)
        .join(', ')}); address it as "<provider>/${requested}"`,
    )
  }
  return undefined
}

/** Every `{provider, model}` pair the host currently advertises. */
async function discover(ctx) {
  const entries = []
  for (const provider of ctx.llm.listProviders()) {
    let models
    try {
      models = await ctx.llm.listModels(provider.id)
    } catch (error) {
      logWarn(ctx, `could not list models for provider "${provider.id}": ${messageOf(error)}`)
      continue
    }
    for (const model of models) entries.push({ provider: provider.id, model })
  }
  return entries
}

async function catalog(ctx, state, ttl, refresh) {
  const fresh = Date.now() - state.catalog.at < ttl
  if (!refresh && fresh && state.catalog.entries.length > 0) return state.catalog.entries
  const entries = await discover(ctx)
  // An empty pass is never cached: the adapters may still be binding their
  // own model settings, and a stale empty table would outlive that window.
  if (entries.length === 0) return state.catalog.entries
  state.catalog = { at: Date.now(), entries }
  return entries
}

/**
 * Watch the catalog until the set of reporting providers stops moving.
 *
 * One non-empty pass is not "warmed". The built-in providers answer from the
 * host immediately, while an adapter that resolves a credential or fetches an
 * upstream directory binds seconds later — and a plugin that sits after this
 * one in the profile registers its provider after this loop has started.
 * Stopping at the first non-empty pass therefore caches a catalog that never
 * mentions them, and the page has no way to ask for a better one.
 */
function warmCatalog(ctx, state, ttl) {
  const startedAt = Date.now()
  let attempts = 0
  let signature
  const tick = async () => {
    attempts += 1
    try {
      const entries = await catalog(ctx, state, ttl, true)
      const reporting = [...new Set(entries.map((entry) => entry.provider))].sort().join(',')
      const registered = ctx.llm.listProviders().map((provider) => provider.id).sort().join(',')
      const current = `${registered}|${reporting}`
      // Two identical passes after the settle window: everything that is
      // going to answer has answered, and nothing is still arriving.
      if (current === signature && Date.now() - startedAt >= WARM_SETTLE_MS) return
      signature = current
    } catch (error) {
      logWarn(ctx, `catalog refresh failed: ${messageOf(error)}`)
    }
    if (attempts >= WARM_ATTEMPTS) return
    const timer = setTimeout(tick, WARM_INTERVAL_MS)
    timer.unref?.()
  }
  tick()
}

/* ------------------------------------------------------------ dispatch */

/**
 * Prepare one call. `configure` runs before validation so a requested
 * reasoning effort is mapped onto an effort the model actually advertises —
 * an unsupported id would otherwise reject the call outright.
 */
async function prepare(ctx, call, signal, { dropStop }) {
  const config = { ...call.config }
  if (dropStop) delete config.stop
  const prepared = await ctx.llm.prepareCall(config, signal, (raw, info) => {
    const controls = { ...raw }
    const effort = pickEffort(info, call.effort)
    if (effort === undefined) delete controls.reasoningEffort
    else controls.reasoningEffort = effort
    return controls
  })
  return {
    ...prepared,
    options: { ...prepared.config, ...call.io, signal },
  }
}

/**
 * The effort to send: the caller's choice when the model advertises it,
 * otherwise the nearest advertised effort, otherwise no explicit effort (so
 * the model default applies).
 */
function pickEffort(info, requested) {
  const reasoning = info?.reasoning
  if (reasoning === undefined || requested === undefined) return undefined
  const ids = reasoning.efforts.map((effort) => effort.id)
  if (ids.includes(requested)) return requested
  const wanted = EFFORT_ORDER.indexOf(requested.toLowerCase())
  if (wanted < 0) return undefined
  let best
  let distance = Number.POSITIVE_INFINITY
  for (const id of ids) {
    const rank = EFFORT_ORDER.indexOf(id)
    if (rank < 0) continue
    const delta = Math.abs(rank - wanted)
    if (delta < distance) {
      distance = delta
      best = id
    }
  }
  return best
}

const EFFORT_ORDER = ['minimal', 'low', 'medium', 'high', 'xhigh', 'max']

/* ----------------------------------------------------------------- retry */

function nonNegativeInteger(value) {
  return Number.isInteger(value) && value >= 0 ? value : 0
}

function positiveOr(value, fallback) {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : fallback
}

/** The retry policy in effect: the host's defaults, overridable per profile. */
function resolveRetryPolicy(settings) {
  const initialDelayMs = positiveOr(settings.retryInitialDelayMs, RETRY_INITIAL_MS)
  const maxDelayMs = Math.max(initialDelayMs, positiveOr(settings.retryMaxDelayMs, RETRY_MAX_MS))
  const maxRetries = Number.isInteger(settings.retryMaxRetries) && settings.retryMaxRetries >= 0
    ? settings.retryMaxRetries
    : RETRY_MAX_RETRIES
  return { maxRetries, initialDelayMs, maxDelayMs, jitterRatio: RETRY_JITTER }
}

/**
 * Rough input size in tokens, from the only unit every message shape shares.
 *
 * Deliberately approximate: characters are divided by three, which lands
 * between Latin text (~4 chars/token) and CJK (~1.5). The number is recorded
 * next to the upstream's own `usage.prompt_tokens`, so the estimate can be
 * calibrated against reality instead of being trusted forever.
 */
function estimateInputTokens(call) {
  let chars = call.io.system?.length ?? 0
  for (const message of call.io.messages) {
    for (const block of message.content ?? []) {
      if (typeof block.text === 'string') chars += block.text.length
      else if (typeof block.arguments === 'string') chars += block.arguments.length
    }
  }
  for (const tool of call.io.tools ?? []) chars += JSON.stringify(tool).length
  return Math.ceil(chars / 3) + call.io.messages.length * 4
}

/** The model's declared context window, when the provider publishes one. */
async function contextWindowOf(ctx, state, ttl, route) {
  try {
    const entries = await catalog(ctx, state, ttl, false)
    const hit = entries.find(
      (entry) => entry.provider === route.provider && entry.model.id === route.model,
    )
    const window = hit?.model?.contextWindow
    return typeof window === 'number' && window > 0 ? window : undefined
  } catch {
    return undefined
  }
}

/**
 * Drop the oldest turns until the history fits `maxMessages`.
 *
 * The kept history always starts at a `user` message: starting at a `tool`
 * result, or at an assistant turn whose tool calls were dropped, hands the
 * adapter a conversation it cannot replay.
 */
function truncateHistory(call, maxMessages) {
  const messages = call.io.messages
  if (!Number.isInteger(maxMessages) || maxMessages <= 0 || messages.length <= maxMessages) return 0
  let start = messages.length - maxMessages
  while (start < messages.length && messages[start].role !== 'user') start += 1
  if (start >= messages.length) return 0
  call.io = { ...call.io, messages: messages.slice(start) }
  return start
}

/**
 * Refuse a request that is plainly larger than the model can take, and trim
 * one that the profile asked to keep short.
 *
 * Why this exists: a stateless gateway is talked to by clients that run their
 * own agent loop and resend their whole history every turn. Nothing here
 * compacts, so the request grows until the upstream answers something useless
 * (measured: reasoning only, `finish: stop`, zero content). Failing loudly at
 * the boundary with the size and the limit is more useful than relaying that.
 *
 * Returns the failure to send, or `undefined` when the request may proceed.
 */
async function applyInputGuard(ctx, state, ttl, route, call, trace) {
  const guard = state.inputGuard
  const dropped = truncateHistory(call, guard.maxMessages)
  if (dropped > 0) {
    trace.truncatedMessages = dropped
    logInfo(ctx, `truncated ${dropped} oldest messages to fit maxMessages=${guard.maxMessages}`)
  }
  const window = await contextWindowOf(ctx, state, ttl, route)
  if (window !== undefined) trace.contextWindow = window
  const limit = guard.maxInputTokens > 0 ? guard.maxInputTokens : window
  if (limit === undefined) return undefined
  const estimate = estimateInputTokens(call)
  trace.inputTokensEst = estimate
  if (estimate <= limit) return undefined
  return {
    code: 'CONTEXT_WINDOW_EXCEEDED',
    message:
      `this request is about ${estimate} input tokens but ${route.provider}/${route.model} `
      + `accepts ${limit}. The gateway is stateless: it cannot compact the history a client `
      + `resends, so the conversation has to be shortened on the calling side (or raise `
      + `maxInputTokens / maxMessages in this plugin's config).`,
  }
}


/**
 * Keep one finished request, and put it where an operator will look.
 *
 * The counters (`requests`, `failures`) answer "did anything fail" but not
 * "what happened to the last call". The five fields here do: which model, how
 * many attempts it took, when the first byte left, how it ended and — when it
 * ended badly — the adapter's own code and message.
 */
function recordRequest(ctx, state, trace) {
  trace.ms = Date.now() - trace.at
  state.recent.unshift(trace)
  if (state.recent.length > RECENT_LIMIT) state.recent.length = RECENT_LIMIT
  const where = `${trace.model} ${trace.stream ? 'stream' : 'blocking'} ${trace.ms}ms`
  const why = trace.code === undefined ? '' : ` ${trace.code}: ${String(trace.message ?? '').slice(0, 200)}`
  if (trace.outcome === 'ok') logInfo(ctx, `request ${where}${why}`)
  else logWarn(ctx, `request ${where} ended ${trace.outcome}${why}`)
}

/** Whether a failure is one the host would retry. */
function retryable(failure) {
  return failure !== undefined && typeof failure.code === 'string' && RETRYABLE_CODES.has(failure.code)
}

/**
 * How long to wait before retry number `retry` (1-based), or `undefined` when
 * this failure must not be retried at all.
 *
 * A failure that names its own reset point is honoured only while that wait
 * fits the budget: a fifteen-minute wait is an answer ("come back later"),
 * not a pause this gateway should hold a caller's request open for. The host's
 * retry policy gives up on it for exactly the same reason.
 */
function retryDelayMs(policy, retry, failure) {
  if (!retryable(failure)) return undefined
  const stated = failure.providerRetryAfterMs
  if (typeof stated === 'number' && Number.isFinite(stated) && stated > 0) {
    return stated <= policy.maxDelayMs ? stated : undefined
  }
  const exponential = Math.min(policy.initialDelayMs * 2 ** Math.min(retry - 1, 16), policy.maxDelayMs)
  const jittered = exponential * (1 - policy.jitterRatio * Math.random())
  return Math.max(1, Math.min(jittered, policy.maxDelayMs))
}

/** Wait, but wake immediately when the caller goes away. */
function sleep(ms, signal) {
  return new Promise((resolve) => {
    if (signal?.aborted === true) {
      resolve(false)
      return
    }
    const onAbort = () => {
      clearTimeout(timer)
      resolve(false)
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener?.('abort', onAbort)
      resolve(true)
    }, ms)
    timer.unref?.()
    signal?.addEventListener?.('abort', onAbort, { once: true })
  })
}

/* ------------------------------------------------------------- keepalive */

/**
 * Keep a long, quiet generation from looking like a dead connection.
 *
 * A model can think for minutes before its first delta, and an upstream can
 * go quiet between deltas; in both windows nothing is written on the wire, and
 * a caller whose read timeout counts silence hangs up on a request that is
 * still healthy. After `SILENT_FLUSH_MS` the response commits its headers and
 * an SSE comment (ignored by every OpenAI client) goes out every
 * `KEEPALIVE_MS` until the stream ends.
 *
 * Committing early costs the ability to answer a pre-content failure with a
 * JSON status, which is why it only happens once the wait has been long enough
 * that silence is the bigger risk; `woke()` cancels the timer as soon as real
 * data arrives.
 */
function startKeepAlive(res, flush, policy) {
  let interval
  const timer = setTimeout(() => {
    if (res.writableEnded) return
    flush()
    interval = setInterval(() => {
      if (res.writableEnded) return
      res.write(': keep-alive\n\n')
    }, policy.keepAliveMs)
    interval.unref?.()
  }, policy.silentFlushMs)
  timer.unref?.()
  return {
    woke() {
      clearTimeout(timer)
    },
    stop() {
      clearTimeout(timer)
      if (interval !== undefined) clearInterval(interval)
    },
  }
}

/** Pull the whole stream through one prepared call. */
async function consume(ctx, call, signal, { dropStop }, onChunk) {
  const prepared = await prepare(ctx, call, signal, { dropStop })
  for await (const chunk of prepared.stream(prepared.options)) onChunk(chunk)
}

/** Non-streaming answer, retried once without `stop` if an adapter refuses it. */
async function blockingCompletion(ctx, state, res, call, signal) {
  const runOnce = async (dropStop) => {
    const result = { text: '', reasoning: '', tools: new Map(), usage: undefined, finish: undefined }
    await consume(ctx, call, signal, { dropStop }, (chunk) => {
      switch (chunk.type) {
        case 'text-delta':
          result.text += chunk.text
          break
        case 'reasoning-delta':
          result.reasoning += chunk.text
          break
        case 'tool-call-delta': {
          const seen = result.tools.get(chunk.index) ?? { id: '', name: '', arguments: '' }
          seen.id += fieldDelta(seen.id, chunk.id)
          seen.name += fieldDelta(seen.name, chunk.name)
          seen.arguments += chunk.argumentsDelta ?? ''
          result.tools.set(chunk.index, seen)
          break
        }
        case 'usage':
          result.usage = chunk.usage
          break
        case 'finish':
          result.finish = chunk.reason
          break
        default:
          break
      }
    })
    return result
  }

  // Nothing has been written to the client yet, so a transient failure can be
  // retried exactly the way the host's agent loop would retry it.
  const trace = call.trace ?? {}
  let result
  for (let attempt = 0; ; attempt += 1) {
    trace.attempts = attempt + 1
    try {
      result = await runOnce(false)
      if (stopRefused(result.finish, call.stopRequested)) result = await runOnce(true)
    } catch (error) {
      const delay = attempt < state.retry.maxRetries && !signal.aborted
        ? retryDelayMs(state.retry, attempt + 1, error)
        : undefined
      if (delay === undefined || !await sleep(delay, signal)) {
        state.failures += 1
        trace.outcome = signal.aborted ? 'aborted' : 'error'
        trace.code = error?.code
        trace.message = messageOf(error)
        sendFailure(res, error)
        return
      }
      logInfo(ctx, `retrying after ${messageOf(error)} in ${delay}ms (${attempt + 1}/${RETRY_MAX_RETRIES})`)
      continue
    }
    const failure = result.finish?.kind === 'error' ? result.finish.failure : undefined
    // Same rule as the streaming path: no text and no tool call is not an
    // answer, it is EMPTY_RESPONSE — retryable, and never a silent success.
    const empty = result.finish?.kind === 'stop' && result.text.length === 0 && result.tools.size === 0
    const retryableFailure = empty === true ? { code: 'EMPTY_RESPONSE', message: 'the model finished without producing any content' } : failure
    const delay = attempt < state.retry.maxRetries && !signal.aborted
      ? retryDelayMs(state.retry, attempt + 1, retryableFailure)
      : undefined
    if (delay === undefined || !await sleep(delay, signal)) break
    logInfo(ctx, `retrying after ${messageOf(retryableFailure)} in ${delay}ms (${attempt + 1}/${state.retry.maxRetries})`)
  }

  if (result.finish?.kind === 'stop' && result.text.length === 0 && result.tools.size === 0) {
    const failure = { code: 'EMPTY_RESPONSE', message: 'the model finished without producing any content' }
    state.failures += 1
    trace.outcome = 'error'
    trace.code = failure.code
    trace.message = failure.message
    sendFailure(res, failure)
    return
  }

  if (result.finish?.kind === 'error' || result.finish?.kind === 'aborted') {
    state.failures += 1
    trace.outcome = result.finish.kind === 'aborted' ? 'aborted' : 'error'
    trace.code = result.finish.failure?.code
    trace.message = messageOf(result.finish.failure)
    sendFailure(res, result.finish.failure)
    return
  }
  trace.firstByteMs = Date.now() - trace.at
  trace.textBytes = result.text.length
  trace.reasoningBytes = result.reasoning.length
  trace.finish = result.finish?.kind ?? 'unknown'
  if (result.usage !== undefined) trace.usage = result.usage

  const toolCalls = [...result.tools.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([, tool]) => ({
      id: tool.id.length > 0 ? tool.id : `call_${randomUUID()}`,
      type: 'function',
      function: {
        name: tool.name.length > 0 ? tool.name : 'unknown',
        arguments: tool.arguments.length > 0 ? tool.arguments : '{}',
      },
    }))

  sendJson(res, 200, {
    id: `chatcmpl-${randomUUID()}`,
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model: call.requested,
    choices: [
      {
        index: 0,
        message: {
          role: 'assistant',
          content: result.text.length > 0 ? result.text : null,
          ...(result.reasoning.length === 0 ? {} : { reasoning_content: result.reasoning }),
          ...(toolCalls.length === 0 ? {} : { tool_calls: toolCalls }),
        },
        finish_reason: openAiFinish(result.finish),
        logprobs: null,
      },
    ],
    ...(result.usage === undefined ? {} : { usage: openAiUsage(result.usage) }),
  })
}

/**
 * Streaming answer. Headers are held back until the call produces its first
 * delta, so a pre-content adapter failure can still answer as a JSON error and
 * can still be retried without `stop`.
 */
async function streamCompletion(ctx, state, res, call, signal) {
  const id = `chatcmpl-${randomUUID()}`
  const created = Math.floor(Date.now() / 1000)
  const trace = call.trace ?? {}
  let open = false
  let usage
  let finish

  const write = (delta, finishReason) => {
    if (res.writableEnded) return
    if (typeof delta.content === 'string') trace.textBytes = (trace.textBytes ?? 0) + delta.content.length
    if (typeof delta.reasoning_content === 'string') trace.reasoningBytes = (trace.reasoningBytes ?? 0) + delta.reasoning_content.length
    if (Array.isArray(delta.tool_calls)) trace.toolCalls = (trace.toolCalls ?? 0) + delta.tool_calls.length
    res.write(
      `data: ${JSON.stringify({
        id,
        object: 'chat.completion.chunk',
        created,
        model: call.requested,
        choices: [
          { index: 0, delta, finish_reason: finishReason ?? null, logprobs: null },
        ],
      })}\n\n`,
    )
  }

  let keepAlive

  const flush = () => {
    if (open) return
    open = true
    trace.firstByteMs = Date.now() - trace.at
    keepAlive?.woke()
    res.writeHead(200, {
      ...corsHeaders(),
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    })
    res.flushHeaders?.()
    write({ role: 'assistant', content: '' })
  }

  const runOnce = async (dropStop) => {
    usage = undefined
    finish = undefined
    // OpenAI clients *append* every string field of a streamed tool call, while
    // the host adapter repeats the full id and name on each delta. Emitting them
    // verbatim would make the caller accumulate "BashBashBash…"; send the suffix
    // instead, so appending once per field reconstructs exactly one value.
    const seenTools = new Map()
    await consume(ctx, call, signal, { dropStop }, (chunk) => {
      switch (chunk.type) {
        case 'text-delta':
          flush()
          write({ content: chunk.text })
          break
        case 'reasoning-delta':
          flush()
          write({ reasoning_content: chunk.text })
          break
        case 'tool-call-delta': {
          flush()
          const seen = seenTools.get(chunk.index) ?? { id: '', name: '' }
          const idDelta = fieldDelta(seen.id, chunk.id)
          const nameDelta = fieldDelta(seen.name, chunk.name)
          if (typeof chunk.id === 'string' && chunk.id.length > 0) seen.id = chunk.id
          if (typeof chunk.name === 'string' && chunk.name.length > 0) seen.name = chunk.name
          seenTools.set(chunk.index, seen)
          write({
            tool_calls: [
              {
                index: chunk.index,
                ...(idDelta.length > 0 ? { id: idDelta, type: 'function' } : {}),
                function: {
                  ...(nameDelta.length > 0 ? { name: nameDelta } : {}),
                  arguments: chunk.argumentsDelta ?? '',
                },
              },
            ],
          })
          break
        }
        case 'usage':
          usage = chunk.usage
          break
        case 'finish':
          finish = chunk.reason
          break
        default:
          break
      }
    })
  }

  keepAlive = startKeepAlive(res, flush, state.keepAlive)

  // Retry only while nothing has been written: once a delta is on the wire the
  // caller would see the answer twice, so a failure after that point is
  // reported rather than replayed.
  for (let attempt = 0; ; attempt += 1) {
    trace.attempts = attempt + 1
    try {
      await runOnce(false)
      if (!open && stopRefused(finish, call.stopRequested)) await runOnce(true)
    } catch (error) {
      const delay = !open && attempt < state.retry.maxRetries && !signal.aborted
        ? retryDelayMs(state.retry, attempt + 1, error)
        : undefined
      if (delay === undefined || !await sleep(delay, signal)) {
        keepAlive.stop()
        state.failures += 1
        trace.outcome = signal.aborted ? 'aborted' : 'error'
        trace.code = error?.code
        trace.message = messageOf(error)
        if (!open) {
          sendFailure(res, error)
          return
        }
        // Committed already: end the stream with the error *and* the terminal
        // marker, so the caller reads "the upstream failed" instead of
        // "the connection dropped".
        res.write(
          `data: ${JSON.stringify({ error: { message: messageOf(error), type: 'server_error' } })}\n\n`,
        )
        res.write('data: [DONE]\n\n')
        res.end()
        return
      }
      logInfo(ctx, `retrying stream after ${messageOf(error)} in ${delay}ms (${attempt + 1}/${RETRY_MAX_RETRIES})`)
      continue
    }
    const failure = finish?.kind === 'error' ? finish.failure : undefined
    // A stop that produced neither text nor a tool call is not an answer. The
    // host classifies exactly this as EMPTY_RESPONSE and retries it; handing
    // the caller an empty success is what a UI reports as "it dropped".
    const empty = finish?.kind === 'stop' && trace.textBytes === 0 && (trace.toolCalls ?? 0) === 0
    const retryableFailure = empty === true ? { code: 'EMPTY_RESPONSE', message: 'the model finished without producing any content' } : failure
    const delay = !open && attempt < state.retry.maxRetries && !signal.aborted
      ? retryDelayMs(state.retry, attempt + 1, retryableFailure)
      : undefined
    if (delay === undefined || !await sleep(delay, signal)) break
    logInfo(ctx, `retrying stream after ${messageOf(retryableFailure)} in ${delay}ms (${attempt + 1}/${state.retry.maxRetries})`)
  }

  keepAlive.stop()

  if (!open && (finish?.kind === 'error' || finish?.kind === 'aborted')) {
    state.failures += 1
    trace.outcome = finish.kind === 'aborted' ? 'aborted' : 'error'
    trace.code = finish.failure?.code
    trace.message = messageOf(finish.failure)
    sendFailure(res, finish.failure)
    return
  }

  // Exhausted the retries and the model still answered nothing: say so. An
  // empty success is indistinguishable from a dropped connection on the
  // client's side, which is the report this whole path exists to stop.
  if (finish?.kind === 'stop' && trace.textBytes === 0 && (trace.toolCalls ?? 0) === 0) {
    const failure = { code: 'EMPTY_RESPONSE', message: 'the model finished without producing any content' }
    state.failures += 1
    trace.outcome = 'error'
    trace.code = failure.code
    trace.message = failure.message
    if (!open) {
      sendFailure(res, failure)
      return
    }
    res.write(
      `data: ${JSON.stringify({ error: { message: failure.message, type: 'server_error', code: failure.code } })}\n\n`,
    )
    res.write('data: [DONE]\n\n')
    res.end()
    return
  }

  // The stream is already committed, so the failure has to travel inside it.
  // Ending with a `finish_reason: stop` here would tell the caller the answer
  // completed when the upstream had actually cut it short.
  if (finish?.kind === 'error' || finish?.kind === 'aborted') {
    state.failures += 1
    const failure = finish.failure
    trace.outcome = finish.kind === 'aborted' ? 'aborted' : 'error'
    trace.code = failure?.code
    trace.message = messageOf(failure)
    res.write(
      `data: ${JSON.stringify({
        error: {
          message: messageOf(failure),
          type: 'server_error',
          ...(failure?.code === undefined ? {} : { code: failure.code }),
        },
      })}\n\n`,
    )
    res.write('data: [DONE]\n\n')
    res.end()
    return
  }

  flush()
  trace.finish = finish?.kind ?? 'unknown'
  // The upstream's own count, next to the estimate: this is what calibrates
  // `inputTokensEst` and what makes "how big was that request" answerable.
  if (usage !== undefined) trace.usage = usage
  write({}, openAiFinish(finish))
  if (call.includeUsage) {
    res.write(
      `data: ${JSON.stringify({
        id,
        object: 'chat.completion.chunk',
        created,
        model: call.requested,
        choices: [],
        ...(usage === undefined ? {} : { usage: openAiUsage(usage) }),
      })}\n\n`,
    )
  }
  res.write('data: [DONE]\n\n')
  res.end()
}

function openAiFinish(reason) {
  switch (reason?.kind) {
    case 'tool-calls':
      return 'tool_calls'
    case 'max-tokens':
      return 'length'
    default:
      return 'stop'
  }
}

function openAiUsage(usage) {
  if (usage === undefined) return undefined
  const prompt = usage.inputTokens ?? 0
  const completion = usage.outputTokens ?? 0
  return {
    prompt_tokens: prompt,
    completion_tokens: completion,
    total_tokens: usage.totalTokens ?? prompt + completion,
    ...(usage.reasoningTokens === undefined
      ? {}
      : { completion_tokens_details: { reasoning_tokens: usage.reasoningTokens } }),
    ...(usage.cacheReadTokens === undefined
      ? {}
      : { prompt_tokens_details: { cached_tokens: usage.cacheReadTokens } }),
  }
}

/** An adapter that refuses `stop` is retried without it, not surfaced. */
function stopRefused(finish, stopRequested) {
  if (!stopRequested) return false
  if (finish?.kind !== 'error' && finish?.kind !== 'aborted') return false
  const failure = finish.failure
  if (failure === undefined) return false
  return (
    failure.code === 'UNSUPPORTED_OPTION' ||
    /does not support GenerateOptions\.stop/i.test(failure.message ?? '')
  )
}

/* --------------------------------------------------------------- storage */

/**
 * The Harness home, in the same precedence the host uses: a non-blank
 * `$DSH_HOME`, else `~/.dsh`.
 */
function dshHome(env = process.env) {
  const configured = env.DSH_HOME
  return configured !== undefined && configured.trim().length > 0
    ? resolve(configured.trim())
    : join(homedir(), '.dsh')
}

function clampPort(value) {
  const port = Math.trunc(value)
  return port >= 1 && port <= 65535 ? port : DEFAULT_PORT
}

/**
 * Read the persisted settings, minting a key on first run and migrating the
 * legacy `api-key` file so an already-configured client keeps working.
 * `portOverride` (an explicit bundle config port) wins over the stored one.
 * Persistence failures are not fatal: the values still apply to this process.
 */
function loadStore(ctx, { portOverride, apiKeyPinned }) {
  const dir = join(dshHome(), KEY_DIRNAME)
  const path = join(dir, SETTINGS_FILENAME)
  let stored = {}
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8'))
    if (parsed !== null && typeof parsed === 'object') stored = parsed
  } catch {
    /* first run, or an unreadable file: rebuilt below */
  }

  const apiKey =
    apiKeyPinned.length >= MIN_KEY_LENGTH
      ? apiKeyPinned
      : typeof stored.apiKey === 'string' && stored.apiKey.trim().length >= MIN_KEY_LENGTH
        ? stored.apiKey.trim()
        : legacyApiKey(dir) ?? mintKey()

  const port =
    portOverride !== undefined
      ? portOverride
      : Number.isFinite(stored.port)
        ? clampPort(stored.port)
        : DEFAULT_PORT
  const store = { path, dir, port, apiKey, persisted: false }
  saveStore(ctx, store)
  return store
}

function legacyApiKey(dir) {
  try {
    const value = readFileSync(join(dir, KEY_FILENAME), 'utf8').trim()
    return value.length >= MIN_KEY_LENGTH ? value : undefined
  } catch {
    return undefined
  }
}

function mintKey() {
  return `${KEY_PREFIX}${randomBytes(24).toString('base64url')}`
}

function saveStore(ctx, store) {
  try {
    mkdirSync(store.dir, { recursive: true })
    writeFileSync(store.path, `${JSON.stringify({ port: store.port, apiKey: store.apiKey }, null, 2)}\n`, {
      mode: 0o600,
    })
    try {
      chmodSync(store.path, 0o600)
    } catch {
      /* Windows ignores POSIX modes; the home directory ACL already applies */
    }
    store.persisted = true
  } catch (error) {
    store.persisted = false
    logWarn(ctx, `could not persist settings at ${store.path}: ${messageOf(error)}`)
  }
}

/* -------------------------------------------------------------- listener */

/**
 * Start the gateway's own loopback listener. A preferred port that is already
 * taken falls back to an OS-assigned one instead of leaving the gateway down;
 * `portFallback` records that so the page can say so.
 */
async function startListener(ctx, state) {
  try {
    await listen(state, state.store.port)
    state.portFallback = false
  } catch (error) {
    if (error?.code !== 'EADDRINUSE') throw error
    logWarn(ctx, `port ${state.store.port} is in use; falling back to a random port`)
    await listen(state, 0)
    state.portFallback = true
  }
  state.listenError = undefined
  logInfo(ctx, `listening on http://${LISTEN_HOST}:${state.listenPort}${API_PREFIX}`)
}

function listen(state, port) {
  return new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => {
      state.handler(req, res)
    })
    const onError = (error) => {
      server.removeListener('listening', onListening)
      server.close(() => {})
      reject(error)
    }
    const onListening = () => {
      server.removeListener('error', onError)
      server.on('error', (error) => {
        state.listenError = messageOf(error)
      })
      state.server = server
      state.listenPort = server.address().port
      resolve(server)
    }
    server.once('error', onError)
    server.once('listening', onListening)
    server.listen({ port, host: LISTEN_HOST })
  })
}

function closeListener(state) {
  const server = state.server
  state.server = undefined
  if (server === undefined) return Promise.resolve()
  return new Promise((resolve) => {
    server.close(() => resolve())
    server.closeAllConnections?.()
  })
}

/**
 * Move the listener to another port. The previous port is restored when the
 * new one cannot be bound, so a rejected change never takes the gateway down.
 */
async function rebind(state, nextPort) {
  const previous = state.store.port
  await closeListener(state)
  try {
    await listen(state, nextPort)
  } catch (error) {
    state.store.port = previous
    await listen(state, previous).catch(() => {})
    throw error
  }
  state.store.port = nextPort
  state.portFallback = false
  state.listenError = undefined
}

/* -------------------------------------------------------------- controls */

/** Shared guard for the two write routes: POST, same-origin, JSON body. */
function control(ctx, req, res, run) {
  if (req.method !== 'POST') {
    sendJson(res, 405, { error: 'method not allowed' })
    return
  }
  if (!loopbackOrigin(req)) {
    sendJson(res, 403, { error: 'origin-not-trusted' })
    return
  }
  const type = req.headers['content-type'] ?? ''
  if (!type.toLowerCase().includes('application/json')) {
    sendJson(res, 415, { error: 'content-type must be application/json' })
    return
  }
  run().catch((error) => {
    fail(res, error)
  })
}

async function applyPort(ctx, state, req, res, bodyLimit) {
  let body
  try {
    body = await readBody(req, bodyLimit)
  } catch (error) {
    sendJson(res, 400, { error: messageOf(error) })
    return
  }
  const requested = Number(body.port)
  if (!Number.isInteger(requested) || requested < 1024 || requested > 65535) {
    sendJson(res, 400, {
      error: 'port-invalid',
      message: 'port must be an integer between 1024 and 65535',
    })
    return
  }
  if (requested === state.listenPort && !state.portFallback) {
    sendJson(res, 200, { port: state.listenPort, baseUrl: baseUrlOf(state) })
    return
  }
  try {
    await rebind(state, requested)
  } catch (error) {
    const busy = error?.code === 'EADDRINUSE'
    sendJson(res, busy ? 409 : 500, {
      error: busy ? 'port-in-use' : 'port-unavailable',
      message: messageOf(error),
      port: state.listenPort,
      baseUrl: baseUrlOf(state),
    })
    return
  }
  saveStore(ctx, state.store)
  sendJson(res, 200, { port: state.listenPort, baseUrl: baseUrlOf(state), fallback: false })
}

async function rotateKey(ctx, state, req, res, bodyLimit) {
  let body
  try {
    body = await readBody(req, bodyLimit)
  } catch (error) {
    sendJson(res, 400, { error: messageOf(error) })
    return
  }
  if (body.action !== 'regenerate') {
    sendJson(res, 400, { error: 'unknown-action', message: 'expected {"action":"regenerate"}' })
    return
  }
  state.store.apiKey = mintKey()
  state.apiKey = state.store.apiKey
  saveStore(ctx, state.store)
  sendJson(res, 200, { apiKey: state.apiKey })
}

/* --------------------------------------------------------------- status */

function baseUrlOf(state) {
  return state.listenPort === undefined
    ? null
    : `http://${LISTEN_HOST}:${state.listenPort}${API_PREFIX}`
}

/** `?refresh=1` (what the page's Refresh button sends) forces a rebuild. */
function refreshRequested(url) {
  const mark = typeof url === 'string' ? url.indexOf('?') : -1
  if (mark < 0) return false
  const flag = new URLSearchParams(url.slice(mark + 1)).get('refresh')
  return flag === '1' || flag === 'true'
}

/**
 * The page's single read. The catalog it carries is rebuilt first when the
 * snapshot is older than the TTL, or when the caller forced a pass: the page
 * renders exactly what this document says, so a snapshot that is never
 * rebuilt turns a late-binding adapter into a provider that is missing from
 * the UI until some unrelated OpenAI client happens to call `/v1/models`.
 */
async function statusPayload(ctx, state, ttl, refresh) {
  let entries
  try {
    entries = await catalog(ctx, state, ttl, refresh)
  } catch (error) {
    logWarn(ctx, `catalog refresh failed: ${messageOf(error)}`)
    entries = state.catalog.entries
  }
  const counts = new Map()
  for (const entry of entries) {
    counts.set(entry.provider, (counts.get(entry.provider) ?? 0) + 1)
  }
  return {
    id: PLUGIN_ID,
    enabled: state.enabled,
    baseUrl: baseUrlOf(state),
    port: state.listenPort ?? null,
    preferredPort: state.store.port,
    portFallback: state.portFallback,
    listenError: state.listenError ?? null,
    apiKey: state.apiKey,
    settingsFile: state.store.persisted ? state.store.path : null,
    modelCount: entries.length,
    // The catalog travels with the status document: the page is same-origin
    // with this route, while `/v1/models` is on the gateway's own port.
    models: entries.map((entry) => ({
      id: modelKey(entry),
      provider: entry.provider,
      ...(entry.model.name === entry.model.id ? {} : { name: entry.model.name }),
    })),
    providers: ctx.llm.listProviders().map((provider) => ({
      id: provider.id,
      name: typeof provider.name === 'string' ? provider.name : provider.id,
      models: counts.get(provider.id) ?? 0,
    })),
    requests: state.requests,
    failures: state.failures,
    // Newest first. This is what turns "it dropped again" into a cause: the
    // model, how many attempts it took, how long the first byte took, and the
    // adapter's own code when it ended badly.
    recent: state.recent.map((entry) => ({ ...entry })),
    startedAt: state.startedAt,
    catalogAt: state.catalog.at,
  }
}

/* ----------------------------------------------------------- http utils */

function corsHeaders() {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Authorization, Content-Type',
    'Access-Control-Max-Age': '86400',
  }
}

function sendCors(res, status) {
  res.writeHead(status, corsHeaders())
  res.end()
}

function sendJson(res, status, body, extra) {
  const payload = JSON.stringify(body)
  res.writeHead(status, {
    ...corsHeaders(),
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(payload),
    ...extra,
  })
  res.end(payload)
}

function sendError(res, status, type, message, extra, headers) {
  sendJson(res, status, { error: { message, type, ...extra } }, headers)
}

/**
 * `Retry-After` in whole seconds, when the failure names a wait it is worth
 * passing on. An adapter that measured the upstream's reset point says so in
 * `providerRetryAfterMs`; dropping it leaves the caller with a 429 and no
 * idea when to come back.
 */
function retryAfterSeconds(failure) {
  const ms = failure?.providerRetryAfterMs
  if (typeof ms !== 'number' || !Number.isFinite(ms) || ms <= 0) return undefined
  return Math.max(1, Math.ceil(ms / 1000))
}

function sendFailure(res, failure) {
  const code = failure?.code
  const status = typeof failure?.status === 'number' ? failure.status : statusForCode(code)
  const type =
    status === 401
      ? 'authentication_error'
      : status === 429
        ? 'rate_limit_error'
        : status >= 500
          ? 'server_error'
          : 'invalid_request_error'
  const retryAfter = retryAfterSeconds(failure)
  sendError(
    res,
    status,
    type,
    messageOf(failure),
    {
      ...(code === undefined ? {} : { code }),
      ...(retryAfter === undefined ? {} : { retry_after_seconds: retryAfter }),
    },
    retryAfter === undefined ? {} : { 'Retry-After': String(retryAfter) },
  )
}

function statusForCode(code) {
  switch (code) {
    case 'NO_ADAPTER':
    case 'INVALID_REQUEST':
    case 'INVALID_PREPARED_CALL':
    case 'UNSUPPORTED_OPTION':
    case 'UNSUPPORTED_CONTENT':
    case 'UNSUPPORTED_REASONING_EFFORT':
    case 'INVALID_MODEL_REASONING':
    case 'INVALID_CATALOG':
    case 'QUOTA_EXCEEDED':
      return 400
    case 'CONTEXT_WINDOW_EXCEEDED':
      return 413
    case 'IMAGE_OFFLOAD_REQUIRED':
      return 415
    // A throttle is not a server fault: 502 tells the caller "this gateway is
    // broken" and most clients either give up or retry immediately. 429 is the
    // answer that makes an OpenAI-compatible client back off.
    case 'RATE_LIMIT':
    case 'QUOTA':
      return 429
    case 'TIMEOUT':
      return 504
    default:
      return 502
  }
}

/** A throwing route handler becomes a bare 400 in the host server. Never throw. */
function fail(res, error) {
  if (res.headersSent) {
    res.destroy()
    return
  }
  sendFailure(res, error)
}

function loopbackOrigin(req) {
  const origin = req.headers.origin
  if (origin === undefined) return true
  try {
    const { hostname } = new URL(origin)
    return (
      hostname === 'localhost' ||
      hostname === '127.0.0.1' ||
      hostname === '[::1]' ||
      hostname === '::1'
    )
  } catch {
    return false
  }
}

function authorize(req, apiKey) {
  const header = req.headers.authorization
  if (typeof header !== 'string') return false
  const match = /^Bearer\s+(.+)$/i.exec(header.trim())
  if (match === null) return false
  const presented = Buffer.from(match[1])
  const expected = Buffer.from(apiKey)
  if (presented.length !== expected.length) return false
  return timingSafeEqual(presented, expected)
}

function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > limit) {
        reject(new Error('request body too large'))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => {
      let parsed
      try {
        parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'))
      } catch (error) {
        reject(error instanceof Error ? error : new Error(String(error)))
        return
      }
      if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
        reject(new Error('request body must be a JSON object'))
        return
      }
      resolve(parsed)
    })
    req.on('error', reject)
  })
}

function messageOf(error) {
  if (error === undefined || error === null) return 'unknown failure'
  if (typeof error === 'string') return error
  if (typeof error.message === 'string' && error.message.length > 0) return error.message
  return String(error)
}

function logWarn(ctx, message) {
  try {
    ctx.logger?.warn?.(`${PLUGIN_ID}: ${message}`)
  } catch {
    /* logging must never break a request */
  }
}

function logInfo(ctx, message) {
  try {
    const logger = ctx.logger
    if (typeof logger?.info === 'function') logger.info(`${PLUGIN_ID}: ${message}`)
    else if (typeof logger?.debug === 'function') logger.debug(`${PLUGIN_ID}: ${message}`)
  } catch {
    /* logging must never break a request */
  }
}
