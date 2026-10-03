// Synchronous, runtime-neutral SHA-256 (FIPS 180-4) for the tool ledger's argument digest. Web
// Crypto is asynchronous: an await before every claim would add an event-loop turn to each
// ledgered call and break `TestClock`-driven host tests, and it is missing in some runtimes.

const roundConstants = Uint32Array.from([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2
])

const initialHash = [
  0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19
]

const rotateRight = (value: number, bits: number) => (value >>> bits) | (value << (32 - bits))

const word = (words: Uint32Array, index: number) => words[index] ?? 0

/** Lower-case hex SHA-256 of the UTF-8 encoding of `text`. */
export const sha256Hex = (text: string): string => {
  const data = new TextEncoder().encode(text)
  const paddedLength = Math.ceil((data.length + 9) / 64) * 64
  const bytes = new Uint8Array(paddedLength)

  bytes.set(data)
  bytes[data.length] = 0x80

  const view = new DataView(bytes.buffer)
  const bitLength = data.length * 8

  view.setUint32(paddedLength - 8, Math.floor(bitLength / 0x1_0000_0000))
  view.setUint32(paddedLength - 4, bitLength >>> 0)

  const hash = Uint32Array.from(initialHash)
  const schedule = new Uint32Array(64)

  for (let offset = 0; offset < paddedLength; offset += 64) {
    for (let index = 0; index < 16; index++) {
      schedule[index] = view.getUint32(offset + index * 4)
    }

    for (let index = 16; index < 64; index++) {
      const early = word(schedule, index - 15)
      const late = word(schedule, index - 2)
      const sigma0 = rotateRight(early, 7) ^ rotateRight(early, 18) ^ (early >>> 3)
      const sigma1 = rotateRight(late, 17) ^ rotateRight(late, 19) ^ (late >>> 10)

      schedule[index] = word(schedule, index - 16) + sigma0 + word(schedule, index - 7) + sigma1
    }

    let a = word(hash, 0)
    let b = word(hash, 1)
    let c = word(hash, 2)
    let d = word(hash, 3)
    let e = word(hash, 4)
    let f = word(hash, 5)
    let g = word(hash, 6)
    let h = word(hash, 7)

    for (let index = 0; index < 64; index++) {
      const sum1 = rotateRight(e, 6) ^ rotateRight(e, 11) ^ rotateRight(e, 25)
      const choice = (e & f) ^ (~e & g)
      const temp1 = (h + sum1 + choice + word(roundConstants, index) + word(schedule, index)) | 0
      const sum0 = rotateRight(a, 2) ^ rotateRight(a, 13) ^ rotateRight(a, 22)
      const majority = (a & b) ^ (a & c) ^ (b & c)
      const temp2 = (sum0 + majority) | 0

      h = g
      g = f
      f = e
      e = (d + temp1) | 0
      d = c
      c = b
      b = a
      a = (temp1 + temp2) | 0
    }

    hash[0] = word(hash, 0) + a
    hash[1] = word(hash, 1) + b
    hash[2] = word(hash, 2) + c
    hash[3] = word(hash, 3) + d
    hash[4] = word(hash, 4) + e
    hash[5] = word(hash, 5) + f
    hash[6] = word(hash, 6) + g
    hash[7] = word(hash, 7) + h
  }

  return Array.from(hash, value => value.toString(16).padStart(8, '0')).join('')
}
