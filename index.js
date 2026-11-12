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
import { spawn } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
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
/**
 * How long a failing alias target sits out before it is tried again.
 *
 * Nothing probes it in the meantime: a target earns its way back by being the
 * next one a real request needs. Five minutes is long enough that a spent daily
 * quota does not cost one failed round-trip per request, and short enough that
 * a transient throttle heals without a restart.
 */
const FAILOVER_COOLDOWN_MS = 5 * 60_000
/**
 * Failures that mean "this target cannot serve right now, another one might":
 * quota, throttling, timeouts, upstream faults and unreachable hosts.
 *
 * Deliberately not the request-shape codes (INVALID_REQUEST, UNSUPPORTED_*,
 * CONTEXT_WINDOW_EXCEEDED). Those describe the caller's own payload, so every
 * other target would reject it identically — walking the whole list would just
 * multiply the latency of an answer that is never going to change.
 */
const FAILOVER_CODES = new Set([
  'QUOTA',
  'QUOTA_EXCEEDED',
  'RATE_LIMIT',
  'TIMEOUT',
  'TRANSPORT',
  'SERVER',
  'EMPTY_RESPONSE',
])
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
const ALIAS_ROUTE = `/plugins/${PLUGIN_ID}/aliases`
const TUNNEL_ROUTE = `/plugins/${PLUGIN_ID}/tunnel`
/** Tunnel providers the plugin can supervise itself. */
const TUNNEL_PROVIDERS = new Set(['ngrok', 'cloudflared'])
/** How long a spawned tunnel may take to publish its public URL. */
const TUNNEL_START_TIMEOUT_MS = 25_000
/**
 * Public URL shapes each provider prints. Matching the hostname rather than a
 * log field keeps all three ngrok formats working — `--log-format json` emits
 * `"url":"https://…"`, the text log prints `url=https://…`, and the default
 * human log says `Forwarding  https://…`.
 */
const TUNNEL_URL_PATTERNS = {
  ngrok: /https:\/\/[a-z0-9-]+\.ngrok-free\.(?:dev|app)/g,
  cloudflared: /https:\/\/[a-z0-9-]+\.trycloudflare\.com/g,
}

/** Where an ngrok account and its credential come from. */
const NGROK_SIGNUP_URL = 'https://dashboard.ngrok.com/signup'
const NGROK_TOKEN_URL = 'https://dashboard.ngrok.com/get-started/your-authtoken'
/**
 * ngrok's code for "this session is not authenticated". It is the one tunnel
 * failure with an obvious next step, and the one users hit most often, because
 * a free dev domain needs an account before a tunnel can claim it.
 */
const NGROK_NEEDS_CREDENTIAL = 'ERR_NGROK_4018'

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
 *   publicBaseUrl  — the address external clients should use (default: the
 *                    loopback one; set it to a tunnel hostname such as
 *                    `https://gw.example.com` and the page prints that)
 *   tunnel         — `{ provider, autostart }` lets the gateway supervise a
 *                    `ngrok` / `cloudflared` process itself
 *   aliases        — `{ "gpt-4o": "provider/model", … }` extra names a client
 *                    may send; the catalog advertises them too
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
  // An external hostname the caller supplies wins over anything the stored
  // settings or a supervised tunnel later reports.
  const publicBaseUrl = normalizeBaseUrl(settings.publicBaseUrl)
  const tunnelConfig = resolveTunnelConfig(settings.tunnel)

  // Persisted state lives in one plugin-owned file under the Harness home:
  // a configured external client then survives every restart.
  const store = loadStore(ctx, {
    portOverride: Number.isFinite(settings.port) ? clampPort(settings.port) : undefined,
    apiKeyPinned: typeof settings.apiKey === 'string' ? settings.apiKey.trim() : '',
    aliases: normalizeAliases(settings.aliases),
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
    // Rolling totals for the dashboard. Deliberately not persisted: these
    // describe this process's lifetime, which is what "since 09:41" on the
    // page means. A restart zeroes them along with `requests`.
    usageTotals: {
      inputTokens: 0,
      outputTokens: 0,
      totalTokens: 0,
      reasoningTokens: 0,
      cacheReadTokens: 0,
      // Only requests that reported usage of their own are counted here, so
      // this number is the denominator for the token figures beside it.
      calls: 0,
    },
    // Bytes that crossed the OpenAI surface, in and out. Headers are not
    // counted; bodies and SSE frames are, which is the traffic a tile can
    // honestly report.
    bytes: { in: 0, out: 0 },
    server: undefined,
    listenPort: undefined,
    portFallback: false,
    listenError: undefined,
    // External addressing: a configured hostname is authoritative; a tunnel
    // this plugin supervises only fills the gap while it is up.
    publicBaseUrl,
    tunnelConfig,
    // Left empty in production so `startTunnel` spawns the real agent. A test
    // sets it to run a stand-in script instead, which is the only substitution
    // that works on Windows (see the comment in startTunnel).
    tunnelCommand: undefined,
    // Which alias targets are sitting out, and why. In memory only: a restart
    // is exactly when a spent quota may have reset.
    failover: new Map(),
    failoverReason: new Map(),
    tunnel: {
      status: 'idle',
      provider: tunnelConfig.provider ?? null,
      url: undefined,
      error: undefined,
      pid: undefined,
      startedAt: undefined,
    },
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
    startListener(ctx, state)
      .then(() => {
        if (state.tunnelConfig.autostart) startTunnel(ctx, state)
      })
      .catch((error) => {
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
      webServer.register({
        kind: 'exact',
        path: ALIAS_ROUTE,
        handler: (req, res) => {
          control(ctx, req, res, () => applyAliases(ctx, state, req, res, bodyLimit))
        },
      }),
      webServer.register({
        kind: 'exact',
        path: TUNNEL_ROUTE,
        handler: (req, res) => {
          control(ctx, req, res, () => applyTunnel(ctx, state, req, res, bodyLimit))
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
      stopTunnel(ctx, state)
      closeListener(state)
    },
    `${PLUGIN_ID}: listener`,
  )

  // The live state, so a test (or a host that wants the bound port) can read
  // what this instance actually did instead of re-deriving it.
  return state

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
    data: [
      ...entries.map((entry) => ({
        id: modelKey(entry),
        object: 'model',
        created: 0,
        owned_by: entry.provider,
        ...(entry.model.name === entry.model.id ? {} : { name: entry.model.name }),
      })),
      // Aliases are listed beside the real ids: a client that only knows the
      // name it was configured with (Cursor sends its own ids) discovers that
      // the gateway honours it, instead of guessing from the error. A
      // multi-target alias is advertised once, under its own name, with every
      // target it may reach listed in order.
      ...aliasEntries(state).map((alias) => ({
        id: alias.alias,
        object: 'model',
        created: 0,
        owned_by: alias.targets[0].split('/')[0],
        alias_of: alias.targets[0],
        ...(alias.targets.length > 1 ? { alias_targets: [...alias.targets] } : {}),
      })),
    ],
  })
}

async function handleModel(ctx, state, ttl, rest, res) {
  const wanted = decodeURIComponent(rest)
  const entries = await catalog(ctx, state, ttl, false)
  const found =
    entries.find((entry) => modelKey(entry) === wanted) ??
    entries.find((entry) => entry.model.id === wanted)
  if (found === undefined) {
    const targets = aliasTargets(state, wanted)
    if (targets !== undefined) {
      sendJson(res, 200, {
        id: wanted,
        object: 'model',
        created: 0,
        alias_of: targets[0],
        ...(targets.length > 1 ? { alias_targets: [...targets] } : {}),
      })
      return
    }
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
    chargeInbound(state, req)
    sendError(res, 400, 'invalid_request_error', messageOf(error))
    return
  }
  // Only the OpenAI surface is metered: the control routes are the dashboard
  // talking to itself, and counting them would inflate the traffic tile with
  // page refreshes instead of client traffic.
  chargeInbound(state, req)

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

  // Traffic out of the OpenAI surface is measured by wrapping the two write
  // paths a response can take, so JSON bodies and SSE frames are counted by
  // the same rule. The control routes never pass through here, so a dashboard
  // refresh cannot inflate the tile. The fold happens on `finish`/`close`, so
  // every early return below is already covered.
  meterWrites(res, state)

  try {
    let call
    let route
    try {
      route = await resolveRoute(ctx, state, ttl, requested)
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

  await dispatchWithFailover(ctx, state, res, call, route, requested, trace, controller.signal)
  } catch (error) {
    trace.outcome = 'error'
    trace.code = error?.code
    trace.message = messageOf(error)
    throw error
  } finally {
    // `res.__gwOutBytes` is final only after the answer finished, so the
    // response total is folded in here rather than inside the senders.
    foldOutBytes(res, state)
    recordRequest(ctx, state, trace)
  }
}

/* ------------------------------------------------------------ failover */

/**
 * Send one request to the best target the alias allows, moving on when a
 * target reports that it cannot serve right now.
 *
 * The candidate list is the alias's own order, minus anything cooling down.
 * When every target is cooling down the list is not empty: the least-recently
 * failed one is used anyway. An alias whose whole list is benched still has to
 * answer something, and a caller would rather get a real 402 from the best
 * candidate than a synthetic "everything is cooling down" that no client knows
 * how to read.
 *
 * Failover is only possible before the response commits. Once a stream has sent
 * its first delta the answer is partly delivered, so replaying it on another
 * target would either duplicate it or silently swap the model mid-answer; that
 * failure is reported instead.
 */
async function dispatchWithFailover(ctx, state, res, call, route, requested, trace, signal) {
  const targets = aliasPlan(state, requested)
  const candidates = []

  if (targets === undefined) {
    candidates.push({ provider: route.provider, model: route.model })
  } else {
    for (const target of targets) {
      const cut = target.indexOf('/')
      if (cut <= 0) continue
      const provider = target.slice(0, cut)
      const model = target.slice(cut + 1)
      if (model.length === 0) continue
      if (!targetUsable(state, target)) continue
      candidates.push({ provider, model, target })
    }
    if (candidates.length === 0) {
      // Everything is benched: use the one whose cooldown expires first, so a
      // spent quota still produces a real upstream answer for the caller.
      let soonest
      let soonestUntil = Number.POSITIVE_INFINITY
      for (const target of targets) {
        const until = state.failover.get(target) ?? 0
        if (until < soonestUntil) {
          soonestUntil = until
          soonest = target
        }
      }
      const cut = String(soonest).indexOf('/')
      if (cut > 0) {
        candidates.push({ provider: soonest.slice(0, cut), model: soonest.slice(cut + 1), target: soonest })
      }
    }
  }

  trace.attempts = 0
  trace.targets = candidates.map((candidate) => `${candidate.provider}/${candidate.model}`)

  let lastFailure
  for (const [index, candidate] of candidates.entries()) {
    if (signal.aborted) break
    // Every candidate gets its own config, including the first. `call` was
    // translated against whatever `resolveRoute` picked, and that may well be a
    // target whose cooldown is still running — so the candidate's own
    // provider/model has to win in every case, not just from the second one on.
    const attemptCall = {
      ...call,
      config: { ...call.config, provider: candidate.provider, model: candidate.model },
    }

    trace.provider = candidate.provider
    trace.upstreamModel = candidate.model
    trace.attempts = (trace.attempts ?? 0) + 1
    trace.failoverIndex = index

    const outcome = attemptCall.wantsStream
      ? await streamCompletion(ctx, state, res, attemptCall, signal)
      : await blockingCompletion(ctx, state, res, attemptCall, signal)

    if (outcome?.ok === true) {
      if (candidate.target !== undefined) state.failover.delete(candidate.target)
      return outcome
    }

    lastFailure = outcome?.failure
    if (candidate.target !== undefined && failoverEligible(lastFailure, { committed: outcome?.committed === true }) !== undefined) {
      coolDown(state, candidate.target, lastFailure)
    }
    // A committed stream has already answered; nothing left to try.
    if (outcome?.committed === true) return outcome
    if (failoverEligible(lastFailure, { committed: false }) === undefined) break
    if (index < candidates.length - 1) {
      logInfo(
        ctx,
        `failover ${requested}: ${candidate.provider}/${candidate.model} failed (${lastFailure?.code ?? 'error'}), trying ${candidates[index + 1].provider}/${candidates[index + 1].model}`,
      )
    }
  }

  state.failures += 1
  trace.outcome = signal.aborted ? 'aborted' : 'error'
  trace.code = lastFailure?.code
  trace.message = messageOf(lastFailure)
  sendFailure(res, lastFailure)
  return { ok: false }
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

/** Resolve `provider/model`, a configured alias, or an unambiguous bare id. */
async function resolveRoute(ctx, state, ttl, requested) {
  const providers = ctx.llm.listProviders().map((provider) => provider.id)
  const slash = requested.indexOf('/')
  if (slash > 0) {
    const provider = requested.slice(0, slash)
    const model = requested.slice(slash + 1)
    if (providers.includes(provider) && model.length > 0) return { provider, model }
  }
  if (providers.includes(requested)) return undefined

  // An alias is resolved before the catalog is consulted: the whole point of
  // one is to name a model the caller cannot address unambiguously, and a
  // colliding bare id would otherwise throw before the alias is considered.
  // A multi-target alias resolves to its first usable target here; the others
  // are kept for the failover loop in `handleChat`.
  const targets = aliasTargets(state, requested)
  if (targets !== undefined) {
    for (const target of targets) {
      const cut = target.indexOf('/')
      if (cut <= 0) continue
      const provider = target.slice(0, cut)
      const model = target.slice(cut + 1)
      if (providers.includes(provider) && model.length > 0) return { provider, model }
    }
  }

  const matches = (await catalog(ctx, state, ttl, false)).filter(
    (entry) => entry.model.id === requested,
  )
  if (matches.length === 1) return { provider: matches[0].provider, model: requested }
  if (matches.length > 1) {
    throw new Error(
      `model ${requested} exists on several providers (${matches
        .map((entry) => entry.provider)
        .join(', ')}); address it as "<provider>/${requested}", or add an alias for it`,
    )
  }
  return undefined
}

/* ---------------------------------------------------------------- aliases */

/**
 * Aliases as `{ alias, targets }` pairs, in the order they will be tried. An
 * alias that names a provider the profile no longer registers is still
 * advertised: dropping it silently would turn a stale entry into a mystery 404
 * at the client, while keeping it lets the request fail with the adapter's own
 * answer.
 */
function aliasEntries(state) {
  return Object.entries(state.store.aliases).map(([alias, targets]) => ({ alias, targets }))
}

/**
 * The list a single alias points at. The stored form is always an array, but
 * every reader goes through here so a store written by an older build — where
 * a target was one string — keeps working without a migration step.
 */
function aliasTargets(state, alias) {
  const stored = state.store.aliases[alias]
  if (stored === undefined) return undefined
  return Array.isArray(stored) ? stored : [stored]
}

/**
 * Accept `{"name": "provider/model"}` and `{"name": ["provider/model", …]}`.
 *
 * Anything else is dropped rather than rejected: a partially useful table beats
 * a boot failure, and the page's own write route validates the shape it sends.
 * A duplicate target inside one alias is dropped too — trying the same endpoint
 * twice cannot succeed the second time, it only doubles the wait.
 */
function normalizeAliases(input) {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) return {}
  const aliases = {}
  for (const [alias, raw] of Object.entries(input)) {
    const name = typeof alias === 'string' ? alias.trim() : ''
    if (name.length === 0) continue
    const list = Array.isArray(raw) ? raw : [raw]
    const targets = []
    for (const entry of list) {
      const value = typeof entry === 'string' ? entry.trim() : ''
      if (value.length === 0) continue
      // An alias without a provider prefix cannot be resolved deterministically;
      // the caller should name the model it means.
      if (value.indexOf('/') <= 0) continue
      if (targets.includes(value)) continue
      targets.push(value)
    }
    if (targets.length === 0) continue
    aliases[name] = targets
  }
  return aliases
}

/**
 * Whether a target can be tried right now.
 *
 * Cooldowns live in memory only: a restart is exactly when a spent quota may
 * have been reset, so persisting "this one is bad" would outlive the fact that
 * made it true.
 */
function targetUsable(state, target) {
  const until = state.failover.get(target)
  if (until === undefined) return true
  if (Date.now() >= until) {
    state.failover.delete(target)
    return true
  }
  return false
}

/** Record that a target just failed in a way another target might survive. */
function coolDown(state, target, failure) {
  state.failover.set(target, Date.now() + FAILOVER_COOLDOWN_MS)
  state.failoverReason.set(target, {
    code: failure?.code,
    message: messageOf(failure),
    at: Date.now(),
    until: Date.now() + FAILOVER_COOLDOWN_MS,
  })
}

/**
 * Why a failure should move on to the next target, or `undefined` to stop.
 *
 * A committed stream is never failed over: the caller has already seen part of
 * an answer, and replaying the request elsewhere would either duplicate it or
 * silently replace it with a different one.
 */
function failoverEligible(failure, { committed }) {
  if (committed) return undefined
  if (failure === undefined || failure === null) return undefined
  if (typeof failure.code !== 'string' || !FAILOVER_CODES.has(failure.code)) return undefined
  return failure
}

/** The alias targets to try for `requested`, or `undefined` when it is not one. */
function aliasPlan(state, requested) {
  const targets = aliasTargets(state, requested)
  if (targets === undefined || targets.length === 0) return undefined
  return targets
}

/** `https://host/path` without a trailing slash, or undefined when unusable. */
function normalizeBaseUrl(value) {
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim()
  if (trimmed.length === 0) return undefined
  try {
    const url = new URL(trimmed)
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return undefined
    return `${url.origin}${url.pathname.replace(/\/+$/, '')}`
  } catch {
    return undefined
  }
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
  // Every request ends here — succeeded, refused, aborted — so this is the one
  // place totals can be accumulated without a second code path to keep in sync.
  addUsageTotals(state.usageTotals, trace.usage)
  const where = `${trace.model} ${trace.stream ? 'stream' : 'blocking'} ${trace.ms}ms`
  const why = trace.code === undefined ? '' : ` ${trace.code}: ${String(trace.message ?? '').slice(0, 200)}`
  if (trace.outcome === 'ok') logInfo(ctx, `request ${where}${why}`)
  else logWarn(ctx, `request ${where} ended ${trace.outcome}${why}`)
}

/**
 * Fold one request's upstream usage into the running totals.
 *
 * Adapters that do not report usage leave the totals untouched rather than
 * adding a zero: the tile then reads "0 tokens from 0 calls", which is
 * truthful, instead of a number diluted by requests that were never measured.
 */
function addUsageTotals(totals, usage) {
  if (usage === undefined || usage === null) return
  const input = Number(usage.inputTokens)
  const output = Number(usage.outputTokens)
  if (!Number.isFinite(input) && !Number.isFinite(output)) return
  const safeInput = Number.isFinite(input) ? input : 0
  const safeOutput = Number.isFinite(output) ? output : 0
  const total = Number.isFinite(Number(usage.totalTokens)) ? Number(usage.totalTokens) : safeInput + safeOutput
  totals.inputTokens += safeInput
  totals.outputTokens += safeOutput
  totals.totalTokens += total
  if (Number.isFinite(Number(usage.reasoningTokens))) totals.reasoningTokens += Number(usage.reasoningTokens)
  if (Number.isFinite(Number(usage.cacheReadTokens))) totals.cacheReadTokens += Number(usage.cacheReadTokens)
  totals.calls += 1
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
    trace.attempts = (trace.attempts ?? 0) + 1
    try {
      result = await runOnce(false)
      if (stopRefused(result.finish, call.stopRequested)) result = await runOnce(true)
    } catch (error) {
      const delay = attempt < state.retry.maxRetries && !signal.aborted
        ? retryDelayMs(state.retry, attempt + 1, error)
        : undefined
      if (delay === undefined || !await sleep(delay, signal)) {
        trace.outcome = signal.aborted ? 'aborted' : 'error'
        trace.code = error?.code
        trace.message = messageOf(error)
        // Nothing has been written yet, so the caller of this function still
        // owns the response: it may hand the request to another target instead
        // of answering with this failure.
        return { failure: error }
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
    trace.outcome = 'error'
    trace.code = failure.code
    trace.message = failure.message
    return { failure }
  }

  if (result.finish?.kind === 'error' || result.finish?.kind === 'aborted') {
    trace.outcome = result.finish.kind === 'aborted' ? 'aborted' : 'error'
    trace.code = result.finish.failure?.code
    trace.message = messageOf(result.finish.failure)
    return { failure: result.finish.failure }
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
  return { ok: true }
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
        trace.outcome = signal.aborted ? 'aborted' : 'error'
        trace.code = error?.code
        trace.message = messageOf(error)
        // Nothing committed: the caller still owns the response and may try
        // another target. Committed: this failure is final for this request.
        if (!open) return { failure: error, committed: false }
        state.failures += 1
        // End the stream with the error *and* the terminal marker, so the
        // caller reads "the upstream failed" instead of "the connection
        // dropped".
        res.write(
          `data: ${JSON.stringify({ error: { message: messageOf(error), type: 'server_error' } })}\n\n`,
        )
        res.write('data: [DONE]\n\n')
        res.end()
        return { ok: true, committed: true }
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
    trace.outcome = finish.kind === 'aborted' ? 'aborted' : 'error'
    trace.code = finish.failure?.code
    trace.message = messageOf(finish.failure)
    return { failure: finish.failure, committed: false }
  }

  // Exhausted the retries and the model still answered nothing: say so. An
  // empty success is indistinguishable from a dropped connection on the
  // client's side, which is the report this whole path exists to stop.
  if (finish?.kind === 'stop' && trace.textBytes === 0 && (trace.toolCalls ?? 0) === 0) {
    const failure = { code: 'EMPTY_RESPONSE', message: 'the model finished without producing any content' }
    trace.outcome = 'error'
    trace.code = failure.code
    trace.message = failure.message
    if (!open) return { failure, committed: false }
    state.failures += 1
    res.write(
      `data: ${JSON.stringify({ error: { message: failure.message, type: 'server_error', code: failure.code } })}\n\n`,
    )
    res.write('data: [DONE]\n\n')
    res.end()
    return { ok: true, committed: true }
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
    // Already answered: the caller must not fail over or send a second reply.
    return { ok: true, committed: true }
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
  return { ok: true }
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
function loadStore(ctx, { portOverride, apiKeyPinned, aliases }) {
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
  // Bundle config aliases win; the stored table is the fallback, so a profile
  // that pins them in YAML keeps them across a settings write.
  const aliasTable =
    aliases !== undefined && Object.keys(aliases).length > 0
      ? aliases
      : normalizeAliases(stored.aliases)
  const store = { path, dir, port, apiKey, aliases: aliasTable, persisted: false }
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
    const body = { port: store.port, apiKey: store.apiKey }
    // Only persisted when non-empty: an empty table would otherwise erase a
    // profile's YAML aliases on the next boot.
    if (Object.keys(store.aliases ?? {}).length > 0) body.aliases = store.aliases
    writeFileSync(store.path, `${JSON.stringify(body, null, 2)}\n`, {
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

/** Replace the whole alias table. `{}` clears it. */
async function applyAliases(ctx, state, req, res, bodyLimit) {
  let body
  try {
    body = await readBody(req, bodyLimit)
  } catch (error) {
    sendJson(res, 400, { error: messageOf(error) })
    return
  }
  const incoming = body.aliases
  if (incoming !== undefined && incoming !== null) {
    if (typeof incoming !== 'object' || Array.isArray(incoming)) {
      sendJson(res, 400, {
        error: 'aliases-invalid',
        message: 'aliases must be an object of {"name":"provider/model"} or {"name":["provider/model", …]} pairs',
      })
      return
    }
    // A target that is not `provider/model` cannot be routed, so the write is
    // refused here instead of leaving an alias that always 404s.
    for (const [alias, raw] of Object.entries(incoming)) {
      const list = Array.isArray(raw) ? raw : [raw]
      if (list.length === 0) {
        sendJson(res, 400, {
          error: 'alias-target-invalid',
          message: `alias "${alias}" must point at "provider/model"`,
        })
        return
      }
      for (const entry of list) {
        const value = typeof entry === 'string' ? entry.trim() : ''
        if (value.length === 0 || value.indexOf('/') <= 0) {
          sendJson(res, 400, {
            error: 'alias-target-invalid',
            message: `alias "${alias}" must point at "provider/model"`,
          })
          return
        }
      }
    }
  }
  state.store.aliases = normalizeAliases(incoming ?? {})
  saveStore(ctx, state.store)
  sendJson(res, 200, { aliases: { ...state.store.aliases } })
}

/* --------------------------------------------------------------- tunnel */

/** `{ provider, autostart }`, ignoring anything the plugin cannot supervise. */
function resolveTunnelConfig(input) {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) {
    return { provider: undefined, autostart: false }
  }
  const provider =
    typeof input.provider === 'string' && TUNNEL_PROVIDERS.has(input.provider.trim())
      ? input.provider.trim()
      : undefined
  return { provider, autostart: input.autostart === true && provider !== undefined }
}

/**
 * Start the configured tunnel as a child process and watch its output for the
 * public URL it prints. The child is owned by this plugin: it is killed on
 * dispose, so a reloaded profile does not leave an orphan holding the port.
 */
function startTunnel(ctx, state) {
  const provider = state.tunnel.provider ?? state.tunnelConfig.provider
  if (provider === undefined) {
    state.tunnel.status = 'unconfigured'
    return
  }
  if (state.tunnel.status === 'starting' || state.tunnel.status === 'running') return
  const port = state.listenPort
  if (port === undefined) {
    state.tunnel.status = 'failed'
    state.tunnel.error = 'the gateway listener is not up yet'
    return
  }

  // The binary is overridable so a test can substitute a script instead of
  // spawning the real tunnel agent. On Windows `spawn` resolves an executable
  // image and ignores a `.cmd` shim, so the only safe substitution is to run a
  // different command outright — which is what `command`/`prefixArgs` allow.
  const command = state.tunnelCommand?.command ?? (provider === 'ngrok' ? 'ngrok' : 'cloudflared')
  const prefixArgs = state.tunnelCommand?.prefixArgs ?? []
  const binary = command === process.execPath ? 'ngrok' : command
  const providerArgs =
    provider === 'ngrok'
      ? ['http', String(port), '--log', 'stdout', '--log-format', 'json']
      : ['tunnel', '--url', `http://${LISTEN_HOST}:${port}`, '--no-autoupdate']
  const args = [...prefixArgs, ...providerArgs]

  state.tunnel.status = 'starting'
  state.tunnel.provider = provider
  state.tunnel.url = undefined
  state.tunnel.error = undefined
  state.tunnel.startedAt = Date.now()

  let child
  try {
    child = spawn(command, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
  } catch (error) {
    state.tunnel.status = 'failed'
    state.tunnel.error = `could not run ${binary}: ${messageOf(error)}`
    return
  }
  state.tunnel.pid = child.pid

  let settled = false
  const finish = (status, error) => {
    if (settled) return
    settled = true
    state.tunnel.status = status
    if (error !== undefined) state.tunnel.error = error
    clearTimeout(timer)
  }

  const timer = setTimeout(() => {
    // No URL after the window: report it rather than waiting forever, but
    // leave the child running — it may still publish, and the status route
    // keeps reading its output.
    if (state.tunnel.url === undefined) {
      finish('failed', `no public URL from ${binary} within ${TUNNEL_START_TIMEOUT_MS / 1000}s`)
    }
  }, TUNNEL_START_TIMEOUT_MS)
  timer.unref?.()

  // ngrok explains a failed start on both streams — with `--log stdout` the
  // JSON records go to stdout and a short human summary to stderr, and both
  // carry the error code. Collecting only one of them loses the reason half the
  // time, so both are kept.
  let outputTail = ''
  const collect = (chunk) => {
    outputTail = (outputTail + String(chunk)).slice(-4000)
  }

  const readLine = (chunk) => {
    // The URL is matched anywhere in the chunk rather than only at the start
    // of a line: a JSON log record carries it mid-string, and ngrok can emit
    // several records in one chunk.
    const matches = String(chunk).match(TUNNEL_URL_PATTERNS[provider])
    const url = matches === null ? undefined : matches[matches.length - 1]
    if (url === undefined || url === state.tunnel.url) return
    state.tunnel.url = url
    finish('running')
    logInfo(ctx, `tunnel up at ${url}`)
  }

  child.stdout?.on('data', (chunk) => {
    collect(chunk)
    readLine(chunk)
  })
  child.stderr?.on('data', (chunk) => {
    collect(chunk)
    readLine(chunk)
  })

  child.on('error', (error) => {
    finish('failed', `could not run ${binary}: ${messageOf(error)}`)
    logWarn(ctx, `tunnel ${provider} failed: ${messageOf(error)}`)
  })
  child.on('exit', (code) => {
    if (state.tunnel.child !== child) return
    state.tunnel.child = undefined
    state.tunnel.pid = undefined
    // An exit before the URL arrived is a failure the page should show; one
    // after it is just the tunnel being taken down.
    if (state.tunnel.url === undefined) {
      finish('failed', explainTunnelExit(provider, binary, code, outputTail))
    } else state.tunnel.status = 'stopped'
  })

  state.tunnel.child = child
}

/**
 * Turn a tunnel's exit into a message the page can act on.
 *
 * The plain `exited with code 1` is technically true and completely useless:
 * ngrok had already printed the reason and the two URLs that fix it, and the
 * old code dropped all of it on the floor. The message is kept short and the
 * links travel separately, so the page can render them as links rather than
 * making the user copy a URL out of a sentence.
 */
function explainTunnelExit(provider, binary, code, stderr) {
  if (provider === 'ngrok' && stderr.includes(NGROK_NEEDS_CREDENTIAL)) {
    return (
      'ngrok needs an account and an authtoken before it can open a tunnel. ' +
      `Run \`ngrok config add-authtoken <token>\` with the token from ${NGROK_TOKEN_URL}, ` +
      'then start the tunnel again.'
    )
  }
  // Any other provider failure keeps whatever the binary actually said, minus
  // the log noise, so the real reason is not replaced by a generic one.
  const detail = lastMeaningfulLine(stderr)
  return detail === undefined ? `${binary} exited with code ${code}` : `${binary} exited with code ${code}: ${detail}`
}

/**
 * The most useful line of a provider's stderr.
 *
 * ngrok's JSON log puts the reason in an `err` field and repeats it across
 * several records; cloudflared writes plain text. Preferring an `err` value
 * picks the reason over the surrounding bookkeeping.
 */
function lastMeaningfulLine(text) {
  const lines = String(text)
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line !== '')
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index]
    const json = /"err":"((?:[^"\\]|\\.)*)"/.exec(line)
    if (json !== null) return unescapeJsonString(json[1]).split(/\r?\n/)[0].slice(0, 300)
    if (/^ERROR\b|^\s*err:|error/i.test(line)) return line.slice(0, 300)
  }
  return undefined
}

function unescapeJsonString(value) {
  try {
    return JSON.parse(`"${value}"`)
  } catch {
    return value
  }
}

function stopTunnel(ctx, state) {
  const child = state.tunnel.child
  state.tunnel.child = undefined
  state.tunnel.pid = undefined
  state.tunnel.url = undefined
  if (child === undefined) {
    if (state.tunnel.status === 'running') state.tunnel.status = 'stopped'
    return
  }
  try {
    child.kill()
  } catch (error) {
    logWarn(ctx, `could not stop the tunnel: ${messageOf(error)}`)
  }
  state.tunnel.status = 'stopped'
}

/** `{ action: "start" | "stop", provider? }` from the page. */
async function applyTunnel(ctx, state, req, res, bodyLimit) {
  let body
  try {
    body = await readBody(req, bodyLimit)
  } catch (error) {
    sendJson(res, 400, { error: messageOf(error) })
    return
  }
  const action = body.action
  if (action !== 'start' && action !== 'stop') {
    sendJson(res, 400, {
      error: 'unknown-action',
      message: 'expected {"action":"start"} or {"action":"stop"}',
    })
    return
  }
  if (action === 'stop') {
    stopTunnel(ctx, state)
    sendJson(res, 200, tunnelPayload(state))
    return
  }
  if (typeof body.provider === 'string' && TUNNEL_PROVIDERS.has(body.provider.trim())) {
    state.tunnelConfig.provider = body.provider.trim()
  }
  startTunnel(ctx, state)
  sendJson(res, 200, tunnelPayload(state))
}

/**
 * The tunnel block both the status document and the control route publish.
 *
 * One function rather than two literals: they were duplicated, and the copy in
 * the status document is the one the page actually reads, so a field added to
 * only one of them would have been invisible exactly where it mattered.
 */
function tunnelState(state) {
  return {
    status: state.tunnel.status,
    provider: state.tunnel.provider ?? null,
    url: state.tunnel.url ?? null,
    error: state.tunnel.error ?? null,
    pid: state.tunnel.pid ?? null,
    autostart: state.tunnelConfig.autostart,
    // Set only when the failure was "no credential": the page then offers the
    // signup and token pages as buttons instead of leaving the user to read
    // two URLs out of an error string.
    needsCredential: state.tunnel.error !== undefined && state.tunnel.error.includes(NGROK_TOKEN_URL),
    signupUrl: NGROK_SIGNUP_URL,
    tokenUrl: NGROK_TOKEN_URL,
  }
}

function tunnelPayload(state) {
  return { tunnel: tunnelState(state) }
}

/* --------------------------------------------------------------- status */

/**
 * The address an external client should use. A hostname configured for the
 * profile is authoritative; a supervised tunnel's published URL fills the gap
 * only while it is up, so the page never advertises a dead endpoint as the
 * primary one.
 */
function baseUrlOf(state) {
  if (state.publicBaseUrl !== undefined) return state.publicBaseUrl
  if (state.tunnel.url !== undefined) return `${state.tunnel.url.replace(/\/+$/, '')}${API_PREFIX}`
  return state.listenPort === undefined
    ? null
    : `http://${LISTEN_HOST}:${state.listenPort}${API_PREFIX}`
}

/** The loopback address, always, for clients that are on this machine. */
function localBaseUrlOf(state) {
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
    localBaseUrl: localBaseUrlOf(state),
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
    aliases: aliasEntries(state),
    // Which targets are sitting out right now, and the reason each was benched.
    // Derived from the in-memory cooldown map on every read, so the page never
    // shows a target as unavailable after its cooldown has expired.
    failover: failoverState(state),
    tunnel: tunnelState(state),
    providers: ctx.llm.listProviders().map((provider) => ({
      id: provider.id,
      name: typeof provider.name === 'string' ? provider.name : provider.id,
      models: counts.get(provider.id) ?? 0,
    })),
    requests: state.requests,
    failures: state.failures,
    // Totals for this process only, accumulated in `recordRequest`. Not
    // persisted: they reset with the gateway, and the page labels them with
    // `startedAt` so "since 09:41" is read correctly.
    usageTotals: { ...state.usageTotals },
    bytes: { ...state.bytes },
    // Newest first. This is what turns "it dropped again" into a cause: the
    // model, how many attempts it took, how long the first byte took, and the
    // adapter's own code when it ended badly.
    recent: state.recent.map((entry) => ({ ...entry })),
    startedAt: state.startedAt,
    catalogAt: state.catalog.at,
  }
}

/**
 * The live cooldown table, as the page needs it.
 *
 * Expired entries are dropped on read rather than on a timer: a target becomes
 * usable again the moment its cooldown passes, and nothing has to run in the
 * background to make that true.
 */
function failoverState(state) {
  const now = Date.now()
  const cooling = []
  for (const [target, until] of state.failover) {
    if (now >= until) {
      state.failover.delete(target)
      state.failoverReason.delete(target)
      continue
    }
    const reason = state.failoverReason.get(target)
    cooling.push({
      target,
      until,
      remainingMs: until - now,
      code: reason?.code,
      message: reason?.message,
    })
  }
  cooling.sort((a, b) => a.until - b.until)
  return { cooldownMs: FAILOVER_COOLDOWN_MS, cooling }
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
      // The exact byte count, for callers that meter traffic. Recorded here
      // because this is the only place the body is fully seen.
      req.bodyBytes = size
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

/** Bytes `readBody` measured, or 0 when the body was never read. */
function byteLengthOf(req) {
  return Number.isFinite(req.bodyBytes) ? req.bodyBytes : 0
}

/** Fold the request body's bytes into the inbound total, at most once. */
function chargeInbound(state, req) {
  const bytes = byteLengthOf(req)
  if (bytes <= 0) return
  state.bytes.in += bytes
}

/**
 * Count the bytes a response actually sends, and fold the total into `state`
 * once the response is done.
 *
 * Every OpenAI-surface answer leaves through `res.write` (SSE frames) or
 * `res.end(payload)` (a JSON body), so wrapping both covers streaming and
 * blocking without threading a counter through each sender. Headers are not
 * counted: they are a fixed cost the caller cannot act on.
 *
 * The fold is idempotent and hangs off both `finish` and `close`, so an
 * aborted stream still reports the bytes it managed to send, and a route that
 * returns early — a 400 for a malformed body, a 404 for an unknown model —
 * cannot silently skip the counter the way a `finally` block would.
 */
function meterWrites(res, state) {
  if (res.__gwMetered === true) return
  res.__gwMetered = true
  res.__gwOutBytes = 0
  const write = res.write.bind(res)
  const end = res.end.bind(res)
  res.write = (chunk, ...rest) => {
    if (typeof chunk === 'string') res.__gwOutBytes += Buffer.byteLength(chunk)
    else if (Buffer.isBuffer(chunk)) res.__gwOutBytes += chunk.length
    return write(chunk, ...rest)
  }
  res.end = (chunk, ...rest) => {
    if (typeof chunk === 'string') res.__gwOutBytes += Buffer.byteLength(chunk)
    else if (Buffer.isBuffer(chunk)) res.__gwOutBytes += chunk.length
    return end(chunk, ...rest)
  }
  const fold = () => {
    if (res.__gwFolded === true) return
    res.__gwFolded = true
    state.bytes.out += res.__gwOutBytes
  }
  if (typeof res.once === 'function') {
    res.once('finish', fold)
    res.once('close', fold)
  }
}

/** Fold a metered response's total in now, for a caller that cannot wait. */
function foldOutBytes(res, state) {
  if (res.__gwMetered !== true || res.__gwFolded === true) return
  res.__gwFolded = true
  state.bytes.out += res.__gwOutBytes
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
