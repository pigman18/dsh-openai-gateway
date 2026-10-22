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
    requests: 0,
    failures: 0,
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
          sendJson(res, 200, statusPayload(ctx, state), { 'Cache-Control': 'no-store' })
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

  let call
  try {
    const route = await resolveRoute(ctx, state, ttl, requested)
    if (route === undefined) {
      sendError(res, 404, 'invalid_request_error', `model ${requested} is not registered`, {
        code: 'model_not_found',
      })
      return
    }
    call = translate(body, route, requested)
  } catch (error) {
    sendError(res, 400, 'invalid_request_error', messageOf(error))
    return
  }

  const controller = new AbortController()
  res.on('close', () => controller.abort())

  if (call.wantsStream) await streamCompletion(ctx, state, res, call, controller.signal)
  else await blockingCompletion(ctx, state, res, call, controller.signal)
}

/* --------------------------------------------------------- translation */

/** Build the adapter-agnostic request: call config plus per-dispatch options. */
function translate(body, route, requested) {
  const systems = []
  const messages = []

  for (const raw of Array.isArray(body.messages) ? body.messages : []) {
    const role = typeof raw?.role === 'string' ? raw.role : ''
    if (role === 'system' || role === 'developer') {
      const text = textOf(raw.content)
      if (text.length > 0) systems.push(text)
      continue
    }
    if (role === 'user') {
      messages.push({ role: 'user', content: [{ type: 'text', text: textOf(raw.content) }] })
      continue
    }
    if (role === 'assistant') {
      const content = []
      const text = textOf(raw.content)
      if (text.length > 0) content.push({ type: 'text', text })
      for (const entry of Array.isArray(raw.tool_calls) ? raw.tool_calls : []) {
        const fn = entry?.function ?? {}
        const args =
          typeof fn.arguments === 'string' ? fn.arguments : JSON.stringify(fn.arguments ?? {})
        content.push({
          type: 'tool-call',
          id: typeof entry?.id === 'string' && entry.id.length > 0 ? entry.id : `call_${randomUUID()}`,
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
 * OpenAI content is a string or a list of parts. Images are not forwarded:
 * an out-of-band caller cannot supply durable attachment references, so only
 * text survives, in order.
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
 * Retry the first catalog load until an adapter reports models, then stop.
 * A profile whose providers are all unconfigured simply exhausts the budget
 * and keeps serving an empty catalog.
 */
function warmCatalog(ctx, state, ttl) {
  let attempts = 0
  const tick = async () => {
    attempts += 1
    try {
      const entries = await catalog(ctx, state, ttl, true)
      if (entries.length > 0) return
    } catch (error) {
      logWarn(ctx, `catalog refresh failed: ${messageOf(error)}`)
    }
    if (attempts >= 24) return
    const timer = setTimeout(tick, 1500)
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

  let result
  try {
    result = await runOnce(false)
    if (stopRefused(result.finish, call.stopRequested)) result = await runOnce(true)
  } catch (error) {
    state.failures += 1
    sendFailure(res, error)
    return
  }

  if (result.finish?.kind === 'error' || result.finish?.kind === 'aborted') {
    state.failures += 1
    sendFailure(res, result.finish.failure)
    return
  }

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
  let open = false
  let usage
  let finish

  const write = (delta, finishReason) => {
    if (res.writableEnded) return
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

  const flush = () => {
    if (open) return
    open = true
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

  try {
    await runOnce(false)
    if (!open && stopRefused(finish, call.stopRequested)) await runOnce(true)
  } catch (error) {
    state.failures += 1
    if (!open) {
      sendFailure(res, error)
      return
    }
    res.write(
      `data: ${JSON.stringify({ error: { message: messageOf(error), type: 'server_error' } })}\n\n`,
    )
    res.end()
    return
  }

  if (!open && (finish?.kind === 'error' || finish?.kind === 'aborted')) {
    state.failures += 1
    sendFailure(res, finish.failure)
    return
  }

  flush()
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

function statusPayload(ctx, state) {
  const counts = new Map()
  for (const entry of state.catalog.entries) {
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
    modelCount: state.catalog.entries.length,
    // The catalog travels with the status document: the page is same-origin
    // with this route, while `/v1/models` is on the gateway's own port.
    models: state.catalog.entries.map((entry) => ({
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

function sendError(res, status, type, message, extra) {
  sendJson(res, status, { error: { message, type, ...extra } })
}

function sendFailure(res, failure) {
  const code = failure?.code
  const status = typeof failure?.status === 'number' ? failure.status : statusForCode(code)
  const type =
    status === 401 ? 'authentication_error' : status >= 500 ? 'server_error' : 'invalid_request_error'
  sendError(res, status, type, messageOf(failure), code === undefined ? {} : { code })
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
