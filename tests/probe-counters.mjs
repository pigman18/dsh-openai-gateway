/**
 * Live proof, not a unit test: boot the real `index.js` in this process, drive
 * one real HTTP request through it, and print the status document the page
 * reads. The point is to see `usageTotals` and `bytes` carry real numbers,
 * produced by the shipped code rather than by a test double.
 *
 * Run:  node tests/probe-counters.mjs
 */
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import http from 'node:http'

process.env.DSH_HOME = mkdtempSync(join(tmpdir(), 'gateway-probe-'))

const { apply } = await import(new URL('../index.js', import.meta.url).href)

const KEY = 'sk-dsh-probe-0123456789'
const PORT = 19120
const webRoutes = new Map()

const stream = async function* () {
  yield { type: 'reasoning-delta', text: 'thinking about it' }
  yield { type: 'text-delta', text: 'the gateway counts what it carries' }
  yield {
    type: 'usage',
    usage: { inputTokens: 1182, outputTokens: 74, totalTokens: 1256, reasoningTokens: 21, cacheReadTokens: 960 },
  }
  yield { type: 'finish', reason: { kind: 'stop' } }
}

apply(
  {
    llm: {
      listProviders: () => [
        { id: 'probe', name: 'probe' },
        { id: 'other', name: 'other' },
      ],
      listModels: async () => [{ id: 'm1', name: 'm1' }],
      prepareCall: async () => ({ config: {}, stream }),
    },
    get: (key) =>
      key === 'webServer'
        ? { register: (route) => { webRoutes.set(route.path, route.handler); return () => {} } }
        : undefined,
    effect: () => {},
    on: () => () => {},
    logger: { info: () => {}, warn: () => {}, error: () => {} },
  },
  { enabled: true, port: PORT, apiKey: KEY },
)

function post(body) {
  const payload = JSON.stringify(body)
  return new Promise((resolve, reject) => {
    const request = http.request(
      {
        host: '127.0.0.1',
        port: PORT,
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
        response.on('end', () => resolve({ status: response.statusCode, text, sent: Buffer.byteLength(payload) }))
      },
    )
    request.on('error', reject)
    request.write(payload)
    request.end()
  })
}

function status() {
  return new Promise((resolve, reject) => {
    const handler = webRoutes.get('/plugins/dsh-openai-gateway/status')
    if (handler === undefined) { reject(new Error('status route not mounted')); return }
    const res = {
      headersSent: false,
      writeHead(code, headers) { this.headersSent = true; this.code = code; this.headers = headers },
      end(payload) { resolve(JSON.parse(String(payload ?? '{}'))) },
      destroy() { reject(new Error('destroyed')) },
    }
    handler({ method: 'GET', headers: { host: '127.0.0.1' }, url: '/plugins/dsh-openai-gateway/status' }, res)
  })
}

/* One streamed answer, then one refusal: the counters must survive both. */
const answered = await post({ model: 'probe/m1', stream: true, messages: [{ role: 'user', content: 'count this' }] })
const refused = await post({ model: 'nope/missing', messages: [{ role: 'user', content: 'x' }] })

const doc = await status()
console.log(`answered status ${answered.status}, ${answered.sent} bytes sent, ${answered.text.length} chars back`)
console.log(`refused  status ${refused.status}`)
console.log(`status keys: ${Object.keys(doc).join(', ')}`)
console.log(`requests=${doc.requests} failures=${doc.failures} models=${doc.modelCount} providers=${doc.providers.length}`)
console.log(`usageTotals=${JSON.stringify(doc.usageTotals)}`)
console.log(`bytes=${JSON.stringify(doc.bytes)}`)
console.log(`recent[0].usage=${JSON.stringify(doc.recent[0]?.usage)}`)

const ok =
  doc.usageTotals?.calls === 1 &&
  doc.usageTotals?.inputTokens === 1182 &&
  doc.usageTotals?.outputTokens === 74 &&
  doc.bytes?.in === answered.sent + refused.sent &&
  doc.bytes?.out > 0
console.log(`\n${ok ? 'COUNTERS LIVE' : 'COUNTERS BROKEN'}`)
process.exit(ok ? 0 : 1)
