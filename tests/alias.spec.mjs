/**
 * Alias and address coverage.
 *
 * A real gateway instance is started in-process against a fake `llm` service,
 * so the alias table, its persistence, its interaction with colliding bare ids
 * and the advertised address are exercised end to end. `apply` returns the live
 * state, which is where the bound port and the minted key come from — no port
 * guessing, no dependence on a running harness profile.
 */
import assert from 'node:assert/strict'
import http from 'node:http'
import net from 'node:net'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { apply } from '../index.js'

/* --------------------------------------------------------------- fake llm */

const MODELS = {
  'provider-a': [
    { id: 'shared-model', name: 'Shared' },
    { id: 'only-a', name: 'Only A' },
  ],
  'provider-b': [{ id: 'shared-model', name: 'Shared' }],
}

function fakeLlm() {
  const calls = []
  return {
    calls,
    listProviders: () => [
      { id: 'provider-a', name: 'A' },
      { id: 'provider-b', name: 'B' },
    ],
    listModels: async (provider) => MODELS[provider] ?? [],
    prepareCall: async (config) => ({
      config,
      async *stream() {
        calls.push(config.model)
        yield { type: 'text-delta', text: `echo:${config.model}` }
        yield { type: 'finish', reason: 'stop' }
      },
    }),
  }
}

/** A minimal cordis-shaped context, enough for `apply`. */
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

/* ---------------------------------------------------------------- helpers */

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

function request(port, { method = 'GET', path = '/', body, auth } = {}) {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? undefined : JSON.stringify(body)
    const headers = {}
    if (auth !== undefined) headers.Authorization = `Bearer ${auth}`
    if (payload !== undefined) {
      headers['Content-Type'] = 'application/json'
      headers['Content-Length'] = String(Buffer.byteLength(payload))
    }
    const req = http.request({ host: '127.0.0.1', port, method, path, headers }, (res) => {
      const chunks = []
      res.on('data', (chunk) => chunks.push(chunk))
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8')
        let json
        try {
          json = JSON.parse(text)
        } catch {
          json = undefined
        }
        resolve({ status: res.statusCode, text, json })
      })
    })
    req.on('error', reject)
    if (payload !== undefined) req.end(payload)
    else req.end()
  })
}

async function waitForPort(state) {
  for (let i = 0; i < 300; i += 1) {
    if (state.listenPort !== undefined) return state.listenPort
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  throw new Error(`listener never came up (${state.listenError?.message ?? 'no error recorded'})`)
}

/** Boot one gateway on its own port, home and settings file. */
async function boot(config = {}) {
  const home = mkdtempSync(join(tmpdir(), 'dsh-gw-'))
  process.env.DSH_HOME = home
  const llm = fakeLlm()
  const ctx = fakeCtx(llm)
  const state = apply(ctx, { port: await freePort(), ...config })
  const port = await waitForPort(state)
  return {
    llm,
    state,
    port,
    home,
    settingsFile: join(home, 'openai-gateway', 'settings.json'),
    stop: () => {
      ctx.disposeAll()
      rmSync(home, { recursive: true, force: true })
    },
  }
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

/* -------------------------------------------------------------- aliasing */

const gateway = await boot({ aliases: { 'gpt-4o': 'provider-a/only-a' } })
try {
  await check('an alias resolves to its target and answers', async () => {
    const res = await request(gateway.port, {
      method: 'POST',
      path: '/v1/chat/completions',
      auth: gateway.state.apiKey,
      body: { model: 'gpt-4o', messages: [{ role: 'user', content: 'hi' }] },
    })
    assert.equal(res.status, 200, res.text)
    assert.equal(res.json.choices[0].message.content, 'echo:only-a')
    assert.equal(res.json.model, 'gpt-4o', 'the caller sees the name it sent')
    assert.equal(gateway.llm.calls.at(-1), 'only-a', 'the upstream got the real model id')
  })

  await check('the catalog advertises the alias beside the real ids', async () => {
    const res = await request(gateway.port, { path: '/v1/models', auth: gateway.state.apiKey })
    assert.equal(res.status, 200, res.text)
    const ids = res.json.data.map((entry) => entry.id)
    assert.ok(ids.includes('provider-a/only-a'), 'the real id is listed')
    assert.ok(ids.includes('gpt-4o'), 'the alias is listed')
    const alias = res.json.data.find((entry) => entry.id === 'gpt-4o')
    assert.equal(alias.alias_of, 'provider-a/only-a')
    assert.equal(alias.owned_by, 'provider-a')
  })

  await check('a single alias is readable through /v1/models/<alias>', async () => {
    const res = await request(gateway.port, { path: '/v1/models/gpt-4o', auth: gateway.state.apiKey })
    assert.equal(res.status, 200, res.text)
    assert.equal(res.json.id, 'gpt-4o')
    assert.equal(res.json.alias_of, 'provider-a/only-a')
  })

  await check('an unknown model is still a 404', async () => {
    const res = await request(gateway.port, {
      method: 'POST',
      path: '/v1/chat/completions',
      auth: gateway.state.apiKey,
      body: { model: 'not-a-model', messages: [{ role: 'user', content: 'hi' }] },
    })
    assert.equal(res.status, 404, res.text)
    assert.equal(res.json.error.code, 'model_not_found')
  })

  await check('the alias table is written to the settings file', async () => {
    const persisted = JSON.parse(readFileSync(gateway.settingsFile, 'utf8'))
    // The stored form is the list of targets, in the order they are tried.
    assert.deepEqual(persisted.aliases, { 'gpt-4o': ['provider-a/only-a'] })
    assert.equal(persisted.port, gateway.state.store.port)
  })
} finally {
  gateway.stop()
}

await check('the alias table is read back on the next boot', async () => {
  const home = mkdtempSync(join(tmpdir(), 'dsh-gw-restart-'))
  process.env.DSH_HOME = home
  try {
    const ctx1 = fakeCtx(fakeLlm())
    const first = apply(ctx1, { port: await freePort(), aliases: { 'gpt-4o': 'provider-a/only-a' } })
    const port1 = await waitForPort(first)
    const key = first.apiKey
    ctx1.disposeAll()

    // Only the file can supply the alias on the second boot: no bundle config.
    const seeded = JSON.parse(readFileSync(join(home, 'openai-gateway', 'settings.json'), 'utf8'))
    assert.deepEqual(seeded.aliases, { 'gpt-4o': ['provider-a/only-a'] })

    const ctx2 = fakeCtx(fakeLlm())
    const second = apply(ctx2, { port: port1 })
    await waitForPort(second)
    try {
      assert.deepEqual(second.store.aliases, { 'gpt-4o': ['provider-a/only-a'] })
      const res = await request(port1, {
        method: 'POST',
        path: '/v1/chat/completions',
        auth: second.apiKey,
        body: { model: 'gpt-4o', messages: [{ role: 'user', content: 'hi' }] },
      })
      assert.equal(res.status, 200, res.text)
      assert.equal(res.json.choices[0].message.content, 'echo:only-a')
      assert.equal(second.apiKey, key, 'the minted key is reused, not re-minted')
    } finally {
      ctx2.disposeAll()
    }
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

/* ------------------------------------------------------------- collisions */

const colliding = await boot({ aliases: { 'shared-model': 'provider-b/shared-model' } })
try {
  await check('an alias beats a colliding bare id', async () => {
    const res = await request(colliding.port, {
      method: 'POST',
      path: '/v1/chat/completions',
      auth: colliding.state.apiKey,
      body: { model: 'shared-model', messages: [{ role: 'user', content: 'hi' }] },
    })
    assert.equal(res.status, 200, res.text)
    assert.equal(res.json.choices[0].message.content, 'echo:shared-model')
    assert.equal(colliding.llm.calls.at(-1), 'shared-model')
  })
} finally {
  colliding.stop()
}

const plain = await boot({})
try {
  await check('without an alias a colliding bare id is still refused', async () => {
    const res = await request(plain.port, {
      method: 'POST',
      path: '/v1/chat/completions',
      auth: plain.state.apiKey,
      body: { model: 'shared-model', messages: [{ role: 'user', content: 'hi' }] },
    })
    assert.equal(res.status, 400, res.text)
    assert.match(res.json.error.message, /several providers/)
  })

  await check('a provider-qualified id still works when aliases exist', async () => {
    const res = await request(plain.port, {
      method: 'POST',
      path: '/v1/chat/completions',
      auth: plain.state.apiKey,
      body: { model: 'provider-b/shared-model', messages: [{ role: 'user', content: 'hi' }] },
    })
    assert.equal(res.status, 200, res.text)
    assert.equal(plain.llm.calls.at(-1), 'shared-model')
  })
} finally {
  plain.stop()
}

/* ------------------------------------------------------ malformed aliases */

await check('a malformed alias target is dropped instead of routed', async () => {
  const home = mkdtempSync(join(tmpdir(), 'dsh-gw-bad-'))
  process.env.DSH_HOME = home
  const ctx = fakeCtx(fakeLlm())
  try {
    const state = apply(ctx, {
      port: await freePort(),
      aliases: { bad: 'no-slash', 'also-bad': '', ok: 'provider-a/only-a' },
    })
    const port = await waitForPort(state)
    const res = await request(port, { path: '/v1/models', auth: state.apiKey })
    assert.equal(res.status, 200, res.text)
    const ids = res.json.data.map((entry) => entry.id)
    assert.ok(!ids.includes('bad'), 'a target without a provider is not advertised')
    assert.ok(!ids.includes('also-bad'), 'an empty target is not advertised')
    assert.ok(ids.includes('ok'), 'a well-formed alias survives')
  } finally {
    ctx.disposeAll()
    rmSync(home, { recursive: true, force: true })
  }
})

/* --------------------------------------------------------- public address */

await check('publicBaseUrl replaces the advertised address', async () => {
  const home = mkdtempSync(join(tmpdir(), 'dsh-gw-pub-'))
  process.env.DSH_HOME = home
  const ctx = fakeCtx(fakeLlm())
  try {
    const state = apply(ctx, {
      port: await freePort(),
      publicBaseUrl: 'https://gw.example.com/v1/',
    })
    const port = await waitForPort(state)
    assert.equal(state.publicBaseUrl, 'https://gw.example.com/v1', 'the trailing slash is trimmed')
    assert.equal(state.listenPort, port)
  } finally {
    ctx.disposeAll()
    rmSync(home, { recursive: true, force: true })
  }
})

await check('an unusable publicBaseUrl is ignored', async () => {
  const home = mkdtempSync(join(tmpdir(), 'dsh-gw-badpub-'))
  process.env.DSH_HOME = home
  const ctx = fakeCtx(fakeLlm())
  try {
    const state = apply(ctx, { port: await freePort(), publicBaseUrl: 'not a url' })
    await waitForPort(state)
    assert.equal(state.publicBaseUrl, undefined)
  } finally {
    ctx.disposeAll()
    rmSync(home, { recursive: true, force: true })
  }
})

/* ----------------------------------------------------------------- tunnel */

await check('a tunnel that is not configured reports that, not a crash', async () => {
  const home = mkdtempSync(join(tmpdir(), 'dsh-gw-notun-'))
  process.env.DSH_HOME = home
  const ctx = fakeCtx(fakeLlm())
  try {
    const state = apply(ctx, { port: await freePort() })
    await waitForPort(state)
    assert.equal(state.tunnel.status, 'idle')
    assert.equal(state.tunnel.provider, null)
    assert.equal(state.tunnel.url, undefined)
    assert.equal(state.tunnelConfig.autostart, false)
  } finally {
    ctx.disposeAll()
    rmSync(home, { recursive: true, force: true })
  }
})

await check('an unknown tunnel provider is refused, not spawned', async () => {
  const home = mkdtempSync(join(tmpdir(), 'dsh-gw-badprov-'))
  process.env.DSH_HOME = home
  const ctx = fakeCtx(fakeLlm())
  try {
    const state = apply(ctx, { port: await freePort(), tunnel: { provider: 'not-a-tunnel' } })
    await waitForPort(state)
    assert.equal(state.tunnelConfig.provider, undefined)
    assert.equal(state.tunnel.status, 'idle')
  } finally {
    ctx.disposeAll()
    rmSync(home, { recursive: true, force: true })
  }
})

/* ----------------------------------------------------------------- report */

const failed = results.filter((entry) => !entry.ok)
console.log(`\n${results.length - failed.length}/${results.length} checks passed`)
process.exit(failed.length === 0 ? 0 : 1)
