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

// SheetJS matches `_xHHHH_` codes ignoring case (`coderegex`), so `_X0041_` is a code too.
const startsCodeEscape = /_x[\da-fA-F]{4}_/iy

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

type TextStep = (text: string) => string | undefined

/** The two conversions SheetJS chains over cell and shared-string text. */
const sheetJsTextSteps: ReadonlyArray<TextStep> = [sheetJsUnescapeXml, sheetJsUtf8Read]

/** Depth first, so at most `steps + 1` derived strings are alive at once. */
const meetsCdata = (text: string, steps: number): boolean => {
  if (text.includes(cdataMarker)) return true

  if (steps === 0) return false

  return sheetJsTextSteps.some(step => {
    const next = step(text)

    return next !== undefined && next !== text && meetsCdata(next, steps - 1)
  })
}

const isNameCode = (code: number) =>
  (code >= 48 && code <= 57) || // 0-9
  (code >= 65 && code <= 90) || // A-Z
  (code >= 97 && code <= 122) || // a-z
  code === 95 || // _
  code === 46 || // .
  code === 45 // -

/** The end of the run of name characters (`[\w.-]`) starting at `start`. */
const nameEnd = (text: string, start: number) => {
  let end = start

  while (end < text.length && isNameCode(text.charCodeAt(end))) end += 1

  return end
}

/**
 * `text` without its simple opening tags, `<(?:[\w.-]+:)?[\w.-]+>`: a superset of the tags SheetJS
 * removes before decoding (`<(?:\w+:)?(?:si|sstItem)>` in `parse_sst_xml`, `<(?:\w+:)?r>` in
 * `parse_rs`). One forward scan: a `<` that does not start such a tag is kept and the scan resumes
 * at the next `<`, so every character is read at most twice.
 */
export const withoutSimpleTags = (text: string) => {
  let output = ''
  let kept = 0
  let index = text.indexOf('<')

  while (index >= 0) {
    let end = nameEnd(text, index + 1)

    if (end > index + 1 && text.charCodeAt(end) === 58) {
      const local = nameEnd(text, end + 1)

      end = local > end + 1 ? local : -1
    }

    if (end > index + 1 && text.charCodeAt(end) === 62) {
      output += text.slice(kept, index)
      kept = end + 1
      index = text.indexOf('<', kept)
    } else {
      index = text.indexOf('<', index + 1)
    }
  }

  return output + text.slice(kept)
}

/** `<<` or `<!`: never written in worksheets or shared strings by Excel, LibreOffice, or Sheets. */
const hasMarkupOpener = (text: string) => text.includes('<<') || text.includes('<!')

/**
 * Whether SheetJS could meet a CDATA marker in this part. SheetJS's `unescapexml` handles CDATA by
 * recursing on a string two characters shorter and copying the whole tail at every level, so an
 * unterminated marker costs quadratic time and memory.
 *
 * What SheetJS hands to `unescapexml` in a worksheet or shared-strings part comes from the part
 * text through two kinds of transformation:
 *
 * - Decodes: raw (`<v>` of every cell), `utf8read(raw)` (shared and inline strings), and
 *   `utf8read(unescapexml(raw))` (cells of type `str`, decoded again after `utf8read`).
 *   `utf8read` keeps only the low byte of each character, so U+013C from `_x013C_`, `&#x13C;`, or
 *   `&#316;` becomes `<`.
 * - Tag removal before decoding: `parse_sst_xml` removes every `<si>`/`<sstItem>` opening tag
 *   from the whole shared-strings table, and `parse_rs` removes every `<r>` opening tag from rich
 *   text (after `utf8read`). Inline strings (`t="inlineStr"`) call `parse_si` without options,
 *   so their rich text is processed even with `cellHTML: false`. `A<<r>![CDATA[B` thus reaches
 *   `unescapexml` as `A<![CDATA[B`.
 *
 * So the check rejects a text view (`sheetJsTextViews`) when:
 *
 * - the view, or `utf8read` of it, contains `<<` or `<!`. A marker assembled by removing tags
 *   needs a literal `<` (in the view, or from `utf8read`) followed by a removed tag, or by `!`,
 *   and every removed tag starts with `<`;
 * - the view, or the view without any simple opening tag (`withoutSimpleTags`, a superset of
 *   SheetJS's removals), meets the marker raw or after any chain of up to two steps of
 *   `unescapexml` and `utf8read`, in any order (a superset of SheetJS's decode sequences).
 *
 * Every step is a linear pass, at most a few per view. The first rule deliberately fails closed:
 * it also rejects XML comments, `<!DOCTYPE`, and any other `<!…` declaration, which Excel,
 * LibreOffice, and Google Sheets never write in worksheets or shared strings (nor a literal `<<`).
 */
export const sheetJsCouldReadCdata = (content: Uint8Array) =>
  sheetJsTextViews(content).some(
    view =>
      hasMarkupOpener(view) ||
      hasMarkupOpener(sheetJsUtf8Read(view)) ||
      meetsCdata(view, 2) ||
      meetsCdata(withoutSimpleTags(view), 2)
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
