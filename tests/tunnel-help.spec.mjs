/**
 * What the page says when a tunnel cannot start.
 *
 * The failure this covers is the common one: ngrok has no credential, so it
 * prints ERR_NGROK_4018 along with the two URLs that fix it, and exits. The old
 * code reported only "ngrok exited with code 1" and dropped the URLs, leaving
 * the user with a true statement and no next step.
 *
 * ---------------------------------------------------------------------------
 * Why the stand-in runs as `node <script>` rather than as a fake `ngrok` on PATH
 *
 * An earlier spec put a `ngrok.cmd` first on PATH and assumed `spawn` would run
 * it. On Windows, `spawn('ngrok', …, { shell: false })` resolves an executable
 * image and ignores `.cmd` entirely — so the REAL ngrok ran, and rewrote a real
 * authtoken. Measured both ways in `tests/probe-substitution.mjs`:
 * `spawn('shim')` → ENOENT when only `shim.cmd` exists, while
 * `spawn(process.execPath, [script])` works. The plugin therefore exposes
 * `state.tunnelCommand` and this test drives that, never touching PATH and
 * never being able to reach the real agent.
 *
 * Run:  node tests/tunnel-help.spec.mjs
 */
import { strict as assert } from 'node:assert'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { apply } from '../index.js'

const sandbox = mkdtempSync(join(tmpdir(), 'gw-tunnel-help-'))
process.env.DSH_HOME = mkdtempSync(join(tmpdir(), 'gw-tunnel-help-home-'))

const KEY = 'sk-dsh-tunnel-help-0123456789'
let nextPort = 19620

/** A stand-in agent that fails the way ngrok does without a credential. */
const NEEDS_CREDENTIAL = join(sandbox, 'needs-credential.js')
writeFileSync(
  NEEDS_CREDENTIAL,
  `const line = (o) => process.stdout.write(JSON.stringify(o) + "\\n")
line({ lvl: "info", msg: "starting web service" })
line({
  lvl: "eror",
  msg: "failed to reconnect session",
  err: "authentication failed: This ngrok session is not authenticated. ngrok requires an account and a valid credential to start a session.\\n\\nSign up for an account: https://dashboard.ngrok.com/signup\\nGet your credential: https://dashboard.ngrok.com/get-started/your-authtoken\\r\\n\\r\\nERR_NGROK_4018\\r\\n",
})
process.stderr.write("ERROR:  authentication failed\\n")
process.exit(1)
`,
  'utf8',
)

/** A stand-in that fails for some unrelated reason. */
const OTHER_FAILURE = join(sandbox, 'other-failure.js')
writeFileSync(
  OTHER_FAILURE,
  `process.stderr.write("ERROR:  bind: An attempt was made to access a socket in a way forbidden by its access permissions\\n")
process.exit(1)
`,
  'utf8',
)

/** A stand-in that publishes a URL and then stays up. */
const PUBLISHES = join(sandbox, 'publishes.js')
writeFileSync(
  PUBLISHES,
  `process.stdout.write(JSON.stringify({ lvl: "info", msg: "started tunnel", url: "https://standin-test.ngrok-free.dev" }) + "\\n")
setInterval(() => {}, 1000)
`,
  'utf8',
)

function mount(tunnel, script) {
  const port = nextPort++
  const webRoutes = new Map()
  const ctx = {
    llm: {
      listProviders: () => [{ id: 'fake', name: 'fake' }],
      listModels: async () => [{ id: 'm1', name: 'm1' }],
      prepareCall: async () => ({ config: {}, stream: async function* () {} }),
    },
    get: (key) =>
      key === 'webServer'
        ? { register: (route) => { webRoutes.set(route.path, route.handler); return () => {} } }
        : undefined,
    effect: () => {},
    on: () => () => {},
    logger: { warn: () => {}, error: () => {}, info: () => {} },
  }
  const state = apply(ctx, { enabled: true, port, apiKey: KEY, tunnel })
  if (script !== undefined) {
    state.tunnelCommand = { command: process.execPath, prefixArgs: [script] }
  }
  return { webRoutes, state }
}

function readStatus(webRoutes) {
  return new Promise((resolve, reject) => {
    const handler = webRoutes.get('/plugins/dsh-openai-gateway/status')
    if (handler === undefined) { reject(new Error('status route never mounted')); return }
    const res = {
      writeHead() {},
      end(payload) { resolve(JSON.parse(String(payload ?? '{}'))) },
      destroy() { reject(new Error('destroyed')) },
    }
    handler({ method: 'GET', headers: { host: '127.0.0.1' }, url: '/plugins/dsh-openai-gateway/status' }, res)
  })
}

/** Start the tunnel and wait until it stops being `starting`. */
async function startAndSettle(state, webRoutes) {
  await new Promise((resolve, reject) => {
    const handler = webRoutes.get('/plugins/dsh-openai-gateway/tunnel')
    if (handler === undefined) { reject(new Error('tunnel route never mounted')); return }
    const payload = Buffer.from(JSON.stringify({ action: 'start' }))
    const req = {
      method: 'POST',
      url: '/plugins/dsh-openai-gateway/tunnel',
      headers: {
        host: '127.0.0.1',
        origin: 'http://127.0.0.1',
        'content-type': 'application/json',
        'content-length': String(payload.length),
      },
      on(event, listener) {
        if (event === 'data') listener(payload)
        if (event === 'end') setImmediate(listener)
        return this
      },
    }
    const res = { writeHead() {}, end() { resolve() }, destroy() { reject(new Error('destroyed')) } }
    handler(req, res)
  })
  for (let i = 0; i < 300; i += 1) {
    if (state.tunnel.status === 'failed' || state.tunnel.status === 'running') return
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
  throw new Error(`tunnel never settled: ${state.tunnel.status}`)
}

const results = []
async function check(name, run) {
  try { await run(); results.push([true, name]) } catch (error) { results.push([false, `${name} — ${error.message}`]) }
}

/* ----------------------------------------------------------------- checks */

await check('a missing credential is named, not hidden behind an exit code', async () => {
  const { webRoutes, state } = mount({ provider: 'ngrok' }, NEEDS_CREDENTIAL)
  await startAndSettle(state, webRoutes)
  assert.equal(state.tunnel.status, 'failed')
  const message = String(state.tunnel.error ?? '')
  assert.ok(
    !/^ngrok exited with code 1$/.test(message),
    `the failure is still the bare exit code: ${message}`,
  )
  assert.match(message, /authtoken/i, `the message does not mention the authtoken: ${message}`)
  assert.match(message, /add-authtoken/, `the message does not say what to run: ${message}`)
})

await check('the status document offers the signup and token pages', async () => {
  const { webRoutes, state } = mount({ provider: 'ngrok' }, NEEDS_CREDENTIAL)
  await startAndSettle(state, webRoutes)
  const status = await readStatus(webRoutes)
  assert.equal(status.tunnel.status, 'failed')
  assert.equal(status.tunnel.needsCredential, true, 'the page is not told that a credential is what is missing')
  assert.equal(status.tunnel.signupUrl, 'https://dashboard.ngrok.com/signup')
  assert.equal(status.tunnel.tokenUrl, 'https://dashboard.ngrok.com/get-started/your-authtoken')
})

await check('needsCredential stays false for an unrelated failure', async () => {
  const { webRoutes, state } = mount({ provider: 'ngrok' }, OTHER_FAILURE)
  await startAndSettle(state, webRoutes)
  const status = await readStatus(webRoutes)
  assert.equal(status.tunnel.status, 'failed')
  assert.equal(status.tunnel.needsCredential, false, 'an unrelated failure must not be reported as a missing credential')
})

await check('an unrelated failure keeps the reason the agent gave', async () => {
  const { webRoutes, state } = mount({ provider: 'ngrok' }, OTHER_FAILURE)
  await startAndSettle(state, webRoutes)
  const message = String(state.tunnel.error ?? '')
  assert.match(message, /socket|forbidden|access permissions/i, `the real reason was lost: ${message}`)
})

await check('a tunnel that publishes a URL is still reported as running', async () => {
  const { webRoutes, state } = mount({ provider: 'ngrok' }, PUBLISHES)
  await startAndSettle(state, webRoutes)
  assert.equal(state.tunnel.status, 'running', `expected running, got ${state.tunnel.status}: ${state.tunnel.error ?? ''}`)
  assert.equal(state.tunnel.url, 'https://standin-test.ngrok-free.dev')
  const status = await readStatus(webRoutes)
  assert.equal(status.tunnel.needsCredential, false, 'a healthy tunnel must not claim it needs a credential')
})

await check('the tunnel block is identical on the status route and the control route', async () => {
  const { webRoutes, state } = mount({ provider: 'ngrok' }, NEEDS_CREDENTIAL)
  await startAndSettle(state, webRoutes)
  const status = await readStatus(webRoutes)
  // The control route is POST-only, so this reads the tunnel back by asking it
  // to stop — which reports the same block without starting anything.
  const control = await new Promise((resolve, reject) => {
    const handler = webRoutes.get('/plugins/dsh-openai-gateway/tunnel')
    if (handler === undefined) { reject(new Error('tunnel route never mounted')); return }
    const payload = Buffer.from(JSON.stringify({ action: 'stop' }))
    const req = {
      method: 'POST',
      url: '/plugins/dsh-openai-gateway/tunnel',
      headers: {
        host: '127.0.0.1',
        origin: 'http://127.0.0.1',
        'content-type': 'application/json',
        'content-length': String(payload.length),
      },
      on(event, listener) {
        if (event === 'data') listener(payload)
        if (event === 'end') setImmediate(listener)
        return this
      },
    }
    const res = {
      writeHead() {},
      end(body) { resolve(JSON.parse(String(body ?? '{}'))) },
      destroy() { reject(new Error('destroyed')) },
    }
    handler(req, res)
  })
  assert.ok(control.tunnel !== undefined, 'the control route returned no tunnel block')
  assert.equal(control.tunnel.needsCredential, status.tunnel.needsCredential, 'the two routes disagree about the credential flag')
  assert.equal(control.tunnel.signupUrl, status.tunnel.signupUrl, 'the two routes disagree about the signup URL')
  assert.equal(control.tunnel.tokenUrl, status.tunnel.tokenUrl, 'the two routes disagree about the token URL')
})

/* --------------------------------------------------------------- verdict */

let passed = 0
for (const [ok, name] of results) {
  console.log(`${ok ? 'ok  ' : 'FAIL'}  ${name}`)
  if (ok) passed += 1
}
console.log(`\n${passed}/${results.length} checks passed`)
process.exit(passed === results.length ? 0 : 1)
