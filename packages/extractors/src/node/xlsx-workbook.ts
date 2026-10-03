import { Buffer } from 'node:buffer'
import { FileExtractionError } from '../errors.ts'
import {
  sheetJsAttributeEscape,
  sheetJsAttributeText,
  sheetJsTags,
  stripSheetJsNamespace,
  sheetJsXmlHeader,
  spreadsheetMainNamespace,
  officeDocumentRelationshipsNamespace
} from './sheetjs-xml.ts'
import type { SheetJsTag } from './sheetjs-xml.ts'
import { decodeXmlEntities, prefixedAttribute, rawXmlAttributes } from './xml-text.ts'

/**
 * `xl/workbook.xml` is never handed to SheetJS as uploaded. SheetJS's workbook parser slices and
 * decodes the whole prefix of the part at every `</definedName>` (quadratic), and walks every
 * `<sheet>` its own tag pattern finds, resolving each through its `r:id`, so one worksheet can be
 * parsed once per declaration. The extractor reads the sheet list itself, checks that its strict
 * scan and SheetJS's tag grammar see the same sheets, and writes a minimal workbook: the sheets in
 * order (name, `sheetId`, hidden state, a fresh `r:id`) and the 1904 date system.
 */

export type WorkbookSheetDeclaration = {
  /** The sheet name exactly as SheetJS reads it (`unescapexml(utf8read(name))`). */
  readonly name: string
  readonly sheetId: string
  readonly state: 'hidden' | 'veryHidden' | undefined
  /** The `r:id` of the sheet's relationship in the uploaded workbook, entity-decoded. */
  readonly relationshipId: string | undefined
}

export type WorkbookModel = {
  readonly sheets: ReadonlyArray<WorkbookSheetDeclaration>
  readonly date1904: boolean
}

export const malformedWorkbookMessage = 'XLSX workbook is malformed.'

const malformed = () =>
  new FileExtractionError({ format: 'xlsx', message: malformedWorkbookMessage })

const tooManySheets = () =>
  new FileExtractionError({
    format: 'xlsx',
    message: 'XLSX exceeds the worksheet or cell-visit limit.'
  })

// `[^<>]` keeps each candidate inside one tag, so the strict scan stays linear.
const strictSheetTag = /<(?:[\w.-]+:)?sheet(?=[\s/>])[^<>]*>/g

const plainSheetId = /^[1-9]\d{0,8}$/

/**
 * The sheets of `xl/workbook.xml` and its date system. Throws `FileExtractionError` when the
 * workbook declares more than `maxSheets` sheets (counted by either scan), when the strict scan
 * and SheetJS's grammar disagree on the number or names of sheets, when a name is missing, holds
 * CDATA, or repeats another ignoring case, or when there are no sheets.
 */
export const readWorkbookModel = (bytes: Uint8Array, maxSheets: number): WorkbookModel => {
  // SheetJS parses the Latin-1 ("binary") view and decodes attribute text as UTF-8 afterwards.
  const text = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString('latin1')
  const sheetJsSheets: Array<SheetJsTag> = []
  let date1904 = false

  for (const tag of sheetJsTags(text)) {
    const head = stripSheetJsNamespace(tag.head)

    if (head === '<sheet') {
      sheetJsSheets.push(tag)

      if (sheetJsSheets.length > maxSheets) throw tooManySheets()
    } else if (head === '<workbookPr' || head === '<workbookPr/>') {
      // Each `workbookPr` that carries the attribute overrides the last (SheetJS `parsexmlbool`).
      const value = tag.attributes.get('date1904')

      if (value !== undefined) date1904 = value === '1' || value === 'true'
    }
  }

  const strictSheets: Array<ReadonlyMap<string, string>> = []

  for (const [tag] of text.matchAll(strictSheetTag)) {
    strictSheets.push(rawXmlAttributes(tag))

    if (strictSheets.length > maxSheets) throw tooManySheets()
  }

  if (sheetJsSheets.length === 0 || sheetJsSheets.length !== strictSheets.length) throw malformed()

  const seen = new Set<string>()

  const sheets = sheetJsSheets.map((tag, index): WorkbookSheetDeclaration => {
    const strict = strictSheets[index]
    const rawName = tag.attributes.get('name')

    if (strict === undefined || rawName === undefined || strict.get('name') !== rawName)
      throw malformed()

    const name = sheetJsAttributeText(rawName)

    // Excel compares sheet names ignoring case.
    if (name === undefined || seen.has(name.toLowerCase())) throw malformed()

    seen.add(name.toLowerCase())

    const state = tag.attributes.get('state')
    const sheetId = tag.attributes.get('sheetId')
    const relationshipId = prefixedAttribute(strict, 'id')

    return {
      name,
      sheetId: sheetId !== undefined && plainSheetId.test(sheetId) ? sheetId : `${index + 1}`,
      state: state === 'hidden' || state === 'veryHidden' ? state : undefined,
      relationshipId: relationshipId === undefined ? undefined : decodeXmlEntities(relationshipId)
    }
  })

  return { sheets, date1904 }
}

/** The generated workbook: sheet `n` has `r:id="rId<n>"`. */
export const workbookXml = (model: WorkbookModel) =>
  `${sheetJsXmlHeader}<workbook xmlns="${spreadsheetMainNamespace}" xmlns:r="${officeDocumentRelationshipsNamespace}">${
    model.date1904 ? '<workbookPr date1904="1"/>' : ''
  }<sheets>${model.sheets
    .map(
      (sheet, index) =>
        `<sheet name="${sheetJsAttributeEscape(sheet.name)}" sheetId="${sheet.sheetId}"${
          sheet.state === undefined ? '' : ` state="${sheet.state}"`
        } r:id="rId${index + 1}"/>`
    )
    .join('')}</sheets></workbook>`
