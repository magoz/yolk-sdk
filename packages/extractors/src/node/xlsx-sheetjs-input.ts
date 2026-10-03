import { strToU8, zipSync } from 'fflate'
import { FileExtractionError } from '../errors.ts'
import {
  directoryOf,
  indexParts,
  relationships,
  relationshipsPathFor,
  resolvePartPath,
  utf8Text,
  workbookPartPath,
  workbookSheets
} from './xlsx-parts.ts'
import type { PartIndex, Relationship } from './xlsx-parts.ts'

/**
 * The archive SheetJS reads is built here from scratch, never passed through. It holds only
 * validated, hyperlink-stripped XML parts under canonical names, plus content types and
 * relationships generated from constants. With these entries SheetJS 0.20.3 `parse_zip` can only
 * take its XLSX path:
 *
 * - no `META-INF/manifest.xml`, `objectdata.xml`, or `Index/Document.iwa`, so it never reaches
 *   `parse_ods` or `parse_numbers_iwa`; `[Content_Types].xml` exists, so `Index.zip` is never read;
 * - every entry ends in `.xml` or `.rels`, so no binary (XLSB) parser can receive data: SheetJS
 *   dispatches on the requested path ending in `.bin`, and `safegetzipfile` only returns an entry
 *   whose name equals that path ignoring case;
 * - the generated content types name the XML workbook, so `xlsb` stays false, and no attacker
 *   `Override`, `PartName`, relationship `Type`, or `Target` reaches SheetJS.
 *
 * Comments, threaded comments, VML, drawings, worksheet relationships, external links, pivot
 * caches, calculation chains, metadata, themes, `customXml`, `docProps/app.xml`, and `.bin` parts
 * are left out; SheetJS reads none of them to produce cell values or display text.
 */

const officeDocumentRelationships =
  'http://schemas.openxmlformats.org/officeDocument/2006/relationships'

const strictOfficeDocumentRelationships = 'http://purl.oclc.org/ooxml/officeDocument/relationships'

const corePropertiesTypes = new Set([
  'http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties',
  'http://schemas.openxmlformats.org/officedocument/2006/relationships/metadata/core-properties'
])

/** A relationship of `kind` in the transitional or strict namespace. */
const hasKind = (relationship: Relationship, kind: string) =>
  relationship.type === `${officeDocumentRelationships}/${kind}` ||
  relationship.type === `${strictOfficeDocumentRelationships}/${kind}`

/** Canonical names SheetJS can receive besides `xl/worksheets/sheet<n>.xml`. */
export const sheetJsFixedParts = [
  '[Content_Types].xml',
  '_rels/.rels',
  'docProps/core.xml',
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

const xmlHeader = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\r\n'

const contentType = {
  workbook: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml',
  worksheet: 'application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml',
  sharedStrings: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sharedStrings+xml',
  styles: 'application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml',
  core: 'application/vnd.openxmlformats-package.core-properties+xml'
} as const

const contentTypesXml = (overrides: ReadonlyArray<readonly [string, string]>) =>
  `${xmlHeader}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/>${overrides
    .map(([path, type]) => `<Override PartName="/${path}" ContentType="${type}"/>`)
    .join('')}</Types>`

const relationshipsXml = (entries: ReadonlyArray<readonly [string, string, string]>) =>
  `${xmlHeader}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${entries
    .map(([id, type, target]) => `<Relationship Id="${id}" Type="${type}" Target="${target}"/>`)
    .join('')}</Relationships>`

/**
 * Relationship ids copied into generated XML: SheetJS matches them raw against `<sheet r:id>`,
 * so only ids that need no escaping are kept. Others fall back to SheetJS's positional lookup.
 */
const plainRelationshipId = /^[A-Za-z0-9_.-]{1,255}$/

/** An XML part found by name ignoring case; `.xml` only, so no binary bytes are renamed. */
const xmlPart = (index: PartIndex, path: string | undefined) => {
  const part = path === undefined ? undefined : index.find(path)

  return part !== undefined && part.name.toLowerCase().endsWith('.xml') ? part.bytes : undefined
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

export type SheetJsInput = {
  /** The stored-entry ZIP handed to SheetJS. */
  readonly archive: Uint8Array
  /** Entry names in `archive`, all canonical (see `isSheetJsInputName`). */
  readonly names: ReadonlyArray<string>
}

/**
 * Build SheetJS's input from validated parts. A sheet is included only when its workbook
 * relationship is a worksheet whose target resolves to `xl/worksheets/<name>.xml`. Sheet `n` of
 * the workbook is stored as `xl/worksheets/sheet<n>.xml`, which is also the name SheetJS falls
 * back to when it cannot match a relationship, and each source part is stored once.
 * Throws `FileExtractionError` when the workbook declares more than `maxSheets` sheets, before
 * SheetJS would walk them.
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

  const sheets = workbookSheets(utf8Text(workbook.bytes))

  if (sheets.length > maxSheets)
    throw new FileExtractionError({
      format: 'xlsx',
      message: 'XLSX exceeds the worksheet or cell-visit limit.'
    })

  const files: Record<string, Uint8Array> = Object.create(null)
  const overrides: Array<readonly [string, string]> = []
  const sheetRelationships: Array<readonly [string, string, string]> = []
  const included = new Set<string>()

  for (const [position, sheet] of sheets.entries()) {
    const relationship = sheet.id === undefined ? undefined : workbookRelationships.get(sheet.id)

    if (relationship === undefined || relationship.external || !hasKind(relationship, 'worksheet'))
      continue

    const source = resolvePartPath(workbookDirectory, relationship.target)

    if (!/^xl\/worksheets\/[^/]+\.xml$/i.test(source)) continue

    const part = index.find(source)

    if (part === undefined || included.has(part.name)) continue

    included.add(part.name)

    const name = `worksheets/sheet${position + 1}.xml`
    files[`xl/${name}`] = part.bytes
    overrides.push([`xl/${name}`, contentType.worksheet])

    if (sheet.id !== undefined && plainRelationshipId.test(sheet.id))
      sheetRelationships.push([sheet.id, `${officeDocumentRelationships}/worksheet`, name])
  }

  const sharedStrings = relatedXmlPart(
    index,
    workbookRelationships,
    workbookDirectory,
    relationship => hasKind(relationship, 'sharedStrings'),
    'xl/sharedStrings.xml'
  )

  const styles = relatedXmlPart(
    index,
    workbookRelationships,
    workbookDirectory,
    relationship => hasKind(relationship, 'styles'),
    'xl/styles.xml'
  )

  const core = relatedXmlPart(
    index,
    relationships(utf8Text(index.find('_rels/.rels')?.bytes)),
    '',
    relationship => relationship.type !== undefined && corePropertiesTypes.has(relationship.type),
    'docProps/core.xml'
  )

  const optional = [
    ['xl/sharedStrings.xml', sharedStrings, contentType.sharedStrings],
    ['xl/styles.xml', styles, contentType.styles],
    ['docProps/core.xml', core, contentType.core]
  ] as const

  for (const [name, bytes, type] of optional) {
    if (bytes === undefined) continue

    files[name] = bytes
    overrides.push([name, type])
  }

  const archive = {
    '[Content_Types].xml': strToU8(
      contentTypesXml([[workbookPartPath, contentType.workbook], ...overrides])
    ),
    '_rels/.rels': strToU8(
      relationshipsXml([
        ['rId1', `${officeDocumentRelationships}/officeDocument`, workbookPartPath],
        ...(core === undefined
          ? []
          : [
              [
                'rId2',
                'http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties',
                'docProps/core.xml'
              ] as const
            ])
      ])
    ),
    [workbookPartPath]: workbook.bytes,
    'xl/_rels/workbook.xml.rels': strToU8(relationshipsXml(sheetRelationships)),
    ...files
  }

  return { archive: zipSync(archive, { level: 0 }), names: Object.keys(archive) }
}
