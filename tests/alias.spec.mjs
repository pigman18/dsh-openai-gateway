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
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'
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
        // Usage is a chunk of its own, which is where the gateway reads it
        // from; an adapter that omits one leaves the persisted totals zero.
        yield { type: 'usage', usage: { inputTokens: 100, outputTokens: 20, cacheReadTokens: 40 } }
        yield { type: 'finish', reason: 'stop' }
      },
    }),
  }
}

/** A minimal cordis-shaped context, enough for `apply`. */
function fakeCtx(llm) {
  const disposers = []
  // Control routes are mounted on the harness web server, so a test that drives
  // them (clear-log, tunnel) needs the same register seam the page goes through.
  const webRoutes = new Map()
  return {
    llm,
    webRoutes,
    logger: { info() {}, warn() {} },
    effect: (factory) => {
      disposers.push(factory())
    },
    get: (key) =>
      key === 'webServer' || key === 'httpServer'
        ? {
            register: (route) => {
              webRoutes.set(route.path, route.handler)
              return () => {}
            },
          }
        : undefined,
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

await check('a page save survives a reload that also has bundle aliases', async () => {
  /* The reported bug. A profile pinned two aliases in YAML (gpt-4o,
     claude-sonnet-5.5) and the user then added routes from the page. Every
     reload threw the page's work away and restored the YAML pair, so routes
     looked like they reset themselves for no reason.
     A save is more specific than a static config file, so the stored table has
     to win once it exists; the bundle config only seeds a fresh install. */
  const home = mkdtempSync(join(tmpdir(), 'dsh-gw-save-vs-yaml-'))
  process.env.DSH_HOME = home
  try {
    const bundleAliases = { 'gpt-4o': 'provider-a/only-a' }

    // First boot: nothing stored yet, so the bundle config seeds the table.
    const ctx1 = fakeCtx(fakeLlm())
    const first = apply(ctx1, { port: await freePort(), aliases: bundleAliases })
    const port = await waitForPort(first)
    assert.deepEqual(
      first.store.aliases,
      { 'gpt-4o': ['provider-a/only-a'] },
      'the bundle aliases did not seed a fresh install',
    )

    // The page then writes what the user picked.
    const file = join(home, 'openai-gateway', 'settings.json')
    const settings = JSON.parse(readFileSync(file, 'utf8'))
    settings.aliases = { 'page-route': ['provider-b/shared-model'] }
    writeFileSync(file, `${JSON.stringify(settings, null, 2)}\n`)
    ctx1.disposeAll()

    // Second boot with the SAME bundle config still present.
    const ctx2 = fakeCtx(fakeLlm())
    const second = apply(ctx2, { port, aliases: bundleAliases })
    await waitForPort(second)
    try {
      assert.deepEqual(
        second.store.aliases,
        { 'page-route': ['provider-b/shared-model'] },
        'the reload restored the bundle aliases and discarded the page save',
      )
      assert.equal(
        Object.prototype.hasOwnProperty.call(second.store.aliases, 'gpt-4o'),
        false,
        'the stale bundle alias came back after a page save',
      )
    } finally {
      ctx2.disposeAll()
    }
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

await check('removing the stored alias table falls back to the bundle config', async () => {
  /* The fallback has to stay reachable, otherwise the bundle config becomes
     write-only. Deleting the key from settings.json is the documented reset. */
  const home = mkdtempSync(join(tmpdir(), 'dsh-gw-yaml-reset-'))
  process.env.DSH_HOME = home
  try {
    const bundleAliases = { 'from-yaml': 'provider-a/only-a' }
    const ctx1 = fakeCtx(fakeLlm())
    const first = apply(ctx1, { port: await freePort(), aliases: bundleAliases })
    const port = await waitForPort(first)
    ctx1.disposeAll()

    // Pretend the page saved something different.
    const file = join(home, 'openai-gateway', 'settings.json')
    const settings = JSON.parse(readFileSync(file, 'utf8'))
    settings.aliases = { 'from-page': ['provider-a/only-a'] }
    writeFileSync(file, `${JSON.stringify(settings, null, 2)}\n`)

    const ctx2 = fakeCtx(fakeLlm())
    const second = apply(ctx2, { port, aliases: bundleAliases })
    await waitForPort(second)
    assert.deepEqual(
      second.store.aliases,
      { 'from-page': ['provider-a/only-a'] },
      'the stored table did not win over the bundle aliases',
    )
    ctx2.disposeAll()

    // Reset: drop the alias key, keeping the port and key so the client is intact.
    const reset = JSON.parse(readFileSync(file, 'utf8'))
    delete reset.aliases
    writeFileSync(file, `${JSON.stringify(reset, null, 2)}\n`)

    const ctx3 = fakeCtx(fakeLlm())
    const third = apply(ctx3, { port, aliases: bundleAliases })
    await waitForPort(third)
    try {
      assert.deepEqual(
        third.store.aliases,
        { 'from-yaml': ['provider-a/only-a'] },
        'the bundle aliases were not used after the stored table was removed',
      )
    } finally {
      ctx3.disposeAll()
    }
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

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

/* ------------------------------------------------------------ usage store */

/** One chat completion against the gateway's own listener. */
function postCompletion(state, model = 'flash') {
  return request(state.listenPort, {
    method: 'POST',
    path: '/v1/chat/completions',
    auth: state.apiKey,
    body: { model, messages: [{ role: 'user', content: 'hi' }] },
  })
}

/**
 * One control-route write. The control routes are mounted on the harness web
 * server, so the fake context records their handlers and this drives them with
 * a real readable request, exactly as the page's fetch would.
 */
function postControl(ctx, path, body) {
  const handler = ctx.webRoutes.get(path)
  if (handler === undefined) throw new Error(`control route never mounted: ${path}`)
  const payload = JSON.stringify(body)
  const req = Readable.from([Buffer.from(payload)])
  req.method = 'POST'
  req.url = path
  req.headers = {
    'content-type': 'application/json',
    'content-length': String(Buffer.byteLength(payload)),
    origin: 'http://127.0.0.1',
    host: '127.0.0.1',
  }
  return new Promise((resolve, reject) => {
    const res = {
      statusCode: 0,
      headersSent: false,
      writeHead(status) {
        this.statusCode = status
        this.headersSent = true
        return this
      },
      setHeader() {},
      getHeader() {},
      write() {},
      on() {},
      end(text) {
        resolve({ status: this.statusCode, body: String(text ?? '') })
      },
      destroy() {
        reject(new Error('response destroyed before it ended'))
      },
    }
    Promise.resolve(handler(req, res)).catch(reject)
  })
}

await check('the counters survive a restart instead of zeroing', async () => {
  /* The reported complaint: updating or restarting the plugin reset "累计调用"
     to zero. The counters now live in usage.json and are restored on load. */
  const home = mkdtempSync(join(tmpdir(), 'dsh-gw-usage-'))
  process.env.DSH_HOME = home
  const port = await freePort()
  try {
    const ctx1 = fakeCtx(fakeLlm())
    const first = apply(ctx1, { port, aliases: { flash: ['provider-a/only-a'] } })
    await waitForPort(first)
    await postCompletion(first, 'flash')
    // The flush is debounced; dispose runs it synchronously.
    ctx1.disposeAll()

    const usagePath = join(home, 'openai-gateway', 'usage.json')
    const persisted = JSON.parse(readFileSync(usagePath, 'utf8'))
    assert.equal(persisted.requests, 1, 'the request counter was not written')
    assert.equal(persisted.totals.calls, 1, 'the usage totals were not written')
    assert.equal(persisted.recent.length, 1, 'the detail row was not written')

    const ctx2 = fakeCtx(fakeLlm())
    const second = apply(ctx2, { port, aliases: { flash: ['provider-a/only-a'] } })
    await waitForPort(second)
    try {
      assert.equal(second.requests, 1, 'the counter did not survive the restart')
      assert.equal(second.usageTotals.calls, 1, 'the totals did not survive the restart')
      assert.equal(second.recent.length, 1, 'the detail log did not survive the restart')
    } finally {
      ctx2.disposeAll()
    }
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

await check('rows outside the retention window are dropped, totals are not', async () => {
  const home = mkdtempSync(join(tmpdir(), 'dsh-gw-usage-age-'))
  process.env.DSH_HOME = home
  const port = await freePort()
  try {
    const dir = join(home, 'openai-gateway')
    mkdirSync(dir, { recursive: true })
    const now = Date.now()
    const stale = now - 31 * 24 * 60 * 60 * 1000
    writeFileSync(
      join(dir, 'usage.json'),
      JSON.stringify({
        version: 1,
        totals: { inputTokens: 500, outputTokens: 50, totalTokens: 550, calls: 9 },
        requests: 12,
        failures: 3,
        recent: [
          { at: now - 1000, model: 'fresh', outcome: 'ok' },
          { at: stale, model: 'expired', outcome: 'ok' },
        ],
      }),
    )

    const ctx = fakeCtx(fakeLlm())
    const state = apply(ctx, { port })
    await waitForPort(state)
    try {
      assert.equal(state.recent.length, 1, 'the expired row survived the retention window')
      assert.equal(state.recent[0].model, 'fresh')
      assert.equal(state.requests, 12, 'the counter must not age out with the rows')
      assert.equal(state.usageTotals.calls, 9, 'the totals must not age out with the rows')
    } finally {
      ctx.disposeAll()
    }
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

await check('clearing the log keeps the all-time counters', async () => {
  const home = mkdtempSync(join(tmpdir(), 'dsh-gw-usage-clear-'))
  process.env.DSH_HOME = home
  const port = await freePort()
  try {
    const ctx = fakeCtx(fakeLlm())
    const state = apply(ctx, { port, aliases: { flash: ['provider-a/only-a'] } })
    await waitForPort(state)
    try {
      await postCompletion(state, 'flash')
      assert.equal(state.recent.length, 1)

      const cleared = await postControl(ctx, '/plugins/dsh-openai-gateway/usage', { action: 'clear' })
      assert.equal(cleared.status, 200, `clear failed: ${cleared.body}`)
      assert.equal(JSON.parse(cleared.body).cleared, 1, 'the response did not report the count')
      assert.equal(state.recent.length, 0, 'the rows were not cleared')
      assert.equal(state.requests, 1, 'clearing the log must keep the cumulative counter')
      assert.equal(state.usageTotals.calls, 1, 'clearing the log must keep the token totals')
    } finally {
      ctx.disposeAll()
    }
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

await check('the tunnel provider is remembered across a restart', async () => {
  /* The reported annoyance: ngrok had to be re-picked after every restart
     because the choice was only ever held in memory. */
  const home = mkdtempSync(join(tmpdir(), 'dsh-gw-tunnel-remember-'))
  process.env.DSH_HOME = home
  const port = await freePort()
  try {
    const ctx1 = fakeCtx(fakeLlm())
    const first = apply(ctx1, { port })
    await waitForPort(first)
    // A stand-in tunnel process: this check is about what gets written to
    // settings.json, not about ngrok. Spawning the real binary would hang the
    // suite on a machine that does not have it installed.
    first.tunnelCommand = { command: process.execPath, prefixArgs: ['-e', ''] }
    // Selecting a provider is a control-route write, same as the page's click.
    await postControl(ctx1, '/plugins/dsh-openai-gateway/tunnel', { action: 'start', provider: 'ngrok' })
    ctx1.disposeAll()

    const settings = JSON.parse(readFileSync(join(home, 'openai-gateway', 'settings.json'), 'utf8'))
    assert.equal(settings.tunnel?.provider, 'ngrok', 'the provider was not written to settings.json')

    const ctx2 = fakeCtx(fakeLlm())
    const second = apply(ctx2, { port })
    await waitForPort(second)
    try {
      assert.equal(
        second.tunnelConfig.provider,
        'ngrok',
        'the remembered provider did not come back on the next boot',
      )
      assert.equal(second.tunnel.provider, 'ngrok', 'the page would show no provider selected')
    } finally {
      ctx2.disposeAll()
    }
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

/* ----------------------------------------------------------------- report */

const failed = results.filter((entry) => !entry.ok)
console.log(`\n${results.length - failed.length}/${results.length} checks passed`)
process.exit(failed.length === 0 ? 0 : 1)
