/**
 * Guard: every colour-bearing declaration in the plugin stylesheet must come
 * from a `--dsw-*` theme token, so light and dark themes both work and a future
 * token rename degrades the look instead of freezing one palette.
 *
 * `transparent` and `currentColor` are theme-neutral keywords, so they pass.
 * Font sizes, paddings, and durations are not colours and are not checked.
 */
import { readFileSync } from 'node:fs'
import assert from 'node:assert/strict'

const SOURCE = readFileSync(new URL('../client.js', import.meta.url), 'utf8')

/* Pull the CSS template literal out of the module. */
const start = SOURCE.indexOf('const CSS = `')
assert.ok(start > 0, 'the CSS template literal is missing')
const end = SOURCE.indexOf('`;', start)
assert.ok(end > start, 'the CSS template literal is unterminated')
const css = SOURCE.slice(start + 'const CSS = `'.length, end)

/* Colour-bearing properties. `font:` is excluded: it carries size and family. */
const PROPS = [
  'color',
  'background',
  'background-color',
  'border',
  'border-color',
  'border-top',
  'border-bottom',
  'border-left',
  'border-right',
  'outline',
  'box-shadow',
  'text-shadow',
  'fill',
  'stroke',
]

const NEUTRAL = new Set(['transparent', 'currentColor', 'none', 'inherit', 'initial', 'unset'])
const LITERAL = /#[0-9a-fA-F]{3,8}\b|\brgba?\s*\(|\bhsla?\s*\(|\boklch\s*\(|\bcolor-mix\s*\(/

const failures = []
for (const line of css.split('\n')) {
  const declaration = line.trim()
  if (!declaration.endsWith(';')) continue
  if (declaration.startsWith('--')) continue
  const colon = declaration.indexOf(':')
  if (colon < 0) continue
  const property = declaration.slice(0, colon).trim()
  if (!PROPS.includes(property)) continue
  const value = declaration.slice(colon + 1).trim()

  /* A shorthand may mix a token and a neutral keyword. Every part that carries
   * a colour must be a token; widths and styles may be literals. */
  const parts = value.split(/\s+(?![^(]*\))/)
  const colourish = parts.filter((part) => {
    const bare = part.replace(/!important$/, '').trim()
    if (bare.length === 0) return false
    if (/^[0-9.]+(px|em|rem|%|s|ms)?$/.test(bare)) return false
    if (NEUTRAL.has(bare)) return false
    if (/^(solid|dashed|dotted|double|groove|ridge|inset|outset|hidden|thin|medium|thick)$/.test(bare)) return false
    if (/^var\(--dsw-/.test(bare)) return false
    if (/^[0-9.]+px\s+[0-9.]+px/.test(bare)) return false
    return true
  })

  for (const part of colourish) {
    if (LITERAL.test(part)) {
      failures.push(`${property}: ${value}`)
      break
    }
  }
}

assert.equal(
  failures.length,
  0,
  `literal colours are not allowed; use a --dsw-* token:\n  ${failures.join('\n  ')}`,
)

const tokenCount = (css.match(/var\(--dsw-/g) ?? []).length
assert.ok(tokenCount >= 60, `expected the page to be token-driven, saw only ${tokenCount} token references`)

console.log(`ok    stylesheet uses ${tokenCount} theme tokens and no literal colours`)
