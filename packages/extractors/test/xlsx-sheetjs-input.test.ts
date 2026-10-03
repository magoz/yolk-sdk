import { describe, expect, it } from '@effect/vitest'
import { Effect } from 'effect'
import { strToU8, unzipSync } from 'fflate'
import * as XLSX from 'xlsx'
import {
  allCells,
  decode,
  expectAllowlisted,
  extractWith,
  recordingSheetJs,
  workbookParts,
  xlsxInput,
  zipParts
} from './fixtures.ts'
import type { SheetJsCall } from './fixtures.ts'

const xmlHeader = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'

const mainNs = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main'

const relNs = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships'

const packageRelNs = 'http://schemas.openxmlformats.org/package/2006/relationships'

const worksheet = (sheetData: string, dimension: string, after = '') =>
  strToU8(
    `${xmlHeader}<worksheet xmlns="${mainNs}" xmlns:r="${relNs}"><dimension ref="${dimension}"/><sheetData>${sheetData}</sheetData>${after}</worksheet>`
  )

/** A one-sheet workbook whose worksheet XML is `sheet`, plus any extra parts. */
const singleSheetParts = (sheet: Uint8Array, extra: Record<string, Uint8Array> = {}) => {
  const parts = workbookParts([{ name: 'Sheet1' }])

  parts['xl/worksheets/sheet1.xml'] = sheet

  return { ...parts, ...extra }
}

/** Unprotected SheetJS with its defaults (formulas on): the control for each attack. */
const readDirectly = (parts: Record<string, Uint8Array>) =>
  XLSX.read(zipParts(parts), { type: 'array' })

const extractRecorded = (parts: Record<string, Uint8Array>) =>
  Effect.gen(function* () {
    const calls: Array<SheetJsCall> = []

    const result = yield* extractWith(xlsxInput(zipParts(parts)), {
      loadSheetJs: recordingSheetJs(calls)
    })

    expect(calls).toHaveLength(1)

    const call = calls[0]

    if (call === undefined) throw new Error('SheetJS was not called')

    expectAllowlisted(call.names)

    return { result, call }
  })

const comments = (count: number) =>
  strToU8(
    `${xmlHeader}<comments xmlns="${mainNs}"><authors><author>a</author></authors><commentList>${Array.from(
      { length: count },
      (_, index) => `<comment ref="A1" authorId="0"><text><t>note ${index}</t></text></comment>`
    ).join('')}</commentList></comments>`
  )

const sheetRelationships = (relationships: ReadonlyArray<readonly [string, string, string]>) =>
  strToU8(
    `${xmlHeader}<Relationships xmlns="${packageRelNs}">${relationships
      .map(([id, type, target]) => `<Relationship Id="${id}" Type="${type}" Target="${target}"/>`)
      .join('')}</Relationships>`
  )

describe('SheetJS formula parsing is off (S3, S4)', () => {
  it.effect('never expands a shared formula onto its dependents', () =>
    Effect.gen(function* () {
      // A ~10 KB master formula with relative references and 200 dependents with cached values.
      const master = Array.from({ length: 2500 }, () => 'B1').join('+')

      const rows = Array.from({ length: 201 }, (_, index) => {
        const row = index + 1

        const formula =
          row === 1 ? `<f t="shared" ref="A1:A201" si="0">${master}</f>` : '<f t="shared" si="0"/>'

        return `<row r="${row}"><c r="A${row}">${formula}<v>${row}</v></c></row>`
      })

      const parts = singleSheetParts(worksheet(rows.join(''), 'A1:A201'))

      // Control: with formulas on, SheetJS stores a shifted copy of the master on every
      // dependent: about 2 MB here, and gigabytes for a 1 MB master with a few thousand cells.
      const direct = allCells(readDirectly(parts))

      expect(direct).toHaveLength(201)
      expect(direct.every(cell => (cell.f?.length ?? 0) >= master.length)).toBe(true)

      const { result, call } = yield* extractRecorded(parts)

      expect(call.options).toMatchObject({ cellFormula: false })
      expect(allCells(call.workbook)).toHaveLength(201)
      expect(allCells(call.workbook).filter(cell => 'f' in cell || 'F' in cell)).toEqual([])
      expect(result.content).toBe(
        `# Sheet1\n${Array.from({ length: 201 }, (_, index) => index + 1).join('\n')}`
      )
    })
  )

  it.effect('never scans array formulas', () =>
    Effect.gen(function* () {
      const count = 2000

      const rows = Array.from(
        { length: count },
        (_, index) =>
          `<row r="${index + 1}"><c r="A${index + 1}"><f t="array" ref="A${index + 1}:B${index + 1}">1</f><v>1</v></c></row>`
      )

      const parts = singleSheetParts(worksheet(rows.join(''), `A1:A${count}`))

      // Control: every array formula joins a list that SheetJS scans for every later cell.
      const direct = allCells(readDirectly(parts))

      expect(direct.filter(cell => cell.F !== undefined)).toHaveLength(count)

      const { call } = yield* extractRecorded(parts)

      expect(allCells(call.workbook)).toHaveLength(count)
      expect(allCells(call.workbook).filter(cell => 'f' in cell || 'F' in cell)).toEqual([])
    })
  )

  it.effect('renders cached formula values and leaves formula-only cells empty', () =>
    Effect.gen(function* () {
      const parts = singleSheetParts(
        worksheet(
          '<row r="1"><c r="A1"><f>1+1</f><v>2</v></c><c r="B1"><f>A1*2</f></c><c r="C1" t="e"><f>1/0</f></c><c r="D1" t="inlineStr"><is><t>end</t></is></c></row>',
          'A1:D1'
        )
      )

      // Control: with formulas on, SheetJS keeps a formula without a cached value as `f` (the
      // renderer used to write it as `=1/0`).
      const direct = readDirectly(parts).Sheets.Sheet1

      expect(direct?.C1?.f).toBe('1/0')
      expect(direct?.C1?.v).toBeUndefined()

      const { result } = yield* extractRecorded(parts)

      expect(result.content).toBe('# Sheet1\n2,,,end')
    })
  )
})

describe('the allowlisted SheetJS input', () => {
  it.effect('leaves out comments, so many comments on one cell cost nothing (S4)', () =>
    Effect.gen(function* () {
      const parts = singleSheetParts(
        worksheet('<row r="1"><c r="A1" t="inlineStr"><is><t>cell</t></is></c></row>', 'A1'),
        {
          'xl/comments1.xml': comments(2000),
          'xl/worksheets/_rels/sheet1.xml.rels': sheetRelationships([
            ['rId1', `${relNs}/comments`, '../comments1.xml']
          ])
        }
      )

      // Control: SheetJS rescans the cell's comment list for every comment on it.
      expect(readDirectly(parts).Sheets.Sheet1?.A1?.c).toHaveLength(2000)

      const { result, call } = yield* extractRecorded(parts)

      expect(call.names.some(name => /comment|_rels\/sheet/i.test(name))).toBe(false)
      expect(call.workbook.Sheets.Sheet1?.A1?.c).toBeUndefined()
      expect(result.content).toBe('# Sheet1\ncell')
    })
  )

  it.effect('generates content types and relationships instead of passing them through', () =>
    Effect.gen(function* () {
      const parts = workbookParts([
        { name: 'One', rows: [['1']] },
        { name: 'Two', rows: [['2']] }
      ])

      const { call } = yield* extractRecorded(parts)
      const handed = unzipSync(call.bytes)

      expect(call.names).toEqual([
        '[Content_Types].xml',
        '_rels/.rels',
        'xl/workbook.xml',
        'xl/_rels/workbook.xml.rels',
        'xl/worksheets/sheet1.xml',
        'xl/worksheets/sheet2.xml'
      ])
      // The fixture's own content types declare a comments part; the generated ones do not.
      expect(decode(handed['[Content_Types].xml'])).not.toContain('comments')
      expect(decode(handed['xl/_rels/workbook.xml.rels'])).toBe(
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\r\n<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet2.xml"/></Relationships>'
      )
      expect(handed['xl/worksheets/sheet2.xml']).toEqual(parts['xl/worksheets/sheet2.xml'])
    })
  )

  it.effect('stores sheets under canonical names, matching sources ignoring case', () =>
    Effect.gen(function* () {
      const parts = workbookParts([
        { name: 'Upper', rows: [['u']], path: 'xl/worksheets/Data.XML' },
        { name: 'Elsewhere', rows: [['e']], path: 'xl/other/sheet2.xml' },
        { name: 'Third', rows: [['t']] }
      ])

      const rels = parts['xl/_rels/workbook.xml.rels']

      if (rels === undefined) throw new Error('Missing fixture relationships')

      parts['xl/_rels/workbook.xml.rels'] = strToU8(
        decode(rels).replace('worksheets/Data.XML', 'WORKSHEETS/data.xml')
      )

      const { result, call } = yield* extractRecorded(parts)

      // Only worksheets under xl/worksheets/ are handed over; sheet 3 keeps its position.
      expect(call.names).toEqual(
        expect.arrayContaining(['xl/worksheets/sheet1.xml', 'xl/worksheets/sheet3.xml'])
      )
      expect(call.names).not.toContain('xl/worksheets/sheet2.xml')
      expect(result.content).toBe('# Upper\nu\n\n# Third\nt')
      expect(result.metadata.sheetNames).toEqual(['Upper', 'Elsewhere', 'Third'])
    })
  )

  it.effect('hands a worksheet part shared by several sheets over once', () =>
    Effect.gen(function* () {
      const parts = workbookParts([
        { name: 'A', rows: [['shared']] },
        { name: 'B', rows: [['other']] }
      ])

      const rels = parts['xl/_rels/workbook.xml.rels']

      if (rels === undefined) throw new Error('Missing fixture relationships')

      parts['xl/_rels/workbook.xml.rels'] = strToU8(
        decode(rels).replace('worksheets/sheet2.xml', 'worksheets/sheet1.xml')
      )

      const { result, call } = yield* extractRecorded(parts)

      expect(call.names.filter(name => name.startsWith('xl/worksheets/'))).toEqual([
        'xl/worksheets/sheet1.xml'
      ])
      expect(result.content).toBe('# A\nshared')
    })
  )

  it.effect('rejects a workbook with more sheets than the limit before loading SheetJS', () =>
    Effect.gen(function* () {
      const calls: Array<SheetJsCall> = []

      const book = zipParts(
        workbookParts([
          { name: 'A', rows: [['a']] },
          { name: 'B', rows: [['b']] },
          { name: 'C', rows: [['c']] }
        ])
      )

      const error = yield* extractWith(xlsxInput(book), {
        limits: { maxXlsxSheets: 2 },
        loadSheetJs: recordingSheetJs(calls)
      }).pipe(Effect.flip)

      expect(error.message).toBe('XLSX exceeds the worksheet or cell-visit limit.')
      expect(calls).toHaveLength(0)
    })
  )
})

describe('positive controls', () => {
  it.effect('extracts an XLSX written by SheetJS 0.20.3 with its title', () =>
    Effect.gen(function* () {
      const book = XLSX.utils.book_new()

      XLSX.utils.book_append_sheet(
        book,
        XLSX.utils.aoa_to_sheet([
          ['Name', 'Count'],
          ['Alpha', 2]
        ]),
        'Inventory'
      )
      book.Props = { Title: 'Inventory report' }

      const written: unknown = XLSX.write(book, { bookType: 'xlsx', type: 'array', bookSST: true })

      if (!(written instanceof ArrayBuffer)) throw new Error('Expected XLSX fixture')

      const parts = unzipSync(new Uint8Array(written))
      const direct = readDirectly(parts)
      const { result, call } = yield* extractRecorded(parts)

      expect(call.names).toEqual(
        expect.arrayContaining(['xl/sharedStrings.xml', 'xl/styles.xml', 'docProps/core.xml'])
      )
      expect(result.content).toBe('# Inventory\nName,Count\nAlpha,2')
      expect(result.content).toBe(
        `# Inventory\n${XLSX.utils.sheet_to_csv(direct.Sheets.Inventory ?? {})}`
      )
      expect(result.metadata).toEqual({
        format: 'xlsx',
        title: 'Inventory report',
        sheetNames: ['Inventory']
      })
    })
  )

  it.effect('extracts an Excel-like workbook with the same text and title as SheetJS', () =>
    Effect.gen(function* () {
      const parts = excelLikeParts()
      const direct = readDirectly(parts)
      const { result, call } = yield* extractRecorded(parts)

      expect(call.names).toEqual([
        '[Content_Types].xml',
        '_rels/.rels',
        'xl/workbook.xml',
        'xl/_rels/workbook.xml.rels',
        'xl/worksheets/sheet1.xml',
        'xl/worksheets/sheet2.xml',
        'xl/sharedStrings.xml',
        'xl/styles.xml',
        'docProps/core.xml'
      ])

      // Number formats come through styles.xml: a custom percentage and a built-in date.
      expect(result.content).toBe(
        '# Summary\nRegion,Share,Opened\nNorth,12.5%,1/1/24\n\n# Notes\n"Remember, quarterly"'
      )

      const csv = direct.SheetNames.map(
        name => `# ${name}\n${XLSX.utils.sheet_to_csv(direct.Sheets[name] ?? {})}`
      )

      expect(result.content).toBe(csv.join('\n\n'))
      expect(result.metadata.title).toBe('Quarterly numbers')
      expect(direct.Props?.Title).toBe('Quarterly numbers')
      expect(result.metadata.sheetNames).toEqual(['Summary', 'Notes'])
    })
  )
})

/** A workbook shaped like Excel's output: themes, comments, drawings, VML, printer settings. */
const excelLikeParts = () => {
  const override = (path: string, type: string) =>
    `<Override PartName="/${path}" ContentType="application/vnd.openxmlformats-officedocument.${type}"/>`

  return {
    '[Content_Types].xml': strToU8(
      `${xmlHeader}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="bin" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.printerSettings"/><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Default Extension="vml" ContentType="application/vnd.openxmlformats-officedocument.vmlDrawing"/>${[
        override('xl/workbook.xml', 'spreadsheetml.sheet.main+xml'),
        override('xl/worksheets/sheet1.xml', 'spreadsheetml.worksheet+xml'),
        override('xl/worksheets/sheet2.xml', 'spreadsheetml.worksheet+xml'),
        override('xl/theme/theme1.xml', 'theme+xml'),
        override('xl/styles.xml', 'spreadsheetml.styles+xml'),
        override('xl/sharedStrings.xml', 'spreadsheetml.sharedStrings+xml'),
        override('xl/drawings/drawing1.xml', 'drawing+xml'),
        override('xl/comments1.xml', 'spreadsheetml.comments+xml'),
        override('docProps/app.xml', 'extended-properties+xml')
      ].join(
        ''
      )}<Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/></Types>`
    ),
    '_rels/.rels': sheetRelationships([
      ['rId3', `${relNs}/extended-properties`, 'docProps/app.xml'],
      ['rId2', `${packageRelNs}/metadata/core-properties`, 'docProps/core.xml'],
      ['rId1', `${relNs}/officeDocument`, 'xl/workbook.xml']
    ]),
    'docProps/core.xml': strToU8(
      `${xmlHeader}<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:title>Quarterly numbers</dc:title><dc:creator>Analyst</dc:creator></cp:coreProperties>`
    ),
    'docProps/app.xml': strToU8(
      `${xmlHeader}<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties"><Application>Microsoft Excel</Application><TitlesOfParts><vt:vector xmlns:vt="http://schemas.openxmlformats.org/officeDocument/2006/docPropsVTypes" size="2" baseType="lpstr"><vt:lpstr>Summary</vt:lpstr><vt:lpstr>Notes</vt:lpstr></vt:vector></TitlesOfParts></Properties>`
    ),
    'xl/workbook.xml': strToU8(
      `${xmlHeader}<workbook xmlns="${mainNs}" xmlns:r="${relNs}"><workbookPr/><sheets><sheet name="Summary" sheetId="1" r:id="rId1"/><sheet name="Notes" sheetId="2" r:id="rId2"/></sheets><calcPr calcId="191029"/></workbook>`
    ),
    'xl/_rels/workbook.xml.rels': sheetRelationships([
      ['rId3', `${relNs}/theme`, 'theme/theme1.xml'],
      ['rId2', `${relNs}/worksheet`, 'worksheets/sheet2.xml'],
      ['rId1', `${relNs}/worksheet`, 'worksheets/sheet1.xml'],
      ['rId5', `${relNs}/sharedStrings`, 'sharedStrings.xml'],
      ['rId4', `${relNs}/styles`, 'styles.xml']
    ]),
    'xl/theme/theme1.xml': strToU8(
      `${xmlHeader}<a:theme xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" name="Office Theme"><a:themeElements/></a:theme>`
    ),
    'xl/styles.xml': strToU8(
      `${xmlHeader}<styleSheet xmlns="${mainNs}"><numFmts count="1"><numFmt numFmtId="164" formatCode="0.0%"/></numFmts><fonts count="1"><font><sz val="11"/><name val="Calibri"/></font></fonts><fills count="1"><fill><patternFill patternType="none"/></fill></fills><borders count="1"><border/></borders><cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs><cellXfs count="3"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/><xf numFmtId="164" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/><xf numFmtId="14" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/></cellXfs></styleSheet>`
    ),
    'xl/sharedStrings.xml': strToU8(
      `${xmlHeader}<sst xmlns="${mainNs}" count="5" uniqueCount="5"><si><t>Region</t></si><si><t>Share</t></si><si><t>Opened</t></si><si><t>North</t></si><si><r><rPr><b/></rPr><t>Remember, </t></r><r><t>quarterly</t></r></si></sst>`
    ),
    'xl/worksheets/sheet1.xml': worksheet(
      '<row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c><c r="C1" t="s"><v>2</v></c></row><row r="2"><c r="A2" t="s"><v>3</v></c><c r="B2" s="1"><v>0.125</v></c><c r="C2" s="2"><v>45292</v></c></row>',
      'A1:C2',
      '<pageSetup orientation="portrait" r:id="rId1"/><drawing r:id="rId2"/><legacyDrawing r:id="rId3"/>'
    ),
    'xl/worksheets/_rels/sheet1.xml.rels': sheetRelationships([
      ['rId1', `${relNs}/printerSettings`, '../printerSettings/printerSettings1.bin'],
      ['rId2', `${relNs}/drawing`, '../drawings/drawing1.xml'],
      ['rId3', `${relNs}/vmlDrawing`, '../drawings/vmlDrawing1.vml'],
      ['rId4', `${relNs}/comments`, '../comments1.xml']
    ]),
    'xl/worksheets/sheet2.xml': worksheet('<row r="1"><c r="A1" t="s"><v>4</v></c></row>', 'A1'),
    'xl/printerSettings/printerSettings1.bin': new Uint8Array([0, 1, 2, 3]),
    'xl/drawings/drawing1.xml': strToU8(
      `${xmlHeader}<xdr:wsDr xmlns:xdr="http://schemas.openxmlformats.org/drawingml/2006/spreadsheetDrawing"/>`
    ),
    'xl/drawings/vmlDrawing1.vml': strToU8(
      '<xml xmlns:v="urn:schemas-microsoft-com:vml"><v:shape id="_x0000_s1025"/></xml>'
    ),
    'xl/comments1.xml': comments(1)
  }
}
