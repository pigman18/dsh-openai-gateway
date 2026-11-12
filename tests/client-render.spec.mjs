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
const HOOKS = { status: null, slots: [], openEditor: null }

/** The route editor's position in the page's `useState` call order. */
const EDITOR_SLOT = 8

const react = {
  createElement: (type, props, ...children) => ({ type, props: props ?? {}, children: children.flat() }),
  useCallback: (fn) => fn,
  useEffect: (fn) => {
    HOOKS.effects = (HOOKS.effects ?? []).concat(fn)
  },
  useState: (initial) => {
    const index = HOOKS.slots.length
    let value =
      index === 0 && HOOKS.status !== null
        ? HOOKS.status
        : typeof initial === 'function'
          ? initial()
          : initial
    // `HOOKS.openEditor` stands in for pressing a row's Edit button. The route
    // editor is declared eighth (see the slot order in client.js: status,
    // failed, copied, revealed, portDraft, notice, confirmKey, aliasDraftRows,
    // editor). Matching on index rather than on "the first null" avoids being
    // consumed by an earlier null slot such as `notice`.
    if (index === EDITOR_SLOT && HOOKS.openEditor !== null) value = HOOKS.openEditor
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
  aliases: [{ alias: 'gpt-4o', targets: ['provider-a/only-a'] }],
  failover: { cooldownMs: 300000, cooling: [] },
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
  for (const required of [
    'gw-page',
    'gw-head',
    'gw-tabs',
    'gw-panel',
    'gw-stats',
    'gw-card',
    'gw-table',
  ]) {
    assert.ok(used.has(required), `layout class ${required} missing; saw: ${[...used].join(', ')}`)
  }
  /* Five metric tiles: requests, models, tokens, traffic, uptime. */
  const tiles = [...used].filter((name) => name === 'gw-stat')
  assert.ok(tiles.length === 1, 'sanity: gw-stat is a class name, counted once')
})

await check('the tab bar carries the five panels in order', () => {
  const tabButtons = []
  const panelNodes = []
  const walk = (node) => {
    if (node === null || node === undefined || typeof node !== 'object') return
    if (Array.isArray(node)) {
      for (const child of node) walk(child)
      return
    }
    const className = node.props?.className
    if (typeof className === 'string' && node.type === 'button' && className.split(' ').includes('gw-tab')) {
      tabButtons.push({ className, text: collect(node).join('') })
    }
    if (typeof className === 'string' && className.split(' ').includes('gw-panel')) {
      panelNodes.push(className)
    }
    for (const child of node.children ?? []) walk(child)
  }
  walk(rendered)

  assert.equal(tabButtons.length, 5, `expected 5 tabs; saw ${tabButtons.length}`)
  const labels = tabButtons.map((button) => button.text)
  assert.deepEqual(
    labels,
    ['tab.overview', 'tab.routes1', 'tab.tunnel', 'tab.catalog', 'tab.settings'],
    `tab labels are wrong: ${labels.join(' | ')}`,
  )

  assert.equal(panelNodes.length, 5, `expected 5 panels; saw ${panelNodes.length}`)
  /* Exactly one panel is laid out: the rest are display:none, which also takes
     them out of the accessibility tree. */
  const active = panelNodes.filter((className) => className.split(' ').includes('is-active'))
  assert.equal(active.length, 1, `exactly one panel may be active; saw ${active.length}`)
  assert.ok(
    tabButtons[0].className.includes('is-active'),
    'the first tab should be the active one on a fresh load',
  )
})

await check('the tunnel tab reports the running tunnel', () => {
  assert.ok(
    texts.includes('page.tunnelRunning'),
    `tunnel label missing; saw: ${texts.filter((t) => t.startsWith('page.tunnel')).join(', ')}`,
  )
  /* The hero is where the copyable address lives. */
  const heroUrl = texts.filter((entry) => entry === 'https://trickery-unwilling-risk.ngrok-free.dev/v1')
  assert.ok(heroUrl.length >= 1, 'the tunnel URL row is missing')
  assert.ok(texts.includes('page.tunnelStop'), 'a running tunnel should offer Stop')
  assert.ok(texts.includes('tunnel.heroRunning'), 'a running tunnel should label the hero as the public address')
  assert.ok(texts.includes('ngrok'), 'the provider should be named')
})

await check('the overview bar links the tunnel state to its tab', () => {
  const used = classes(rendered)
  assert.ok(used.has('gw-bar'), 'the overview tunnel bar is missing')
  assert.ok(used.has('gw-bar-meta'), 'the overview tunnel bar has no detail line')
  assert.ok(texts.includes('tunnel.title'), 'the overview bar should name the tunnel')
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
    texts.includes('page.tunnelRunning'),
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

await check('a multi-target alias renders every target, in try order', () => {
  const tree = render({
    ...STATUS,
    aliases: [
      {
        alias: 'deepseek-flash',
        targets: [
          'our-free-model/deepseek-v4.1-flash-free',
          'trae/deepseek-v4.1-flash',
          'trae-global/deepseek-v4.1-flash',
        ],
      },
    ],
    failover: { cooldownMs: 300000, cooling: [] },
  })
  const rendered = collect(tree)
  assert.ok(rendered.includes('deepseek-flash'), 'the alias name is missing')

  /* Every target is present, and each hop carries its 1-based try position.
     The position is what replaces the old "→ " prefix: it says the same thing
     (this is a fallback, tried later) without relying on a glyph. */
  const hops = []
  const walk = (node) => {
    if (node === null || node === undefined || typeof node !== 'object') return
    if (Array.isArray(node)) {
      for (const child of node) walk(child)
      return
    }
    const className = node.props?.className
    if (typeof className === 'string' && className.split(' ').includes('gw-hop')) {
      const inner = collect(node)
      /* The index badge is a nested span; `is-first` lives there. */
      let idxClass = ''
      let badge = ''
      const scan = (child) => {
        if (child === null || child === undefined || typeof child !== 'object') return
        if (Array.isArray(child)) {
          for (const grandchild of child) scan(grandchild)
          return
        }
        const cls = child.props?.className
        if (typeof cls === 'string' && cls.split(' ').includes('gw-hop-idx')) idxClass = cls
        if (typeof cls === 'string' && cls.split(' ').includes('gw-badge')) badge = collect(child).join('')
        for (const grandchild of child.children ?? []) scan(grandchild)
      }
      scan(node)
      hops.push({
        className,
        idxClass,
        badge,
        index: inner.find((entry) => /^\d+$/.test(entry)),
        target: inner.find((entry) => entry.includes('/')),
      })
    }
    for (const child of node.children ?? []) walk(child)
  }
  walk(tree)

  assert.equal(hops.length, 3, `expected 3 hops; saw ${hops.length}`)
  assert.deepEqual(
    hops.map((hop) => hop.target),
    [
      'our-free-model/deepseek-v4.1-flash-free',
      'trae/deepseek-v4.1-flash',
      'trae-global/deepseek-v4.1-flash',
    ],
    `targets are out of try order: ${hops.map((hop) => hop.target).join(' | ')}`,
  )
  assert.deepEqual(
    hops.map((hop) => hop.index),
    ['1', '2', '3'],
    `hops are not numbered by try order: ${hops.map((hop) => hop.index).join(', ')}`,
  )
  /* Only the first hop is the primary; the rest are fallbacks. */
  assert.ok(hops[0].idxClass.includes('is-first'), 'the primary target should be marked as the first hop')
  assert.ok(!hops[1].idxClass.includes('is-first'), 'a fallback target must not be marked primary')
  assert.deepEqual(
    hops.map((hop) => hop.badge),
    ['routes.primary', 'routes.fallback', 'routes.fallback'],
    `the primary/fallback labels are wrong: ${hops.map((hop) => hop.badge).join(', ')}`,
  )
})

await check('a benched target is marked in the chain', () => {
  const tree = render({
    ...STATUS,
    aliases: [{ alias: 'deepseek-flash', targets: ['a/one', 'b/two'] }],
    failover: {
      cooldownMs: 300000,
      cooling: [{ target: 'a/one', code: 'QUOTA', message: 'quota spent', remainingMs: 240000, until: Date.now() + 240000 }],
    },
  })
  assert.ok(classes(tree).has('is-cooling'), 'no target was marked as cooling down')
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
    stoppedTexts.includes('page.tunnelStopped'),
    `the stopped label is missing; saw: ${stoppedTexts.filter((x) => x.startsWith('page.tunnel')).join(', ')}`,
  )
  /* With no URL the hero must say so rather than print an empty line where a
     copyable address belongs. */
  assert.ok(stoppedTexts.includes('tunnel.heroDown'), 'a stopped tunnel should label the hero as not open')
  assert.ok(
    !stoppedTexts.includes('tunnel.heroRunning'),
    'a stopped tunnel must not claim to have a public address',
  )
  assert.ok(stoppedTexts.includes('page.tunnelStart'), 'a stopped tunnel should offer Start')
})

await check('a cooling target shows its countdown on the routes tab', () => {
  const tree = render({
    ...STATUS,
    aliases: [{ alias: 'deepseek-flash', targets: ['a/one', 'b/two'] }],
    failover: {
      cooldownMs: 300000,
      cooling: [
        { target: 'a/one', code: 'QUOTA', message: 'quota spent', remainingMs: 240000, until: Date.now() + 240000 },
      ],
    },
  })
  const rendered = collect(tree)
  /* The strip on the overview names the count, and the hop shows the seconds. */
  assert.ok(rendered.includes('cool.title'), 'the cooling strip is missing')
  assert.ok(rendered.includes('240s'), `the countdown is missing; saw: ${rendered.filter((x) => /^\d+s$/.test(x)).join(', ')}`)
  assert.ok(rendered.includes('page.aliasCooling'), 'the benched hop should say it is cooling')
  /* The meter is the visual share of the cooldown still to run. */
  assert.ok(classes(tree).has('gw-meter'), 'the cooldown meter is missing')
})

await check('the routes tab badge counts the configured routes', () => {
  const tree = render({
    ...STATUS,
    aliases: [
      { alias: 'one', targets: ['a/one'] },
      { alias: 'two', targets: ['a/two', 'b/two'] },
    ],
    failover: { cooldownMs: 300000, cooling: [] },
  })
  const badge = []
  const walk = (node) => {
    if (node === null || node === undefined || typeof node !== 'object') return
    if (Array.isArray(node)) {
      for (const child of node) walk(child)
      return
    }
    const className = node.props?.className
    if (typeof className === 'string' && className.split(' ').includes('gw-tab-n')) {
      badge.push(collect(node).join(''))
    }
    for (const child of node.children ?? []) walk(child)
  }
  walk(tree)
  assert.deepEqual(badge, ['2'], `the route count badge should read 2; saw ${badge.join(', ')}`)
})

await check('the settings tab carries the key, the port, and the example', () => {
  const used = classes(rendered)
  assert.ok(used.has('gw-kv'), 'the settings key/value rows are missing')
  assert.ok(texts.includes('settings.title'), 'the settings heading is missing')
  assert.ok(texts.includes('settings.key'), 'the key section is missing')
  assert.ok(texts.includes('settings.port'), 'the port section is missing')
  assert.ok(texts.includes('page.portApply'), 'the port apply button is missing')
  assert.ok(texts.includes('page.reveal'), 'the key should be masked behind a reveal control')
  /* The masked key must not leak the middle of the secret. */
  assert.ok(
    texts.some((entry) => entry.startsWith('sk-dsh-') && entry.includes('•')),
    `the key should be masked; saw: ${texts.filter((x) => x.startsWith('sk-')).join(', ')}`,
  )
  assert.ok(
    texts.some((entry) => entry.startsWith('curl ')),
    'the request example is missing from settings',
  )
})


await check('the routes tab offers an add button and a per-row edit button', () => {
  const tree = render(STATUS)
  const text = collect(tree)
  assert.ok(text.includes('routes.add'), 'the routes header has no add button')
  assert.ok(text.includes('routes.edit'), 'the route row has no edit button')
})

await check('the route editor is not mounted until it is opened', () => {
  /* The modal is state-driven: the first frame must not paint a scrim over the
   * page, or the plugin would be unusable on load. */
  const tree = render(STATUS)
  assert.ok(!classes(tree).has('gw-scrim'), 'the scrim rendered before the dialog was opened')
  assert.ok(!classes(tree).has('gw-modal'), 'the dialog rendered before it was opened')
})

await check('the old free-text target form is gone', () => {
  /* Variant C replaced the name+textarea form with the picker. If the textarea
   * came back, two ways to edit a route would be on screen at once. */
  const tree = render(STATUS)
  assert.ok(!classes(tree).has('gw-form'), 'the removed free-text form is still rendered')
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

/** Every `href` in the tree, so a check can assert a link points where it should. */
function links(node, out = []) {
  if (node === null || node === undefined || typeof node === 'boolean') return out
  if (typeof node !== 'object') return out
  if (Array.isArray(node)) {
    for (const child of node) links(child, out)
    return out
  }
  const href = node.props?.href
  if (typeof href === 'string') out.push(href)
  for (const child of node.children ?? []) links(child, out)
  return out
}

await check('a tunnel that needs a credential offers the signup and token links', () => {
  const needsCredential = {
    ...STATUS,
    baseUrl: 'http://127.0.0.1:8787/v1',
    tunnel: {
      status: 'failed',
      provider: 'ngrok',
      url: null,
      error: 'ngrok needs an account and an authtoken before it can open a tunnel.',
      pid: null,
      autostart: true,
      needsCredential: true,
      signupUrl: 'https://dashboard.ngrok.com/signup',
      tokenUrl: 'https://dashboard.ngrok.com/get-started/your-authtoken',
    },
  }
  const tree = render(needsCredential)
  const hrefs = links(tree)
  assert.ok(hrefs.includes('https://dashboard.ngrok.com/signup'), 'no link to the signup page')
  assert.ok(
    hrefs.includes('https://dashboard.ngrok.com/get-started/your-authtoken'),
    'no link to the token page',
  )
  const texts = collect(tree)
  assert.ok(texts.includes('page.tunnelSignup'), 'the signup button has no label')
  assert.ok(texts.includes('page.tunnelToken'), 'the token button has no label')
})

await check('a tunnel failing for another reason offers no credential links', () => {
  const other = {
    ...STATUS,
    baseUrl: 'http://127.0.0.1:8787/v1',
    tunnel: {
      status: 'failed',
      provider: 'ngrok',
      url: null,
      error: 'ngrok exited with code 1: bind: access permissions',
      pid: null,
      autostart: true,
      needsCredential: false,
      signupUrl: 'https://dashboard.ngrok.com/signup',
      tokenUrl: 'https://dashboard.ngrok.com/get-started/your-authtoken',
    },
  }
  const hrefs = links(render(other))
  assert.ok(!hrefs.includes('https://dashboard.ngrok.com/signup'), 'a credential link appeared for an unrelated failure')
})

/* ------------------------------------------------------------------ layout */

/**
 * The settings rows carry values people copy, so the CSS must not let a value
 * collapse to make room for its own label. That bug shipped once: the address
 * was clipped to "http://127…" and the port field to a single digit, and no
 * assertion here noticed because the text was still in the tree.
 *
 * These checks read the stylesheet, so they catch the class of bug the DOM
 * checks cannot see.
 */
await check('a key/value control is not allowed to shrink the value away', () => {
  const css = readFileSync(new URL('../client.js', import.meta.url), 'utf8')
  const block = css.slice(css.indexOf('.gw-kv-value'), css.indexOf('.gw-kv-value') + 400)
  assert.ok(block.length > 0, '.gw-kv-value rule is missing')

  /* The value must not be a shrinkable flex item, and its row must wrap so the
     control can drop to its own line instead of being squeezed. */
  const rowRule = css.slice(css.indexOf('.gw-kv {'), css.indexOf('.gw-kv {') + 400)
  assert.ok(
    /flex-wrap:\s*wrap/.test(rowRule),
    'the key/value row must wrap; without it a long address is clipped',
  )
  assert.ok(
    /flex:\s*none/.test(block),
    'the value must keep its natural width instead of shrinking',
  )
  assert.ok(
    /flex:\s*none/.test(
      css.slice(css.indexOf('.gw-kv-ctl .gw-input'), css.indexOf('.gw-kv-ctl .gw-input') + 120),
    ),
    'a control inside a value row must keep its own size',
  )
})

await check('the port field is wide enough to show a real port', () => {
  const page = readFileSync(new URL('../client.js', import.meta.url), 'utf8')
  const rule = page.slice(page.indexOf('gw-kv-ctl .gw-input'), page.indexOf('gw-kv-ctl .gw-input') + 120)
  assert.ok(rule.length > 0, 'the port input rule is missing')
  /* The page also sets an inline width; assert it is a usable one. */
  assert.ok(
    /width:\s*"(7[0-9]|8[0-9]|9[0-9]|1[0-9][0-9])px"/.test(page),
    'the port input needs an explicit width wide enough for four digits',
  )
})

await check('a stale target is labelled on the routes tab', () => {
  /* The row a request would waste a round-trip on has to be visible before the
     request happens. The host reports `unavailable` per alias; the page turns
     that into a badge on the hop and a count on the row. */
  const tree = render({
    ...STATUS,
    aliases: [
      { alias: 'flash', targets: ['gone/retired', 'provider-a/only-a'], unavailable: ['gone/retired'] },
    ],
    failover: { cooldownMs: 300000, cooling: [] },
  })
  const text = collect(tree)
  assert.ok(text.includes('routes.unavailable'), 'the stale hop carries no unavailable label')
  assert.ok(text.includes('routes.goneCount'), 'the row does not summarise how many targets are stale')
  assert.ok(classes(tree).has('is-gone'), 'the unavailable badge style is missing')
  /* The live target must not be marked, or the badge would be noise. */
  const stale = text.filter((entry) => entry === 'routes.unavailable').length
  assert.equal(stale, 1, `expected exactly one stale badge, saw ${stale}`)
})

await check('a stale target is labelled inside the route editor too', () => {
  /* Editing is what fixes a stale row, so the editor has to show it. The stub
     renders one pass with inert setters, so the modal is opened by seeding its
     state slot through `HOOKS.openEditor`, which stands in for pressing Edit. */
  HOOKS.openEditor = {
    kind: 'edit',
    original: 'flash',
    name: 'flash',
    targets: ['gone/retired', 'provider-a/only-a'],
    query: '',
    provider: '',
    open: new Set(),
    drag: null,
    drop: null,
  }
  try {
    const tree = render({
      ...STATUS,
      aliases: [
        { alias: 'flash', targets: ['gone/retired', 'provider-a/only-a'], unavailable: ['gone/retired'] },
      ],
      failover: { cooldownMs: 300000, cooling: [] },
    })
    assert.ok(classes(tree).has('gw-modal'), 'the editor did not open')
    const text = collect(tree)
    assert.ok(
      text.includes('routes.unavailableMeta'),
      `the editor does not flag the stale target; saw: ${text.join(' ').slice(0, 240)}`,
    )
    assert.ok(
      text.includes('routes.unavailable'),
      'the editor chain row carries no unavailable badge',
    )
  } finally {
    HOOKS.openEditor = null
  }
})

const failed = results.filter((entry) => !entry.ok)
console.log(`\n${results.length - failed.length}/${results.length} checks passed`)
process.exit(failed.length === 0 ? 0 : 1)
