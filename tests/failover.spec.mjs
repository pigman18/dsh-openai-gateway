/**
 * One alias, several targets, and what happens when the first one cannot serve.
 *
 * This is the shape a relay (one-api and friends) calls "channel failover": the
 * caller names one model, the gateway tries its targets in order, and a target
 * that reports "not right now" is benched for a cooldown instead of being
 * retried on every request.
 *
 * The fake `llm` here scripts each provider's answer, so every check asserts a
 * fact about what the gateway did — which provider it reached, how many times,
 * what the caller finally received — rather than how the code is written.
 *
 * Run:  node tests/failover.spec.mjs
 */
import assert from 'node:assert/strict'
import http from 'node:http'
import net from 'node:net'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { apply } from '../index.js'

const home = mkdtempSync(join(tmpdir(), 'gw-failover-'))
process.env.DSH_HOME = home

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

/**
 * A fake `llm` whose per-model behaviour is a function of the model id.
 *
 * `plan` maps `provider/model` to either `'ok'` or a failure code. Every call is
 * recorded, so a check can prove the gateway stopped trying after a success and
 * did not touch a benched target.
 */
function fakeLlm(plan) {
  const calls = []
  const models = {}
  for (const key of Object.keys(plan)) {
    const [provider, model] = key.split('/')
    models[provider] ??= []
    models[provider].push({ id: model, name: model })
  }
  return {
    calls,
    listProviders: () => Object.keys(models).map((id) => ({ id, name: id })),
    listModels: async (provider) => models[provider] ?? [],
    prepareCall: async (config) => {
      const key = `${config.provider}/${config.model}`
      const behaviour = plan[key] ?? 'ok'
      return {
        config,
        async *stream() {
          calls.push(key)
          if (behaviour !== 'ok') {
            yield {
              type: 'finish',
              reason: { kind: 'error', failure: { code: behaviour, message: `${key} says ${behaviour}` } },
            }
            return
          }
          yield { type: 'text-delta', text: `served-by:${key}` }
          yield { type: 'finish', reason: { kind: 'stop' } }
        },
      }
    },
  }
}

function fakeCtx(llm) {
  const disposers = []
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

async function waitForPort(state) {
  for (let i = 0; i < 300; i += 1) {
    if (state.listenPort !== undefined) return state.listenPort
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  throw new Error('listener never came up')
}

/**
 * Boot a gateway with one alias pointing at `targets`, in order.
 *
 * Each boot gets its own DSH_HOME. The store persists the alias table to
 * settings.json, and a stored table deliberately outranks the bundle config, so
 * a shared home would let one check's routes leak into the next — the second
 * boot would then read the first boot's aliases instead of its own.
 */
async function boot(plan, targets, { alias = 'flash' } = {}) {
  const llm = fakeLlm(plan)
  const ctx = fakeCtx(llm)
  const previousHome = process.env.DSH_HOME
  const bootHome = mkdtempSync(join(tmpdir(), 'gw-failover-boot-'))
  process.env.DSH_HOME = bootHome
  const state = apply(ctx, {
    port: await freePort(),
    aliases: { [alias]: targets },
  })
  const port = await waitForPort(state)
  const stop = () => {
    ctx.disposeAll()
    rmSync(bootHome, { recursive: true, force: true })
    if (previousHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previousHome
  }
  return { llm, ctx, state, port, alias, stop }
}

function post(port, key, body) {
  return new Promise((resolve, reject) => {
    const payload = Buffer.from(JSON.stringify(body))
    const req = http.request(
      {
        host: '127.0.0.1',
        port,
        path: '/v1/chat/completions',
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'content-length': String(payload.length),
          authorization: `Bearer ${key}`,
        },
      },
      (res) => {
        let text = ''
        res.setEncoding('utf8')
        res.on('data', (chunk) => {
          text += chunk
        })
        res.on('end', () => resolve({ status: res.statusCode, text }))
      },
    )
    req.on('error', reject)
    req.end(payload)
  })
}

function readStatus(webRoutes) {
  return new Promise((resolve, reject) => {
    const handler = webRoutes.get('/plugins/dsh-openai-gateway/status')
    if (handler === undefined) {
      reject(new Error('status route never mounted'))
      return
    }
    const res = {
      writeHead() {},
      end(payload) {
        resolve(JSON.parse(String(payload ?? '{}')))
      },
      destroy() {
        reject(new Error('destroyed'))
      },
    }
    handler({ method: 'GET', headers: { host: '127.0.0.1' }, url: '/plugins/dsh-openai-gateway/status' }, res)
  })
}

const MESSAGES = [{ role: 'user', content: 'hi' }]

const results = []
async function check(name, run) {
  try {
    await run()
    results.push([true, name])
    console.log(`ok    ${name}`)
  } catch (error) {
    results.push([false, name])
    console.log(`FAIL  ${name}\n      ${error.message.split('\n').slice(0, 4).join('\n      ')}`)
  }
}

/* ------------------------------------------------------------------ checks */

await check('a healthy first target serves the request and nothing else is tried', async () => {
  const app = await boot({ 'a/one': 'ok', 'b/two': 'ok' }, ['a/one', 'b/two'])
  try {
    const res = await post(app.port, app.state.apiKey, { model: 'flash', messages: MESSAGES })
    assert.equal(res.status, 200, res.text.slice(0, 200))
    assert.ok(res.text.includes('served-by:a/one'), `the first target did not serve it: ${res.text.slice(0, 200)}`)
    assert.deepEqual(app.llm.calls, ['a/one'], `expected exactly one upstream call, got ${JSON.stringify(app.llm.calls)}`)
  } finally {
    app.stop()
  }
})

await check('a target that is out of quota hands the request to the next one', async () => {
  const app = await boot({ 'a/one': 'QUOTA', 'b/two': 'ok' }, ['a/one', 'b/two'])
  try {
    const res = await post(app.port, app.state.apiKey, { model: 'flash', messages: MESSAGES })
    assert.equal(res.status, 200, `the caller should have been served by the fallback: ${res.text.slice(0, 240)}`)
    assert.ok(res.text.includes('served-by:b/two'), `the wrong target answered: ${res.text.slice(0, 240)}`)
    assert.deepEqual(app.llm.calls, ['a/one', 'b/two'], `unexpected attempt order: ${JSON.stringify(app.llm.calls)}`)
  } finally {
    app.stop()
  }
})

await check('a throttle, a timeout, a 5xx and an unreachable host all fail over', async () => {
  for (const code of ['RATE_LIMIT', 'TIMEOUT', 'SERVER', 'TRANSPORT']) {
    const app = await boot({ 'a/one': code, 'b/two': 'ok' }, ['a/one', 'b/two'])
    try {
      const res = await post(app.port, app.state.apiKey, { model: 'flash', messages: MESSAGES })
      assert.equal(res.status, 200, `${code} did not fail over: ${res.text.slice(0, 200)}`)
      assert.ok(res.text.includes('served-by:b/two'), `${code} did not reach the fallback`)
    } finally {
      app.stop()
    }
  }
})

await check('a stale model name in the middle of the chain does not end it', async () => {
  /* The reported failure, reproduced: target 2 names a model the provider no
     longer advertises, so it answers UNKNOWN_MODEL. That code was absent from
     FAILOVER_CODES, so the loop stopped dead and target 3 — healthy — was never
     tried. The caller got a 502 while two good targets sat unused.
     A renamed upstream model is routine catalogue drift, so this must fail over
     like any other "this target cannot serve" answer. */
  const app = await boot(
    { 'a/one': 'UNKNOWN_MODEL', 'b/two': 'ok' },
    ['a/one', 'b/two'],
  )
  try {
    const res = await post(app.port, app.state.apiKey, { model: 'flash', messages: MESSAGES })
    assert.equal(res.status, 200, `a stale target stopped the chain: ${res.text.slice(0, 240)}`)
    assert.ok(res.text.includes('served-by:b/two'), `the healthy target was never tried: ${res.text.slice(0, 240)}`)
    assert.deepEqual(app.llm.calls, ['a/one', 'b/two'], `unexpected attempt order: ${JSON.stringify(app.llm.calls)}`)
  } finally {
    app.stop()
  }
})

await check('a stale target between two good ones is stepped over, not fatal', async () => {
  /* The exact shape of the real route: eight targets, one of them stale, the
     healthy ones sitting behind it. Before the fix the request died at the stale
     row and never reached the four targets that followed. */
  const app = await boot(
    {
      'a/one': 'RATE_LIMIT',
      'b/two': 'UNKNOWN_MODEL',
      'c/three': 'ok',
    },
    ['a/one', 'b/two', 'c/three'],
  )
  try {
    const res = await post(app.port, app.state.apiKey, { model: 'flash', messages: MESSAGES })
    assert.equal(res.status, 200, `the chain did not survive a stale row: ${res.text.slice(0, 240)}`)
    assert.ok(res.text.includes('served-by:c/three'), `the third target did not answer: ${res.text.slice(0, 240)}`)
    const order = [...new Set(app.llm.calls)]
    assert.deepEqual(order, ['a/one', 'b/two', 'c/three'], `not every target was tried, in order: ${JSON.stringify(app.llm.calls)}`)
  } finally {
    app.stop()
  }
})

await check('a chain that is entirely stale names the model, not a broken gateway', async () => {
  /* UNKNOWN_MODEL is a configuration problem: the gateway is fine, one alias row
     points at a model that moved. With every target stale the caller has to learn
     that, so it is a 400 naming the model rather than a 502 that reads like the
     gateway itself is down. */
  const app = await boot({ 'a/one': 'UNKNOWN_MODEL' }, ['a/one'])
  try {
    const res = await post(app.port, app.state.apiKey, { model: 'flash', messages: MESSAGES })
    assert.equal(res.status, 400, `expected a configuration error, got ${res.status}: ${res.text.slice(0, 200)}`)
    assert.ok(res.text.includes('a/one'), `the failing target is not named: ${res.text.slice(0, 200)}`)
  } finally {
    app.stop()
  }
})

await check('the whole list is walked before the caller is refused', async () => {
  const app = await boot(
    { 'a/one': 'QUOTA', 'b/two': 'RATE_LIMIT', 'c/three': 'SERVER' },
    ['a/one', 'b/two', 'c/three'],
  )
  try {
    const res = await post(app.port, app.state.apiKey, { model: 'flash', messages: MESSAGES })
    // The last failure is SERVER, which answers 502; what matters is that the
    // caller got an upstream refusal rather than the first target's 429.
    assert.equal(res.status, 502, `expected the last failure to be reported, got ${res.status}: ${res.text.slice(0, 200)}`)
    assert.ok(res.text.includes('c/three'), `the reported failure is not the last target's: ${res.text.slice(0, 200)}`)
    // Each target may be retried by the per-target retry policy before the
    // gateway moves on, so the assertion is about which targets were reached,
    // in what order — not about how many attempts each one took.
    const order = [...new Set(app.llm.calls)]
    assert.deepEqual(order, ['a/one', 'b/two', 'c/three'], `not every target was tried, in order: ${JSON.stringify(app.llm.calls)}`)
  } finally {
    app.stop()
  }
})

await check('a failure that is the caller\'s own fault does not walk the list', async () => {
  const app = await boot({ 'a/one': 'INVALID_REQUEST', 'b/two': 'ok' }, ['a/one', 'b/two'])
  try {
    const res = await post(app.port, app.state.apiKey, { model: 'flash', messages: MESSAGES })
    assert.equal(res.status, 400, `expected the request to be refused as-is, got ${res.status}`)
    assert.deepEqual(
      app.llm.calls,
      ['a/one'],
      `a malformed request was replayed against every target: ${JSON.stringify(app.llm.calls)}`,
    )
  } finally {
    app.stop()
  }
})

await check('a benched target is skipped on the next request', async () => {
  const app = await boot({ 'a/one': 'QUOTA', 'b/two': 'ok' }, ['a/one', 'b/two'])
  try {
    await post(app.port, app.state.apiKey, { model: 'flash', messages: MESSAGES })
    assert.deepEqual(app.llm.calls, ['a/one', 'b/two'], 'the first request did not fail over')

    app.llm.calls.length = 0
    const second = await post(app.port, app.state.apiKey, { model: 'flash', messages: MESSAGES })
    assert.equal(second.status, 200, second.text.slice(0, 200))
    assert.deepEqual(
      app.llm.calls,
      ['b/two'],
      `the benched target was tried again: ${JSON.stringify(app.llm.calls)}`,
    )
  } finally {
    app.stop()
  }
})

await check('the status document reports which targets are benched, and why', async () => {
  const app = await boot({ 'a/one': 'QUOTA', 'b/two': 'ok' }, ['a/one', 'b/two'])
  try {
    await post(app.port, app.state.apiKey, { model: 'flash', messages: MESSAGES })
    const status = await readStatus(app.ctx.webRoutes)
    assert.equal(status.failover.cooldownMs, 5 * 60_000, 'the cooldown is not the documented five minutes')
    const benched = status.failover.cooling
    assert.equal(benched.length, 1, `expected exactly one benched target, got ${JSON.stringify(benched)}`)
    assert.equal(benched[0].target, 'a/one')
    assert.equal(benched[0].code, 'QUOTA', 'the reason was not recorded')
    assert.ok(
      benched[0].remainingMs > 4 * 60_000 && benched[0].remainingMs <= 5 * 60_000,
      `the remaining cooldown is implausible: ${benched[0].remainingMs}`,
    )
  } finally {
    app.stop()
  }
})

await check('a healthy target is not reported as benched', async () => {
  const app = await boot({ 'a/one': 'ok' }, ['a/one'])
  try {
    await post(app.port, app.state.apiKey, { model: 'flash', messages: MESSAGES })
    const status = await readStatus(app.ctx.webRoutes)
    assert.deepEqual(status.failover.cooling, [], 'a working target was reported as benched')
  } finally {
    app.stop()
  }
})

await check('when every target is benched the request still goes somewhere real', async () => {
  const app = await boot({ 'a/one': 'QUOTA', 'b/two': 'QUOTA' }, ['a/one', 'b/two'])
  try {
    await post(app.port, app.state.apiKey, { model: 'flash', messages: MESSAGES })
    const status = await readStatus(app.ctx.webRoutes)
    assert.equal(status.failover.cooling.length, 2, 'both targets should be benched after failing')

    app.llm.calls.length = 0
    const third = await post(app.port, app.state.apiKey, { model: 'flash', messages: MESSAGES })
    assert.equal(third.status, 429, `expected a real upstream refusal, got ${third.status}`)
    assert.ok(app.llm.calls.length > 0, 'a fully benched alias answered without contacting any target')
  } finally {
    app.stop()
  }
})

await check('the alias is advertised once, with every target it may reach', async () => {
  const app = await boot({ 'a/one': 'ok', 'b/two': 'ok' }, ['a/one', 'b/two'])
  try {
    const res = await new Promise((resolve, reject) => {
      const req = http.request(
        {
          host: '127.0.0.1',
          port: app.port,
          path: '/v1/models',
          method: 'GET',
          headers: { authorization: `Bearer ${app.state.apiKey}` },
        },
        (response) => {
          let text = ''
          response.setEncoding('utf8')
          response.on('data', (chunk) => {
            text += chunk
          })
          response.on('end', () => resolve({ status: response.statusCode, text }))
        },
      )
      req.on('error', reject)
      req.end()
    })
    assert.equal(res.status, 200, res.text.slice(0, 200))
    const listed = JSON.parse(res.text).data.filter((entry) => entry.id === 'flash')
    assert.equal(listed.length, 1, `the alias was listed ${listed.length} times`)
    assert.deepEqual(listed[0].alias_targets, ['a/one', 'b/two'], 'the target list is not advertised')
    assert.equal(listed[0].alias_of, 'a/one', 'the primary target is not advertised')
  } finally {
    app.stop()
  }
})

await check('a single-target alias still works exactly as before', async () => {
  const app = await boot({ 'a/one': 'ok' }, ['a/one'])
  try {
    const res = await post(app.port, app.state.apiKey, { model: 'flash', messages: MESSAGES })
    assert.equal(res.status, 200, res.text.slice(0, 200))
    assert.ok(res.text.includes('served-by:a/one'))
  } finally {
    app.stop()
  }
})

await check('a legacy string alias is read as a one-element list', async () => {
  // A settings file written by 1.3.1 has `"alias": "provider/model"`.
  const llm = fakeLlm({ 'a/one': 'ok' })
  const ctx = fakeCtx(llm)
  const state = apply(ctx, { port: await freePort(), aliases: { flash: 'a/one' } })
  const port = await waitForPort(state)
  try {
    assert.deepEqual(state.store.aliases.flash, ['a/one'], 'the legacy string was not normalised to a list')
    const res = await post(port, state.apiKey, { model: 'flash', messages: MESSAGES })
    assert.equal(res.status, 200, res.text.slice(0, 200))
  } finally {
    ctx.disposeAll()
  }
})

await check('the same target listed twice is tried once', async () => {
  const llm = fakeLlm({ 'a/one': 'ok' })
  const ctx = fakeCtx(llm)
  const state = apply(ctx, { port: await freePort(), aliases: { flash: ['a/one', 'a/one'] } })
  const port = await waitForPort(state)
  try {
    assert.deepEqual(state.store.aliases.flash, ['a/one'], 'a duplicate target was kept')
    await post(port, state.apiKey, { model: 'flash', messages: MESSAGES })
    assert.deepEqual(llm.calls, ['a/one'])
  } finally {
    ctx.disposeAll()
  }
})

/**
 * Boot a gateway that installs its own `prepareCall`, for the checks that need
 * an error shape the `plan` helper cannot express. Like `boot`, it gets a
 * private DSH_HOME so one check's persisted routes cannot leak into another.
 */
async function bootCustom(aliases, install) {
  const llm = fakeLlm({ 'b/two': 'ok' })
  const ctx = fakeCtx(llm)
  const previousHome = process.env.DSH_HOME
  const bootHome = mkdtempSync(join(tmpdir(), 'gw-failover-custom-'))
  process.env.DSH_HOME = bootHome
  const state = apply(ctx, { port: await freePort(), aliases })
  const port = await waitForPort(state)
  const original = llm.prepareCall
  llm.prepareCall = install(original)
  const stop = () => {
    ctx.disposeAll()
    rmSync(bootHome, { recursive: true, force: true })
    if (previousHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previousHome
  }
  return { llm, ctx, state, port, stop }
}

await check('a bare upstream 429 with no code still reaches the next target', async () => {
  /* The reported failure, reproduced. The first target is an OpenCode free-tier
     model whose quota is spent; the adapter surfaces the raw upstream answer
     with NO `code` at all — only a `status` and the JSON body as `message`:

       429: {"type":"FreeUsageLimitError","message":"Free usage limit reached…"}10000

     `failoverEligible` used to require a recognised `code`, so this was treated
     as unrecoverable and the healthy target behind it was never tried. */
  const app = await bootCustom({ flash: ['a/one', 'b/two'] }, (original) => async (config) => {
    if (`${config.provider}/${config.model}` !== 'a/one') return original(config)
    return {
      config,
      async *stream() {
        app.llm.calls.push('a/one')
        yield {
          type: 'finish',
          reason: {
            kind: 'error',
            failure: {
              status: 429,
              message:
                '429: {"type":"FreeUsageLimitError","message":"Free usage limit reached. Free models work in OpenCode (https://opencode.ai); subscribe to OpenCode Go to keep going: https://opencode.ai/go"}10000',
            },
          },
        }
      },
    }
  })
  try {
    const res = await post(app.port, app.state.apiKey, { model: 'flash', messages: MESSAGES })
    assert.equal(res.status, 200, `the spent target killed the route: ${res.text.slice(0, 300)}`)
    assert.ok(res.text.includes('served-by:b/two'), 'the healthy target was never tried')
    assert.deepEqual(app.llm.calls, ['a/one', 'b/two'], `wrong target order: ${JSON.stringify(app.llm.calls)}`)
  } finally {
    app.stop()
  }
})

await check('a quota refusal carrying only text is still failed over', async () => {
  // Some adapters drop the status too and leave only the sentence behind.
  const app = await bootCustom({ flash: ['a/one', 'b/two'] }, (original) => async (config) => {
    if (`${config.provider}/${config.model}` !== 'a/one') return original(config)
    return {
      config,
      async *stream() {
        app.llm.calls.push('a/one')
        yield {
          type: 'finish',
          reason: {
            kind: 'error',
            failure: { message: 'Free usage limit reached. Free models work in OpenCode' },
          },
        }
      },
    }
  })
  try {
    const res = await post(app.port, app.state.apiKey, { model: 'flash', messages: MESSAGES })
    assert.equal(res.status, 200, `an unlabelled quota refusal stopped the route: ${res.text.slice(0, 300)}`)
    assert.ok(res.text.includes('served-by:b/two'))
  } finally {
    app.stop()
  }
})

await check('a plain text error that is not a quota failure still stops', async () => {
  /* The widening must not turn every unlabelled error into a failover. A bare
     "the model refused" is not about the account, so the next target would
     answer identically and the route should not be walked. */
  const app = await bootCustom({ flash: ['a/one', 'b/two'] }, (original) => async (config) => {
    if (`${config.provider}/${config.model}` !== 'a/one') return original(config)
    return {
      config,
      async *stream() {
        app.llm.calls.push('a/one')
        yield {
          type: 'finish',
          reason: { kind: 'error', failure: { message: 'the model refused this prompt' } },
        }
      },
    }
  })
  try {
    await post(app.port, app.state.apiKey, { model: 'flash', messages: MESSAGES })
    assert.deepEqual(
      app.llm.calls,
      ['a/one'],
      `an ordinary error was replayed across targets: ${JSON.stringify(app.llm.calls)}`,
    )
  } finally {
    app.stop()
  }
})

await check('a 402 payment refusal is failed over', async () => {
  // A provider that answers 402 has an account problem, not a request problem.
  const app = await bootCustom({ flash: ['a/one', 'b/two'] }, (original) => async (config) => {
    if (`${config.provider}/${config.model}` !== 'a/one') return original(config)
    return {
      config,
      async *stream() {
        app.llm.calls.push('a/one')
        yield { type: 'finish', reason: { kind: 'error', failure: { status: 402 } } }
      },
    }
  })
  try {
    const res = await post(app.port, app.state.apiKey, { model: 'flash', messages: MESSAGES })
    assert.equal(res.status, 200, `a 402 killed the route: ${res.text.slice(0, 300)}`)
    assert.ok(res.text.includes('served-by:b/two'))
  } finally {
    app.stop()
  }
})

await check('a target whose provider was renamed does not kill the route', async () => {
  /* The reported failure, reproduced. The route's first target names a provider
     the profile no longer registers — `our-free-model` had been re-registered as
     `opencode-free` — so resolving it answered:

       {"error":{"message":"no adapter registered for provider \"our-free-model\"",
                 "type":"invalid_request_error","code":"NO_ADAPTER"}}

     `NO_ADAPTER` was absent from FAILOVER_CODES, so the chain stopped there and
     answered the caller 400 while five healthy targets sat untouched behind it.
     A stale provider row is the same class of problem as a stale model row. */
  const app = await bootCustom({ flash: ['gone/one', 'b/two'] }, (original) => async (config) => {
    if (`${config.provider}/${config.model}` !== 'gone/one') return original(config)
    return {
      config,
      async *stream() {
        app.llm.calls.push('gone/one')
        yield {
          type: 'finish',
          reason: {
            kind: 'error',
            failure: {
              code: 'NO_ADAPTER',
              message: 'no adapter registered for provider "gone"',
            },
          },
        }
      },
    }
  })
  try {
    const res = await post(app.port, app.state.apiKey, { model: 'flash', messages: MESSAGES })
    assert.equal(res.status, 200, `a renamed provider killed the route: ${res.text.slice(0, 300)}`)
    assert.ok(res.text.includes('served-by:b/two'), 'the healthy target was never tried')
    assert.deepEqual(app.llm.calls, ['gone/one', 'b/two'], `wrong order: ${JSON.stringify(app.llm.calls)}`)
  } finally {
    app.stop()
  }
})

await check('a renamed provider is benched rather than retried every request', async () => {
  // The stale row costs one round-trip, then sits out like any other dead target.
  const app = await bootCustom({ flash: ['gone/one', 'b/two'] }, (original) => async (config) => {
    if (`${config.provider}/${config.model}` !== 'gone/one') return original(config)
    return {
      config,
      async *stream() {
        app.llm.calls.push('gone/one')
        yield {
          type: 'finish',
          reason: { kind: 'error', failure: { code: 'NO_ADAPTER', message: 'no adapter registered' } },
        }
      },
    }
  })
  try {
    await post(app.port, app.state.apiKey, { model: 'flash', messages: MESSAGES })
    assert.deepEqual(app.llm.calls, ['gone/one', 'b/two'], 'the first request did not fail over')

    app.llm.calls.length = 0
    const second = await post(app.port, app.state.apiKey, { model: 'flash', messages: MESSAGES })
    assert.equal(second.status, 200, second.text.slice(0, 200))
    assert.deepEqual(
      app.llm.calls,
      ['b/two'],
      `the dead provider row was tried again: ${JSON.stringify(app.llm.calls)}`,
    )
  } finally {
    app.stop()
  }
})

await check('the status document marks targets the catalogue no longer has', async () => {
  /* The page has to show a stale row before a request discovers it. Only the
     host can see the catalogue, so it reports the dead targets per alias. */
  const app = await boot(
    { 'a/one': 'ok', 'c/three': 'ok' },
    ['a/one', 'gone/two', 'c/three'],
  )
  try {
    const status = await readStatus(app.ctx.webRoutes)
    const row = status.aliases.find((entry) => entry.alias === 'flash')
    assert.ok(row !== undefined, 'the alias row is missing from the status document')
    assert.deepEqual(
      row.unavailable,
      ['gone/two'],
      `the dead target was not reported: ${JSON.stringify(row.unavailable)}`,
    )
    assert.equal(
      row.targets.length,
      3,
      'the dead target must stay in the chain so the page can still show and edit it',
    )
  } finally {
    app.stop()
  }
})

await check('a fully live route reports nothing unavailable', async () => {
  const app = await boot({ 'a/one': 'ok', 'b/two': 'ok' }, ['a/one', 'b/two'])
  try {
    const status = await readStatus(app.ctx.webRoutes)
    const row = status.aliases.find((entry) => entry.alias === 'flash')
    assert.deepEqual(row.unavailable, [], `a healthy route was flagged: ${JSON.stringify(row.unavailable)}`)
  } finally {
    app.stop()
  }
})

/* ----------------------------------------------------------------- verdict */

rmSync(home, { recursive: true, force: true })
const failed = results.filter((entry) => !entry[0])
console.log(`\n${results.length - failed.length}/${results.length} checks passed`)
process.exit(failed.length === 0 ? 0 : 1)
