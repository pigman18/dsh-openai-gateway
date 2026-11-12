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

/** Boot a gateway with one alias pointing at `targets`, in order. */
async function boot(plan, targets, { alias = 'flash' } = {}) {
  const llm = fakeLlm(plan)
  const ctx = fakeCtx(llm)
  const state = apply(ctx, {
    port: await freePort(),
    aliases: { [alias]: targets },
  })
  const port = await waitForPort(state)
  return { llm, ctx, state, port, alias, stop: () => ctx.disposeAll() }
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

/* ----------------------------------------------------------------- verdict */

rmSync(home, { recursive: true, force: true })
const failed = results.filter((entry) => !entry[0])
console.log(`\n${results.length - failed.length}/${results.length} checks passed`)
process.exit(failed.length === 0 ? 0 : 1)
