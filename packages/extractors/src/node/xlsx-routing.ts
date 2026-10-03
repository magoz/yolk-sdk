import { Buffer } from 'node:buffer'

/**
 * Keep XLSX input on SheetJS's XML path. SheetJS 0.20.3 `parse_zip` routes an archive to its ODS
 * or Numbers parsers when certain entries exist (checked before content types), and hands any
 * part whose path ends in `.bin` to its binary (XLSB) parsers. `parse_ws_bin` expands every
 * `BrtHLink` range into per-cell objects, and `parse_ods` expands repeated rows and columns, both
 * before any extractor budget runs. None of those parts pass through the XML hyperlink strip.
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

/** Entries `parse_zip` checks before content types (case-insensitive full paths). */
const alternateFormatEntries = new Set([
  'meta-inf/manifest.xml',
  'objectdata.xml',
  'index/document.iwa'
])

/**
 * Whether SheetJS would treat this entry name as an ODS, UOC, or Numbers marker. `CFB.find`
 * matches `Index.zip` by base name, and the CFB container strips a leading `Root Entry/`, so such
 * names are rejected outright.
 */
export const isAlternateFormatEntry = (name: string) => {
  const lower = name.toLowerCase()

  return (
    alternateFormatEntries.has(lower) ||
    lower.startsWith('root entry/') ||
    lower.slice(lower.lastIndexOf('/') + 1) === 'index.zip'
  )
}

/** SheetJS dispatches to a binary parser only for paths ending in `.bin`. */
export const isBinaryPartName = (name: string) => name.toLowerCase().endsWith('.bin')

/** Parts SheetJS may read during extraction: everything except `.bin` parts (the backstop). */
export const withoutBinaryParts = (parts: Readonly<Record<string, Uint8Array>>) => {
  const kept: Record<string, Uint8Array> = Object.create(null)

  for (const [name, bytes] of Object.entries(parts)) {
    if (!isBinaryPartName(name)) kept[name] = bytes
  }

  return kept
}

// Tag candidates never span a `<`, so every scan is linear in the part size. The quote-aware
// pattern also keeps `>` inside quoted values; the plain one tolerates unbalanced quotes.
const plainTag = /<[^<>]*>/g

const quotedTag = /<[^<>"']*(?:(?:"[^"<]*"|'[^'<]*')[^<>"']*)*>/g

const tagName = /^<[/?]?([^\s/>]*)/

/** Attributes as SheetJS `parsexmltag` reads them: preceded by whitespace, any quoting. */
const attributePattern = /(?<=\s)([^"\s?>/=]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^'">\s]+))/g

/** Start tags whose local name (any prefix, any case) is `localName`, from every view. */
const tagsNamed = (content: Uint8Array, localName: string) => {
  const tags = new Set<string>()

  for (const text of sheetJsTextViews(content)) {
    for (const pattern of [plainTag, quotedTag]) {
      for (const [tag] of text.matchAll(pattern)) {
        const name = tagName.exec(tag)?.[1] ?? ''

        if (name.slice(name.indexOf(':') + 1).toLowerCase() === localName) tags.add(tag)
      }
    }
  }

  return tags
}

/**
 * Every value of the attribute keys SheetJS would read as `key` (compared case-insensitively):
 * a namespace prefix is dropped, and an unprefixed name is cut at its first `_`, as SheetJS does.
 */
const attributeValues = (tag: string, key: string) => {
  const values: Array<string> = []

  for (const match of tag.matchAll(attributePattern)) {
    const name = match[1] ?? ''
    const colon = name.indexOf(':')
    const underscore = name.indexOf('_')

    const local =
      colon >= 0 ? name.slice(colon + 1) : underscore > 0 ? name.slice(0, underscore) : name

    const value = match[2] ?? match[3] ?? match[4]

    if (value !== undefined && local.toLowerCase() === key) values.push(value)
  }

  return values
}

const namedEntities: ReadonlyMap<string, string> = new Map([
  ['quot', '"'],
  ['apos', "'"],
  ['gt', '>'],
  ['lt', '<'],
  ['amp', '&']
])

/** SheetJS `unescapexml`: XML entities, numeric references, `_xHHHH_` codes, CDATA. */
const unescapeLikeSheetJs = (text: string): string =>
  text
    .replace(/<!\[CDATA\[|\]\]>/g, '')
    .replace(/&(quot|apos|gt|lt|amp|#x?[\da-f]+);/gi, (raw, entity: string) => {
      const named = namedEntities.get(entity.toLowerCase())

      if (named !== undefined) return named

      const hex = entity[1] === 'x' || entity[1] === 'X'
      const code = Number.parseInt(entity.slice(hex ? 2 : 1), hex ? 16 : 10)

      return Number.isInteger(code) && code <= 0xffff ? String.fromCharCode(code) : raw
    })
    .replace(/_x([\da-f]{4})_/gi, (_, code: string) =>
      String.fromCharCode(Number.parseInt(code, 16))
    )

/** A `.bin` path anywhere in the tag text, raw or after SheetJS unescaping. */
const binaryPathPattern = /\.bin\b/i

const mentionsBinaryPart = (tag: string) =>
  binaryPathPattern.test(tag) || binaryPathPattern.test(unescapeLikeSheetJs(tag))

const normalizedValues = (values: ReadonlyArray<string>) =>
  values.flatMap(value => [value, unescapeLikeSheetJs(value)]).map(value => value.trim())

/**
 * Relationship types whose `.bin` targets SheetJS never parses: it follows workbook
 * relationships only as sheets (worksheet, chartsheet, dialogsheet, macrosheet, or no type) and
 * worksheet relationships only as comments, drawings, and legacy drawings.
 */
const binaryRelationshipTypes = new Set([
  'printerSettings',
  'oleObject',
  'activeXControlBinary',
  'customProperty',
  'attachedToolbars',
  'image',
  'hyperlink'
])

/**
 * Whether a relationships part names a `.bin` target under a relationship type outside the
 * allowlist. Every tag naming a `.bin` path must carry only allowlisted types.
 */
export const relationshipsRouteToBinary = (content: Uint8Array) => {
  for (const tag of tagsNamed(content, 'relationship')) {
    if (!mentionsBinaryPart(tag)) continue

    const types = normalizedValues(attributeValues(tag, 'type'))

    if (
      types.length === 0 ||
      !types.every(type => binaryRelationshipTypes.has(type.slice(type.lastIndexOf('/') + 1)))
    )
      return true
  }

  return false
}

/** Content types SheetJS maps to its workbook parser (`ct2type` "workbooks"), lower-cased. */
const workbookContentTypes = new Set([
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml',
  'application/vnd.ms-excel.sheet.macroenabled.main+xml',
  'application/vnd.ms-excel.sheet.binary.macroenabled.main',
  'application/vnd.ms-excel.addin.macroenabled.main+xml',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.template.main+xml'
])

/** Content types of `.bin` parts SheetJS never parses, lower-cased. */
const binaryPartContentTypes = new Set([
  'application/vnd.openxmlformats-officedocument.spreadsheetml.printersettings',
  'application/vnd.ms-office.activex',
  'application/vnd.openxmlformats-officedocument.oleobject',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.customproperty'
])

/** XLSB part types: `application/vnd.ms-excel.*` without an `+xml` suffix. */
const isBinarySpreadsheetType = (contentType: string) =>
  contentType.startsWith('application/vnd.ms-excel.') && !contentType.endsWith('+xml')

/**
 * Whether `[Content_Types].xml` sends SheetJS to a binary parser: an `<Override>` with an XLSB
 * content type, a workbook part other than `/xl/workbook.xml`, or a `.bin` part whose content
 * type is outside the allowlist. `<Default>` entries are ignored: SheetJS does not route by them,
 * and its own XLSX writer emits `<Default Extension="bin">` with the XLSB workbook type.
 */
export const contentTypesRouteToBinary = (content: Uint8Array) => {
  for (const tag of tagsNamed(content, 'override')) {
    const contentTypes = normalizedValues(attributeValues(tag, 'contenttype')).map(type =>
      type.toLowerCase()
    )

    const partNames = normalizedValues(attributeValues(tag, 'partname'))

    if (contentTypes.some(isBinarySpreadsheetType)) return true

    if (
      contentTypes.some(type => workbookContentTypes.has(type)) &&
      (partNames.length === 0 || partNames.some(name => name !== '/xl/workbook.xml'))
    )
      return true

    if (
      mentionsBinaryPart(tag) &&
      (contentTypes.length === 0 || !contentTypes.every(type => binaryPartContentTypes.has(type)))
    )
      return true
  }

  return false
}
