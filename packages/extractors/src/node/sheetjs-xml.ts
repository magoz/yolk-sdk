import { Buffer } from 'node:buffer'

/**
 * Ports of the SheetJS 0.20.3 XML helpers (`xlsx.mjs`) the extractor needs to read a part the way
 * SheetJS would: its tag pattern, `parsexmltag`, `strip_ns`, `utf8read`, and `unescapexml`.
 * Everything here is linear in the text it scans.
 */

const swapUtf16ByteOrder = (bytes: Buffer) =>
  Buffer.from(bytes.subarray(0, bytes.length - (bytes.length % 2))).swap16()

/**
 * The texts SheetJS can read from a part: its Latin-1 ("binary") view and, for BOM-marked parts,
 * the UTF-16 decodings of `cc2str` (little- and big-endian from byte 2, including its
 * `arr[1]/arr[2]` Buffer check) plus an extra odd-offset big-endian decode.
 */
export const sheetJsTextViews = (content: Uint8Array): ReadonlyArray<string> => {
  const bytes = Buffer.from(content.buffer, content.byteOffset, content.byteLength)
  const latin1 = bytes.toString('latin1')
  const littleEndian = bytes[0] === 0xff && bytes[1] === 0xfe
  const bigEndian = bytes[0] === 0xfe && bytes[1] === 0xff
  const offsetBigEndian = bytes[1] === 0xfe && bytes[2] === 0xff

  if (!littleEndian && !bigEndian && !offsetBigEndian) return [latin1]

  return [
    latin1,
    bytes.subarray(2).toString('utf16le'),
    swapUtf16ByteOrder(bytes.subarray(2)).toString('utf16le'),
    swapUtf16ByteOrder(bytes.subarray(3)).toString('utf16le')
  ]
}

/**
 * SheetJS's own tag pattern (`tagregex1`, used for every part it parses): quoted values may hold
 * `<` and `>`. Each attempt stops at the next quote of its kind, so a scan stays linear.
 */
const sheetJsTagPattern =
  /<[/?]?[a-zA-Z0-9:_-]+(?:\s+[^"\s?<>/]+\s*=\s*(?:"[^"]*"|'[^']*'|[^'"<>\s=]+))*\s*[/?]?>/gm

/** SheetJS `attregexg`. */
const sheetJsAttribute = /\s([^"\s?>/]+)\s*=\s*((?:")([^"]*)(?:")|(?:')([^']*)(?:')|([^'">\s]+))/g

export type SheetJsTag = {
  /** The tag up to its first space, line feed, or carriage return (SheetJS `y[0]`). */
  readonly head: string
  /** Raw (still escaped) attribute values by SheetJS key, plus lower-cased copies. */
  readonly attributes: ReadonlyMap<string, string>
}

/**
 * Port of SheetJS `parsexmltag`: exact-case keys (plus lower-cased copies), a namespace prefix
 * dropped, an unprefixed name cut at its first `_`, the last value winning. Values are raw.
 */
export const parseSheetJsTag = (tag: string): SheetJsTag => {
  let end = 0

  for (; end < tag.length; end += 1) {
    const code = tag.charCodeAt(end)

    if (code === 32 || code === 10 || code === 13) break
  }

  const attributes = new Map<string, string>()

  if (end === tag.length) return { head: tag, attributes }

  for (const [match] of tag.matchAll(sheetJsAttribute)) {
    const text = match.slice(1)
    let equals = text.indexOf('=')
    let name = text.slice(0, equals).trim()

    while (text.charCodeAt(equals + 1) === 32) equals += 1

    const quoteCode = text.charCodeAt(equals + 1)
    const quoted = quoteCode === 34 || quoteCode === 39 ? 1 : 0
    const value = text.slice(equals + 1 + quoted, text.length - quoted)
    const colon = name.indexOf(':')

    if (colon < 0) {
      if (name.indexOf('_') > 0) name = name.slice(0, name.indexOf('_'))
    } else {
      const local = (colon === 5 && name.startsWith('xmlns') ? 'xmlns' : '') + name.slice(colon + 1)

      if (attributes.has(local) && name.slice(colon - 3, colon) === 'ext') continue

      name = local
    }

    attributes.set(name, value)
    attributes.set(name.toLowerCase(), value)
  }

  return { head: tag.slice(0, end), attributes }
}

/** Every tag SheetJS's pattern finds in `text`, in document order. */
export function* sheetJsTags(text: string): Generator<SheetJsTag> {
  for (const [tag] of text.matchAll(sheetJsTagPattern)) yield parseSheetJsTag(tag)
}

/** SheetJS `strip_ns`: the first `<prefix:` (or `</prefix:`) loses its prefix. */
export const stripSheetJsNamespace = (head: string) => head.replace(/<(\/?)\w+:/, '<$1')

/** SheetJS `utf8read` in Node: the Latin-1 ("binary") string read back as UTF-8. */
export const sheetJsUtf8Read = (binary: string) => Buffer.from(binary, 'latin1').toString('utf8')

const encodings: ReadonlyMap<string, string> = new Map([
  ['&quot;', '"'],
  ['&apos;', "'"],
  ['&gt;', '>'],
  ['&lt;', '<'],
  ['&amp;', '&']
])

/**
 * SheetJS `unescapexml` for text without CDATA, quirks included: entity names match ignoring
 * case but only lower-case ones map (`&QUOT;` becomes U+0000), `&#X41;` is read as decimal, and
 * numeric references wrap at U+FFFF. Returns `undefined` for text with a CDATA marker, which
 * SheetJS splits recursively (and never ends for an unterminated one).
 */
export const sheetJsUnescapeXml = (text: string): string | undefined => {
  if (text.includes('<![CDATA[')) return undefined

  return text
    .replace(
      /&(?:quot|apos|gt|lt|amp|#x?([\da-fA-F]+));/gi,
      (entity, code: string | undefined) =>
        encodings.get(entity) ??
        String.fromCharCode(Number.parseInt(code ?? '', entity.includes('x') ? 16 : 10))
    )
    .replace(/_x([\da-fA-F]{4})_/gi, (_, code: string) =>
      String.fromCharCode(Number.parseInt(code, 16))
    )
}

/** An attribute value as SheetJS reads text attributes: `unescapexml(utf8read(raw))`. */
export const sheetJsAttributeText = (raw: string) => sheetJsUnescapeXml(sheetJsUtf8Read(raw))

const isHighSurrogate = (code: number) => code >= 0xd800 && code <= 0xdbff

const isLowSurrogate = (code: number) => code >= 0xdc00 && code <= 0xdfff

const codeEscape = (code: number) => `_x${code.toString(16).toUpperCase().padStart(4, '0')}_`

const escapedCharacters: ReadonlyMap<string, string> = new Map([
  ['&', '&amp;'],
  ['<', '&lt;'],
  ['>', '&gt;'],
  ['"', '&quot;']
])

const startsCodeEscape = /_x[\da-fA-F]{4}_/y

/**
 * Escape `text` for a double-quoted attribute of a generated UTF-8 part so that SheetJS's
 * `unescapexml(utf8read(…))` returns `text` exactly: markup characters become entities, an `_`
 * that would start an `_xHHHH_` code becomes `_x005F_`, and control characters, U+FFFE, U+FFFF,
 * and lone surrogates become `_xHHHH_` codes.
 */
export const sheetJsAttributeEscape = (text: string) => {
  let output = ''

  for (let index = 0; index < text.length; index += 1) {
    const character = text.charAt(index)
    const code = text.charCodeAt(index)
    const escaped = escapedCharacters.get(character)

    if (escaped !== undefined) {
      output += escaped
      continue
    }

    if (character === '_') {
      startsCodeEscape.lastIndex = index
      output += startsCodeEscape.test(text) ? codeEscape(code) : character
      continue
    }

    if (isHighSurrogate(code) && isLowSurrogate(text.charCodeAt(index + 1))) {
      output += text.slice(index, index + 2)
      index += 1
      continue
    }

    output +=
      code < 0x20 ||
      code === 0xfffe ||
      code === 0xffff ||
      isHighSurrogate(code) ||
      isLowSurrogate(code)
        ? codeEscape(code)
        : character
  }

  return output
}

/** SheetJS's own `XML_HEADER`, used for every generated part. */
export const sheetJsXmlHeader = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\r\n'

export const spreadsheetMainNamespace = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main'

export const officeDocumentRelationshipsNamespace =
  'http://schemas.openxmlformats.org/officeDocument/2006/relationships'

const cdataMarker = '<![CDATA['

/**
 * Whether SheetJS could meet a CDATA marker in this part: in any text view (`sheetJsTextViews`),
 * raw or after one `unescapexml` (cells of type `str` are decoded twice, so `&lt;![CDATA[`
 * counts). SheetJS's `unescapexml` handles CDATA by recursing on a string two characters shorter
 * and copying the whole tail at every level, so an unterminated marker costs quadratic time and
 * memory. Excel, LibreOffice, and Google Sheets never write CDATA in worksheets or shared strings.
 */
export const sheetJsCouldReadCdata = (content: Uint8Array) =>
  sheetJsTextViews(content).some(
    text => text.includes(cdataMarker) || sheetJsUnescapeXml(text)?.includes(cdataMarker) === true
  )

const xmlBoundary = new Set([' ', '\t', '\r', '\n', '>'])

/** SheetJS `str_match_xml`: the first `<tag` element's inner text (exact prefix and case). */
const sheetJsElementText = (text: string, tag: string) => {
  const width = tag.length + 1
  let start = text.indexOf(`<${tag}`)

  while (start >= 0 && start <= text.length - width && !xmlBoundary.has(text.charAt(start + width)))
    start = text.indexOf(`<${tag}`, start + 1)

  if (start === -1) return undefined

  const contentStart = text.indexOf('>', start + tag.length)

  if (contentStart === -1) return undefined

  const end = text.indexOf(`</${tag}>`, contentStart)

  return end === -1 ? undefined : text.slice(contentStart + 1, end)
}

/**
 * The `dc:title` of a core-properties part, read as SheetJS `parse_core_props` reads it, without
 * handing the part to SheetJS. A title holding CDATA is ignored.
 */
export const coreTitle = (content: Uint8Array | undefined) => {
  if (content === undefined) return undefined

  const raw = sheetJsElementText(
    Buffer.from(content.buffer, content.byteOffset, content.byteLength).toString('utf8'),
    'dc:title'
  )

  const title = raw === undefined ? undefined : sheetJsUnescapeXml(raw)

  return title !== undefined && title.trim().length > 0 ? title : undefined
}
