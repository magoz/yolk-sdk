import { Buffer } from 'node:buffer'
import { describe, expect, it } from '@effect/vitest'
import { Effect } from 'effect'
import { strToU8, unzipSync } from 'fflate'
import * as XLSX from 'xlsx'
import { normalizeOfficeArchive } from '../src/node/index.ts'
import { sheetJsReadOptions } from '../src/node/sheetjs.ts'
import { buildSheetJsInput } from '../src/node/xlsx-sheetjs-input.ts'
import { sheetJsEntryPath } from '../src/node/xlsx-routing.ts'
import {
  cellCount,
  decode,
  expectAllowlisted,
  extractWith,
  recordingSheetJs,
  workbookParts,
  xlsbHyperlinkSheet,
  xlsxInput,
  zipParts
} from './fixtures.ts'
import type { SheetJsCall } from './fixtures.ts'

const relNs = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships'

const binaryRouteMessage = 'XLSX archive contains binary (XLSB), ODS, or Numbers parts.'

const invalidArchiveMessage = 'Invalid Office archive.'

const replaceInPart = (
  parts: Record<string, Uint8Array>,
  path: string,
  search: string,
  replacement: string
) => {
  const part = parts[path]

  if (part === undefined) throw new Error(`Missing fixture part ${path}`)

  const text = decode(part)

  if (!text.includes(search)) throw new Error(`Fixture part ${path} lacks ${search}`)

  parts[path] = strToU8(text.replace(search, replacement))
}

const singleSheet = () => workbookParts([{ name: 'Sheet1', rows: [['a']] }])

/** An XML workbook whose worksheet relationship points at a binary worksheet with a link. */
const binaryWorksheetParts = (relationship: string, entry = 'xl/worksheets/sheet1.bin') => {
  const parts = singleSheet()

  parts[entry] = xlsbHyperlinkSheet(2)
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

/** SheetJS-written XLSB parts. */
const sheetJsXlsbParts = () => {
  const book = XLSX.utils.book_new()
  XLSX.utils.book_append_sheet(book, XLSX.utils.aoa_to_sheet([['a']]), 'Sheet1')

  const written: unknown = XLSX.write(book, { type: 'array', bookType: 'xlsb' })

  if (!(written instanceof ArrayBuffer)) throw new Error('Expected XLSB fixture')

  return { ...unzipSync(new Uint8Array(written)) }
}

/** A SheetJS-written XLSB whose worksheet carries a 3x3 `BrtHLink`, plus an `xl/workbook.xml`. */
const binaryWorkbookParts = () => {
  const parts = sheetJsXlsbParts()
  const main = singleSheet()['xl/workbook.xml']

  if (main === undefined) throw new Error('Missing fixture workbook')

  parts['xl/worksheets/sheet1.bin'] = xlsbHyperlinkSheet(2)
  parts['xl/workbook.xml'] = new Uint8Array(main)

  return parts
}

/** Unprotected SheetJS on the raw parts (a control: never done with attacker input in code). */
const readDirectly = (parts: Record<string, Uint8Array>) =>
  XLSX.read(zipParts(parts), { type: 'array' })

/**
 * The construction guarantee on its own: build SheetJS's input from parts that never went
 * through the routing checks, parse it with real SheetJS, and return the workbook.
 */
const readThroughAllowlist = (parts: Record<string, Uint8Array>) => {
  const input = buildSheetJsInput(parts, 100)

  expectAllowlisted(input.names)
  expect(Object.keys(unzipSync(input.archive))).toEqual(input.names)

  const parsed = XLSX.read(input.archive, { ...sheetJsReadOptions })

  expect(parsed.bookType).toBe('xlsx')

  return parsed
}

const expectRejectedBeforeSheetJs = (
  parts: Record<string, Uint8Array>,
  message = binaryRouteMessage
) =>
  Effect.gen(function* () {
    const calls: Array<SheetJsCall> = []

    const error = yield* extractWith(xlsxInput(zipParts(parts)), {
      loadSheetJs: recordingSheetJs(calls)
    }).pipe(Effect.flip)

    expect(error._tag).toBe('FileExtractionError')
    expect(error.message).toBe(message)
    expect(calls).toHaveLength(0)
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
    ],
    [
      'a lower-case type attribute SheetJS ignores (S2)',
      `<Relationship Id="rId1" type="${relNs}/printerSettings" Target="worksheets/sheet1.bin"/>`
    ]
  ] as const

  for (const [label, relationship] of routedTargets) {
    it.effect(`rejects ${label} before loading SheetJS`, () =>
      Effect.gen(function* () {
        const parts = binaryWorksheetParts(relationship)

        // Control: unprotected SheetJS expands the 3x3 BrtHLink into nine cell objects.
        expect(cellCount(readDirectly(parts).Sheets.Sheet1)).toBe(9)

        yield* expectRejectedBeforeSheetJs(parts)

        // Construction: even unchecked, the allowlisted input has no .bin part to expand.
        expect(cellCount(readThroughAllowlist(parts).Sheets.Sheet1)).toBe(0)
      })
    )
  }

  it.effect('rejects a .bin worksheet target with `<` inside its quoted value (S2)', () =>
    Effect.gen(function* () {
      const parts = binaryWorksheetParts(
        worksheetRelationship('worksheets/a<b.bin'),
        'xl/worksheets/a<b.bin'
      )

      expect(cellCount(readDirectly(parts).Sheets.Sheet1)).toBe(9)

      yield* expectRejectedBeforeSheetJs(parts)

      expect(cellCount(readThroughAllowlist(parts).Sheets.Sheet1)).toBe(0)
    })
  )

  it.effect('rejects an XLSB workbook override with `<` inside its quoted PartName (S2)', () =>
    Effect.gen(function* () {
      // SheetJS follows the override into `xl/a<b.bin`, finds no binary workbook relationships,
      // and falls back to `xl/worksheets/sheet1.bin`; no relationships part names a .bin path.
      const xlsb = sheetJsXlsbParts()
      const parts = singleSheet()

      parts['xl/a<b.bin'] = xlsb['xl/workbook.bin'] ?? new Uint8Array()
      parts['xl/worksheets/sheet1.bin'] = xlsbHyperlinkSheet(2)
      replaceInPart(
        parts,
        '[Content_Types].xml',
        '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>',
        '<Override PartName="/xl/a<b.bin" ContentType="application/vnd.ms-excel.sheet.binary.macroEnabled.main"/>'
      )

      const direct = readDirectly(parts)

      expect(direct.bookType).toBe('xlsb')
      expect(cellCount(direct.Sheets.Sheet1)).toBe(9)

      yield* expectRejectedBeforeSheetJs(parts)

      const constructed = readThroughAllowlist(parts)

      expect(constructed.Sheets.Sheet1?.A1?.v).toBe('a')
      expect(cellCount(constructed.Sheets.Sheet1)).toBe(1)
    })
  )

  it.effect('rejects a worksheet relationship aimed at a printer-settings .bin part', () =>
    Effect.gen(function* () {
      const parts = binaryWorksheetParts(
        worksheetRelationship('printerSettings/printerSettings1.bin'),
        'xl/printerSettings/printerSettings1.bin'
      )

      expect(cellCount(readDirectly(parts).Sheets.Sheet1)).toBe(9)

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

      expect(cellCount(readDirectly(parts).Sheets.Sheet1)).toBe(9)

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
      const parsed = readDirectly(parts)

      expect(parsed.bookType).toBe('xlsb')
      expect(cellCount(parsed.Sheets.Sheet1)).toBe(9)

      yield* expectRejectedBeforeSheetJs(parts)

      // Construction: generated content types keep SheetJS on the XML workbook, which has no
      // XML worksheet relationship here, so the sheet is listed but empty.
      const constructed = readThroughAllowlist(parts)

      expect(constructed.SheetNames).toEqual(['Sheet1'])
      expect(cellCount(constructed.Sheets.Sheet1)).toBe(0)
    })
  )

  const contentTypeOverrides = [
    [
      'a binary content type on the XML workbook part',
      '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.ms-excel.sheet.binary.macroEnabled.main"/>'
    ],
    [
      'a binary shared-strings part',
      '<Override PartName="/xl/sharedStrings.bin" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sharedStrings+xml"/>'
    ],
    [
      'a binary worksheet content type',
      '<Override PartName="/xl/worksheets/sheet9.xml" ContentType="application/vnd.ms-excel.worksheet"/>'
    ],
    [
      'a prefixed override with `<` in its PartName',
      '<ct:Override PartName="/xl/styles<1.bin" ContentType="application/vnd.ms-excel.styles"/>'
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

  it.effect('accepts printer settings, OLE objects, toolbars, and the binary Default', () =>
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
        '<Default Extension="bin" ContentType="application/vnd.ms-excel.sheet.binary.macroEnabled.main"/><Override PartName="/xl/printerSettings/printerSettings1.bin" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.printerSettings"/><Override PartName="/xl/attachedToolbars.bin" ContentType="application/vnd.ms-excel.attachedToolbars"/></Types>'
      )
      // S5: the attached-toolbars relationship and its content type are both allowed.
      replaceInPart(
        parts,
        'xl/_rels/workbook.xml.rels',
        '</Relationships>',
        '<Relationship Id="rId9" Type="http://schemas.microsoft.com/office/2006/relationships/attachedToolbars" Target="attachedToolbars.bin"/></Relationships>'
      )

      parts['xl/printerSettings/printerSettings1.bin'] = new Uint8Array([1, 2, 3])
      parts['xl/embeddings/oleObject1.bin'] = new Uint8Array([4, 5, 6])
      parts['xl/attachedToolbars.bin'] = new Uint8Array([7, 8, 9])

      const calls: Array<SheetJsCall> = []

      const result = yield* extractWith(xlsxInput(zipParts(parts)), {
        loadSheetJs: recordingSheetJs(calls)
      })

      expect(result.content).toBe('# Sheet1\nkept')
      expect(calls).toHaveLength(1)
      expectAllowlisted(calls[0]?.names ?? [])

      // Normalization keeps the binary parts so stored files still open.
      const normalized = yield* normalizeOfficeArchive(zipParts(parts), 'xlsx')

      expect(Object.keys(unzipSync(normalized))).toEqual(
        expect.arrayContaining(['xl/embeddings/oleObject1.bin', 'xl/attachedToolbars.bin'])
      )
    })
  )

  it.effect('does not mistake `.bin` inside names, directories, or ids for a binary part', () =>
    Effect.gen(function* () {
      const parts = workbookParts([
        { name: 'Data', rows: [['12.5%']], path: 'xl/worksheets/data.bin.xml' }
      ])

      // A relationship id containing `.bin`, a directory named `archive.bin/` (with its directory
      // entry), and a styles part inside it.
      replaceInPart(parts, 'xl/workbook.xml', 'r:id="rId1"', 'r:id="rId.bin"')
      replaceInPart(parts, 'xl/_rels/workbook.xml.rels', 'Id="rId1"', 'Id="rId.bin"')
      replaceInPart(
        parts,
        'xl/_rels/workbook.xml.rels',
        '</Relationships>',
        `<Relationship Id="rId2" Type="${relNs}/styles" Target="archive.bin/styles.xml"/></Relationships>`
      )
      replaceInPart(
        parts,
        '[Content_Types].xml',
        '</Types>',
        '<Override PartName="/xl/archive.bin/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/></Types>'
      )
      parts['xl/archive.bin/'] = new Uint8Array()
      parts['xl/archive.bin/styles.xml'] = strToU8(
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><cellXfs count="1"><xf numFmtId="0"/></cellXfs></styleSheet>'
      )

      const calls: Array<SheetJsCall> = []

      const result = yield* extractWith(xlsxInput(zipParts(parts)), {
        loadSheetJs: recordingSheetJs(calls)
      })

      expect(result.content).toBe('# Data\n12.5%')
      expectAllowlisted(calls[0]?.names ?? [])
      expect(calls[0]?.names).toEqual(
        expect.arrayContaining(['xl/worksheets/sheet1.xml', 'xl/styles.xml'])
      )
    })
  )
})

describe('XLSX archives SheetJS would route to its ODS or Numbers parsers', () => {
  const odsContent =
    '<office:document-content xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0" xmlns:table="urn:oasis:names:tc:opendocument:xmlns:table:1.0" xmlns:text="urn:oasis:names:tc:opendocument:xmlns:text:1.0"><office:body><office:spreadsheet><table:table table:name="Repeated"><table:table-row table:number-rows-repeated="3"><table:table-cell table:number-columns-repeated="3"><text:p>x</text:p></table:table-cell></table:table-row></table:table></office:spreadsheet></office:body></office:document-content>'

  const odsDisguise = (manifest: string) => {
    const parts = singleSheet()

    parts[manifest] = strToU8('<manifest/>')
    parts['content.xml'] = strToU8(odsContent)
    parts['styles.xml'] = strToU8('<office:document-styles/>')

    return parts
  }

  it.effect('rejects an ODS manifest (matched case-insensitively) before loading SheetJS', () =>
    Effect.gen(function* () {
      for (const manifest of ['META-INF/manifest.xml', 'Meta-Inf/MANIFEST.XML']) {
        const parts = odsDisguise(manifest)

        // Control: SheetJS checks the manifest before content types and parses ODS repeats.
        const parsed = readDirectly(parts)

        expect(parsed.SheetNames).toEqual(['Repeated'])
        expect(cellCount(parsed.Sheets.Repeated)).toBe(9)

        yield* expectRejectedBeforeSheetJs(parts)

        expect(readThroughAllowlist(parts).SheetNames).toEqual(['Sheet1'])
      }
    })
  )

  it.effect('rejects `META-INF//manifest.xml`, which SheetJS collapses to the manifest (S1)', () =>
    Effect.gen(function* () {
      const parts = odsDisguise('META-INF//manifest.xml')

      expect(sheetJsEntryPath('META-INF//manifest.xml')).toBe('meta-inf/manifest.xml')

      const parsed = readDirectly(parts)

      expect(parsed.SheetNames).toEqual(['Repeated'])
      expect(cellCount(parsed.Sheets.Repeated)).toBe(9)

      // Every format rejects `//` names while reading the ZIP directory.
      yield* expectRejectedBeforeSheetJs(parts, invalidArchiveMessage)

      const constructed = readThroughAllowlist(parts)

      expect(constructed.SheetNames).toEqual(['Sheet1'])
      expect(constructed.Sheets.Sheet1?.A1?.v).toBe('a')
    })
  )

  it.effect('rejects `Index//Document.iwa`, which SheetJS sends to its Numbers parser (S1)', () =>
    Effect.gen(function* () {
      const parts = singleSheet()

      parts['Index//Document.iwa'] = new Uint8Array([0, 1, 2])

      expect(sheetJsEntryPath('Index//Document.iwa')).toBe('index/document.iwa')

      // Control: `parse_numbers_iwa` runs (and rejects this stub) instead of the XLSX parser.
      expect(() => readDirectly(parts)).toThrow('File has no messages')

      yield* expectRejectedBeforeSheetJs(parts, invalidArchiveMessage)

      expect(readThroughAllowlist(parts).Sheets.Sheet1?.A1?.v).toBe('a')
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
        'Root Entry/META-INF/manifest.xml',
        'root entry/xl/workbook.xml'
      ]) {
        const parts = singleSheet()

        parts[name] = new Uint8Array([0, 1, 2])

        yield* expectRejectedBeforeSheetJs(parts)
      }
    })
  )

  it('normalizes entry names the way SheetJS looks them up', () => {
    expect(sheetJsEntryPath('Root Entry/META-INF/manifest.xml')).toBe('meta-inf/manifest.xml')
    expect(sheetJsEntryPath('Index\\Document.iwa')).toBe('index/document.iwa')
    // Only the first `//` collapses, as in SheetJS `cfb_add`.
    expect(sheetJsEntryPath('a//b//c')).toBe('a/b//c')
  })

  it.effect('rejects `//` names for every format but keeps directory entries', () =>
    Effect.gen(function* () {
      const docx = {
        '[Content_Types].xml': strToU8('<Types/>'),
        'word/document.xml': strToU8('text')
      }

      for (const [name, tag] of [
        ['word//extra.xml', 'Failure'],
        ['word/media/', 'Success']
      ] as const) {
        const result = yield* normalizeOfficeArchive(
          zipParts({ ...docx, [name]: new Uint8Array() }),
          'docx'
        ).pipe(Effect.result)

        expect([name, result._tag]).toEqual([name, tag])
      }
    })
  )

  it.effect('rejects names that differ only in case, which SheetJS cannot tell apart', () =>
    Effect.gen(function* () {
      const parts = singleSheet()

      parts['XL/WORKSHEETS/SHEET1.XML'] = strToU8('<worksheet/>')

      yield* expectRejectedBeforeSheetJs(parts, invalidArchiveMessage)
    })
  )
})
