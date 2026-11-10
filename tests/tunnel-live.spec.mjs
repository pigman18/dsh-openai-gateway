/**
 * A live tunnel test: the plugin spawns the real binary against its own listener,
 * reads the public URL out of the process output, and that URL actually serves
 * the gateway.
 *
 * Opt-in only (`DSH_GW_TUNNEL=1`): it needs the binary on PATH and it spends the
 * machine's tunnel quota, so it must not run as part of `npm test`.
 *
 * `DSH_GW_TUNNEL_PROVIDER` picks `ngrok` (default) or `cloudflared`. ngrok's dev
 * domain is a single online endpoint per account, so a second ngrok cannot start
 * while the live gateway holds one; cloudflared's quick tunnel is a fresh host
 * every run and never collides.
 *
 * What this proves: the tunnel process is spawned by the plugin, its URL is
 * parsed from output, and the public URL answers `/v1` with the minted key and
 * refuses it without. What it does not prove: that some particular client's
 * network can reach that host.
 */
import assert from 'node:assert/strict'
import net from 'node:net'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { apply } from '../index.js'

const PROVIDER = process.env.DSH_GW_TUNNEL_PROVIDER ?? 'ngrok'

function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer()
    server.on('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port
      server.close(() => resolve(port))
    })
  })
}

function fakeLlm() {
  return {
    listProviders: () => [{ id: 'provider-a', name: 'A' }],
    listModels: async () => [
      { id: 'only-a', name: 'Only A' },
      { id: 'only-b', name: 'Only B' },
    ],
    prepareCall: async (config) => ({
      config,
      async *stream() {
        yield { type: 'text-delta', text: 'ok' }
        yield { type: 'finish', reason: 'stop' }
      },
    }),
  }
}

function fakeCtx(llm) {
  const disposers = []
  return {
    llm,
    logger: { info() {}, warn() {} },
    effect: (factory) => {
      disposers.push(factory())
    },
    get: () => undefined,
    on: () => {},
    disposeAll: () => {
      for (const dispose of disposers) {
        try {
          dispose?.()
        } catch {
          /* teardown must not throw */
        }
      }
    },
  }
}

async function waitForPort(state) {
  for (let i = 0; i < 300; i += 1) {
    if (state.listenPort !== undefined) return state.listenPort
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  throw new Error('listener never came up')
}

async function waitForTunnel(state) {
  for (let i = 0; i < 600; i += 1) {
    if (state.tunnel.status === 'running' || state.tunnel.status === 'failed') return
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
}

/** The hostname shape each provider publishes; a URL that misses it is wrong. */
const URL_SHAPE = {
  ngrok: /^https:\/\/[a-z0-9-]+\.ngrok-free\.(?:dev|app)$/,
  cloudflared: /^https:\/\/[a-z0-9-]+\.trycloudflare\.com$/,
}

/**
 * Fetch with retries: a quick tunnel answers on its public host a moment after
 * the process prints the URL, so the first attempt can fail on a cold edge.
 */
async function fetchWithRetry(url, init, attempts = 20) {
  let last
  for (let i = 0; i < attempts; i += 1) {
    try {
      return await fetch(url, init)
    } catch (error) {
      last = error
      await new Promise((resolve) => setTimeout(resolve, 1000))
    }
  }
  throw last
}

const results = []
async function check(name, fn) {
  try {
    await fn()
    results.push({ name, ok: true })
    console.log(`ok    ${name}`)
  } catch (error) {
    results.push({ name, ok: false })
    console.log(`FAIL  ${name}\n      ${error.message}`)
  }
}

const home = mkdtempSync(join(tmpdir(), 'dsh-gw-tunnel-'))
process.env.DSH_HOME = home
const ctx = fakeCtx(fakeLlm())
const state = apply(ctx, {
  port: await freePort(),
  tunnel: { provider: PROVIDER, autostart: true },
})

const HEADERS = { 'user-agent': 'cursor/0.48.9' }

try {
  await waitForPort(state)
  await waitForTunnel(state)

  console.log(`provider: ${PROVIDER}`)
  console.log(`status:   ${state.tunnel.status}`)
  console.log(`pid:      ${state.tunnel.pid ?? '(none)'}`)
  console.log(`url:      ${state.tunnel.url ?? '(none)'}`)
  if (state.tunnel.error != null) console.log(`error:    ${state.tunnel.error}`)
  console.log('')

  await check('the plugin spawned the tunnel itself', () => {
    assert.equal(state.tunnel.status, 'running', `tunnel did not come up: ${state.tunnel.error ?? ''}`)
    assert.ok(state.tunnel.pid !== null, 'no child process id was recorded')
  })

  await check('the public URL is the shape that provider publishes', () => {
    assert.match(state.tunnel.url, URL_SHAPE[PROVIDER], `unexpected URL: ${state.tunnel.url}`)
  })

  await check('the loopback API still answers while the tunnel is up', async () => {
    const response = await fetch(`http://127.0.0.1:${state.listenPort}/v1/`)
    const body = await response.text()
    assert.equal(response.status, 200, `the loopback API did not answer: ${response.status}`)
    assert.ok(body.includes('/v1/models'), `unexpected body: ${body.slice(0, 120)}`)
  })

  await check('the public URL serves /v1/models with the minted key', async () => {
    const response = await fetchWithRetry(`${state.tunnel.url}/v1/models`, {
      headers: { ...HEADERS, authorization: `Bearer ${state.apiKey}` },
    })
    const body = await response.text()
    assert.equal(response.status, 200, `got ${response.status}: ${body.slice(0, 160)}`)
    const parsed = JSON.parse(body)
    assert.ok(Array.isArray(parsed.data), 'no model list in the response')
    assert.ok(parsed.data.length >= 2, `expected the fake catalog, got ${parsed.data.length}`)
  })

  await check('the public URL refuses a request without the key', async () => {
    const response = await fetchWithRetry(`${state.tunnel.url}/v1/models`, { headers: HEADERS })
    const body = await response.text()
    assert.equal(response.status, 401, `expected 401, got ${response.status}: ${body.slice(0, 160)}`)
  })
} finally {
  ctx.disposeAll()
  rmSync(home, { recursive: true, force: true })
}

const failed = results.filter((entry) => !entry.ok)
console.log(`\n${results.length - failed.length}/${results.length} checks passed`)
process.exit(failed.length === 0 ? 0 : 1)
