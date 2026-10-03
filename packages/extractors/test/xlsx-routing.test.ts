import { Buffer } from 'node:buffer'
import { describe, expect, it } from '@effect/vitest'
import { Effect } from 'effect'
import { strToU8, unzipSync, zipSync } from 'fflate'
import * as XLSX from 'xlsx'
import { normalizeOfficeArchive } from '../src/node/index.ts'
import type { SheetJsLoader } from '../src/node/sheetjs.ts'
import { withoutBinaryParts } from '../src/node/xlsx-routing.ts'
import {
  decode,
  extractWith,
  workbookParts,
  xlsbHyperlinkSheet,
  xlsxInput,
  zipParts
} from './fixtures.ts'

/** Real SheetJS 0.20.3, recording every archive it is asked to parse. */
const recordingSheetJs =
  (seen: Array<Uint8Array>): SheetJsLoader =>
  async () => ({
    version: XLSX.version,
    read: (bytes: Uint8Array) => {
      seen.push(bytes)

      return XLSX.read(bytes, { type: 'array' })
    }
  })

const relNs = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships'

const binaryRouteMessage = 'XLSX archive contains binary (XLSB), ODS, or Numbers parts.'

/** Cells SheetJS created for a sheet (own keys that are not `!` metadata). */
const cellCount = (sheet: object | undefined) =>
  sheet === undefined ? 0 : Object.keys(sheet).filter(key => !key.startsWith('!')).length

const replaceInPart = (
  parts: Record<string, Uint8Array>,
  path: string,
  search: string,
  replacement: string
) => {
  const part = parts[path]

  if (part === undefined) throw new Error(`Missing fixture part ${path}`)

  parts[path] = strToU8(decode(part).replace(search, replacement))
}

const singleSheet = () => workbookParts([{ name: 'Sheet1', rows: [['a']] }])

/** An XML workbook whose worksheet relationship points at a binary worksheet with a link. */
const binaryWorksheetParts = (relationship: string) => {
  const parts = singleSheet()

  parts['xl/worksheets/sheet1.bin'] = xlsbHyperlinkSheet(2)
  delete parts['xl/worksheets/sheet1.xml']
  replaceInPart(
    parts,
    'xl/_rels/workbook.xml.rels',
    `<Relationship Id="rId1" Type="${relNs}/worksheet" Target="worksheets/sheet1.xml"/>`,
    relationship
  )

  return parts
}

const worksheetRelationship = (target: string) =>
  `<Relationship Id="rId1" Type="${relNs}/worksheet" Target="${target}"/>`

/** A SheetJS-written XLSB whose worksheet carries a 3x3 `BrtHLink`, plus an `xl/workbook.xml`. */
const binaryWorkbookParts = () => {
  const book = XLSX.utils.book_new()
  XLSX.utils.book_append_sheet(book, XLSX.utils.aoa_to_sheet([['a']]), 'Sheet1')

  const written: unknown = XLSX.write(book, { type: 'array', bookType: 'xlsb' })

  if (!(written instanceof ArrayBuffer)) throw new Error('Expected XLSB fixture')

  const parts = { ...unzipSync(new Uint8Array(written)) }
  const main = singleSheet()['xl/workbook.xml']

  if (main === undefined) throw new Error('Missing fixture workbook')

  parts['xl/worksheets/sheet1.bin'] = xlsbHyperlinkSheet(2)
  parts['xl/workbook.xml'] = new Uint8Array(main)

  return parts
}

const expectRejectedBeforeSheetJs = (parts: Record<string, Uint8Array>) =>
  Effect.gen(function* () {
    const seen: Array<Uint8Array> = []

    const error = yield* extractWith(xlsxInput(zipParts(parts)), {
      loadSheetJs: recordingSheetJs(seen)
    }).pipe(Effect.flip)

    expect(error._tag).toBe('FileExtractionError')
    expect(error.message).toBe(binaryRouteMessage)
    expect(seen).toHaveLength(0)
  })

describe('XLSX parts SheetJS would parse with its binary parsers', () => {
  const routedTargets = [
    ['a .bin worksheet target', worksheetRelationship('worksheets/sheet1.bin')],
    ['an entity-encoded .bin target', worksheetRelationship('worksheets/sheet1.b&#105;n')],
    ['an _xHHHH_-encoded .bin target', worksheetRelationship('worksheets/sheet1._x0062_in')],
    [
      'a Target_ attribute SheetJS truncates to Target',
      `<Relationship Id="rId1" Type="${relNs}/worksheet" Target_1="worksheets/sheet1.bin"/>`
    ],
    [
      'a relationship with an empty type',
      '<Relationship Id="rId1" Target="worksheets/sheet1.bin" Type=""/>'
    ]
  ] as const

  for (const [label, relationship] of routedTargets) {
    it.effect(`rejects ${label} before loading SheetJS`, () =>
      Effect.gen(function* () {
        const parts = binaryWorksheetParts(relationship)

        // Control: unprotected SheetJS expands the 3x3 BrtHLink into nine cell objects.
        const parsed = XLSX.read(zipParts(parts), { type: 'array' })

        expect(cellCount(parsed.Sheets.Sheet1)).toBe(9)

        yield* expectRejectedBeforeSheetJs(parts)
      })
    )
  }

  it.effect('rejects a worksheet relationship aimed at a printer-settings .bin part', () =>
    Effect.gen(function* () {
      const parts = binaryWorksheetParts(
        worksheetRelationship('printerSettings/printerSettings1.bin')
      )

      const sheet = parts['xl/worksheets/sheet1.bin']

      if (sheet === undefined) throw new Error('Missing fixture worksheet')

      parts['xl/printerSettings/printerSettings1.bin'] = sheet
      delete parts['xl/worksheets/sheet1.bin']

      expect(cellCount(XLSX.read(zipParts(parts), { type: 'array' }).Sheets.Sheet1)).toBe(9)

      yield* expectRejectedBeforeSheetJs(parts)
    })
  )

  it.effect('rejects a UTF-16 relationships part with a .bin worksheet target', () =>
    Effect.gen(function* () {
      const parts = binaryWorksheetParts(worksheetRelationship('worksheets/sheet1.bin'))
      const rels = parts['xl/_rels/workbook.xml.rels']

      if (rels === undefined) throw new Error('Missing fixture relationships')

      parts['xl/_rels/workbook.xml.rels'] = Buffer.concat([
        Buffer.from([0xff, 0xfe]),
        Buffer.from(decode(rels), 'utf16le')
      ])

      expect(cellCount(XLSX.read(zipParts(parts), { type: 'array' }).Sheets.Sheet1)).toBe(9)

      yield* expectRejectedBeforeSheetJs(parts)
    })
  )

  it.effect('rejects a .bin comments target in worksheet relationships', () =>
    Effect.gen(function* () {
      const parts = workbookParts([
        {
          name: 'Sheet1',
          rows: [['a']],
          relationships: [['rId1', 'comments', '../comments1.bin', false]]
        }
      ])

      parts['xl/comments1.bin'] = xlsbHyperlinkSheet(0)

      yield* expectRejectedBeforeSheetJs(parts)
    })
  )

  it.effect('rejects a binary workbook content type before loading SheetJS', () =>
    Effect.gen(function* () {
      const parts = binaryWorkbookParts()

      // Control: SheetJS follows the content type into its XLSB parsers and expands the link.
      const parsed = XLSX.read(zipParts(parts), { type: 'array' })

      expect(parsed.bookType).toBe('xlsb')
      expect(cellCount(parsed.Sheets.Sheet1)).toBe(9)

      yield* expectRejectedBeforeSheetJs(parts)
    })
  )

  const contentTypeOverrides = [
    [
      'a binary content type on the XML workbook part',
      '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.ms-excel.sheet.binary.macroEnabled.main"/>'
    ],
    [
      'a second workbook part',
      '<Override PartName="/xl/workbookbin" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>'
    ],
    [
      'a binary shared-strings part',
      '<Override PartName="/xl/sharedStrings.bin" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sharedStrings+xml"/>'
    ],
    [
      'a binary worksheet content type',
      '<Override PartName="/xl/worksheets/sheet9.xml" ContentType="application/vnd.ms-excel.worksheet"/>'
    ]
  ] as const

  for (const [label, override] of contentTypeOverrides) {
    it.effect(`rejects ${label} in [Content_Types].xml`, () =>
      Effect.gen(function* () {
        const parts = singleSheet()

        replaceInPart(parts, '[Content_Types].xml', '</Types>', `${override}</Types>`)

        yield* expectRejectedBeforeSheetJs(parts)
      })
    )
  }

  it.effect('accepts printer settings, OLE objects, and the binary Default SheetJS writes', () =>
    Effect.gen(function* () {
      const parts = workbookParts([
        {
          name: 'Sheet1',
          rows: [['kept']],
          relationships: [
            ['rId1', 'printerSettings', '../printerSettings/printerSettings1.bin', false],
            ['rId2', 'oleObject', '../embeddings/oleObject1.bin', false],
            ['rId3', 'hyperlink', 'https://files.example/firmware.bin', true]
          ]
        }
      ])

      replaceInPart(
        parts,
        '[Content_Types].xml',
        '</Types>',
        '<Default Extension="bin" ContentType="application/vnd.ms-excel.sheet.binary.macroEnabled.main"/><Override PartName="/xl/printerSettings/printerSettings1.bin" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.printerSettings"/></Types>'
      )

      parts['xl/printerSettings/printerSettings1.bin'] = new Uint8Array([1, 2, 3])
      parts['xl/embeddings/oleObject1.bin'] = new Uint8Array([4, 5, 6])

      const seen: Array<Uint8Array> = []

      const result = yield* extractWith(xlsxInput(zipParts(parts)), {
        loadSheetJs: recordingSheetJs(seen)
      })

      expect(result.content).toBe('# Sheet1\nkept')
      expect(seen).toHaveLength(1)

      // Backstop: SheetJS gets the archive without `.bin` parts; normalization keeps them.
      const handed = Object.keys(unzipSync(seen[0] ?? new Uint8Array()))

      expect(handed.filter(name => name.endsWith('.bin'))).toEqual([])
      expect(handed).toContain('xl/worksheets/sheet1.xml')

      const normalized = yield* normalizeOfficeArchive(zipParts(parts), 'xlsx')

      expect(Object.keys(unzipSync(normalized))).toContain('xl/embeddings/oleObject1.bin')
    })
  )

  it('starves a .bin worksheet SheetJS would follow even if the relationship checks were bypassed', () => {
    // These parts never went through the checks: the backstop alone must keep SheetJS's binary
    // parser from receiving the worksheet.
    const parts = binaryWorksheetParts(worksheetRelationship('worksheets/sheet1.bin'))

    expect(cellCount(XLSX.read(zipParts(parts), { type: 'array' }).Sheets.Sheet1)).toBe(9)

    const handed = XLSX.read(zipSync(withoutBinaryParts(parts), { level: 0 }), { type: 'array' })

    expect(handed.SheetNames).toEqual(['Sheet1'])
    expect(cellCount(handed.Sheets.Sheet1)).toBe(0)
  })
})

describe('XLSX archives SheetJS would route to its ODS or Numbers parsers', () => {
  const odsContent =
    '<office:document-content xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0" xmlns:table="urn:oasis:names:tc:opendocument:xmlns:table:1.0" xmlns:text="urn:oasis:names:tc:opendocument:xmlns:text:1.0"><office:body><office:spreadsheet><table:table table:name="Repeated"><table:table-row table:number-rows-repeated="3"><table:table-cell table:number-columns-repeated="3"><text:p>x</text:p></table:table-cell></table:table-row></table:table></office:spreadsheet></office:body></office:document-content>'

  it.effect('rejects an ODS manifest (matched case-insensitively) before loading SheetJS', () =>
    Effect.gen(function* () {
      for (const manifest of ['META-INF/manifest.xml', 'Meta-Inf/MANIFEST.XML']) {
        const parts = singleSheet()

        parts[manifest] = strToU8('<manifest/>')
        parts['content.xml'] = strToU8(odsContent)
        parts['styles.xml'] = strToU8('<office:document-styles/>')

        // Control: SheetJS checks the manifest before content types and parses ODS repeats.
        const parsed = XLSX.read(zipParts(parts), { type: 'array' })

        expect(parsed.SheetNames).toEqual(['Repeated'])
        expect(cellCount(parsed.Sheets.Repeated)).toBe(9)

        yield* expectRejectedBeforeSheetJs(parts)
      }
    })
  )

  it.effect('rejects every other entry SheetJS routes away from the XLSX parser', () =>
    Effect.gen(function* () {
      for (const name of [
        'objectdata.xml',
        'ObjectData.XML',
        'Index/Document.iwa',
        'index/document.IWA',
        'Index.zip',
        'nested/INDEX.ZIP',
        'Root Entry/META-INF/manifest.xml'
      ]) {
        const parts = singleSheet()

        parts[name] = new Uint8Array([0, 1, 2])

        yield* expectRejectedBeforeSheetJs(parts)
      }
    })
  )
})
