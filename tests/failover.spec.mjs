/**
 * One alias, several targets, and what happens when the first one cannot serve.
 *
 * This is the shape a relay (one-api and friends) calls "channel failover": the
 * caller names one model, the gateway tries its targets in order, and a target
 * that reports "not right now" is skipped from then on — the route's cursor
 * moves past it and the next request starts one further along.
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
 * did not touch a target the cursor has moved past.
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
    // Exposed so a check can heal a target mid-run and prove the gateway
    // notices: the plan is read at call time, not at boot.
    plan,
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
    // The tests that send images need a store; a stand-in that accepts anything
    // and hands back a stable ref is enough to exercise the routing order.
    attachments: {
      saveImages: async (images) => images.map(() => 'sha256:test'),
      saveFile: async () => 'sha256:test',
    },
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
        : key === 'attachments'
          ? {
              // A stand-in store: accept anything, hand back a stable ref.
              saveImages: async (images) => images.map(() => 'sha256:test'),
              saveFile: async () => 'sha256:test',
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

await check('a refused target is skipped on the next request', async () => {
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

await check('the status document reports where each route starts, and why', async () => {
  const app = await boot({ 'a/one': 'QUOTA', 'b/two': 'ok' }, ['a/one', 'b/two'])
  try {
    await post(app.port, app.state.apiKey, { model: 'flash', messages: MESSAGES })
    const status = await readStatus(app.ctx.webRoutes)
    const routes = status.rotation.routes
    assert.equal(routes.length, 1, `expected one rotated route, got ${JSON.stringify(routes)}`)
    assert.equal(routes[0].alias, 'flash')
    assert.equal(routes[0].next, 'b/two', 'the cursor did not move past the refused target')
    assert.equal(routes[0].movedFrom, 'a/one', 'the target that moved the cursor was not recorded')
    assert.equal(routes[0].code, 'QUOTA', 'the reason was not recorded')
  } finally {
    app.stop()
  }
})

await check('a healthy route is not reported as rotated', async () => {
  const app = await boot({ 'a/one': 'ok' }, ['a/one'])
  try {
    await post(app.port, app.state.apiKey, { model: 'flash', messages: MESSAGES })
    const status = await readStatus(app.ctx.webRoutes)
    assert.deepEqual(status.rotation.routes, [], 'a working target moved the cursor')
  } finally {
    app.stop()
  }
})

await check('a target that refused is reported as faulty, with a reason', async () => {
  const app = await boot({ 'a/one': 'QUOTA', 'b/two': 'ok' }, ['a/one', 'b/two'])
  try {
    await post(app.port, app.state.apiKey, { model: 'flash', messages: MESSAGES })
    const status = await readStatus(app.ctx.webRoutes)
    const faults = status.faults
    assert.ok(faults !== null && typeof faults === 'object', `no fault map in the status document: ${JSON.stringify(status)}`)
    const fault = faults['a/one']
    assert.ok(fault !== undefined, `the refused target is not reported: ${JSON.stringify(faults)}`)
    assert.equal(fault.code, 'QUOTA', 'the failure code was not kept')
    assert.equal(fault.failover, true, 'a quota refusal is a failover, so the target is being skipped')
    /* The reason is what the page prints next to the red badge, so it has to be
       the adapter's own words and short enough for one line. */
    assert.ok(typeof fault.reason === 'string' && fault.reason.length > 0, 'no human-readable reason')
    assert.ok(!fault.reason.includes('\n'), 'the reason should be one line')
  } finally {
    app.stop()
  }
})

await check('a target that starts working again loses its fault', async () => {
  const app = await boot({ 'a/one': 'QUOTA', 'b/two': 'ok' }, ['a/one', 'b/two'])
  try {
    await post(app.port, app.state.apiKey, { model: 'flash', messages: MESSAGES })
    const before = await readStatus(app.ctx.webRoutes)
    assert.ok(before.faults['a/one'] !== undefined, 'the refusal was not recorded in the first place')

    /* Swap which target is broken: the cursor now starts at b/two, so the next
       request fails there and lands on a/one, which is healthy again. Serving a
       target is what clears its fault — nothing polls in the background. */
    app.llm.plan['a/one'] = 'ok'
    app.llm.plan['b/two'] = 'QUOTA'
    const second = await post(app.port, app.state.apiKey, { model: 'flash', messages: MESSAGES })
    assert.equal(second.status, 200, second.text.slice(0, 200))

    const after = await readStatus(app.ctx.webRoutes)
    assert.equal(after.faults['a/one'], undefined, `a recovered target is still flagged: ${JSON.stringify(after.faults)}`)
    assert.ok(after.faults['b/two'] !== undefined, 'the newly refused target was not flagged')
  } finally {
    app.stop()
  }
})

await check('when every target refuses, the request still reaches one of them', async () => {
  const app = await boot({ 'a/one': 'QUOTA', 'b/two': 'QUOTA' }, ['a/one', 'b/two'])
  try {
    await post(app.port, app.state.apiKey, { model: 'flash', messages: MESSAGES })
    const status = await readStatus(app.ctx.webRoutes)
    assert.equal(status.rotation.routes.length, 1, 'the route should have a cursor after a full lap')
    // A full lap wraps: the head is where the next request starts again, so a
    // chain of refusals costs one lap per request rather than sticking on one.
    assert.equal(status.rotation.routes[0].next, 'a/one', 'the cursor did not wrap to the head')

    app.llm.calls.length = 0
    const third = await post(app.port, app.state.apiKey, { model: 'flash', messages: MESSAGES })
    assert.equal(third.status, 429, `expected a real upstream refusal, got ${third.status}`)
    assert.deepEqual(app.llm.calls, ['a/one', 'b/two'], 'the whole chain was not tried exactly once')
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

await check('a target whose provider has no credential is stepped over', async () => {
  /* The reported failure, reproduced. A provider listed without an `apiKeyEnv`
     makes the pi-ai adapter refuse before any network call:

        PI_AI_ERROR  No API key for provider: opencode-zen

     No `status`, and a `code` (`PI_AI_ERROR`) that names the adapter rather than
     the problem, so neither the code set nor the status set nor the quota text
     matched: the nine-target route answered 502 on its first target while eight
     healthy ones sat behind it. A missing credential is entirely the target's
     own problem, so the route has to walk past it. */
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
            failure: { code: 'PI_AI_ERROR', message: 'No API key for provider: opencode-zen' },
          },
        }
      },
    }
  })
  try {
    const res = await post(app.port, app.state.apiKey, { model: 'flash', messages: MESSAGES })
    assert.equal(res.status, 200, `an unconfigured target killed the route: ${res.text.slice(0, 300)}`)
    assert.ok(res.text.includes('served-by:b/two'), 'the healthy target was never tried')
    assert.deepEqual(app.llm.calls, ['a/one', 'b/two'], `wrong target order: ${JSON.stringify(app.llm.calls)}`)
  } finally {
    app.stop()
  }
})

await check('a request that walked past a dead target is recorded as answered', async () => {
  /* The record is what the dashboard shows and what "it dropped again" is
     answered from, so it must describe the request, not its first attempt. A
     target that refuses writes its failure onto the trace; when a later target
     answers, that failure is stale. Left in place, a request that succeeded on
     its fourth target showed up as an error naming the first target's problem. */
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
            failure: { code: 'PI_AI_ERROR', message: 'No API key for provider: opencode-zen' },
          },
        }
      },
    }
  })
  try {
    const res = await post(app.port, app.state.apiKey, { model: 'flash', messages: MESSAGES })
    assert.equal(res.status, 200, `the route did not recover: ${res.text.slice(0, 300)}`)
    const trace = app.state.recent[0]
    assert.equal(trace.outcome, 'ok', `a served request was recorded as ${trace.outcome}: ${trace.code}`)
    assert.equal(trace.code, undefined, `the dead target's code was left on a served request: ${trace.code}`)
    assert.equal(trace.message, undefined, `the dead target's message was left on a served request: ${trace.message}`)
    assert.equal(trace.provider, 'b', `the record names the wrong target: ${trace.provider}`)
    assert.ok(trace.attempts >= 2, `the record lost the attempt count: ${trace.attempts}`)
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

await check('a renamed provider is skipped rather than retried every request', async () => {
  // The stale row costs one round-trip, then the cursor moves past it.
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

await check('a request with images is routed to a vision-capable target first', async () => {
  /* A text-only target handed an image does not fail — it answers with the
     omission placeholder, which reads like a refusal. The known-vision target
     has to move to the front so the first try can actually see the image. */
  const app = await boot({ 'b/two': 'ok' }, ['a/one', 'b/two'])
  try {
    // Teach the catalogue that b/two's provider advertises a vision model.
    const original = app.llm.prepareCall
    app.llm.prepareCall = original
    app.state.catalog = {
      at: Date.now(),
      entries: [
        { provider: 'a', model: { id: 'one', name: 'text-model' } },
        { provider: 'b', model: { id: 'two', name: 'Gemini Flash' } },
      ],
    }
    app.llm.calls.length = 0

    const image = { type: 'image_url', image_url: { url: 'data:image/png;base64,iVBORw0KGgo=' } }
    const res = await post(app.port, app.state.apiKey, {
      model: 'flash',
      messages: [{ role: 'user', content: [{ type: 'text', text: 'what is this' }, image] }],
    })
    assert.equal(res.status, 200, res.text.slice(0, 240))
    assert.ok(res.text.includes('served-by:b/two'), 'the vision target did not serve')
    assert.deepEqual(
      app.llm.calls,
      ['b/two'],
      `the vision target was not tried first: ${JSON.stringify(app.llm.calls)}`,
    )
  } finally {
    app.stop()
  }
})

await check('a text-only request keeps the caller’s target order', async () => {
  const app = await boot({ 'a/one': 'ok' }, ['a/one', 'b/two'])
  try {
    app.state.catalog = {
      at: Date.now(),
      entries: [{ provider: 'b', model: { id: 'two', name: 'Gemini Flash' } }],
    }
    app.llm.calls.length = 0

    const res = await post(app.port, app.state.apiKey, {
      model: 'flash',
      messages: [{ role: 'user', content: 'plain text question' }],
    })
    assert.equal(res.status, 200, res.text.slice(0, 240))
    assert.deepEqual(
      app.llm.calls,
      ['a/one'],
      `a text request was reordered: ${JSON.stringify(app.llm.calls)}`,
    )
  } finally {
    app.stop()
  }
})

/* ----------------------------------------------------------------- verdict */

rmSync(home, { recursive: true, force: true })
const failed = results.filter((entry) => !entry[0])
console.log(`\n${results.length - failed.length}/${results.length} checks passed`)
process.exit(failed.length === 0 ? 0 : 1)
