/**
 * Regression: the gateway must be as patient as the host it forwards to.
 *
 * The host's agent loop retries RATE_LIMIT / SERVER / TIMEOUT / TRANSPORT /
 * EMPTY_RESPONSE up to five times with exponential backoff, and honours the
 * reset point the upstream names. The gateway used to forward the very first
 * failure to its caller, so a single 14003 ("model busy") or 6004 ("usage
 * exceeds frequency limit") ended an HTTP request that DSH itself would have
 * waited out and answered.
 *
 * These checks pin the four things that difference produced:
 *   1. a transient failure is retried instead of surfaced;
 *   2. an exhausted retry budget answers 429 + Retry-After, not 502;
 *   3. a non-retryable failure is not retried at all;
 *   4. a failure after the first byte still ends the stream with [DONE], so the
 *      caller reads "the upstream failed" instead of "the connection dropped".
 *
 * Run:  node tests/resilience.spec.mjs
 *       GATEWAY_ENTRY=<file-or-url> node tests/resilience.spec.mjs   # older build
 */
import { strict as assert } from 'node:assert'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { EventEmitter } from 'node:events'
import http from 'node:http'

process.env.DSH_HOME = mkdtempSync(join(tmpdir(), 'gateway-resilience-'))

const configured = process.env.GATEWAY_ENTRY
const entry = configured === undefined
  ? new URL('../index.js', import.meta.url).href
  : /^[a-z]+:\/\//i.test(configured) ? configured : pathToFileURL(configured).href
const { apply } = await import(entry)

/** One scripted attempt: either throws, fails, or yields these chunks. */
function scripted(attempts) {
  let index = 0
  return async function* stream() {
    const attempt = attempts[Math.min(index, attempts.length - 1)]
    index += 1
    if (attempt.throw !== undefined) throw attempt.throw
    for (const chunk of attempt.chunks ?? []) {
      if (chunk.delayMs !== undefined) await settle(chunk.delayMs)
      yield chunk.type === undefined ? chunk : chunk
    }
    if (attempt.failure !== undefined) {
      yield { type: 'finish', reason: { kind: 'error', failure: attempt.failure } }
      return
    }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}

let nextPort = 18990
function mount(config, attempts) {
  const port = nextPort++
  const webRoutes = new Map()
  let stream = scripted(attempts)
  const ctx = {
    llm: {
      listProviders: () => [{ id: 'fake', name: 'fake' }],
      listModels: async () => [{ id: 'm1', name: 'm1' }],
      prepareCall: async () => ({ config: {}, stream }),
    },
    // The chat surface lives on the gateway's own listener; the web server only
    // carries the page's control routes (status/settings/key).
    get: (key) => (key === 'webServer' ? { register: (route) => { webRoutes.set(route.path, route.handler); return () => {} } } : undefined),
    effect: () => {},
    on: () => () => {},
    logger: { warn: () => {}, error: () => {}, info: () => {} },
  }
  apply(ctx, { enabled: true, port, apiKey: KEY, ...config })
  return { port, webRoutes }
}

const KEY = 'sk-dsh-spec-0123456789'

/** POST to the gateway's own listener — the surface an external client uses. */
function post(port, body) {
  const payload = JSON.stringify(body)
  return new Promise((resolve, reject) => {
    const started = Date.now()
    const request = http.request({
      host: '127.0.0.1',
      port,
      path: '/v1/chat/completions',
      method: 'POST',
      timeout: 30_000,
      headers: {
        'content-type': 'application/json',
        'content-length': Buffer.byteLength(payload),
        authorization: `Bearer ${KEY}`,
      },
    }, (response) => {
      let text = ''
      response.setEncoding('utf8')
      response.on('data', (chunk) => { text += chunk })
      response.on('end', () => resolve({
        status: response.statusCode,
        headers: response.headers,
        text,
        elapsedMs: Date.now() - started,
      }))
    })
    request.on('error', reject)
    request.on('timeout', () => request.destroy(new Error('client timeout')))
    request.write(payload)
    request.end()
  })
}

const settle = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/** Drive the page's own read of the status document. */
function readStatus(webRoutes) {
  return new Promise((resolve, reject) => {
    const handler = webRoutes.get('/plugins/dsh-openai-gateway/status')
    if (handler === undefined) { reject(new Error('status route never mounted')); return }
    const res = {
      headersSent: false,
      writeHead(code, headers) { this.headersSent = true; this.code = code; this.headers = headers },
      end(payload) { resolve(JSON.parse(String(payload ?? '{}'))) },
      destroy() { reject(new Error('response destroyed')) },
    }
    handler({ method: 'GET', headers: { host: '127.0.0.1' }, url: '/plugins/dsh-openai-gateway/status' }, res)
  })
}

const results = []
async function check(name, run) {
  try { await run(); results.push([true, name]) }
  catch (error) { results.push([false, `${name} — ${error.message}`]) }
}

const fast = { retryInitialDelayMs: 5, retryMaxDelayMs: 20 }
const body = { model: 'fake/m1', messages: [{ role: 'user', content: 'hi' }], stream: true }

// ---- 1. a transient failure is retried, then answered ----
let used = 0
const transient = {
  llm: null,
  attempts: [
    { failure: { code: 'RATE_LIMIT', message: '6004 usage exceeds frequency limit' } },
    { failure: { code: 'SERVER', message: '502 upstream blip' } },
    { chunks: [{ type: 'text-delta', text: 'hello' }, { type: 'usage', usage: { inputTokens: 1, outputTokens: 1 } }] },
  ],
}
await check('a transient failure is retried and then answered', async () => {
  const app = mount({ ...fast, retryMaxRetries: 5 }, transient.attempts)
  const res = await post(app.port, body)
  const text = res.text
  assert.equal(res.status, 200, `expected a streamed answer, got status ${res.status}: ${text.slice(0, 200)}`)
  assert.ok(text.includes('hello'), 'the answer never reached the caller')
  assert.ok(text.includes('[DONE]'), 'the stream did not terminate with [DONE]')
  assert.ok(transient.attempts.length === 3, 'sanity')
})

// ---- 2. an exhausted budget answers 429 + Retry-After ----
await check('an exhausted retry budget answers 429 with Retry-After', async () => {
  const attempts = [{ failure: { code: 'RATE_LIMIT', message: '6004', providerRetryAfterMs: 3000 } }]
  const app = mount({ ...fast, retryMaxRetries: 0 }, attempts)
  const res = await post(app.port, body)
  assert.equal(res.status, 429, `expected 429, got ${res.status}`)
  assert.equal(res.headers['retry-after'], '3', `expected retry-after: 3, got ${res.headers['retry-after']}`)
  const payload = JSON.parse(res.text)
  assert.equal(payload.error.type, 'rate_limit_error')
  assert.equal(payload.error.code, 'RATE_LIMIT')
})

// ---- 3. a non-retryable failure is not retried ----
await check('a non-retryable failure is answered immediately', async () => {
  const attempts = [{ failure: { code: 'INVALID_REQUEST', message: 'bad body' } }]
  const app = mount({ ...fast, retryMaxRetries: 5 }, attempts)
  const res = await post(app.port, body)
  assert.equal(res.status, 400, `expected 400, got ${res.status}`)
})

// ---- 4. a failure after the first byte still terminates the stream ----
await check('a mid-stream failure ends the stream with [DONE]', async () => {
  const attempts = [{
    chunks: [{ type: 'text-delta', text: 'partial' }],
    failure: { code: 'RATE_LIMIT', message: '6004 mid-stream' },
  }]
  const app = mount({ ...fast, retryMaxRetries: 5 }, attempts)
  const res = await post(app.port, body)
  const text = res.text
  assert.equal(res.status, 200, `expected a committed stream, got ${res.status}`)
  assert.ok(text.includes('partial'), 'the partial answer was not forwarded')
  assert.ok(text.includes('"error"'), 'the failure was not reported in-stream')
  assert.ok(text.endsWith('[DONE]\n\n'), 'the stream did not end with [DONE] — callers read this as a dropped connection')
})

// ---- 5. a quiet stream keeps the connection warm ----
await check('a quiet stream emits keep-alive comments', async () => {
  const attempts = [{
    chunks: [{ type: 'text-delta', text: 'late', delayMs: 350 }],
  }]
  const app = mount({ ...fast, silentFlushMs: 80, keepAliveMs: 80 }, attempts)
  const res = await post(app.port, body)
  const text = res.text
  assert.ok(text.includes(': keep-alive'), `no keep-alive comment was written; body was: ${text.slice(0, 200)}`)
  assert.ok(text.includes('late'), 'the answer never arrived')
  assert.ok(text.includes('[DONE]'), 'the stream did not terminate with [DONE]')
})

// ---- 6. the status document explains the last requests ----
await check('the status document records what each request did', async () => {
  const ok = mount({ ...fast }, [{ chunks: [{ type: 'text-delta', text: 'fine' }] }])
  await post(ok.port, body)
  const bad = mount({ ...fast, retryMaxRetries: 0 }, [{ failure: { code: 'RATE_LIMIT', message: '6004 mid-stream' }, chunks: [{ type: 'text-delta', text: 'x' }] }])
  await post(bad.port, body)
  const payload = await readStatus(bad.webRoutes)
  assert.ok(Array.isArray(payload.recent), 'status carries no recent list')
  const last = payload.recent[0]
  assert.equal(last.model, 'fake/m1')
  assert.equal(last.stream, true)
  assert.equal(last.outcome, 'error', `expected the failed request to be recorded, got ${JSON.stringify(last)}`)
  assert.equal(last.code, 'RATE_LIMIT')
  assert.ok(typeof last.ms === 'number' && last.ms >= 0, 'no duration recorded')
  assert.ok(typeof last.firstByteMs === 'number', 'no first-byte time recorded')

  const good = await readStatus(ok.webRoutes)
  const done = good.recent[0]
  assert.equal(done.outcome, 'ok', 'a successful request was not recorded as ok')
  assert.ok(typeof done.textBytes === 'number' && done.textBytes > 0, `no text bytes recorded: ${JSON.stringify(done)}`)
  assert.ok(typeof done.reasoningBytes === 'number', 'no reasoning byte count recorded')
  assert.equal(done.finish, 'stop', `expected the finish kind to be recorded, got ${done.finish}`)
})


// ---- 7. reasoning without any reply is not a success ----
await check('a reply-less stop becomes an explicit EMPTY_RESPONSE', async () => {
  const attempts = [{
    chunks: [{ type: 'reasoning-delta', text: 'thinking hard…' }],
  }]
  const app = mount({ ...fast, retryMaxRetries: 5 }, attempts)
  const res = await post(app.port, body)
  const text = res.text
  assert.ok(text.includes('"EMPTY_RESPONSE"'), `the empty reply was not reported: ${text.slice(0, 240)}`)
  assert.ok(text.endsWith('[DONE]\n\n'), 'the stream did not end with [DONE]')
  const status = await readStatus(app.webRoutes)
  assert.equal(status.recent[0].outcome, 'error')
  assert.equal(status.recent[0].code, 'EMPTY_RESPONSE')
  assert.equal(status.recent[0].textBytes, 0)
  assert.ok(status.recent[0].reasoningBytes > 0, 'the reasoning that was sent should be recorded')
})

// ---- 8. an empty stop is retried while nothing has been written ----
await check('a reply-less stop with no output is retried', async () => {
  const attempts = [
    {},                                   // stop with nothing at all
    { chunks: [{ type: 'text-delta', text: 'answer' }] },
  ]
  const app = mount({ ...fast, retryMaxRetries: 5 }, attempts)
  const res = await post(app.port, body)
  assert.ok(res.text.includes('answer'), `the retry never produced the answer: ${res.text.slice(0, 200)}`)
  const status = await readStatus(app.webRoutes)
  assert.ok(status.recent[0].attempts >= 2, `expected at least two attempts, got ${status.recent[0].attempts}`)
  assert.equal(status.recent[0].outcome, 'ok')
})

// ---- 9. the request shape is recorded, not just its outcome ----
await check('the request shape is recorded', async () => {
  const app = mount({ ...fast }, [{ chunks: [{ type: 'text-delta', text: 'x' }] }])
  await post(app.port, { ...body, max_tokens: 4096, reasoning_effort: 'high' })
  const status = await readStatus(app.webRoutes)
  const last = status.recent[0]
  assert.equal(last.maxTokens, 4096, `maxTokens not recorded: ${JSON.stringify(last)}`)
  assert.equal(last.effort, 'high')
  assert.equal(last.tools, 0)
  assert.equal(last.roles, 'user')
})


// ---- 10. a request over the limit is refused with a reason ----
await check('an oversized request is refused as CONTEXT_WINDOW_EXCEEDED', async () => {
  const app = mount({ ...fast, maxInputTokens: 200 }, [{ chunks: [{ type: 'text-delta', text: 'x' }] }])
  const big = 'x'.repeat(4000)          // ~1333 tokens by the estimator, over the 200 limit
  const res = await post(app.port, { ...body, messages: [{ role: 'user', content: big }] })
  assert.equal(res.status, 413, `expected 413, got ${res.status}: ${res.text.slice(0, 160)}`)
  const payload = JSON.parse(res.text)
  assert.equal(payload.error.code, 'CONTEXT_WINDOW_EXCEEDED')
  assert.ok(/input tokens/.test(payload.error.message), 'the refusal does not say how big it was')
  const status = await readStatus(app.webRoutes)
  assert.equal(status.recent[0].code, 'CONTEXT_WINDOW_EXCEEDED')
  assert.ok(status.recent[0].inputTokensEst > 200, 'the estimate was not recorded')
})

// ---- 11. a request under the limit is untouched ----
await check('a request under the limit is not refused', async () => {
  const app = mount({ ...fast, maxInputTokens: 100_000 }, [{ chunks: [{ type: 'text-delta', text: 'ok' }] }])
  const res = await post(app.port, body)
  assert.equal(res.status, 200, `expected 200, got ${res.status}: ${res.text.slice(0, 160)}`)
  assert.ok(res.text.includes('ok'))
})

// ---- 12. maxMessages drops the oldest turns, keeping a user boundary ----
await check('maxMessages trims history at a user boundary', async () => {
  const app = mount({ ...fast, maxMessages: 3 }, [{ chunks: [{ type: 'text-delta', text: 'ok' }] }])
  const history = [
    { role: 'user', content: 'first' },
    { role: 'assistant', content: 'a1' },
    { role: 'user', content: 'second' },
    { role: 'assistant', content: 'a2' },
    { role: 'user', content: 'third' },
  ]
  const res = await post(app.port, { ...body, messages: history })
  assert.equal(res.status, 200, `expected 200, got ${res.status}: ${res.text.slice(0, 160)}`)
  const status = await readStatus(app.webRoutes)
  assert.ok(status.recent[0].truncatedMessages >= 2, `expected history to be trimmed, got ${JSON.stringify(status.recent[0])}`)
  assert.equal(status.recent[0].roles, 'user,assistant,user', `kept roles should start at a user turn: ${status.recent[0].roles}`)
})

for (const [ok, name] of results) console.log(`${ok ? 'ok  ' : 'FAIL'}  ${name}`)
const failed = results.filter(([ok]) => !ok).length
console.log(`\n${results.length - failed}/${results.length} checks passed`)
process.exit(failed === 0 ? 0 : 1)
