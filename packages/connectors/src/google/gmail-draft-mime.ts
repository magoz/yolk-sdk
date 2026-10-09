/**
 * Body MIME of the drafts `gmail.draft_compose`, `gmail.draft_update`, and `gmail.draft_reply`
 * build.
 *
 * Gmail web opens a text/plain-only draft in its plain-text composer and hard-wraps it at about
 * 70 columns when a person clicks Send; a draft with an HTML alternative opens in rich mode and
 * goes out unwrapped. Gmail also rewraps long unencoded (7bit/8bit) text/plain lines. So a text
 * body becomes `multipart/alternative`: the exact text, then HTML derived from it, both
 * quoted-printable with lines of at most 76 characters. An HTML body is one text/html part.
 *
 * A draft with attachments wraps that body entity as the first part of a 7-bit `multipart/mixed`,
 * followed by one base64 part per attachment.
 */
import type { GmailDraftContentType } from './gmail.ts'

/**
 * The `multipart/alternative` boundary. `=_` never occurs in quoted-printable output (every `=`
 * starts a hex escape or a soft line break), so it cannot collide with either part, and it is
 * constant so the same body always yields the same MIME.
 */
export const gmailDraftAlternativeBoundary = '=_yolk-draft-alternative'

const quotedPrintableMaxLineLength = 76

const utf8 = new TextEncoder()

const hexEscape = (byte: number) => `=${byte.toString(16).toUpperCase().padStart(2, '0')}`

/** One code point as quoted-printable, its bytes kept together so no soft break splits them. */
const quotedPrintableToken = (char: string, isLineEnd: boolean): string => {
  if (char === ' ') return isLineEnd ? hexEscape(0x20) : char

  const code = char.charCodeAt(0)

  if (char.length === 1 && code >= 0x21 && code <= 0x7e && char !== '=') return char

  let token = ''

  for (const byte of utf8.encode(char)) {
    token += hexEscape(byte)
  }

  return token
}

/** One hard line as quoted-printable lines, soft-wrapped to at most 76 characters each. */
const quotedPrintableLine = (line: string): ReadonlyArray<string> => {
  const chars = Array.from(line)
  const lines: Array<string> = []
  let current = ''

  for (let index = 0; index < chars.length; index += 1) {
    const token = quotedPrintableToken(chars[index] ?? '', index === chars.length - 1)

    // Leave room for the soft break's trailing `=`.
    if (current.length + token.length > quotedPrintableMaxLineLength - 1) {
      lines.push(`${current}=`)
      current = ''
    }

    current += token
  }

  lines.push(current)

  return lines
}

/** `text` with CRLF and lone CR line breaks normalized to LF. */
const normalizeGmailDraftLineBreaks = (text: string) =>
  text.replaceAll('\r\n', '\n').replaceAll('\r', '\n')

/**
 * `text` (UTF-8) as quoted-printable with CRLF hard line breaks: every input line break is a hard
 * break, and every encoded line is at most 76 characters.
 */
export const encodeGmailQuotedPrintable = (text: string): string =>
  normalizeGmailDraftLineBreaks(text).split('\n').flatMap(quotedPrintableLine).join('\r\n')

const escapeHtml = (text: string) =>
  text
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;')

/**
 * Escaped text whose runs of spaces survive HTML whitespace collapsing: the first space of a run
 * stays a space and the rest become `&nbsp;`; spaces that start a line are all `&nbsp;`.
 */
const htmlText = (text: string, atLineStart: boolean) =>
  escapeHtml(text).replaceAll(/ +/g, (run, offset: number) =>
    atLineStart && offset === 0
      ? '&nbsp;'.repeat(run.length)
      : ` ${'&nbsp;'.repeat(run.length - 1)}`
  )

/** `http(s)://` followed by characters that cannot end or quote a URL in prose. */
const urlPattern = /\bhttps?:\/\/[^\s<>"'`]+/gi

const trailingUrlPunctuation = new Set(['.', ',', ';', ':', '!', '?'])

const count = (text: string, char: string) => text.split(char).length - 1

const closingBrackets = new Map([
  [')', '('],
  [']', '[']
])

/** A matched URL without the sentence punctuation (and unbalanced `)` or `]`) that follows it. */
const trimUrl = (url: string): string => {
  let trimmed = url

  for (;;) {
    const last = trimmed.at(-1)
    const opening = last === undefined ? undefined : closingBrackets.get(last)

    if (last !== undefined && trailingUrlPunctuation.has(last)) {
      trimmed = trimmed.slice(0, -1)
    } else if (
      last !== undefined &&
      opening !== undefined &&
      count(trimmed, last) > count(trimmed, opening)
    ) {
      trimmed = trimmed.slice(0, -1)
    } else {
      return trimmed
    }
  }
}

/** One line as HTML: escaped text, preserved spaces, and `http(s)` URLs as links to themselves. */
const htmlLine = (line: string): string => {
  let html = ''
  let consumed = 0

  for (const match of line.matchAll(urlPattern)) {
    const url = trimUrl(match[0])

    // A bare scheme (`https://` followed by punctuation only) stays text.
    if (!/^https?:\/\/./i.test(url)) continue

    html += htmlText(line.slice(consumed, match.index), consumed === 0)

    const escaped = escapeHtml(url)

    html += `<a href="${escaped}">${escaped}</a>`
    consumed = match.index + url.length
  }

  return html + htmlText(line.slice(consumed), consumed === 0)
}

/**
 * The HTML alternative of a plain-text draft body, shaped like Gmail's own composer output: one
 * `<div dir="ltr">`, `<br>` for every line break (so a blank line is `<br><br>`), no document
 * wrapper, styles, or fonts. `& < > " '` are escaped, runs of spaces are preserved, and `http(s)`
 * URLs become links whose visible text equals their `href` (mail clients do not link bare URLs
 * inside HTML). Line breaks are normalized first (CRLF and CR become LF).
 */
export const gmailDraftHtmlFromText = (text: string): string =>
  `<div dir="ltr">${normalizeGmailDraftLineBreaks(text).split('\n').map(htmlLine).join('<br>')}</div>`

const quotedPrintablePart = (contentType: string, content: string) =>
  [
    `Content-Type: ${contentType}; charset=UTF-8`,
    'Content-Transfer-Encoding: quoted-printable',
    '',
    encodeGmailQuotedPrintable(content)
  ].join('\r\n')

/** The body entity (content headers and content, no `MIME-Version`) of a draft body. */
const gmailDraftBodyEntity = (body: string, contentType: GmailDraftContentType): string => {
  if (contentType === 'html') return quotedPrintablePart('text/html', body)

  const delimiter = `--${gmailDraftAlternativeBoundary}`

  return [
    `Content-Type: multipart/alternative; boundary="${gmailDraftAlternativeBoundary}"`,
    '',
    delimiter,
    quotedPrintablePart('text/plain', body),
    delimiter,
    quotedPrintablePart('text/html', gmailDraftHtmlFromText(body)),
    `${delimiter}--`
  ].join('\r\n')
}

/**
 * The `MIME-Version`, content headers, and body of a draft (everything after its address,
 * subject, and threading headers), CRLF-separated and 7-bit: a `text` body becomes
 * `multipart/alternative` (text/plain with the exact body, then the derived text/html), an `html`
 * body a single text/html part.
 */
export const gmailDraftBodyMime = (body: string, contentType: GmailDraftContentType): string =>
  ['MIME-Version: 1.0', gmailDraftBodyEntity(body, contentType)].join('\r\n')

/**
 * The `multipart/mixed` boundary of a draft with attachments. Like the alternative boundary, `=_`
 * never occurs in quoted-printable or base64 content, header continuation lines start with
 * whitespace, and `--=_yolk-draft-alternative` does not start with this delimiter, so it cannot
 * collide with any part; it is constant so the same draft always yields the same MIME.
 */
export const gmailDraftMixedBoundary = '=_yolk-draft-mixed'

/** One already validated draft attachment: canonical standard base64 content. */
export type GmailDraftMimeAttachment = {
  readonly filename: string
  readonly mimeType: string
  readonly contentBase64: string
}

const base64MaxLineLength = 76

/** Canonical base64 split into lines of at most 76 characters (RFC 2045), CRLF-joined. */
const base64Lines = (encoded: string): string => {
  const lines: Array<string> = []

  for (let index = 0; index < encoded.length; index += base64MaxLineLength) {
    lines.push(encoded.slice(index, index + base64MaxLineLength))
  }

  return lines.join('\r\n')
}

/** Longest unfolded parameter line before a name is encoded instead (RFC 5322 recommends 78). */
const headerLineMaxLength = 78

const printableAscii = /^[\x20-\x7e]*$/u

/** A quoted-string with `"` and `\` as quoted-pairs. */
const quotedParameter = (value: string) => `"${value.replaceAll(/["\\]/gu, char => `\\${char}`)}"`

/** Longest UTF-8 run per RFC 2047 B-word: 42 bytes encode to 56 characters, a 68-character word. */
const encodedWordMaxBytes = 42

const base64OfBytes = (bytes: Uint8Array) => {
  let binary = ''

  for (const byte of bytes) binary += String.fromCharCode(byte)

  return btoa(binary)
}

/** RFC 2047 UTF-8 B-encoded words of at most 75 characters, never splitting a code point. */
const encodedWords = (value: string): ReadonlyArray<string> => {
  const words: Array<string> = []
  let pending = ''

  for (const char of value) {
    if (pending !== '' && utf8.encode(pending + char).length > encodedWordMaxBytes) {
      words.push(pending)
      pending = char
    } else {
      pending += char
    }
  }

  if (pending !== '') words.push(pending)

  return words.map(word => `=?UTF-8?B?${base64OfBytes(utf8.encode(word))}?=`)
}

/** RFC 2231 `attr-char`: every other octet is percent-encoded. */
const attrChar = /^[A-Za-z0-9!#$&+\-.^_`|~]$/u

/** Longest encoded value per RFC 2231 continuation, keeping folded lines short. */
const extendedParameterChunkLength = 50

/** RFC 2231 `name*=UTF-8''...`, split into `name*0*`, `name*1*`, ... continuations when long. */
const extendedParameter = (name: string, value: string): ReadonlyArray<string> => {
  const chunks: Array<string> = []
  let current = ''

  for (const byte of utf8.encode(value)) {
    const char = String.fromCharCode(byte)

    const token =
      byte < 0x80 && attrChar.test(char)
        ? char
        : `%${byte.toString(16).toUpperCase().padStart(2, '0')}`

    if (current.length + token.length > extendedParameterChunkLength) {
      chunks.push(current)
      current = token
    } else {
      current += token
    }
  }

  chunks.push(current)

  return chunks.length === 1
    ? [`${name}*=UTF-8''${chunks[0] ?? ''}`]
    : chunks.map((chunk, index) =>
        index === 0 ? `${name}*0*=UTF-8''${chunk}` : `${name}*${index}*=${chunk}`
      )
}

/**
 * An attachment part: `Content-Type` with `name`, base64 transfer encoding, and an `attachment`
 * disposition with `filename`. A short printable-ASCII name stays a quoted-string on one line;
 * any other name is folded as RFC 2047 words in `name` and RFC 2231 `filename*` continuations.
 */
const attachmentPart = (attachment: GmailDraftMimeAttachment): string => {
  const plain = printableAscii.test(attachment.filename)
  const typeLine = `Content-Type: ${attachment.mimeType}; name=${quotedParameter(attachment.filename)}`

  const dispositionLine = `Content-Disposition: attachment; filename=${quotedParameter(attachment.filename)}`

  return [
    plain && typeLine.length <= headerLineMaxLength
      ? typeLine
      : `Content-Type: ${attachment.mimeType};\r\n name="${encodedWords(attachment.filename).join('\r\n ')}"`,
    'Content-Transfer-Encoding: base64',
    plain && dispositionLine.length <= headerLineMaxLength
      ? dispositionLine
      : `Content-Disposition: attachment;\r\n ${extendedParameter('filename', attachment.filename).join(';\r\n ')}`,
    '',
    base64Lines(attachment.contentBase64)
  ].join('\r\n')
}

/**
 * Like `gmailDraftBodyMime`, but with attachments: a 7-bit `multipart/mixed` whose first part is
 * the draft body entity (the same `multipart/alternative` or text/html part), followed by one
 * base64 part per attachment, in order. Without attachments it is exactly `gmailDraftBodyMime`.
 */
export const gmailDraftMime = (
  body: string,
  contentType: GmailDraftContentType,
  attachments: ReadonlyArray<GmailDraftMimeAttachment>
): string => {
  if (attachments.length === 0) return gmailDraftBodyMime(body, contentType)

  const delimiter = `--${gmailDraftMixedBoundary}`

  return [
    'MIME-Version: 1.0',
    `Content-Type: multipart/mixed; boundary="${gmailDraftMixedBoundary}"`,
    '',
    delimiter,
    gmailDraftBodyEntity(body, contentType),
    ...attachments.flatMap(attachment => [delimiter, attachmentPart(attachment)]),
    `${delimiter}--`
  ].join('\r\n')
}
