import { expect } from '@effect/vitest'

/**
 * A small MIME reader for the Gmail draft tests, written independently of the encoder under test:
 * it splits one `multipart/mixed` level, unfolds headers, and decodes attachment names (RFC 2047
 * B-words in `name`, quoted-strings, RFC 2231 `filename*` continuations) and base64 content.
 */

export type MimePart = {
  /** Unfolded header lines, in order. */
  readonly headers: ReadonlyArray<string>
  /** The raw part body (after the blank line), CRLF line breaks. */
  readonly body: string
}

/** Header lines and body of one entity, with folded header lines joined. */
export const splitEntity = (entity: string): MimePart => {
  const end = entity.indexOf('\r\n\r\n')

  expect(end).toBeGreaterThan(0)

  const headers: Array<string> = []

  for (const line of entity.slice(0, end).split('\r\n')) {
    const last = headers.length - 1

    if ((line.startsWith(' ') || line.startsWith('\t')) && last >= 0) {
      headers[last] = `${headers[last] ?? ''}${line}`
    } else {
      headers.push(line)
    }
  }

  return { headers, body: entity.slice(end + 4) }
}

/** The value of the first header named `name` (case-insensitive), or `undefined`. */
export const headerOf = (part: MimePart, name: string) => {
  const prefix = `${name.toLowerCase()}:`
  const line = part.headers.find(candidate => candidate.toLowerCase().startsWith(prefix))

  return line?.slice(prefix.length).trim()
}

/** The boundary of a `multipart/*; boundary="..."` value. */
export const boundaryOf = (contentType: string | undefined) => {
  const boundary = /;\s*boundary="([^"]+)"$/u.exec(contentType ?? '')?.[1]

  expect(boundary).toBeDefined()

  return boundary ?? ''
}

/** The parts of a multipart body, asserting the exact delimiter and close framing (no preamble). */
export const multipartParts = (body: string, boundary: string): ReadonlyArray<MimePart> => {
  const delimiter = `--${boundary}`
  const close = `\r\n${delimiter}--`

  expect(body.startsWith(`${delimiter}\r\n`)).toBe(true)
  expect(body.endsWith(close)).toBe(true)

  return body
    .slice(delimiter.length + 2, body.length - close.length)
    .split(`\r\n${delimiter}\r\n`)
    .map(splitEntity)
}

const utf8 = new TextDecoder('utf-8', { fatal: true })

/** Decodes RFC 2047 UTF-8 B-words; whitespace between adjacent words is dropped. */
const decodeEncodedWords = (value: string) =>
  value
    .replaceAll(/\?=\s+=\?/gu, '?==?')
    .replaceAll(/=\?UTF-8\?B\?([A-Za-z0-9+/=]*)\?=/gu, (_word, encoded: string) =>
      utf8.decode(Buffer.from(encoded, 'base64'))
    )

const unquote = (value: string) =>
  value.startsWith('"') && value.endsWith('"')
    ? value.slice(1, -1).replaceAll(/\\(.)/gu, '$1')
    : value

/** `; key=value` parameters of a header value (a quoted value may hold `;`). */
const parametersOf = (value: string) => {
  const parameters = new Map<string, string>()

  for (const match of value.matchAll(/;\s*([^=\s;]+)=("(?:[^"\\]|\\.)*"|[^;]*)/gu)) {
    parameters.set((match[1] ?? '').toLowerCase(), (match[2] ?? '').trim())
  }

  return parameters
}

/** The `name` parameter of a Content-Type value, RFC 2047 words decoded. */
export const contentTypeName = (contentType: string | undefined) => {
  const name = parametersOf(contentType ?? '').get('name')

  return name === undefined ? undefined : decodeEncodedWords(unquote(name))
}

/** The `filename` of a Content-Disposition value: quoted, RFC 2231 `filename*`, or continuations. */
export const dispositionFilename = (disposition: string | undefined) => {
  const parameters = parametersOf(disposition ?? '')
  const plain = parameters.get('filename')

  if (plain !== undefined) return unquote(plain)

  const single = parameters.get('filename*')
  const sections: Array<string> = []

  if (single === undefined) {
    for (let index = 0; parameters.has(`filename*${index}*`); index += 1) {
      sections.push(parameters.get(`filename*${index}*`) ?? '')
    }
  } else {
    sections.push(single)
  }

  expect(sections.length).toBeGreaterThan(0)

  const joined = sections.join('')

  expect(joined.startsWith("UTF-8''")).toBe(true)

  return utf8.decode(
    Uint8Array.from(
      joined
        .slice("UTF-8''".length)
        .replaceAll(/%([0-9A-F]{2})/gu, (_escape, hex: string) =>
          String.fromCharCode(Number.parseInt(hex, 16))
        ),
      char => char.charCodeAt(0)
    )
  )
}

/** Base64 content lines (each at most 76 characters) decoded to bytes. */
export const decodeBase64Lines = (body: string) => {
  const lines = body === '' ? [] : body.split('\r\n')

  for (const line of lines) {
    expect(line.length).toBeLessThanOrEqual(76)
    expect(line).toMatch(/^[A-Za-z0-9+/=]+$/u)
  }

  return new Uint8Array(Buffer.from(lines.join(''), 'base64'))
}
