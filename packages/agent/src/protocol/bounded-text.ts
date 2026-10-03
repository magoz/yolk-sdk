import { Predicate, Result } from 'effect'

/** Marker appended to text cut by `truncateUtf8` and `truncateCodePoints`. */
export const truncationMarker = '…'

const codePointUtf8Bytes = (codePoint: number) =>
  codePoint <= 0x7f ? 1 : codePoint <= 0x7ff ? 2 : codePoint <= 0xffff ? 3 : 4

const characterUtf8Bytes = (character: string) => codePointUtf8Bytes(character.codePointAt(0) ?? 0)

/** UTF-8 byte length of `text` (a lone surrogate counts as the 3 bytes of U+FFFD). */
export const utf8ByteLength = (text: string) => {
  let bytes = 0

  for (const character of text) {
    bytes += characterUtf8Bytes(character)
  }

  return bytes
}

/**
 * `text` within `maxBytes` UTF-8 bytes: unchanged when it fits, else cut on a code point boundary
 * (surrogate pairs and multi-byte characters stay whole) with a trailing `…` counted in the
 * budget. A budget smaller than the marker yields `''`, so the result never exceeds `maxBytes`.
 */
export const truncateUtf8 = (text: string, maxBytes: number): string => {
  if (utf8ByteLength(text) <= maxBytes) {
    return text
  }

  const budget = maxBytes - utf8ByteLength(truncationMarker)

  if (budget < 0) {
    return ''
  }

  let bytes = 0
  let kept = ''

  for (const character of text) {
    const size = characterUtf8Bytes(character)

    if (bytes + size > budget) {
      break
    }

    kept += character
    bytes += size
  }

  return `${kept}${truncationMarker}`
}

/** `text` within `maxCharacters` code points: cut with a trailing `…` (counted) when longer. */
export const truncateCodePoints = (text: string, maxCharacters: number): string => {
  const characters = Array.from(text)

  if (characters.length <= maxCharacters) {
    return text
  }

  return maxCharacters < 1
    ? ''
    : `${characters.slice(0, maxCharacters - 1).join('')}${truncationMarker}`
}

/** Compact JSON of tool call arguments: `null` for `undefined`, `[unserializable arguments]` when
 * `JSON.stringify` throws (cycles, BigInt).
 */
export const compactToolArguments = (args: unknown): string =>
  Result.match(
    Result.try(() => JSON.stringify(args)),
    {
      onFailure: () => '[unserializable arguments]',
      onSuccess: (encoded: string | undefined) => (Predicate.isString(encoded) ? encoded : 'null')
    }
  )
