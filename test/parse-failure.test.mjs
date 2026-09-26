import assert from 'node:assert/strict'
import test from 'node:test'

import { parseFailureDetail } from '../src/index.mjs'

/**
 * A parse failure must not reproduce the configuration it failed on.
 *
 * V8 reports a `JSON.parse` failure two ways. One names an offset and says
 * nothing about the content. The other quotes the input back:
 * `Unexpected token 'A', "AKIAIOSFODNN7EXAMPLE" is not valid JSON` -- the whole
 * document when it is short, a ten-character window when it is not.
 *
 * The ORDER inside `parseFailureDetail` is the defence, and it is pinned here
 * rather than only through the CLI. Searching for the offset BEFORE recognising
 * the quoting shape looks safe and is not: a configuration whose own text reads
 * `at position 1` supplies that phrase from inside the quoted span, and the
 * slice hands the document straight back. Every case below fails if that order
 * is reverted.
 *
 * The canary is AWS's published documentation placeholder, not a credential.
 */

const CANARY = 'AKIAIOSFODNN7EXAMPLE'

/** The detail for a document that must not parse. */
function detailFor(document) {
  let thrown = null
  try {
    JSON.parse(document)
  } catch (error) {
    thrown = error
  }
  assert.notEqual(thrown, null, `${JSON.stringify(document)} was supposed to be unparseable`)
  return parseFailureDetail(thrown)
}

/** No prefix of `document` from four characters up survives into the detail. */
function assertNoPrefixOf(document, detail, label) {
  for (let length = Math.min(document.length, 40); length >= 4; length -= 1) {
    const prefix = document.slice(0, length)
    assert.equal(detail.includes(prefix), false, `${label}: the detail carries ${JSON.stringify(prefix)}`)
  }
}

test('a configuration whose own text reads "at position 1" does not smuggle itself out', () => {
  const detail = detailFor('at position 1')
  assert.equal(detail.includes('"'), false, `a quoted span survived: ${detail}`)
  assert.equal(detail.includes('at position 1'), false, `the document came back: ${detail}`)
  assert.equal(detail, "unexpected token 'a' at the start of the document")
})

test('a configuration that is nothing but a credential never appears in the detail', () => {
  const detail = detailFor(CANARY)
  assert.equal(detail.includes(CANARY), false, `the canary came back: ${detail}`)
  assertNoPrefixOf(CANARY, detail, 'credential-only configuration')
  assert.equal(detail, "unexpected token 'A' at the start of the document")
})

test('a long configuration does not leak the ten characters V8 quotes from its head', () => {
  const document = `${CANARY} followed by a great deal of content nobody should read back`
  const detail = detailFor(document)
  assertNoPrefixOf(document, detail, 'long configuration')
  assert.equal(detail, "unexpected token 'A' at the start of the document")
})

test('a quoted span carrying a newline is still recognised as the quoting shape', () => {
  // Without the `s` flag the quoting branch misses this message entirely.
  const detail = detailFor('}x\n')
  assert.equal(detail.includes('"'), false, `a quoted span survived: ${detail}`)
  assert.equal(detail, "unexpected token '}' at the start of the document")
})

test('the genuinely safe positional form keeps its position, line and column', () => {
  // A helper that answered the generic sentence for everything would pass every
  // leak case above while destroying every diagnostic. This is the pin.
  const detail = detailFor('{"a": 1 "b": 2}')
  assert.match(detail, /at position 8 \(line 1 column 9\)$/)
  assert.equal(detail.includes('"'), false, `a quoted span survived: ${detail}`)
  assert.notEqual(detail, 'the document could not be parsed as JSON')
})

test('an empty configuration keeps V8 own words', () => {
  assert.equal(detailFor(''), 'Unexpected end of JSON input')
})

test('a wording this helper has never seen still yields something printable', () => {
  assert.equal(parseFailureDetail(new Error('something new from a future V8')), 'the document could not be parsed as JSON')
  assert.equal(parseFailureDetail(undefined), 'the document could not be parsed as JSON')
})
