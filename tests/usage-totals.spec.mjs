/**
 * The dashboard's two live counters.
 *
 * The page shows a token total and a traffic total. Both come from the status
 * document, and both describe *this process* — they reset when the gateway
 * restarts, which is why the tile is labelled "since <startedAt>".
 *
 * What is pinned here:
 *   1. a request that reports usage adds to the token totals;
 *   2. a request that reports no usage adds nothing (no zero, no phantom call);
 *   3. the totals survive across requests and match the sum of the rows;
 *   4. bytes in are the request bodies, bytes out are the response bodies;
 *   5. a rejected request still counts its inbound bytes, because the client
 *      really did send them.
 *
 * Run:  node tests/usage-totals.spec.mjs
 *       GATEWAY_ENTRY=<file-or-url> node tests/usage-totals.spec.mjs
 */
import { strict as assert } from 'node:assert'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import http from 'node:http'

process.env.DSH_HOME = mkdtempSync(join(tmpdir(), 'gateway-totals-'))

const configured = process.env.GATEWAY_ENTRY
const entry =
  configured === undefined
    ? new URL('../index.js', import.meta.url).href
    : /^[a-z]+:\/\//i.test(configured)
      ? configured
      : pathToFileURL(configured).href
const { apply } = await import(entry)

const KEY = 'sk-dsh-spec-totals-0123456789'

/**
 * Mount one gateway against a scripted adapter. `attempts` is a list of
 * chunk lists: each HTTP request consumes the next one, so several requests
 * through the same instance exercise accumulation.
 */
let nextPort = 19040
function mount(config, attempts) {
  const port = nextPort++
  const webRoutes = new Map()
  let index = 0
  const stream = async function* () {
    const chunks = attempts[Math.min(index, attempts.length - 1)]
    index += 1
    for (const chunk of chunks) yield chunk
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
  const ctx = {
    llm: {
      listProviders: () => [{ id: 'fake', name: 'fake' }],
      listModels: async () => [{ id: 'm1', name: 'm1' }],
      prepareCall: async () => ({ config: {}, stream }),
    },
    get: (key) =>
      key === 'webServer'
        ? { register: (route) => { webRoutes.set(route.path, route.handler); return () => {} } }
        : undefined,
    effect: () => {},
    on: () => () => {},
    logger: { warn: () => {}, error: () => {}, info: () => {} },
  }
  apply(ctx, { enabled: true, port, apiKey: KEY, ...config })
  return { port, webRoutes }
}

function post(port, body) {
  const payload = JSON.stringify(body)
  return new Promise((resolve, reject) => {
    const request = http.request(
      {
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
      },
      (response) => {
        let text = ''
        response.setEncoding('utf8')
        response.on('data', (chunk) => { text += chunk })
        response.on('end', () =>
          resolve({ status: response.statusCode, headers: response.headers, text, sentBytes: Buffer.byteLength(payload) }),
        )
      },
    )
    request.on('error', reject)
    request.on('timeout', () => request.destroy(new Error('client timeout')))
    request.write(payload)
    request.end()
  })
}

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

const usage = (input, output, extra) => ({
  type: 'usage',
  usage: { inputTokens: input, outputTokens: output, totalTokens: input + output, ...extra },
})
const text = (value) => ({ type: 'text-delta', text: value })

/* ---- 1. a measured request adds to the totals ---- */

await check('a request reporting usage adds to the token totals', async () => {
  const app = mount({}, [[text('hi'), usage(120, 30)]])
  const res = await post(app.port, { model: 'fake/m1', messages: [{ role: 'user', content: 'hi' }] })
  assert.equal(res.status, 200, `expected 200, got ${res.status}: ${res.text.slice(0, 200)}`)

  const status = await readStatus(app.webRoutes)
  assert.equal(typeof status.usageTotals, 'object', 'the status document has no usageTotals')
  assert.equal(status.usageTotals.inputTokens, 120, 'inbound tokens not accumulated')
  assert.equal(status.usageTotals.outputTokens, 30, 'outbound tokens not accumulated')
  assert.equal(status.usageTotals.totalTokens, 150, 'the total is not the upstream total')
  assert.equal(status.usageTotals.calls, 1, 'the measured-call count is wrong')
})

/* ---- 2. an unmeasured request adds nothing ---- */

await check('a request without usage adds no tokens and no call', async () => {
  const app = mount({}, [[text('hi')]])
  const res = await post(app.port, { model: 'fake/m1', messages: [{ role: 'user', content: 'hi' }] })
  assert.equal(res.status, 200, `expected 200, got ${res.status}`)

  const status = await readStatus(app.webRoutes)
  assert.equal(status.usageTotals.totalTokens, 0, 'an unmeasured request must not add tokens')
  assert.equal(status.usageTotals.calls, 0, 'an unmeasured request must not count as a measured call')
  /* The request itself still counted: "7 requests, 0 measured" is the honest
   * reading, and it is what tells an operator the adapter reports no usage. */
  assert.equal(status.requests, 1, 'the request counter should still move')
})

/* ---- 3. totals accumulate across requests ---- */

await check('totals accumulate across requests and match the recent rows', async () => {
  const app = mount({}, [
    [text('a'), usage(100, 10)],
    [text('b'), usage(200, 20)],
    [text('c')],
    [text('d'), usage(300, 30, { reasoningTokens: 7, cacheReadTokens: 40 })],
  ])
  for (const model of ['fake/m1', 'fake/m1', 'fake/m1', 'fake/m1']) {
    await post(app.port, { model, messages: [{ role: 'user', content: 'x' }] })
  }

  const status = await readStatus(app.webRoutes)
  assert.equal(status.requests, 4, 'all four requests should be counted')
  assert.equal(status.usageTotals.calls, 3, 'only three of the four reported usage')
  assert.equal(status.usageTotals.inputTokens, 600, `expected 600 input, got ${status.usageTotals.inputTokens}`)
  assert.equal(status.usageTotals.outputTokens, 60, `expected 60 output, got ${status.usageTotals.outputTokens}`)
  assert.equal(status.usageTotals.totalTokens, 660, `expected 660 total, got ${status.usageTotals.totalTokens}`)
  assert.equal(status.usageTotals.reasoningTokens, 7, 'reasoning tokens are not accumulated')
  assert.equal(status.usageTotals.cacheReadTokens, 40, 'cache-read tokens are not accumulated')

  /* Cross-check against the rows the page renders: the tile and the table must
   * not disagree, or one of them is lying to the operator. */
  const summed = status.recent
    .filter((row) => row.usage !== undefined)
    .reduce((total, row) => total + row.usage.inputTokens, 0)
  assert.equal(summed, status.usageTotals.inputTokens, 'the tile disagrees with the recent rows')
})

/* ---- 4. traffic is measured in both directions ---- */

await check('bytes in and out are measured on the OpenAI surface', async () => {
  const app = mount({}, [[text('hello'), usage(10, 5)]])
  const res = await post(app.port, { model: 'fake/m1', messages: [{ role: 'user', content: 'hi' }] })

  const status = await readStatus(app.webRoutes)
  assert.equal(typeof status.bytes, 'object', 'the status document has no bytes')
  assert.ok(status.bytes.in > 0, `inbound bytes should be measured, got ${status.bytes.in}`)
  assert.ok(status.bytes.out > 0, `outbound bytes should be measured, got ${status.bytes.out}`)
  /* The inbound figure is the body the client actually sent, not an estimate. */
  assert.equal(status.bytes.in, res.sentBytes, `expected ${res.sentBytes} inbound bytes, got ${status.bytes.in}`)
  /* The outbound figure cannot exceed what the socket carried, and must be at
   * least the answer text — a wrapper that never fired would report 0. */
  assert.ok(status.bytes.out >= 'hello'.length, `outbound bytes (${status.bytes.out}) are below the answer length`)
  assert.ok(
    status.bytes.out <= Buffer.byteLength(res.text),
    `outbound bytes (${status.bytes.out}) exceed the bytes received (${Buffer.byteLength(res.text)})`,
  )
})

/* ---- 5. a rejected request still counts inbound bytes ---- */

await check('a rejected request counts its inbound bytes but no tokens', async () => {
  const app = mount({}, [[text('unused')]])
  const res = await post(app.port, { model: 'nope/missing', messages: [{ role: 'user', content: 'hi' }] })
  assert.equal(res.status, 404, `expected 404 for an unknown model, got ${res.status}`)

  const status = await readStatus(app.webRoutes)
  assert.equal(status.bytes.in, res.sentBytes, 'the client really sent those bytes')
  /* The 404 body did leave the socket, so it is traffic — just not an answer.
   * What must stay at zero is the token count: nothing reached a model. */
  assert.equal(
    status.bytes.out,
    Buffer.byteLength(res.text),
    `the rejection body is real traffic: expected ${Buffer.byteLength(res.text)} bytes, got ${status.bytes.out}`,
  )
  assert.equal(status.usageTotals.calls, 0, 'a rejected request has no usage')
  assert.equal(status.usageTotals.totalTokens, 0, 'a rejected request must not add tokens')
  assert.equal(status.requests, 1, 'a rejected request is still a request')
})

/* ---- 5b. a malformed body is charged too ---- */

await check('a malformed body is charged before it is refused', async () => {
  const app = mount({}, [[text('unused')]])
  const res = await post(app.port, { model: 'fake/m1', messages: 'not-an-array' })
  assert.ok(res.status >= 400, `a malformed request should be refused, got ${res.status}`)

  const status = await readStatus(app.webRoutes)
  assert.equal(status.bytes.in, res.sentBytes, 'the bytes arrived even though the body was refused')
})

/* ---- 6. a disabled gateway reports the shape, all zero ---- */

await check('a freshly mounted gateway reports zeroed totals', async () => {
  const app = mount({}, [[text('hi')]])
  const status = await readStatus(app.webRoutes)
  assert.equal(status.usageTotals.totalTokens, 0, 'a fresh gateway must start at zero')
  assert.equal(status.usageTotals.calls, 0, 'a fresh gateway must start at zero')
  assert.equal(status.bytes.in, 0, 'a fresh gateway must start at zero')
  assert.equal(status.bytes.out, 0, 'a fresh gateway must start at zero')
  /* `startedAt` is what the page labels the totals with. */
  assert.ok(Number.isFinite(status.startedAt), 'startedAt is missing, so the page cannot date the totals')
})

const failed = results.filter(([ok]) => !ok)
for (const [ok, name] of results) console.log(`${ok ? 'ok  ' : 'FAIL'}  ${name}`)
console.log(`\n${results.length - failed.length}/${results.length} checks passed`)
process.exit(failed.length === 0 ? 0 : 1)
