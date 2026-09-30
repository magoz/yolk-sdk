/**
 * Duplicate-preserving JSON member scan for the fixture probes' redaction survivor checks.
 *
 * `JSON.parse` keeps only the last value of a repeated key, so a check over parsed JSON can miss
 * an earlier value of a redacted field (for example a first `"user"` whose value crossed a network
 * chunk boundary, and so was never rewritten, followed by an already redacted one). This scanner
 * walks the JSON text itself and reports every member of every object in wire order, repeats
 * included, with the kind of its value and (for strings) the decoded text.
 */
import { Predicate } from 'effect'

/** The JSON kind of a member's value. */
export type JsonValueKind = 'string' | 'number' | 'boolean' | 'null' | 'object' | 'array'

/** One `"key": value` member of a JSON object, exactly as it appears on the wire. */
export type JsonMember = {
  /** The decoded key (escapes resolved, so `"us\u0065r"` is `user`). */
  readonly key: string
  readonly kind: JsonValueKind
  /** The decoded value of a string member; undefined for every other kind. */
  readonly text: string | undefined
}

// Deeper nesting is treated as unparseable, so callers fail closed instead of overflowing.
const maxDepth = 256

const numberPattern = /-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/y

class JsonScanError extends Error {}

/**
 * Walk one JSON value in `text` (surrounding whitespace allowed) and call `visitObject` with the
 * members of each object, in wire order and including repeated keys; inner objects are visited
 * before the object that contains them. Returns false when `text` is not exactly one valid JSON
 * value (objects closed before the error were still visited), so callers can fail closed.
 */
export const scanJsonObjects = (
  text: string,
  visitObject: (members: ReadonlyArray<JsonMember>) => void
): boolean => {
  let index = 0

  const fail = (): never => {
    throw new JsonScanError()
  }

  const skipWhitespace = () => {
    while (index < text.length && ' \t\n\r'.includes(text.charAt(index))) index++
  }

  const expectChar = (char: string) => {
    if (text.charAt(index) !== char) fail()

    index++
  }

  const readString = (): string => {
    const start = index

    expectChar('"')

    while (index < text.length) {
      const char = text.charAt(index)

      if (char === '\\') {
        index += 2
      } else if (char === '"') {
        index++

        try {
          const decoded: unknown = JSON.parse(text.slice(start, index))

          return Predicate.isString(decoded) ? decoded : fail()
        } catch {
          return fail()
        }
      } else {
        index++
      }
    }

    return fail()
  }

  type Value = Pick<JsonMember, 'kind' | 'text'>

  const readValue = (depth: number): Value => {
    if (depth > maxDepth) fail()

    skipWhitespace()

    const char = text.charAt(index)

    if (char === '{') {
      index++

      const members: Array<JsonMember> = []

      skipWhitespace()

      if (text.charAt(index) === '}') {
        index++
      } else {
        for (;;) {
          skipWhitespace()

          const key = readString()

          skipWhitespace()
          expectChar(':')
          skipWhitespace()

          members.push({ key, ...readValue(depth + 1) })

          skipWhitespace()

          if (text.charAt(index) === ',') {
            index++
          } else {
            expectChar('}')
            break
          }
        }
      }

      visitObject(members)

      return { kind: 'object', text: undefined }
    }

    if (char === '[') {
      index++
      skipWhitespace()

      if (text.charAt(index) === ']') {
        index++

        return { kind: 'array', text: undefined }
      }

      for (;;) {
        readValue(depth + 1)
        skipWhitespace()

        if (text.charAt(index) === ',') {
          index++
        } else {
          expectChar(']')

          return { kind: 'array', text: undefined }
        }
      }
    }

    if (char === '"') {
      return { kind: 'string', text: readString() }
    }

    for (const [literal, kind] of [
      ['true', 'boolean'],
      ['false', 'boolean'],
      ['null', 'null']
    ] as const) {
      if (text.startsWith(literal, index)) {
        index += literal.length

        return { kind, text: undefined }
      }
    }

    numberPattern.lastIndex = index

    const number = numberPattern.exec(text)

    if (number === null || number[0].length === 0) return fail()

    index += number[0].length

    return { kind: 'number', text: undefined }
  }

  try {
    readValue(0)
    skipWhitespace()

    return index === text.length
  } catch (error) {
    if (error instanceof JsonScanError) return false

    throw error
  }
}

/**
 * Keys among `fields` that carry anything but an allowed value in some object of `text`, or that
 * repeat within one object (a repeated sensitive key is refused whatever its values). Allowed
 * values are `null`, the empty string, and the string `placeholder`; any other string, number,
 * boolean, object, or array is reported. Returns undefined when `text` is not valid JSON.
 */
export const unredactedMembers = (
  text: string,
  fields: ReadonlyArray<string>,
  placeholder: string
): ReadonlySet<string> | undefined => {
  const found = new Set<string>()

  const scanned = scanJsonObjects(text, members => {
    const seen = new Set<string>()

    for (const member of members) {
      if (!fields.includes(member.key)) continue

      if (seen.has(member.key) || !isAllowedMember(member, placeholder)) found.add(member.key)

      seen.add(member.key)
    }
  })

  return scanned ? found : undefined
}

/** True for a member whose value is `null`, the empty string, or exactly `placeholder`. */
export const isAllowedMember = (member: JsonMember, placeholder: string): boolean =>
  member.kind === 'null' ||
  (member.kind === 'string' && (member.text === '' || member.text === placeholder))
