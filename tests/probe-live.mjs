/**
 * Live end-to-end probe against the running gateway through the ngrok tunnel.
 *
 * Reads the key from the settings file and the base URL from the host's own
 * status route, so nothing here is a remembered value: every number printed
 * comes from this run.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'

const HOME = process.env.DSH_HOME ?? join(homedir(), '.dsh')
const settings = JSON.parse(readFileSync(join(HOME, 'openai-gateway', 'settings.json'), 'utf8'))
const KEY = settings.apiKey
// The DSH web port changes between launches, so it is never a remembered
// constant: pass it as argv[2], or set DSH_WEB_URL, and fail loudly otherwise.
const GUI = process.argv[2] ?? process.env.DSH_WEB_URL
if (GUI === undefined) {
  console.error('usage: node tests/probe-live.mjs http://127.0.0.1:<dsh-web-port>')
  console.error('       (or set DSH_WEB_URL; the port is in the DSH Web GUI address)')
  process.exit(2)
}

const status = await (await fetch(`${GUI}/plugins/dsh-openai-gateway/status`)).json()
const BASE = status.baseUrl
console.log(`baseUrl:      ${BASE}`)
console.log(`localBaseUrl: ${status.localBaseUrl}`)
console.log(`tunnel:       ${status.tunnel.status} ${status.tunnel.url ?? ''}`)
console.log(`aliases:      ${JSON.stringify(status.aliases)}`)
console.log('')

const headers = {
  authorization: `Bearer ${KEY}`,
  'user-agent': 'cursor/0.48.9',
  'content-type': 'application/json',
}

/* ------------------------------------------------------ 1. streaming alias */

{
  const response = await fetch(`${BASE}/chat/completions`, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      model: 'gpt-4o',
      stream: true,
      stream_options: { include_usage: true },
      messages: [{ role: 'user', content: 'count from 1 to 5, digits only' }],
      max_tokens: 64,
    }),
  })
  const text = await response.text()
  const frames = (text.match(/data: /g) ?? []).length
  const assembled = [...text.matchAll(/"content":"((?:[^"\\]|\\.)*)"/g)]
    .map((m) => m[1].replace(/\\n/g, '\n').replace(/\\"/g, '"'))
    .join('')
  console.log(`stream  status=${response.status} frames=${frames} hasDONE=${text.includes('[DONE]')} hasUsage=${text.includes('"usage"')}`)
  console.log(`        assembled=${JSON.stringify(assembled)}`)
}

/* --------------------------------------------- 2. a bare id that collides */

for (const model of ['deepseek-v4.1-flash', 'qwen3.8-max', 'no-such-model-at-all']) {
  const response = await fetch(`${BASE}/chat/completions`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ model, messages: [{ role: 'user', content: 'hi' }], max_tokens: 16 }),
  })
  const body = await response.text()
  let note = body
  try {
    const parsed = JSON.parse(body)
    note = parsed?.error?.code ?? parsed?.choices?.[0]?.message?.content ?? body
  } catch {}
  console.log(`model ${model.padEnd(24)} -> ${response.status} ${String(note).slice(0, 90)}`)
}
