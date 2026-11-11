/**
 * Client render smoke test.
 *
 * The browser half is a `window.__ModuleLoader__.load` factory, so it is loaded
 * here with a minimal fake `react` and a fake `window`, then the page component
 * is rendered against a status document shaped exactly like the host's.
 *
 * This is a structural check, not a visual one. It proves the page builds a
 * tree without a missing identifier (a throw here blanks the slot entry), that
 * the dashboard sections exist, that the address a client should copy is the
 * public one, and that the counters read the fields the host actually sends.
 * It says nothing about how the page looks; that judgement needs the live UI.
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))

/* -------------------------------------------------------------- fake react */

/**
 * The page is built once per pass, so a real state machine is unnecessary:
 * `useState` returns `HOOKS.status` for the first slot (the status document)
 * and the supplied initial value for every other slot. A function initializer
 * is invoked, which is what React does. Setting `HOOKS.status` before a render
 * is exactly what "the page loaded that document" means here.
 */
const HOOKS = { status: null, slots: [] }

const react = {
  createElement: (type, props, ...children) => ({ type, props: props ?? {}, children: children.flat() }),
  useCallback: (fn) => fn,
  useEffect: (fn) => {
    HOOKS.effects = (HOOKS.effects ?? []).concat(fn)
  },
  useState: (initial) => {
    const index = HOOKS.slots.length
    const value =
      index === 0 && HOOKS.status !== null
        ? HOOKS.status
        : typeof initial === 'function'
          ? initial()
          : initial
    HOOKS.slots.push(value)
    return [value, () => {}]
  },
}

/* ------------------------------------------------------------- fake window */

const registered = {}
const fakeDocument = {
  createElement: () => ({ style: {}, setAttribute() {}, remove() {} }),
  head: { appendChild() {} },
  body: { appendChild() {}, removeChild() {} },
}
const g = {
  __ModuleLoader__: { load: (spec) => { registered.spec = spec } },
  document: fakeDocument,
}
globalThis.window = g
globalThis.document = fakeDocument

/* ------------------------------------------------------------------ load */

const source = readFileSync(join(here, '..', 'client.js'), 'utf8')
// The file calls `window.__ModuleLoader__.load({…})`; evaluate it with our fake.
new Function('window', source)(g)

assert.ok(registered.spec !== undefined, 'client.js did not register a module')
const factory = registered.spec.factory
const module = factory((name) => {
  if (name === 'react') return react
  throw new Error(`unexpected module request: ${name}`)
})

assert.equal(typeof module.apply, 'function', 'no apply export')
assert.ok(Array.isArray(module.inject), 'no inject export')
assert.equal(module.name, 'dsh-openai-gateway')

/* ---------------------------------------------------- collect the page comp */

// `apply` registers the page into slots; the fake ctx records the factory.
let pageComponent
const fakeCtx = {
  effect: (fn) => fn(),
  locale: { register: () => {}, bind: () => (key) => key },
  slots: {
    inject: (_name, factoryFn) => factoryFn(),
    register: (_spec, component) => {
      if (pageComponent === undefined) pageComponent = component
    },
  },
}
module.apply(fakeCtx)
assert.equal(typeof pageComponent, 'function', 'no page component registered')

/* ------------------------------------------------------------------ render */

const STATUS = {
  id: 'dsh-openai-gateway',
  enabled: true,
  baseUrl: 'https://trickery-unwilling-risk.ngrok-free.dev/v1',
  localBaseUrl: 'http://127.0.0.1:8787/v1',
  port: 8787,
  preferredPort: 8787,
  portFallback: false,
  listenError: null,
  apiKey: 'sk-dsh-o-rllIuMuh2gPlOdm_DUc3bFj_X2S71W',
  settingsFile: 'C:\\Users\\Administrator\\.dsh\\openai-gateway\\settings.json',
  modelCount: 2,
  models: [
    { id: 'provider-a/only-a', provider: 'provider-a' },
    { id: 'provider-b/shared-model', provider: 'provider-b' },
  ],
  aliases: [{ alias: 'gpt-4o', target: 'provider-a/only-a' }],
  tunnel: {
    status: 'running',
    provider: 'ngrok',
    url: 'https://trickery-unwilling-risk.ngrok-free.dev',
    error: null,
    pid: 1234,
    autostart: true,
  },
  providers: [
    { id: 'provider-a', name: 'A', models: 1 },
    { id: 'provider-b', name: 'B', models: 1 },
  ],
  requests: 7,
  failures: 0,
  usageTotals: { inputTokens: 118740, outputTokens: 4211, totalTokens: 122951, calls: 5 },
  bytes: { in: 48210, out: 163842 },
  recent: [
    {
      at: 1793960010426,
      model: 'trae/deepseek-v4.1-flash',
      stream: true,
      attempts: 1,
      outcome: 'ok',
      textBytes: 109,
      reasoningBytes: 401,
      tools: 24,
      systemChars: 43212,
      messages: 1,
      roles: 'user',
      inputTokensEst: 47369,
      firstByteMs: 5314,
      finish: 'stop',
      usage: { inputTokens: 37058, outputTokens: 149, totalTokens: 37207 },
      ms: 7157,
    },
    {
      at: 1793959900000,
      model: 'provider-b/shared-model',
      stream: false,
      attempts: 1,
      outcome: 'error',
      code: 'UNKNOWN_MODEL',
      ms: 812,
    },
  ],
  startedAt: Date.now() - 754000,
  catalogAt: 1,
}

// `useState` slots fill in call order and the first one is the status document,
// so seeding it before the render is exactly what "the page loaded" means here.
function render(status) {
  HOOKS.slots = []
  HOOKS.status = status
  return pageComponent({ t: (key) => key })
}

const rendered = render(STATUS)

function collect(node, out = []) {
  if (node === null || node === undefined || typeof node === 'boolean') return out
  if (typeof node === 'string' || typeof node === 'number') {
    out.push(String(node))
    return out
  }
  if (Array.isArray(node)) {
    for (const child of node) collect(child, out)
    return out
  }
  if (typeof node === 'object') {
    for (const child of node.children ?? []) collect(child, out)
  }
  return out
}

/** Every class name used anywhere in the tree. */
function classes(node, out = new Set()) {
  if (node === null || node === undefined || typeof node === 'boolean') return out
  if (typeof node !== 'object') return out
  if (Array.isArray(node)) {
    for (const child of node) classes(child, out)
    return out
  }
  const className = node.props?.className
  if (typeof className === 'string') {
    for (const part of className.split(/\s+/)) if (part.length > 0) out.add(part)
  }
  for (const child of node.children ?? []) classes(child, out)
  return out
}

const texts = collect(rendered)

/* ------------------------------------------------------------------- checks */

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

await check('the page renders without a missing identifier', () => {
  assert.ok(rendered !== null && typeof rendered === 'object', 'render returned nothing')
  assert.ok(texts.length > 0, 'render produced no text')
})

await check('the public address is shown and is the tunnelled one', () => {
  assert.ok(
    texts.includes('https://trickery-unwilling-risk.ngrok-free.dev/v1'),
    `public URL missing; saw: ${texts.filter((t) => t.startsWith('http')).join(', ')}`,
  )
})

await check('the local address is shown beside it', () => {
  assert.ok(
    texts.includes('http://127.0.0.1:8787/v1'),
    `local URL missing; saw: ${texts.filter((t) => t.startsWith('http')).join(', ')}`,
  )
})

await check('the dashboard layout is present', () => {
  const used = classes(rendered)
  for (const required of ['gw-page', 'gw-head', 'gw-stats', 'gw-grid', 'gw-card', 'gw-table']) {
    assert.ok(used.has(required), `layout class ${required} missing; saw: ${[...used].join(', ')}`)
  }
  /* Five metric tiles: requests, models, tokens, traffic, uptime. */
  const tiles = [...used].filter((name) => name === 'gw-stat')
  assert.ok(tiles.length === 1, 'sanity: gw-stat is a class name, counted once')
})

await check('the metric tiles read the host counters', () => {
  const used = classes(rendered)
  assert.ok(used.has('gw-stat'), 'no metric tiles')
  /* requests=7, failures=0, 2 models, 2 providers */
  assert.ok(texts.includes('7'), `the request count is missing; saw: ${texts.join(' | ')}`)
  assert.ok(texts.includes('stat.failed'), 'the failure hint key is missing')
  /* usageTotals totalTokens 122951 renders as 123k */
  assert.ok(
    texts.includes('123k'),
    `the token total should be abbreviated; saw: ${texts.filter((t) => /k$|M$/.test(t)).join(', ')}`,
  )
  assert.ok(
    texts.includes('stat.tokenHint'),
    'the token in/out hint is missing',
  )
  /* bytes 48210 + 163842 = 212052 -> 207.1 KB */
  assert.ok(
    texts.some((entry) => entry.endsWith('KB')),
    `the traffic tile should show bytes; saw: ${texts.filter((t) => t.includes('B')).join(', ')}`,
  )
})

await check('a host without counters says so instead of showing zero', () => {
  const bare = { ...STATUS, usageTotals: undefined, bytes: undefined }
  const bareTree = render(bare)
  const bareTexts = collect(bareTree)
  assert.ok(bareTexts.includes('stat.noData'), 'a missing counter must not read as zero')
  assert.ok(bareTexts.includes('—'), 'the tile value should be a dash when the host does not count')
})

await check('the tunnel card reports the running tunnel', () => {
  assert.ok(
    texts.includes('page.tunnelRunning · ngrok'),
    `tunnel label missing; saw: ${texts.filter((t) => t.startsWith('page.tunnel')).join(', ')}`,
  )
  assert.ok(
    texts.includes('https://trickery-unwilling-risk.ngrok-free.dev/v1'),
    'the tunnel URL row is missing',
  )
  assert.ok(texts.includes('page.tunnelStop'), 'a running tunnel should offer Stop')
})

await check('the alias table shows the configured alias', () => {
  assert.ok(texts.includes('gpt-4o'), `the alias name is missing; saw: ${texts.join(' | ')}`)
  assert.ok(texts.includes('provider-a/only-a'), 'the alias target is missing')
  assert.ok(texts.includes('page.aliasSave'), 'the save button is missing')
})

await check('the model catalogue is searchable', () => {
  const tree = render(STATUS)
  let searchInput
  const walk = (node) => {
    if (node === null || node === undefined || typeof node !== 'object') return
    if (Array.isArray(node)) {
      for (const child of node) walk(child)
      return
    }
    if (node.type === 'input' && node.props?.type === 'search') searchInput = node
    for (const child of node.children ?? []) walk(child)
  }
  walk(tree)
  assert.ok(searchInput !== undefined, 'no search input')
  assert.equal(searchInput.props['aria-label'], 'search.label', 'the search input needs an accessible name')
})

await check('the recent request table shows both outcomes', () => {
  assert.ok(texts.includes('recent.title'), 'the recent table is missing')
  assert.ok(texts.includes('trae/deepseek-v4.1-flash'), 'the served model is missing')
  assert.ok(texts.includes('recent.ok'), 'a successful request should be marked ok')
  assert.ok(texts.includes('UNKNOWN_MODEL'), 'a failed request should show its code')
  /* 37058 -> 37k (whole thousands above ten thousand), 149 stays exact */
  assert.ok(
    texts.includes('37k → 149'),
    `token in/out should be abbreviated; saw: ${texts.filter((t) => t.includes('→')).join(', ')}`,
  )
  /* The failed row carries no usage, so it must not print 0 → 0. */
  assert.ok(texts.includes('—'), 'a row without usage should render a dash')
})

await check('an empty recent list says so', () => {
  const emptyTree = render({ ...STATUS, recent: [] })
  const emptyTexts = collect(emptyTree)
  assert.ok(emptyTexts.includes('recent.empty'), 'an empty history needs an empty state')
})

await check('the curl example uses the public address', () => {
  const curl = texts.find((entry) => entry.startsWith('curl '))
  assert.ok(curl !== undefined, 'no curl example')
  assert.ok(
    curl.includes('https://trickery-unwilling-risk.ngrok-free.dev/v1/chat/completions'),
    `curl example uses the wrong base: ${curl}`,
  )
})

await check('a failed tunnel surfaces its reason', () => {
  const failedStatus = {
    ...STATUS,
    tunnel: { status: 'failed', provider: 'ngrok', url: null, error: 'ngrok exited with code 1', pid: null, autostart: true },
  }
  const failedTree = render(failedStatus)
  const failedTexts = collect(failedTree)
  assert.ok(failedTexts.includes('ngrok exited with code 1'), 'the tunnel error is not shown')
  assert.ok(failedTexts.includes('page.tunnelStart'), 'a failed tunnel should offer Start')
})

await check('a stopped tunnel does not advertise a dead URL as primary', () => {
  const stoppedStatus = {
    ...STATUS,
    baseUrl: 'http://127.0.0.1:8787/v1',
    tunnel: { status: 'stopped', provider: 'ngrok', url: null, error: null, pid: null, autostart: true },
  }
  const stoppedTree = render(stoppedStatus)
  const stoppedTexts = collect(stoppedTree)
  assert.ok(stoppedTexts.includes('http://127.0.0.1:8787/v1'), 'the local address should be the public row fallback')
  assert.ok(
    stoppedTexts.includes('page.tunnelStopped · ngrok'),
    `the stopped label is missing; saw: ${stoppedTexts.filter((x) => x.startsWith('page.tunnel')).join(', ')}`,
  )
})

await check('the status pill turns on the success dot, not the brand colour', () => {
  const onTree = render(STATUS)
  assert.ok(classes(onTree).has('is-on'), 'a running gateway should use the on-state dot class')
  const offTree = render({ ...STATUS, enabled: false })
  assert.ok(classes(offTree).has('is-bad'), 'a disabled gateway should use the bad-state dot class')
})

await check('the first frame renders while the status document is still null', () => {
  const loadingTree = render(null)
  const loadingTexts = collect(loadingTree)
  assert.ok(loadingTexts.includes('page.loading'), 'the loading state must render before the first read')
  assert.ok(loadingTexts.includes('page.models'), 'the catalogue card should exist before data arrives')
})

const failed = results.filter((entry) => !entry.ok)
console.log(`\n${results.length - failed.length}/${results.length} checks passed`)
process.exit(failed.length === 0 ? 0 : 1)
