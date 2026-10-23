/**
 * Regression: the catalog the page carries must be REBUILT, never replayed.
 *
 * Both failures below are invisible on a profile whose providers all answer
 * during boot — which is why they only showed up in the wild as "WorkBuddy
 * and Qoder disappeared from the page":
 *
 *   1. the boot warm loop stopped at the first non-empty pass, so the cached
 *      catalog predated every adapter that was still binding (a plugin later
 *      in the profile registers its provider after the loop has started);
 *   2. the status route never rebuilt that snapshot, so the page's Refresh
 *      button replayed the same frozen list for the whole session, and no
 *      amount of clicking brought the missing providers back.
 *
 * Run:  node tests/catalog-refresh.spec.mjs
 *       GATEWAY_ENTRY=<file-or-url> node tests/catalog-refresh.spec.mjs   # pre-fix build
 */
import { strict as assert } from 'node:assert'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

// The plugin persists its key under $DSH_HOME; keep the real profile untouched.
process.env.DSH_HOME = mkdtempSync(join(tmpdir(), 'gateway-spec-'))

const configured = process.env.GATEWAY_ENTRY
const entry = configured === undefined
  ? new URL('../index.js', import.meta.url).href
  : /^[a-z]+:\/\//i.test(configured) ? configured : pathToFileURL(configured).href
const { apply } = await import(entry)

const STATUS_PATH = '/plugins/dsh-openai-gateway/status'
const settle = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/** A host stand-in: providers that register at chosen moments, models that lag. */
function mount(config) {
  const providers = ['alpha']
  const reporting = new Set(['alpha'])
  const routes = new Map()
  const ctx = {
    llm: {
      listProviders: () => providers.map((id) => ({ id, name: id })),
      listModels: async (id) => (reporting.has(id) ? [{ id: `${id}-1`, name: `${id}-1` }] : []),
    },
    get: (key) => (key === 'webServer'
      ? { register: (route) => { routes.set(route.path, route.handler); return () => {} } }
      : undefined),
    effect: () => {},
    on: () => () => {},
    logger: { warn: () => {}, error: () => {}, info: () => {} },
  }
  apply(ctx, config)
  const bind = (id) => { providers.push(id); reporting.add(id) }
  return { bind, providers, reporting, routes }
}

/** Drive the page's one read through the host route, exactly as the browser does. */
function read(routes, query = '') {
  return new Promise((resolve, reject) => {
    const handler = routes.get(STATUS_PATH)
    if (handler === undefined) { reject(new Error('status route never mounted')); return }
    const res = {
      headersSent: false,
      writeHead(code, headers) { this.headersSent = true; this.code = code; this.headers = headers },
      end(payload) { resolve({ code: this.code, body: JSON.parse(String(payload ?? '{}')) }) },
      destroy() { reject(new Error('response destroyed')) },
    }
    handler({ method: 'GET', headers: { host: '127.0.0.1' }, url: STATUS_PATH + query }, res)
  })
}

const idsOf = (page) => (page.body.models ?? []).map((model) => model.id)
const results = []
async function check(name, run) {
  try { await run(); results.push([true, name]) }
  catch (error) { results.push([false, `${name} — ${error.message}`]) }
}

// ---- 1. A provider that binds after the first pass still reaches the page ----
const longTtl = mount({ enabled: true, port: 18997, catalogTtlMs: 60_000, apiKey: 'sk-dsh-spec-0123456789' })
await settle(2_000)                      // warm pass 1 has already run and seen alpha
longTtl.bind('beta')                     // adapter resolves its credential late
await settle(7_000)                      // longer than the warm settle window (6 s)

await check('warm loop keeps watching until the provider set settles', async () => {
  const page = await read(longTtl.routes)   // no ?refresh: what a plain page open sees
  assert.ok(idsOf(page).includes('beta/beta-1'),
    `catalog never picked up the late provider; page showed: ${idsOf(page).join(', ') || '(empty)'}`)
})

// ---- 2. Refresh rebuilds even inside the TTL; a plain read still caches ----
longTtl.bind('gamma')

await check('a plain read inside the TTL serves the cached snapshot', async () => {
  const page = await read(longTtl.routes)
  assert.ok(!idsOf(page).includes('gamma/gamma-1'),
    'expected the cached snapshot; the read rebuilt instead, so this test proves nothing')
})

await check('?refresh=1 forces a rebuild (the page Refresh button)', async () => {
  const page = await read(longTtl.routes, '?refresh=1')
  assert.ok(idsOf(page).includes('gamma/gamma-1'),
    `Refresh replayed the frozen snapshot; page showed: ${idsOf(page).join(', ') || '(empty)'}`)
})

// ---- 3. An expired snapshot is rebuilt without anyone asking ----
const shortTtl = mount({ enabled: true, port: 18998, catalogTtlMs: 150, apiKey: 'sk-dsh-spec-0123456789' })
await settle(1_000)
shortTtl.bind('delta')
await settle(700)                        // past the 150 ms TTL

await check('an expired catalog is rebuilt on the next page read', async () => {
  const page = await read(shortTtl.routes)
  assert.ok(idsOf(page).includes('delta/delta-1'),
    `TTL expiry did not trigger a rebuild; page showed: ${idsOf(page).join(', ') || '(empty)'}`)
})

for (const [ok, name] of results) console.log(`${ok ? 'ok  ' : 'FAIL'}  ${name}`)
const failed = results.filter(([ok]) => !ok).length
console.log(`\n${results.length - failed}/${results.length} checks passed`)
process.exit(failed === 0 ? 0 : 1)
