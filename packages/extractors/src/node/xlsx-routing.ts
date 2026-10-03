import { Buffer } from 'node:buffer'

/**
 * Early, exact rejection of XLSX input that SheetJS 0.20.3 would hand to its ODS, Numbers, or
 * binary (XLSB) parsers, so users get a clear error instead of "Could not read XLSX". These checks
 * are not the security guarantee: SheetJS only ever receives the allowlisted archive built by
 * `buildSheetJsInput` (`xlsx-sheetjs-input.ts`), which contains no marker entries and no `.bin`
 * parts whatever these checks decide.
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
 * An entry name as SheetJS looks it up: its ZIP reader (`cfb_add`) keeps a name that already
 * starts with `Root Entry/` and otherwise stores `"Root Entry/" + name` with the first `//`
 * collapsed; `safegetzipfile` strips `Root Entry/`, treats `\` and `/` alike, and compares
 * lower-cased names.
 */
export const sheetJsEntryPath = (name: string) =>
  (name.startsWith('Root Entry/') ? name : `Root Entry/${name}`.replace('//', '/'))
    .replace(/^Root Entry\//, '')
    .replaceAll('\\', '/')
    .toLowerCase()

/** Entries `parse_zip` checks before content types (SheetJS-normalized paths). */
const alternateFormatEntries = new Set([
  'meta-inf/manifest.xml',
  'objectdata.xml',
  'index/document.iwa'
])

/**
 * Whether SheetJS would treat this entry as an ODS, UOC, or Numbers marker. `CFB.find` matches
 * `Index.zip` by base name, and any `Root Entry/` name (any case) is rejected outright.
 */
export const isAlternateFormatEntry = (name: string) => {
  const path = sheetJsEntryPath(name)

  return (
    name.toLowerCase().startsWith('root entry/') ||
    alternateFormatEntries.has(path) ||
    path.slice(path.lastIndexOf('/') + 1) === 'index.zip'
  )
}

/**
 * SheetJS's own tag pattern (`tagregex1`, used for every part it parses): quoted values may hold
 * `<` and `>`. Each attempt stops at the next quote of its kind, so a scan stays linear.
 */
const sheetJsTag =
  /<[/?]?[a-zA-Z0-9:_-]+(?:\s+[^"\s?<>/]+\s*=\s*(?:"[^"]*"|'[^']*'|[^'"<>\s=]+))*\s*[/?]?>/gm

/** SheetJS `attregexg`. */
const sheetJsAttribute = /\s([^"\s?>/]+)\s*=\s*((?:")([^"]*)(?:")|(?:')([^']*)(?:')|([^'">\s]+))/g

type SheetJsTag = {
  /** The tag up to its first space, line feed, or carriage return (SheetJS `y[0]`). */
  readonly head: string
  readonly attributes: ReadonlyMap<string, string>
}

/**
 * Port of SheetJS `parsexmltag`: exact-case keys (plus lower-cased copies), a namespace prefix
 * dropped, an unprefixed name cut at its first `_`, the last value winning. Values are raw.
 */
const parseSheetJsTag = (tag: string): SheetJsTag => {
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

/** Whether any tag SheetJS would parse from any view of `content` satisfies `test`. */
const someSheetJsTag = (content: Uint8Array, test: (tag: SheetJsTag) => boolean) =>
  sheetJsTextViews(content).some(text => {
    for (const [tag] of text.matchAll(sheetJsTag)) {
      if (test(parseSheetJsTag(tag))) return true
    }

    return false
  })

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

/** SheetJS `resolve_path` from the directory of `xl/…` (only the final segment matters here). */
const resolveLikeSheetJs = (target: string) => {
  if (target.startsWith('/')) return target.slice(1)

  const segments = ['xl']

  for (const step of target.split('/')) {
    if (step === '..') segments.pop()
    else if (step !== '.') segments.push(step)
  }

  return segments.join('/')
}

/**
 * Whether a `Target` or `PartName` names a path ending in `.bin`, the only suffix SheetJS hands
 * to a binary parser. Checked raw and SheetJS-unescaped, as written and resolved.
 */
const namesBinaryPart = (value: string) =>
  [value, unescapeLikeSheetJs(value)].some(
    path =>
      path.toLowerCase().endsWith('.bin') || resolveLikeSheetJs(path).toLowerCase().endsWith('.bin')
  )

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
 * Whether a relationships part has a `<Relationship>` whose `Target` ends in `.bin` and whose
 * `Type` (read exactly as SheetJS reads it: case-sensitive, missing counts as a sheet) is not on
 * the allowlist.
 */
export const relationshipsRouteToBinary = (content: Uint8Array) =>
  someSheetJsTag(content, ({ head, attributes }) => {
    const target = attributes.get('Target')

    if (head !== '<Relationship' || target === undefined || !namesBinaryPart(target)) return false

    const type = attributes.get('Type')

    return type === undefined || !binaryRelationshipTypes.has(type.slice(type.lastIndexOf('/') + 1))
  })

/** Content types of `.bin` parts SheetJS never parses, lower-cased. */
const binaryPartContentTypes = new Set([
  'application/vnd.openxmlformats-officedocument.spreadsheetml.printersettings',
  'application/vnd.ms-office.activex',
  'application/vnd.openxmlformats-officedocument.oleobject',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.customproperty',
  'application/vnd.ms-excel.attachedtoolbars'
])

/** XLSB part types: `application/vnd.ms-excel.*` without an `+xml` suffix (toolbars excepted). */
const isBinarySpreadsheetType = (contentType: string) =>
  contentType.startsWith('application/vnd.ms-excel.') &&
  !contentType.endsWith('+xml') &&
  !binaryPartContentTypes.has(contentType)

/**
 * Whether `[Content_Types].xml` has an `<Override>` (any prefix, as SheetJS reads it) with an
 * XLSB content type, or a `PartName` ending in `.bin` whose content type is not on the allowlist.
 * `<Default>` entries are ignored: SheetJS does not route by them, and its own XLSX writer emits
 * `<Default Extension="bin">` with the XLSB workbook type.
 */
export const contentTypesRouteToBinary = (content: Uint8Array) =>
  someSheetJsTag(content, ({ head, attributes }) => {
    if (head.replace(/<\w*:/, '<') !== '<Override') return false

    const contentType = attributes.get('ContentType')?.toLowerCase()
    const partName = attributes.get('PartName')

    if (contentType !== undefined && isBinarySpreadsheetType(contentType)) return true

    return (
      partName !== undefined &&
      namesBinaryPart(partName) &&
      (contentType === undefined || !binaryPartContentTypes.has(contentType))
    )
  })
