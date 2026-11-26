/**
 * Guard: the files a loader parses must be byte-clean.
 *
 * `package.json` is read by tooling that does not strip a byte-order mark, and a
 * BOM at the top makes `JSON.parse` fail with "Unexpected token" on the first
 * character. That failure is invisible in the repository — the diff looks
 * identical — and it takes the whole plugin down: the sidebar entry simply
 * disappears on the next restart.
 *
 * It happened once, from an editor that writes UTF-8 with a BOM by default, so
 * it is worth a test rather than a habit.
 *
 * Run:  node tests/packaging.spec.mjs
 */
import { readFileSync } from 'node:fs'
import assert from 'node:assert/strict'

const BOM = Buffer.from([0xef, 0xbb, 0xbf])

const FILES = ['package.json', 'client.js', 'index.js', 'cordis.patch.yml']

for (const name of FILES) {
  const bytes = readFileSync(new URL(`../${name}`, import.meta.url))
  assert.ok(
    !(bytes[0] === BOM[0] && bytes[1] === BOM[1] && bytes[2] === BOM[2]),
    `${name} starts with a UTF-8 BOM; JSON.parse and some loaders reject that`,
  )
}

const manifest = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
assert.match(String(manifest.version), /^\d+\.\d+\.\d+$/, `the version is not semver: ${manifest.version}`)
assert.equal(manifest.main, 'index.js', 'the entry point moved; the loader follows this field')
assert.ok(manifest.dsh?.bundle?.patch !== undefined, 'the bundle patch is no longer declared')

/* The files the manifest ships must exist: a missing one only shows up as a
 * failed install, long after the edit. */
import { existsSync } from 'node:fs'
for (const entry of ['index.js', 'client.js', 'cordis.patch.yml', 'icon.svg']) {
  assert.ok(existsSync(new URL(`../${entry}`, import.meta.url)), `${entry} is declared or referenced but missing`)
}

console.log('ok    package.json is BOM-free and parses; declared files exist')
console.log('ok    version is semver and the entry points are declared')
