/**
 * The guided ngrok setup: does the plugin refuse a bad token, hand a good one to
 * ngrok, and leave every other config file alone?
 *
 * Signing up for an ngrok account is an interactive flow (email verification or
 * an OAuth grant) that ngrok exposes no API for, so the plugin stops at "open
 * the page, take the token back". What it automates is the step after that.
 *
 * ---------------------------------------------------------------------------
 * ISOLATION, and why it is written this way
 *
 * An earlier version of this file put a fake `ngrok.cmd` first on PATH and set
 * NGROK_CONFIG, assuming that would redirect the write. Both assumptions were
 * wrong on Windows, and the checks below passed while a real `ngrok.exe` was
 * rewriting the user's actual authtoken:
 *
 *   1. `spawn('ngrok', …, { shell: false })` does not resolve a `.cmd` shim, so
 *      the real binary ran. (Measured: the shim's marker file stayed empty while
 *      ngrok printed the user's config path.)
 *   2. `ngrok config add-authtoken` ignores NGROK_CONFIG and writes to the
 *      platform default. (Measured: the redirected file never received the
 *      token; the user's did.)
 *
 * So this version does not try to fake ngrok at all. It uses the real binary —
 * which is the honest test of argv — and forces `--config <sandbox>` through
 * the plugin, then asserts the user's config is byte-identical before and after.
 * If ngrok is not installed the write checks are skipped rather than faked.
 *
 * Run:  node tests/authtoken.spec.mjs
 */
import { strict as assert } from 'node:assert'
import { createHash } from 'node:crypto'
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'

const sandbox = mkdtempSync(join(tmpdir(), 'gateway-authtoken-'))
const sandboxConfig = join(sandbox, 'ngrok.yml')
writeFileSync(sandboxConfig, 'version: "3"\n', 'utf8')

process.env.DSH_HOME = mkdtempSync(join(tmpdir(), 'gateway-authtoken-home-'))
const { apply } = await import(new URL('../index.js', import.meta.url).href)

/* ------------------------------------------------------- the real config */

/** The file the user's token lives in, resolved the way the plugin does. */
function userConfigPath() {
  if (typeof process.env.NGROK_CONFIG === 'string' && process.env.NGROK_CONFIG !== '') {
    return process.env.NGROK_CONFIG
  }
  if (process.platform === 'win32') {
    return join(process.env.LOCALAPPDATA ?? '', 'ngrok', 'ngrok.yml')
  }
  return join(process.env.XDG_CONFIG_HOME ?? join(process.env.HOME ?? '', '.config'), 'ngrok', 'ngrok.yml')
}

const USER_CONFIG = userConfigPath()
const beforeHash = existsSync(USER_CONFIG)
  ? createHash('sha256').update(readFileSync(USER_CONFIG)).digest('hex')
  : '(absent)'

/** Does a usable ngrok binary exist? Without one, only the guard paths run. */
let ngrokAvailable = true
try {
  execFileSync('ngrok', ['version'], { stdio: 'ignore', windowsHide: true, timeout: 15_000 })
} catch {
  ngrokAvailable = false
}

/* --------------------------------------------------------------- harness */

const KEY = 'sk-dsh-spec-authtoken-0123456789'
let nextPort = 19440

function mount(config) {
  const port = nextPort++
  const webRoutes = new Map()
  const stream = async function* () {
    yield { type: 'text-delta', text: 'ok' }
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
  const instance = apply(ctx, { enabled: true, port, apiKey: KEY, ...config })
  // `apply` returns the instance state. Point the write at the sandbox: without
  // this the plugin targets the agent's real config, which is exactly the bug
  // this file now guards against.
  assert.ok(instance?.authtoken !== undefined, 'apply() did not return the instance state')
  instance.authtoken.configFile = sandboxConfig
  return { port, webRoutes, instance }
}

function post(webRoutes, path, body, origin = 'http://127.0.0.1') {
  return new Promise((resolve, reject) => {
    const handler = webRoutes.get(path)
    if (handler === undefined) {
      reject(new Error(`${path} was never mounted`))
      return
    }
    const payload = Buffer.from(JSON.stringify(body))
    const req = {
      method: 'POST',
      url: path,
      headers: {
        host: '127.0.0.1',
        origin,
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
      headersSent: false,
      writeHead(code, headers) { this.headersSent = true; this.code = code; this.headers = headers },
      end(raw) {
        let parsed
        try { parsed = JSON.parse(String(raw ?? '{}')) } catch { parsed = undefined }
        resolve({ status: this.code, body: parsed, raw: String(raw ?? '') })
      },
      destroy() { reject(new Error('response destroyed')) },
    }
    handler(req, res)
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

const gateway = mount({})
const TOKEN = 'spec_token_shaped_like_an_ngrok_one_0123456789'

/* ----------------------------------------------------------------- checks */

await check('the status document offers the signup and token pages', async () => {
  const status = await readStatus(gateway.webRoutes)
  assert.ok(status.authtoken !== undefined, 'status.authtoken is missing')
  assert.equal(status.authtoken.signupUrl, 'https://dashboard.ngrok.com/signup')
  assert.equal(status.authtoken.tokenUrl, 'https://dashboard.ngrok.com/get-started/your-authtoken')
})

await check('the status document never carries a token value', async () => {
  const status = await readStatus(gateway.webRoutes)
  assert.equal(status.authtoken.token, undefined, 'a token field must not exist')
  assert.equal(typeof status.authtoken.configured, 'boolean')
  assert.ok(!JSON.stringify(status).includes(TOKEN), 'the token appeared in the status document')
})

await check('a token that is not token-shaped is refused', async () => {
  for (const bad of ['', '   ', 'short', 'has spaces in it which is wrong', 'x'.repeat(19)]) {
    const response = await post(gateway.webRoutes, '/plugins/dsh-openai-gateway/authtoken', { token: bad })
    assert.equal(response.status, 400, `expected 400 for ${JSON.stringify(bad)}, got ${response.status}`)
    assert.equal(response.body.error, 'token-invalid')
  }
})

await check('a malformed body is refused with 400', async () => {
  const response = await post(gateway.webRoutes, '/plugins/dsh-openai-gateway/authtoken', { token: 42 })
  assert.equal(response.status, 400)
  assert.equal(response.body.error, 'token-invalid')
})

await check('a cross-origin POST is refused', async () => {
  const response = await post(
    gateway.webRoutes,
    '/plugins/dsh-openai-gateway/authtoken',
    { token: TOKEN },
    'https://evil.example',
  )
  assert.equal(response.status, 403, `expected 403, got ${response.status}`)
})

if (!ngrokAvailable) {
  console.log('note: ngrok is not installed, so the write path is not exercised here')
} else {
  await check('a good token is written to the config file it was told to use', async () => {
    const response = await post(gateway.webRoutes, '/plugins/dsh-openai-gateway/authtoken', { token: TOKEN })
    assert.equal(response.status, 200, `expected 200, got ${response.status}: ${response.raw}`)
    assert.equal(response.body.ok, true)
    const written = readFileSync(sandboxConfig, 'utf8')
    assert.ok(written.includes(TOKEN), `the sandbox config did not receive the token:\n${written}`)
  })

  await check('the reply reports where the token was written', async () => {
    const response = await post(gateway.webRoutes, '/plugins/dsh-openai-gateway/authtoken', { token: TOKEN })
    assert.equal(response.status, 200)
    assert.equal(response.body.file, sandboxConfig, `reported ${response.body.file}, expected the sandbox path`)
  })

  await check('the saved token is not echoed back', async () => {
    const response = await post(gateway.webRoutes, '/plugins/dsh-openai-gateway/authtoken', { token: TOKEN })
    assert.ok(!response.raw.includes(TOKEN), 'the reply echoed the token')
  })

  await check('after saving, the status document says a token is configured', async () => {
    const status = await readStatus(gateway.webRoutes)
    assert.equal(status.authtoken.configured, true, 'configured stayed false after a successful write')
    assert.ok(typeof status.authtoken.at === 'number', 'no timestamp for the write')
  })
}

/* ------------------------------------------------- the guard that matters */

await check("the user's own ngrok config is byte-identical afterwards", async () => {
  const afterHash = existsSync(USER_CONFIG)
    ? createHash('sha256').update(readFileSync(USER_CONFIG)).digest('hex')
    : '(absent)'
  assert.equal(
    afterHash,
    beforeHash,
    `the real ngrok config changed during the test (${USER_CONFIG}); the write path escaped its sandbox`,
  )
})

await check('no config file outside the sandbox received the test token', async () => {
  const suspects = [USER_CONFIG, join(process.env.HOME ?? '', '.ngrok2', 'ngrok.yml')]
  for (const file of suspects) {
    if (!existsSync(file)) continue
    const text = readFileSync(file, 'utf8')
    assert.ok(!text.includes(TOKEN), `the test token leaked into ${file}`)
  }
})

/* --------------------------------------------------------------- verdict */

let passed = 0
for (const [ok, name] of results) {
  console.log(`${ok ? 'ok  ' : 'FAIL'}  ${name}`)
  if (ok) passed += 1
}
console.log(`\n${passed}/${results.length} checks passed`)
if (passed !== results.length) process.exitCode = 1
// The gateway keeps a listener open; end the process deliberately.
process.exit(passed === results.length ? 0 : 1)
