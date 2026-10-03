import { createHash } from 'node:crypto'
import { Arbitrary } from 'effect'
import * as Schema from 'effect/Schema'
import { describe, expect, it } from '@effect/vitest'
import { sha256HexSync } from '../../src/tools/sha256.ts'
import { propertyOptions } from './property-options'

// One generated code unit or code point: a kind and a seed folded into that kind's range.
const piece = Schema.Struct({
  kind: Schema.Literals(['ascii', 'control', 'bmp', 'astral', 'loneHigh', 'loneLow']),
  seed: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 0x10ffff }))
})

type Piece = typeof piece.Type

const inRange = (seed: number, minimum: number, maximum: number) =>
  minimum + (seed % (maximum - minimum + 1))

const character = ({ kind, seed }: Piece): string => {
  switch (kind) {
    case 'ascii':
      return String.fromCharCode(inRange(seed, 0x20, 0x7e))
    case 'control': {
      const code = inRange(seed, 0x00, 0x20)

      return String.fromCharCode(code === 0x20 ? 0x7f : code)
    }

    case 'bmp': {
      // Outside the surrogate range: 0x80..0xd7ff and 0xe000..0xffff.
      const code = inRange(seed, 0x80, 0xffff - 0x800)

      return String.fromCharCode(code < 0xd800 ? code : code + 0x800)
    }

    case 'astral':
      return String.fromCodePoint(inRange(seed, 0x10000, 0x10ffff))
    case 'loneHigh':
      return String.fromCharCode(inRange(seed, 0xd800, 0xdbff))
    case 'loneLow':
      return String.fromCharCode(inRange(seed, 0xdc00, 0xdfff))
  }
}

// Strings of 0..300 characters mixing ASCII, control characters, BMP and astral characters, and
// lone surrogates (both sides encode them as U+FFFD).
const textArbitrary = Arbitrary.map(
  Arbitrary.array(Arbitrary.schema(piece), { maxLength: 300 }),
  pieces => pieces.map(character).join('')
)

describe('sha256HexSync properties', () => {
  it.prop(
    'matches node:crypto SHA-256 over the UTF-8 encoding of any string',
    [textArbitrary],
    ([text]) => {
      expect(sha256HexSync(text)).toBe(createHash('sha256').update(text, 'utf8').digest('hex'))
    },
    propertyOptions
  )
})
