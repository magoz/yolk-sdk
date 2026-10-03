import { createHash } from 'node:crypto'
import { describe, expect, it } from '@effect/vitest'
import { sha256HexSync } from '../../src/tools/sha256.ts'

const nodeSha256Hex = (text: string) => createHash('sha256').update(text, 'utf8').digest('hex')

describe('sha256HexSync', () => {
  it('matches the FIPS 180-4 known-answer vectors', () => {
    expect(sha256HexSync('')).toBe(
      'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855'
    )
    expect(sha256HexSync('abc')).toBe(
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad'
    )
    // The 448-bit message: its padding needs a second block.
    expect(sha256HexSync('abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq')).toBe(
      '248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1'
    )
    expect(sha256HexSync('a'.repeat(1_000_000))).toBe(
      'cdc76e5c9914fb9281a1c7e284d73e67f1809a48a497200e046d39ccc7112cd0'
    )
  })

  it('pads exactly at the block boundaries', () => {
    // 55 bytes fit the padding in one block, 56 need two; 64, 120, and 128 cross block ends.
    for (const bytes of [55, 56, 63, 64, 119, 120, 128]) {
      const text = 'x'.repeat(bytes)

      expect(new TextEncoder().encode(text).length).toBe(bytes)
      expect(sha256HexSync(text)).toBe(nodeSha256Hex(text))
    }
  })

  it('matches node:crypto for every padding offset and UTF-8 width', () => {
    for (let length = 0; length <= 300; length++) {
      for (const unit of ['a', '\u00e9', '\u20ac', '\ud83d\ude00']) {
        const text = unit.repeat(length)

        expect(sha256HexSync(text)).toBe(nodeSha256Hex(text))
      }
    }
  })
})
