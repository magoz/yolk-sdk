import { Buffer } from 'node:buffer'
import {
  sheetJsAttributeEscape,
  sheetJsAttributeText,
  sheetJsTags,
  sheetJsXmlHeader,
  spreadsheetMainNamespace,
  stripSheetJsNamespace
} from './sheetjs-xml.ts'

/**
 * `xl/styles.xml` is never handed to SheetJS as uploaded. With `cellText: true`, SheetJS formats
 * every styled cell by re-parsing its number format (`SSF_format`, work proportional to the
 * format's length, a quoted literal built one character at a time), so one huge format reused by
 * many cells amplifies before any budget runs. The extractor writes a minimal stylesheet with
 * only what display text needs: custom number formats (`numFmtId`, `formatCode`) of at most
 * `maxNumberFormatCharacters`, and one `<xf numFmtId>` per source cell format, in order, so cell
 * `s` indexes keep their meaning. Fonts, fills, borders, cell styles, and dxfs are left out:
 * SheetJS parses fonts, fills, and borders whatever the options but uses them only with
 * `cellStyles`, so leaving them out also removes their parsers from the input.
 */

/** Excel's own limit on a number format code, counted after unescaping. */
export const maxNumberFormatCharacters = 255

/** Custom number formats kept; later ones are dropped (their cells show General). */
export const maxCustomNumberFormats = 1000

/** Excel's limit on cell formats (`cellXfs`); later ones are dropped (General). */
export const maxCellFormats = 64_000

/** SheetJS `str_remove_ng(text, '<!--', '-->')`, including its unterminated-comment behavior. */
const removeComments = (text: string) => {
  let start = text.indexOf('<!--')

  if (start === -1) return text

  const output: Array<string> = []
  let last = 0

  while (start > -1) {
    output.push(text.slice(last, start))

    const end = text.indexOf('-->', start + 4)

    if (end === -1) break

    last = end + 3
    start = text.indexOf('<!--', last)

    if (start === -1) output.push(text.slice(last))
  }

  return output.join('')
}

/** SheetJS `remove_doctype`. */
const removeDoctype = (text: string) => {
  const doctype = text.slice(0, 1024).indexOf('<!DOCTYPE')

  if (doctype === -1) return text

  const element = /<\w/.exec(text)

  return element === null ? text : text.slice(0, doctype) + text.slice(element.index)
}

/** SheetJS `str_match_xml_ns`: the first `<tag>` start tag through the next `</tag>` (any prefix). */
const sheetJsRegion = (text: string, tag: string) => {
  const start = new RegExp(`<(?:\\w+:)?${tag}\\b[^<>]*>`, 'g')
  const end = new RegExp(`</(?:\\w+:)?${tag}>`, 'g')
  const open = start.exec(text)

  if (open === null) return undefined

  end.lastIndex = start.lastIndex

  return end.exec(text) === null ? undefined : text.slice(open.index, end.lastIndex)
}

const numberFormatId = (raw: string | undefined) => {
  const id = Number.parseInt(raw ?? '', 10)

  return Number.isSafeInteger(id) && id >= 0 ? id : undefined
}

export type StylesSummary = {
  /** Custom number formats in document order, as `[numFmtId, formatCode]`. */
  readonly numberFormats: ReadonlyArray<readonly [number, string]>
  /** The `numFmtId` of each cell format in order, or `undefined` without a `cellXfs` element. */
  readonly cellFormats: ReadonlyArray<number> | undefined
}

/**
 * Read the number formats and cell formats SheetJS would read from a stylesheet (same comment and
 * doctype removal, same regions, same tag grammar), bounded by the caps above. A format longer
 * than `maxNumberFormatCharacters` after unescaping, holding CDATA, or with an invalid id is
 * dropped; a cell format without a valid `numFmtId` becomes General (0).
 */
export const readStyles = (content: Uint8Array): StylesSummary => {
  const text = removeDoctype(
    removeComments(
      Buffer.from(content.buffer, content.byteOffset, content.byteLength).toString('latin1')
    )
  )

  const numberFormats: Array<readonly [number, string]> = []
  const formatsRegion = sheetJsRegion(text, 'numFmts')

  if (formatsRegion !== undefined) {
    for (const tag of sheetJsTags(formatsRegion)) {
      if (numberFormats.length >= maxCustomNumberFormats) break

      if (stripSheetJsNamespace(tag.head) !== '<numFmt') continue

      const id = numberFormatId(tag.attributes.get('numFmtId'))
      const raw = tag.attributes.get('formatCode')
      const code = raw === undefined ? undefined : sheetJsAttributeText(raw)

      if (id !== undefined && code !== undefined && code.length <= maxNumberFormatCharacters)
        numberFormats.push([id, code])
    }
  }

  const cellFormatsRegion = sheetJsRegion(text, 'cellXfs')

  if (cellFormatsRegion === undefined) return { numberFormats, cellFormats: undefined }

  const cellFormats: Array<number> = []

  for (const tag of sheetJsTags(cellFormatsRegion)) {
    if (cellFormats.length >= maxCellFormats) break

    const head = stripSheetJsNamespace(tag.head)

    if (head === '<xf' || head === '<xf/>' || head === '<xf>')
      cellFormats.push(numberFormatId(tag.attributes.get('numFmtId')) ?? 0)
  }

  return { numberFormats, cellFormats }
}

/** The generated stylesheet SheetJS reads instead of the uploaded one. */
export const stylesXml = ({ numberFormats, cellFormats }: StylesSummary) =>
  `${sheetJsXmlHeader}<styleSheet xmlns="${spreadsheetMainNamespace}">${
    numberFormats.length === 0
      ? ''
      : `<numFmts count="${numberFormats.length}">${numberFormats
          .map(
            ([id, code]) =>
              `<numFmt numFmtId="${id}" formatCode="${sheetJsAttributeEscape(code)}"/>`
          )
          .join('')}</numFmts>`
  }${
    cellFormats === undefined
      ? ''
      : `<cellXfs count="${cellFormats.length}">${cellFormats
          .map(id => `<xf numFmtId="${id}"/>`)
          .join('')}</cellXfs>`
  }</styleSheet>`
