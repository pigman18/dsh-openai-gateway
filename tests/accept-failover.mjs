/**
 * Post-restart acceptance for the failover feature, against the LIVE gateway.
 *
 * Restarting DSH is what loads the new `index.js`, so this script is the
 * after-the-fact proof that the running process actually has it: it writes the
 * multi-target alias through the real control route, asks `/v1/models` what it
 * advertises, sends a real completion through the alias, and reads back which
 * target answered and what got benched.
 *
 * Nothing is faked. Every number printed here came from the running Harness.
 *
 * Run:  node tests/accept-failover.mjs [webPort]
 */
const WEB = Number(process.argv[2] ?? 53118)
const BASE = `http://127.0.0.1:${WEB}`

const TARGETS = [
  'our-free-model/deepseek-v4.1-flash-free',
  'trae/deepseek-v4.1-flash',
  'trae-global/deepseek-v4.1-flash',
  'workbuddy/deepseek-v4.1-flash',
  'qoder-cn/DeepSeek-Flash',
]
const ALIAS = 'deepseek-flash'

let failures = 0
function ok(label, detail) {
  console.log(`ok    ${label}${detail === undefined ? '' : `\n      ${detail}`}`)
}
function bad(label, detail) {
  failures += 1
  console.log(`FAIL  ${label}${detail === undefined ? '' : `\n      ${detail}`}`)
}

async function getStatus() {
  const res = await fetch(`${BASE}/plugins/dsh-openai-gateway/status`, { cache: 'no-store' })
  if (!res.ok) throw new Error(`status ${res.status}`)
  return res.json()
}

async function postJson(path, body) {
  const res = await fetch(`${BASE}${path}`, {
    method: 'POST',
    cache: 'no-store',
    headers: { 'Content-Type': 'application/json', Origin: BASE },
    body: JSON.stringify(body),
  })
  return { status: res.status, text: await res.text() }
}

/* ------------------------------------------------------- 1. the code is new */

console.log('== 1. the running process has the new code ==\n')

const status = await getStatus()
if (status.failover === undefined) {
  bad('the status document has no failover block', 'the running index.js is still the old one — restart DSH')
  console.log('\nStopping: nothing below can be meaningful until the host is restarted.')
  process.exit(1)
}
ok('the status document carries a failover block', `cooldownMs = ${status.failover.cooldownMs}`)

const coolingNow = Array.isArray(status.failover.cooling) ? status.failover.cooling : []
ok('cooling is an array', `${coolingNow.length} target(s) currently benched`)

/* ------------------------------------------- 2. the alias can hold a list */

console.log('\n== 2. a multi-target alias is accepted and advertised ==\n')

const write = await postJson('/plugins/dsh-openai-gateway/aliases', {
  // Keep whatever single-target aliases are already configured, so this run
  // does not silently delete the user's gpt-4o mapping.
  aliases: {
    ...Object.fromEntries(
      (status.aliases ?? [])
        .filter((row) => row.alias !== ALIAS)
        .map((row) => [row.alias, row.targets ?? [row.target]]),
    ),
    [ALIAS]: TARGETS,
  },
})
if (write.status !== 200) {
  bad('the control route refused the list form', `${write.status}: ${write.text.slice(0, 200)}`)
} else {
  ok('the control route accepted the list form')
}

const after = await getStatus()
const row = (after.aliases ?? []).find((entry) => entry.alias === ALIAS)
if (row === undefined) {
  bad('the alias is missing from the status document')
} else {
  const got = row.targets ?? [row.target]
  if (JSON.stringify(got) === JSON.stringify(TARGETS)) {
    ok('the whole chain round-tripped, in order', got.join('  →  '))
  } else {
    bad('the chain did not round-trip', `got ${JSON.stringify(got)}`)
  }
}

/* -------------------------------------- 3. /v1/models advertises the chain */

console.log('\n== 3. /v1/models advertises the alias and its chain ==\n')

const modelsRes = await fetch(`${BASE}/plugins/dsh-openai-gateway/status?refresh=1`, { cache: 'no-store' })
const fresh = await modelsRes.json()
const gwPort = fresh.port
const key = fresh.apiKey

const listed = await fetch(`http://127.0.0.1:${gwPort}/v1/models`, {
  headers: { Authorization: `Bearer ${key}` },
})
if (!listed.ok) {
  bad('/v1/models refused the request', String(listed.status))
} else {
  const entries = (await listed.json()).data.filter((entry) => entry.id === ALIAS)
  if (entries.length !== 1) {
    bad(`the alias is listed ${entries.length} times instead of once`)
  } else if (JSON.stringify(entries[0].alias_targets) === JSON.stringify(TARGETS)) {
    ok('alias_targets carries the whole chain', `alias_of = ${entries[0].alias_of}`)
  } else {
    bad('alias_targets is missing or wrong', JSON.stringify(entries[0].alias_targets))
  }
}

/* ------------------------------- 4. a real request goes through the chain */

console.log('\n== 4. a real completion through the alias ==\n')

const started = Date.now()
const chat = await fetch(`http://127.0.0.1:${gwPort}/v1/chat/completions`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
  body: JSON.stringify({
    model: ALIAS,
    messages: [{ role: 'user', content: 'Reply with exactly: OK' }],
    max_tokens: 16,
  }),
})
const chatText = await chat.text()
const elapsed = Date.now() - started

console.log(`      HTTP ${chat.status} in ${elapsed} ms`)
console.log(`      ${chatText.slice(0, 240).replace(/\s+/g, ' ')}`)

const trace = (await getStatus()).recent?.[0]
if (trace !== undefined) {
  console.log(`\n      served by : ${trace.provider}/${trace.upstreamModel}`)
  console.log(`      tried     : ${(trace.targets ?? []).join('  →  ')}`)
  console.log(`      attempts  : ${trace.attempts}`)
  console.log(`      outcome   : ${trace.outcome}${trace.code === undefined ? '' : ` (${trace.code})`}`)
}

if (chat.status === 200) {
  ok('the caller was served')
  if (trace?.failoverIndex > 0) {
    ok('it landed on a fallback target, not the first one', `failoverIndex = ${trace.failoverIndex}`)
  } else {
    ok('the first target served it (nothing needed to fail over)')
  }
} else {
  // Not automatically a defect: every target may genuinely be down right now.
  const tried = trace?.targets ?? []
  bad(
    'the caller was not served',
    `tried ${tried.length} target(s): ${tried.join(' → ')}; the failure is ${trace?.code ?? 'unknown'}`,
  )
}

/* ------------------------------------- 5. what is benched is now visible */

console.log('\n== 5. the cooldown table reflects what happened ==\n')

const finalStatus = await getStatus()
const cooling = finalStatus.failover.cooling
if (cooling.length === 0) {
  ok('nothing is benched', 'no target reported a failover-eligible failure')
} else {
  ok(`${cooling.length} target(s) benched`)
  for (const entry of cooling) {
    console.log(`      ${entry.target}  ${entry.code}  ${Math.round(entry.remainingMs / 1000)}s left`)
  }
}

console.log(`\n${failures === 0 ? 'all checks passed' : `${failures} check(s) failed`}`)
process.exit(failures === 0 ? 0 : 1)
