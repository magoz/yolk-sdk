const fnvOffsetBasis32 = 0x811c9dc5
const fnvPrime32 = 0x01000193

const fnv1a32 = (value: string, seed: number) => {
  let hash = seed

  for (const character of value) {
    hash ^= character.codePointAt(0) ?? 0
    hash = Math.imul(hash, fnvPrime32)
  }

  return (hash >>> 0).toString(36).padStart(7, '0')
}

const stableHash = (value: string) => {
  const first = fnv1a32(value, fnvOffsetBasis32)
  const second = fnv1a32([...value].reverse().join(''), fnvOffsetBasis32 ^ 0x9e3779b9)

  return `${first}${second}`
}

export const makeVercelSandboxName = (sandboxSessionId: string) =>
  `sandbox-${stableHash(sandboxSessionId)}`
