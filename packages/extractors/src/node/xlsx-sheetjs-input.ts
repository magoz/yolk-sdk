import { strToU8, zipSync } from 'fflate'
import { FileExtractionError } from '../errors.ts'
import {
  coreTitle,
  officeDocumentRelationshipsNamespace,
  sheetJsCouldReadCdata,
  sheetJsXmlHeader
} from './sheetjs-xml.ts'
import { readStyles, stylesXml } from './xlsx-styles.ts'
import { readWorkbookModel, workbookXml } from './xlsx-workbook.ts'
import {
  directoryOf,
  indexParts,
  relationships,
  relationshipsPathFor,
  resolvePartPath,
  utf8Text,
  workbookPartPath
} from './xlsx-parts.ts'
import type { PartIndex, Relationship } from './xlsx-parts.ts'

/**
 * The archive SheetJS reads is built here from scratch, never passed through. Every part SheetJS
 * reads is generated or checked:
 *
 * - generated: `[Content_Types].xml`, `_rels/.rels`, `xl/_rels/workbook.xml.rels`,
 *   `xl/workbook.xml` (`xlsx-workbook.ts`), and `xl/styles.xml` (`xlsx-styles.ts`);
 * - copied after checks: worksheets (stored as `xl/worksheets/sheet<n>.xml`) and
 *   `xl/sharedStrings.xml`, validated, hyperlink-stripped, and free of anything SheetJS could
 *   turn into a CDATA marker (`sheetJsCouldReadCdata`).
 *
 * With these entries SheetJS 0.20.3 `parse_zip` can only take its XLSX path:
 *
 * - no `META-INF/manifest.xml`, `objectdata.xml`, or `Index/Document.iwa`, so it never reaches
 *   `parse_ods` or `parse_numbers_iwa`; `[Content_Types].xml` exists, so `Index.zip` is never read;
 * - every entry ends in `.xml` or `.rels`, so no binary (XLSB) parser can receive data: SheetJS
 *   dispatches on the requested path ending in `.bin`, and `safegetzipfile` only returns an entry
 *   whose name equals that path ignoring case;
 * - the generated content types name the XML workbook, so `xlsb` stays false, and no attacker
 *   `Override`, `PartName`, relationship `Type`, or `Target` reaches SheetJS;
 * - the generated workbook lists exactly the sheets the extractor counted, each with its own
 *   relationship to its own `xl/worksheets/sheet<n>.xml`, so every part is parsed at most once.
 *
 * Comments, threaded comments, VML, drawings, worksheet relationships, external links, pivot
 * caches, calculation chains, metadata, themes, `customXml`, and `docProps/*` (the title is read
 * by the extractor) are left out; SheetJS reads none of them to produce cell values or display
 * text.
 */

const strictOfficeDocumentRelationships = 'http://purl.oclc.org/ooxml/officeDocument/relationships'

const corePropertiesTypes = new Set([
  'http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties',
  'http://schemas.openxmlformats.org/officedocument/2006/relationships/metadata/core-properties'
])

/** A relationship of `kind` in the transitional or strict namespace. */
const hasKind = (relationship: Relationship, kind: string) =>
  relationship.type === `${officeDocumentRelationshipsNamespace}/${kind}` ||
  relationship.type === `${strictOfficeDocumentRelationships}/${kind}`

/** Canonical names SheetJS can receive besides `xl/worksheets/sheet<n>.xml`. */
export const sheetJsFixedParts = [
  '[Content_Types].xml',
  '_rels/.rels',
  'xl/workbook.xml',
  'xl/_rels/workbook.xml.rels',
  'xl/sharedStrings.xml',
  'xl/styles.xml'
] as const

const canonicalWorksheet = /^xl\/worksheets\/sheet[1-9]\d*\.xml$/

const fixedPartNames: ReadonlySet<string> = new Set(sheetJsFixedParts)

/** Whether `name` is one of the canonical names `buildSheetJsInput` emits. */
export const isSheetJsInputName = (name: string) =>
  fixedPartNames.has(name) || canonicalWorksheet.test(name)

const contentType = {
  workbook: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml',
  worksheet: 'application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml',
  sharedStrings: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sharedStrings+xml',
  styles: 'application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml'
} as const

const contentTypesXml = (overrides: ReadonlyArray<readonly [string, string]>) =>
  `${sheetJsXmlHeader}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/>${overrides
    .map(([path, type]) => `<Override PartName="/${path}" ContentType="${type}"/>`)
    .join('')}</Types>`

const relationshipsXml = (entries: ReadonlyArray<readonly [string, string, string]>) =>
  `${sheetJsXmlHeader}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${entries
    .map(([id, type, target]) => `<Relationship Id="${id}" Type="${type}" Target="${target}"/>`)
    .join('')}</Relationships>`

/** An XML part found by name ignoring case; `.xml` only, so no binary bytes are renamed. */
const xmlPart = (index: PartIndex, path: string | undefined) => {
  const part = path === undefined ? undefined : index.find(path)

  return part !== undefined && part.name.toLowerCase().endsWith('.xml') ? part : undefined
}

/** The part a relationship of `kind` points at, else the conventional path. */
const relatedXmlPart = (
  index: PartIndex,
  related: ReadonlyMap<string, Relationship>,
  baseDirectory: string,
  matches: (relationship: Relationship) => boolean,
  conventionalPath: string
) => {
  for (const relationship of related.values()) {
    if (!relationship.external && matches(relationship))
      return xmlPart(index, resolvePartPath(baseDirectory, relationship.target))
  }

  return xmlPart(index, conventionalPath)
}

const malformed = () =>
  new FileExtractionError({ format: 'xlsx', message: 'XLSX workbook is malformed.' })

const cdataRejected = () =>
  new FileExtractionError({
    format: 'xlsx',
    message:
      'XLSX contains unsupported markup (CDATA, comments or declarations) in worksheet or shared-strings parts.'
  })

/** A copied part, unless SheetJS could meet a CDATA marker in it (decoded or tag-removed). */
const withoutCdata = (bytes: Uint8Array) => {
  if (sheetJsCouldReadCdata(bytes)) throw cdataRejected()

  return bytes
}

export type SheetJsInputSheet = {
  /** The sheet name exactly as SheetJS reads it from the generated workbook. */
  readonly name: string
  /** The validated source part handed over as this sheet's worksheet, if any. */
  readonly part: string | undefined
}

export type SheetJsInput = {
  /** The stored-entry ZIP handed to SheetJS. */
  readonly archive: Uint8Array
  /** Entry names in `archive`, all canonical (see `isSheetJsInputName`). */
  readonly names: ReadonlyArray<string>
  /** Every sheet of the generated workbook, in order. */
  readonly sheets: ReadonlyArray<SheetJsInputSheet>
  /** The workbook title from its core properties, read without SheetJS. */
  readonly title: string | undefined
}

/**
 * Build SheetJS's input from validated parts. Sheet `n` of the workbook gets relationship
 * `rId<n>` to `xl/worksheets/sheet<n>.xml`. That entry holds the sheet's worksheet when its
 * workbook relationship is an internal worksheet resolving to an `.xml` part; other sheets (chart
 * sheets, missing parts) keep their name and order but have no entry, so SheetJS skips them.
 *
 * Throws `FileExtractionError` when the workbook declares more than `maxSheets` sheets, when it
 * is malformed (see `readWorkbookModel`; two sheets on one worksheet part count too), or when a
 * copied part holds CDATA, all before SheetJS runs.
 */
export const buildSheetJsInput = (
  parts: Readonly<Record<string, Uint8Array>>,
  maxSheets: number
): SheetJsInput => {
  const index = indexParts(parts)
  const workbook = index.find(workbookPartPath)

  if (workbook === undefined)
    throw new FileExtractionError({ format: 'xlsx', message: 'Invalid Office archive.' })

  const workbookDirectory = directoryOf(workbookPartPath)

  const workbookRelationships = relationships(
    utf8Text(index.find(relationshipsPathFor(workbookPartPath))?.bytes)
  )

  const model = readWorkbookModel(workbook.bytes, maxSheets)
  const files: Record<string, Uint8Array> = Object.create(null)
  const overrides: Array<readonly [string, string]> = []
  const sheetRelationships: Array<readonly [string, string, string]> = []
  const sheets: Array<SheetJsInputSheet> = []
  const included = new Set<string>()

  for (const [position, sheet] of model.sheets.entries()) {
    const name = `worksheets/sheet${position + 1}.xml`

    sheetRelationships.push([
      `rId${position + 1}`,
      `${officeDocumentRelationshipsNamespace}/worksheet`,
      name
    ])

    const relationship =
      sheet.relationshipId === undefined
        ? undefined
        : workbookRelationships.get(sheet.relationshipId)

    const part =
      relationship === undefined || relationship.external || !hasKind(relationship, 'worksheet')
        ? undefined
        : xmlPart(index, resolvePartPath(workbookDirectory, relationship.target))

    if (part === undefined) {
      sheets.push({ name: sheet.name, part: undefined })
      continue
    }

    // One part per sheet: SheetJS would parse and keep a shared part once per declaration.
    if (included.has(part.name)) throw malformed()

    included.add(part.name)
    files[`xl/${name}`] = withoutCdata(part.bytes)
    overrides.push([`xl/${name}`, contentType.worksheet])
    sheets.push({ name: sheet.name, part: part.name })
  }

  const sharedStrings = relatedXmlPart(
    index,
    workbookRelationships,
    workbookDirectory,
    relationship => hasKind(relationship, 'sharedStrings'),
    'xl/sharedStrings.xml'
  )

  if (sharedStrings !== undefined) {
    files['xl/sharedStrings.xml'] = withoutCdata(sharedStrings.bytes)
    overrides.push(['xl/sharedStrings.xml', contentType.sharedStrings])
  }

  const styles = relatedXmlPart(
    index,
    workbookRelationships,
    workbookDirectory,
    relationship => hasKind(relationship, 'styles'),
    'xl/styles.xml'
  )

  if (styles !== undefined) {
    files['xl/styles.xml'] = strToU8(stylesXml(readStyles(styles.bytes)))
    overrides.push(['xl/styles.xml', contentType.styles])
  }

  const core = relatedXmlPart(
    index,
    relationships(utf8Text(index.find('_rels/.rels')?.bytes)),
    '',
    relationship => relationship.type !== undefined && corePropertiesTypes.has(relationship.type),
    'docProps/core.xml'
  )

  const archive = {
    '[Content_Types].xml': strToU8(
      contentTypesXml([[workbookPartPath, contentType.workbook], ...overrides])
    ),
    '_rels/.rels': strToU8(
      relationshipsXml([
        ['rId1', `${officeDocumentRelationshipsNamespace}/officeDocument`, workbookPartPath]
      ])
    ),
    [workbookPartPath]: strToU8(workbookXml(model)),
    'xl/_rels/workbook.xml.rels': strToU8(relationshipsXml(sheetRelationships)),
    ...files
  }

  return {
    archive: zipSync(archive, { level: 0 }),
    names: Object.keys(archive),
    sheets,
    title: coreTitle(core?.bytes)
  }
}
