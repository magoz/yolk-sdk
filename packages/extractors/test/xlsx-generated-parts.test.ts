import { describe, expect, it } from '@effect/vitest'
import { Effect } from 'effect'
import { strToU8, unzipSync } from 'fflate'
import { Buffer } from 'node:buffer'
import { vi } from 'vitest'
import * as XLSX from 'xlsx'
import { sheetJsReadOptions } from '../src/node/sheetjs.ts'
import { withoutSimpleTags } from '../src/node/sheetjs-xml.ts'
import {
  maxCellFormats,
  maxCustomNumberFormats,
  maxNumberFormatCharacters,
  readStyles
} from '../src/node/xlsx-styles.ts'
import {
  allCells,
  decode,
  expectRejected,
  extractRecorded,
  readDirectly,
  singleSheetParts,
  workbookParts,
  worksheet,
  zipParts
} from './fixtures.ts'

const xmlHeader = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'

const mainNs = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main'

const relNs = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships'

const packageRelNs = 'http://schemas.openxmlformats.org/package/2006/relationships'

const cdataMessage =
  'XLSX contains unsupported markup (CDATA, comments or declarations) in worksheet or shared-strings parts.'

/** Add a part with its content-type override and workbook relationship, as Excel declares it. */
const withWorkbookPart = (
  parts: Record<string, Uint8Array>,
  path: 'xl/styles.xml' | 'xl/sharedStrings.xml',
  xml: string
) => {
  const kind = path === 'xl/styles.xml' ? 'styles' : 'sharedStrings'

  const types = decode(parts['[Content_Types].xml']).replace(
    '</Types>',
    `<Override PartName="/${path}" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.${kind}+xml"/></Types>`
  )

  const rels = decode(parts['xl/_rels/workbook.xml.rels']).replace(
    '</Relationships>',
    `<Relationship Id="rId${kind}" Type="${relNs}/${kind}" Target="${path.slice(3)}"/></Relationships>`
  )

  return {
    ...parts,
    '[Content_Types].xml': strToU8(types),
    'xl/_rels/workbook.xml.rels': strToU8(rels),
    [path]: strToU8(xml)
  }
}

const styleSheet = (
  numFmts: ReadonlyArray<readonly [number, string]>,
  xfs: ReadonlyArray<number>
) =>
  `${xmlHeader}<styleSheet xmlns="${mainNs}"><numFmts count="${numFmts.length}">${numFmts
    .map(([id, code]) => `<numFmt numFmtId="${id}" formatCode="${code}"/>`)
    .join(
      ''
    )}</numFmts><fonts count="1"><font><sz val="11"/></font></fonts><cellXfs count="${xfs.length}">${xfs
    .map(id => `<xf numFmtId="${id}" fontId="0" applyNumberFormat="1"/>`)
    .join('')}</cellXfs></styleSheet>`

/** Numeric cells in column A, row `n` styled with `styles[n - 1]`. */
const styledRows = (cells: ReadonlyArray<readonly [number, number]>) =>
  cells
    .map(
      ([value, style], index) =>
        `<row r="${index + 1}"><c r="A${index + 1}" s="${style}"><v>${value}</v></c></row>`
    )
    .join('')

const sharedStrings = (items: string) =>
  `${xmlHeader}<sst xmlns="${mainNs}" count="1" uniqueCount="1">${items}</sst>`

/** Real SheetJS with the extractor's own `read` options (`cellHTML: false` among them). */
const readWithExtractorOptions = (parts: Record<string, Uint8Array>) =>
  XLSX.read(zipParts(parts), { ...sheetJsReadOptions })

/**
 * The longest string `String.prototype.replace` ran on during `run`: SheetJS's rich-text renderer
 * calls it on every run's decoded text, whether or not the HTML is kept.
 */
const longestReplacedString = (run: () => unknown) => {
  const spy = vi.spyOn(String.prototype, 'replace')

  try {
    run()

    return Math.max(0, ...spy.mock.contexts.map(text => String(text).length))
  } finally {
    spy.mockRestore()
  }
}

/** `# name\n<csv>` for every sheet SheetJS read directly, as the extractor renders it. */
const directCsv = (book: XLSX.WorkBook) =>
  book.SheetNames.map(
    name => `# ${name}\n${XLSX.utils.sheet_to_csv(book.Sheets[name] ?? {})}`
  ).join('\n\n')

describe('generated xl/workbook.xml (R3-S2, F3)', () => {
  it.effect('never hands SheetJS defined names, which it decodes quadratically', () =>
    Effect.gen(function* () {
      const closings = 2000
      const parts = workbookParts([{ name: 'Sheet1', rows: [['kept']] }])

      parts['xl/workbook.xml'] = strToU8(
        decode(parts['xl/workbook.xml']).replace(
          '</workbook>',
          `<definedNames><definedName name="n">Sheet1!$A$1</definedName>${'</definedName>'.repeat(closings)}</definedNames><calcPr calcId="1"/></workbook>`
        )
      )

      // Control: every closing tag decodes the whole prefix of the part again and adds a name.
      const direct = readDirectly(parts)
      const names = direct.Workbook?.Names ?? []

      expect(names).toHaveLength(closings + 1)
      expect((names.at(-1)?.Ref ?? '').length).toBeGreaterThan(closings * 10)

      const { result, call } = yield* extractRecorded(parts)
      const handed = decode(unzipSync(call.bytes)['xl/workbook.xml'])

      expect(handed).not.toContain('definedName')
      expect(handed).not.toContain('calcPr')
      expect(call.workbook.Workbook?.Names ?? []).toEqual([])
      expect(result.content).toBe('# Sheet1\nkept')
    })
  )

  it.effect('keeps names SheetJS reads exactly, escapes included', () =>
    Effect.gen(function* () {
      const tricky = [
        'A &amp; B &quot;q&quot;',
        'Code _x0041_ lit',
        'Tab&#9;Name',
        'Emoji 📈',
        'Ünï',
        // SheetJS reads `_xHHHH_` codes ignoring case: this is `_X0041_`, not `A`, and must not
        // become a second sheet named `A` in the generated workbook.
        'Lit _x005F_X0041_',
        'Lit A'
      ]

      const parts = workbookParts(
        tricky.map((name, index) => ({ name: `S${index}`, rows: [[`${index}`]] }))
      )

      // Write the raw (already escaped) attribute values the way Excel would.
      let book = decode(parts['xl/workbook.xml'])

      for (const [index, name] of tricky.entries())
        book = book.replace(`name="S${index}"`, `name="${name}"`)

      parts['xl/workbook.xml'] = strToU8(book)

      const direct = readDirectly(parts)
      const { result, call } = yield* extractRecorded(parts)

      expect(call.workbook.SheetNames).toEqual(direct.SheetNames)
      expect(result.metadata.sheetNames).toEqual(direct.SheetNames)
      expect(direct.SheetNames).toContain('Code A lit')
      expect(direct.SheetNames).toContain('Lit _X0041_')
      expect(result.content).toBe(directCsv(direct))
    })
  )

  it.effect('keeps the 1904 date system (positive control)', () =>
    Effect.gen(function* () {
      const base = singleSheetParts(
        worksheet(
          styledRows([
            [0, 1],
            [1, 1],
            [45000.5, 2]
          ]),
          'A1:A3'
        )
      )

      const parts = withWorkbookPart(
        {
          ...base,
          'xl/workbook.xml': strToU8(
            decode(base['xl/workbook.xml']).replace(
              '<sheets>',
              '<workbookPr date1904="true" defaultThemeVersion="164011"/><sheets>'
            )
          )
        },
        'xl/styles.xml',
        styleSheet([], [0, 14, 22])
      )

      const direct = readDirectly(parts)
      const { result, call } = yield* extractRecorded(parts)

      expect(direct.Workbook?.WBProps?.date1904).toBe(true)
      expect(call.workbook.Workbook?.WBProps?.date1904).toBe(true)
      expect(result.content).toBe(directCsv(direct))
      // 1904 serial 0 is 1 January 1904.
      expect(result.content).toBe('# Sheet1\n1/1/04\n1/2/04\n3/16/27 12:00')
    })
  )

  it.effect('keeps hidden and very hidden sheets (positive control)', () =>
    Effect.gen(function* () {
      const parts = workbookParts([
        { name: 'Shown', rows: [['s']] },
        { name: 'Hidden', rows: [['h']] },
        { name: 'Secret', rows: [['v']] }
      ])

      parts['xl/workbook.xml'] = strToU8(
        decode(parts['xl/workbook.xml'])
          .replace('name="Hidden"', 'name="Hidden" state="hidden"')
          .replace('name="Secret"', 'name="Secret" state="veryHidden"')
      )

      const direct = readDirectly(parts)
      const { result, call } = yield* extractRecorded(parts)
      const hidden = (book: XLSX.WorkBook) => book.Workbook?.Sheets?.map(sheet => sheet.Hidden)

      expect(hidden(direct)).toEqual([0, 1, 2])
      expect(hidden(call.workbook)).toEqual([0, 1, 2])
      expect(result.metadata.sheetNames).toEqual(['Shown', 'Hidden', 'Secret'])
      expect(result.content).toBe(directCsv(direct))
    })
  )
})

describe('generated xl/styles.xml (R3-S3, F2)', () => {
  it.effect('drops a huge number format that SheetJS would apply to every cell', () =>
    Effect.gen(function* () {
      const literal = 'x'.repeat(20_000)
      const count = 50

      const parts = withWorkbookPart(
        singleSheetParts(
          worksheet(
            styledRows(Array.from({ length: count }, () => [1, 1] as const)),
            `A1:A${count}`
          )
        ),
        'xl/styles.xml',
        styleSheet([[164, `&quot;${literal}&quot;`]], [0, 164])
      )

      // Control: SheetJS re-parses the format for every cell and keeps the literal on each one.
      const direct = allCells(readDirectly(parts))

      expect(direct).toHaveLength(count)
      expect(direct.every(cell => (cell.w?.length ?? 0) >= literal.length)).toBe(true)

      const { result, call } = yield* extractRecorded(parts)
      const styles = decode(unzipSync(call.bytes)['xl/styles.xml'])

      expect(styles).not.toContain(literal)
      expect(allCells(call.workbook).every(cell => cell.w === '1')).toBe(true)
      expect(result.content).toBe(
        `# Sheet1\n${Array.from({ length: count }, () => '1').join('\n')}`
      )
    })
  )

  it('keeps formats up to 255 characters after unescaping and caps counts', () => {
    const atLimit = `"${'y'.repeat(maxNumberFormatCharacters - 2)}"`
    const overLimit = `"${'z'.repeat(maxNumberFormatCharacters - 1)}"`
    // Eight escaped characters that unescape to one each: counted after unescaping.
    const escaped = `&quot;${'&amp;'.repeat(maxNumberFormatCharacters - 2)}&quot;`

    const summary = readStyles(
      strToU8(
        styleSheet(
          [
            [164, atLimit.replaceAll('"', '&quot;')],
            [165, overLimit.replaceAll('"', '&quot;')],
            [166, escaped],
            [167, '&lt;![CDATA[0']
          ],
          [0, 164, 165, 9, 166]
        )
      )
    )

    expect(summary.numberFormats).toEqual([
      [164, atLimit],
      [166, `"${'&'.repeat(maxNumberFormatCharacters - 2)}"`],
      [167, '<![CDATA[0']
    ])
    // Cell formats keep their positions so cell `s` indexes keep their meaning.
    expect(summary.cellFormats).toEqual([0, 164, 165, 9, 166])

    const many = readStyles(
      strToU8(
        styleSheet(
          Array.from(
            { length: maxCustomNumberFormats + 5 },
            (_, index) => [164 + index, '0'] as const
          ),
          Array.from({ length: maxCellFormats + 5 }, () => 0)
        )
      )
    )

    expect(many.numberFormats).toHaveLength(maxCustomNumberFormats)
    expect(many.cellFormats).toHaveLength(maxCellFormats)
  })

  it.effect('formats dates, percentages, currency, and text like SheetJS (positive control)', () =>
    Effect.gen(function* () {
      const formats = [
        [164, '&quot;$&quot;#,##0.00'],
        [165, '[$€-2]\\ #,##0.00'],
        [166, 'yyyy\\-mm\\-dd'],
        [167, '0.0%'],
        [168, '#,##0;[Red]\\-#,##0'],
        [169, '&quot;Total: &quot;@'],
        [170, '[$-409]mmm\\ d&quot;, &quot;yyyy;@'],
        // A literal SheetJS reads as `_X0041_` (codes match ignoring case), not `A`.
        [171, '&quot;_x005F_X0041_ &quot;0']
      ] as const

      const xfs = [0, 164, 165, 166, 167, 168, 9, 14, 22, 10, 170, 171]

      const values: ReadonlyArray<readonly [number, number]> = [
        [1234.5, 1],
        [1234.5, 2],
        [45292, 3],
        [0.125, 4],
        [-9876, 5],
        [0.5, 6],
        [45292, 7],
        [45292.25, 8],
        [0.3333, 9],
        [45000, 10],
        [5, 11],
        [42, 0]
      ]

      const parts = withWorkbookPart(
        singleSheetParts(worksheet(styledRows(values), `A1:A${values.length}`)),
        'xl/styles.xml',
        styleSheet(formats, xfs)
      )

      const direct = readDirectly(parts)
      const { result } = yield* extractRecorded(parts)

      expect(result.content).toBe(directCsv(direct))
      expect(result.content.split('\n').slice(1, 5)).toEqual([
        '"$1,234.50"',
        '"€ 1,234.50"',
        '2024-01-01',
        '12.5%'
      ])
      expect(result.content).toContain('\n_X0041_ 5\n')
    })
  )
})

describe('CDATA never reaches SheetJS (F1)', () => {
  // SheetJS's `unescapexml` recurses on an unterminated CDATA marker, copying the whole tail at
  // every level: about (m / 2) * (t + m / 2) characters for m characters before it and t after.
  const before = 200
  const after = 2000
  const quadratic = `${'A'.repeat(before)}<![CDATA[${'B'.repeat(after)}`

  it.effect('rejects an unterminated CDATA section in a worksheet cell', () =>
    Effect.gen(function* () {
      const parts = singleSheetParts(
        worksheet(`<row r="1"><c r="A1" t="str"><v>${quadratic}</v></c></row>`, 'A1')
      )

      // Control: about 2 KB of cell text decodes to over 200,000 characters.
      const value = readDirectly(parts).Sheets.Sheet1?.A1?.v

      expect(String(value).length).toBeGreaterThan(200_000)

      yield* expectRejected(parts, cdataMessage)
    })
  )

  it.effect('rejects CDATA in shared strings and escaped CDATA decoded twice', () =>
    Effect.gen(function* () {
      const sharedStrings = withWorkbookPart(
        singleSheetParts(worksheet('<row r="1"><c r="A1" t="s"><v>0</v></c></row>', 'A1')),
        'xl/sharedStrings.xml',
        `${xmlHeader}<sst xmlns="${mainNs}" count="1" uniqueCount="1"><si><t>${quadratic}</t></si></sst>`
      )

      yield* expectRejected(sharedStrings, cdataMessage)

      // `str` cells are unescaped twice, so an escaped marker becomes a real one.
      const escaped = singleSheetParts(
        worksheet(
          `<row r="1"><c r="A1" t="str"><v>x&lt;![CDATA[${'B'.repeat(50)}</v></c></row>`,
          'A1'
        )
      )

      const value = readDirectly(escaped).Sheets.Sheet1?.A1?.v

      expect(String(value).length).toBeGreaterThan(50)

      yield* expectRejected(escaped, cdataMessage)
    })
  )

  // SheetJS decodes a `str` cell as `unescapexml(utf8read(unescapexml(raw)))`, and `utf8read`
  // keeps only the low byte of each character: U+013C becomes `<` between the two decodes.
  for (const lowByteLessThan of ['_x013C_', '&#x13C;', '&#316;', '_X013c_'])
    it.effect(`rejects ${lowByteLessThan} that utf8read turns into a CDATA marker`, () =>
      Effect.gen(function* () {
        const cell = `${'A'.repeat(before)}${lowByteLessThan}![CDATA[${'B'.repeat(after)}`

        const parts = singleSheetParts(
          worksheet(`<row r="1"><c r="A1" t="str"><v>${cell}</v></c></row>`, 'A1')
        )

        // Control: neither the raw text nor one unescape holds a marker, yet about 2 KB of cell
        // text decodes to over 200,000 characters.
        expect(cell).not.toContain('<![CDATA[')
        expect(String(readDirectly(parts).Sheets.Sheet1?.A1?.v).length).toBeGreaterThan(200_000)

        // Rejected before SheetJS is loaded or `read` runs.
        yield* expectRejected(parts, cdataMessage)
      })
    )

  it.effect(
    'rejects shared strings that could decode to a marker (beyond what SheetJS decodes)',
    () =>
      Effect.gen(function* () {
        const sharedString = `${'A'.repeat(before)}_x013C_![CDATA[${'B'.repeat(after)}`

        const parts = withWorkbookPart(
          singleSheetParts(worksheet('<row r="1"><c r="A1" t="s"><v>0</v></c></row>', 'A1')),
          'xl/sharedStrings.xml',
          sharedStrings(`<si><t>${sharedString}</t></si>`)
        )

        // Control: shared strings are decoded once (`unescapexml(utf8read(raw))`), so SheetJS 0.20.3
        // does not expand this one; the check covers every chain of up to two conversions anyway.
        // The shared-strings path SheetJS does expand is tag removal, tested below.
        expect(String(readDirectly(parts).Sheets.Sheet1?.A1?.v)).toHaveLength(before + after + 9)

        yield* expectRejected(parts, cdataMessage)
      })
  )

  // SheetJS removes some opening tags before it decodes: every `<si>` in the shared-strings table
  // (`parse_sst_xml`), and every `<r>` in rich text (`parse_rs`). Inline strings call `parse_si`
  // without options, so their rich text is rendered even with the extractor's `cellHTML: false`.
  // Removing the tag assembles a marker that no view of the part contains.
  it.effect('rejects a marker that SheetJS assembles by removing <si> from shared strings', () =>
    Effect.gen(function* () {
      const item = `<si><t>${'A'.repeat(before)}<<si>![CDATA[${'B'.repeat(after)}</t></si>`

      const parts = withWorkbookPart(
        singleSheetParts(worksheet('<row r="1"><c r="A1" t="s"><v>0</v></c></row>', 'A1')),
        'xl/sharedStrings.xml',
        sharedStrings(item)
      )

      // Control: about 2 KB of shared string decodes to over 200,000 characters, with the
      // extractor's own read options.
      expect(item).not.toContain('<![CDATA[')
      expect(String(readWithExtractorOptions(parts).Sheets.Sheet1?.A1?.v).length).toBeGreaterThan(
        200_000
      )

      yield* expectRejected(parts, cdataMessage)
    })
  )

  it.effect('rejects a marker that SheetJS assembles by removing <r> from an inline string', () =>
    Effect.gen(function* () {
      const cell = `<c r="A1" t="inlineStr"><is><r><t>${'A'.repeat(before)}<<r>![CDATA[${'B'.repeat(after)}</t></r></is></c>`
      const parts = singleSheetParts(worksheet(`<row r="1">${cell}</row>`, 'A1'))

      // Control: with the extractor's options (`cellHTML: false`) SheetJS keeps no HTML, yet it
      // still renders the run, a string of over 200,000 characters.
      expect(cell).not.toContain('<![CDATA[')
      expect(longestReplacedString(() => readWithExtractorOptions(parts))).toBeGreaterThan(200_000)
      expect(String(readDirectly(parts).Sheets.Sheet1?.A1?.h).length).toBeGreaterThan(200_000)

      yield* expectRejected(parts, cdataMessage)
    })
  )

  it.effect('rejects escaped markers around a removed tag as a superset (not exploitable)', () =>
    Effect.gen(function* () {
      const inline = singleSheetParts(
        worksheet(
          `<row r="1"><c r="A1" t="inlineStr"><is><r><t>${'A'.repeat(before)}&lt;<r>![CDATA[${'B'.repeat(after)}</t></r></is></c></row>`,
          'A1'
        )
      )

      const shared = withWorkbookPart(
        singleSheetParts(worksheet('<row r="1"><c r="A1" t="s"><v>0</v></c></row>', 'A1')),
        'xl/sharedStrings.xml',
        sharedStrings(`<si><t>${'A'.repeat(before)}&lt;<si>![CDATA[${'B'.repeat(after)}</t></si>`)
      )

      // Control: no expansion. SheetJS 0.20.3 decodes these once, after the tag removal, so `&lt;`
      // becomes `<` only after its CDATA check. They are not exploitable; the check rejects them
      // as part of its superset (the view without simple tags unescapes to a marker).
      expect(longestReplacedString(() => readWithExtractorOptions(inline))).toBeLessThan(5_000)
      expect(String(readDirectly(inline).Sheets.Sheet1?.A1?.h).length).toBeLessThan(5_000)
      expect(String(readWithExtractorOptions(shared).Sheets.Sheet1?.A1?.v)).toHaveLength(
        before + after + 9
      )

      yield* expectRejected(inline, cdataMessage)
      yield* expectRejected(shared, cdataMessage)
    })
  )

  it.effect(
    'fails closed on `<<`, comments, and declarations, which spreadsheet apps never write',
    () =>
      Effect.gen(function* () {
        for (const text of ['a<<b', '<!-- note -->', '<!DOCTYPE sst>']) {
          const shared = withWorkbookPart(
            singleSheetParts(worksheet('<row r="1"><c r="A1" t="s"><v>0</v></c></row>', 'A1')),
            'xl/sharedStrings.xml',
            sharedStrings(`<si><t>x</t></si>${text}`)
          )

          yield* expectRejected(shared, cdataMessage)
          yield* expectRejected(
            singleSheetParts(worksheet('<row r="1"><c r="A1"><v>1</v></c></row>', 'A1', text)),
            cdataMessage
          )
        }

        // In a BOM-marked UTF-16 part, `utf8read` keeps only each character's low byte, so U+013C
        // becomes `<` right before a `<r>` that SheetJS removes: rejected through the UTF-16 view.
        const utf16 = (text: string) =>
          Uint8Array.from([0xff, 0xfe, ...new Uint8Array(Buffer.from(text, 'utf16le'))])

        const sheet = decode(
          worksheet(
            '<row r="1"><c r="A1" t="inlineStr"><is><r><t>A\u013C<r>![CDATA[B</t></r></is></c></row>',
            'A1'
          )
        )

        expect(sheet).not.toContain('<<')
        yield* expectRejected(singleSheetParts(utf16(sheet)), cdataMessage)
      })
  )

  it.effect('keeps rich text in shared and inline strings (positive control)', () =>
    Effect.gen(function* () {
      const parts = withWorkbookPart(
        singleSheetParts(
          worksheet(
            '<row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="inlineStr"><is><r><rPr><i/></rPr><t xml:space="preserve">Inline </t></r><r><t>rich &amp; &lt;b&gt;</t></r></is></c><c r="C1" t="inlineStr"><is><t>plain</t></is></c></row>',
            'A1:C1'
          )
        ),
        'xl/sharedStrings.xml',
        sharedStrings(
          '<si><r><rPr><b/><sz val="11"/></rPr><t>東京</t></r><r><t xml:space="preserve"> office</t></r><rPh sb="0" eb="2"><t>トウキョウ</t></rPh><phoneticPr fontId="1"/></si>'
        )
      )

      const { result } = yield* extractRecorded(parts)

      expect(result.content).toBe(directCsv(readDirectly(parts)))
      expect(result.content).toBe('# Sheet1\n東京 office,Inline rich & <b>,plain')
    })
  )

  it('removes only simple opening tags, a superset of the tags SheetJS removes', () => {
    expect(withoutSimpleTags('<si><x:r><sstItem>t<t xml:space="preserve"></t><a:><<r>!<-.>')).toBe(
      't<t xml:space="preserve"></t><a:><!'
    )
  })

  it.effect('reads the title without SheetJS and ignores a CDATA title', () =>
    Effect.gen(function* () {
      const withCore = (title: string) => {
        const parts = workbookParts([{ name: 'Sheet1', rows: [['cell']] }])

        return {
          ...parts,
          '[Content_Types].xml': strToU8(
            decode(parts['[Content_Types].xml']).replace(
              '</Types>',
              '<Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/></Types>'
            )
          ),
          '_rels/.rels': strToU8(
            decode(parts['_rels/.rels']).replace(
              '</Relationships>',
              `<Relationship Id="rId2" Type="${packageRelNs}/metadata/core-properties" Target="docProps/core.xml"/></Relationships>`
            )
          ),
          'docProps/core.xml': strToU8(
            `${xmlHeader}<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:title>${title}</dc:title></cp:coreProperties>`
          )
        }
      }

      const plain = withCore('Q&amp;A notes')
      const { result, call } = yield* extractRecorded(plain)

      expect(call.names).not.toContain('docProps/core.xml')
      expect(readDirectly(plain).Props?.Title).toBe('Q&A notes')
      expect(result.metadata.title).toBe('Q&A notes')

      const cdata = yield* extractRecorded(withCore(quadratic))

      expect(cdata.result.metadata.title).toBe('book.xlsx')
    })
  )
})

describe('LibreOffice- and Google-Sheets-shaped workbooks (positive controls)', () => {
  // Hand-written to mirror the parts these applications write (attribute order, `state="visible"`,
  // defined names, LibreOffice's General numFmt 164, Google's numFmts); not produced by the apps.
  const applicationWorkbook = (variant: 'libreoffice' | 'google') => {
    const parts = workbookParts([{ name: 'Sheet1' }])
    const google = variant === 'google'

    parts['xl/workbook.xml'] = strToU8(
      google
        ? `${xmlHeader}<workbook xmlns="${mainNs}" xmlns:r="${relNs}" xmlns:mc="http://schemas.openxmlformats.org/markup-compatibility/2006"><workbookPr/><sheets><sheet state="visible" name="Sheet1" sheetId="1" r:id="rId1"/><sheet state="hidden" name="Lookup" sheetId="2" r:id="rId2"/></sheets><definedNames/><calcPr/></workbook>`
        : `${xmlHeader}<workbook xmlns="${mainNs}" xmlns:r="${relNs}"><fileVersion appName="Calc"/><workbookPr backupFile="false" showObjects="all" date1904="false"/><workbookProtection/><bookViews><workbookView showHorizontalScroll="true" showVerticalScroll="true" showSheetTabs="true" xWindow="0" yWindow="0" windowWidth="16384" windowHeight="8192" tabRatio="500" firstSheet="0" activeTab="0"/></bookViews><sheets><sheet name="Sheet1" sheetId="1" state="visible" r:id="rId1"/><sheet name="Lookup" sheetId="2" state="hidden" r:id="rId2"/></sheets><definedNames><definedName function="false" hidden="true" localSheetId="0" name="_xlnm._FilterDatabase" vbProcedure="false">Sheet1!$A$1:$C$3</definedName></definedNames><calcPr iterateCount="100" refMode="A1" iterate="false" iterateDelta="0.001"/></workbook>`
    )

    parts['xl/_rels/workbook.xml.rels'] = strToU8(
      `${xmlHeader}<Relationships xmlns="${packageRelNs}"><Relationship Id="rId1" Type="${relNs}/worksheet" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Type="${relNs}/worksheet" Target="worksheets/sheet2.xml"/></Relationships>`
    )

    parts['[Content_Types].xml'] = strToU8(
      decode(parts['[Content_Types].xml']).replace(
        '</Types>',
        '<Override PartName="/xl/worksheets/sheet2.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/></Types>'
      )
    )

    parts['xl/worksheets/sheet1.xml'] = worksheet(
      '<row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c><c r="C1" t="s"><v>2</v></c></row><row r="2"><c r="A2" t="s"><v>3</v></c><c r="B2" s="1"><v>45306</v></c><c r="C2" s="2"><v>1499.9</v></c></row><row r="3"><c r="A3" t="s"><v>4</v></c><c r="B3" s="1"><v>45337</v></c><c r="C3" s="3"><v>0.42</v></c></row>',
      'A1:C3'
    )

    parts['xl/worksheets/sheet2.xml'] = worksheet(
      '<row r="1"><c r="A1" t="s"><v>5</v></c></row>',
      'A1'
    )

    const styles = google
      ? `${xmlHeader}<styleSheet xmlns="${mainNs}" xmlns:x14ac="http://schemas.microsoft.com/office/spreadsheetml/2009/9/ac" xmlns:mc="http://schemas.openxmlformats.org/markup-compatibility/2006"><numFmts count="2"><numFmt numFmtId="164" formatCode="yyyy-mm-dd"/><numFmt numFmtId="165" formatCode="[$$]#,##0.00"/></numFmts><fonts count="1"><font><sz val="10.0"/><color rgb="FF000000"/><name val="Arial"/><scheme val="minor"/></font></fonts><fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="lightGray"/></fill></fills><borders count="1"><border/></borders><cellStyleXfs count="1"><xf borderId="0" fillId="0" fontId="0" numFmtId="0" applyAlignment="1" applyFont="1"/></cellStyleXfs><cellXfs count="4"><xf borderId="0" fillId="0" fontId="0" numFmtId="0" xfId="0" applyAlignment="1" applyFont="1"><alignment readingOrder="0" shrinkToFit="0" vertical="bottom" wrapText="0"/></xf><xf borderId="0" fillId="0" fontId="0" numFmtId="164" xfId="0" applyAlignment="1" applyFont="1" applyNumberFormat="1"><alignment readingOrder="0" vertical="bottom"/></xf><xf borderId="0" fillId="0" fontId="0" numFmtId="165" xfId="0" applyAlignment="1" applyFont="1" applyNumberFormat="1"><alignment readingOrder="0" vertical="bottom"/></xf><xf borderId="0" fillId="0" fontId="0" numFmtId="10" xfId="0" applyAlignment="1" applyFont="1" applyNumberFormat="1"><alignment readingOrder="0" vertical="bottom"/></xf></cellXfs><cellStyles count="1"><cellStyle xfId="0" name="Normal" builtinId="0"/></cellStyles><dxfs count="0"/></styleSheet>`
      : `${xmlHeader}<styleSheet xmlns="${mainNs}"><numFmts count="4"><numFmt numFmtId="164" formatCode="General"/><numFmt numFmtId="165" formatCode="DD/MM/YYYY"/><numFmt numFmtId="166" formatCode="[$€-407]\\ #,##0.00;[RED]\\-[$€-407]\\ #,##0.00"/><numFmt numFmtId="167" formatCode="0.00%"/></numFmts><fonts count="1"><font><sz val="10"/><name val="Arial"/><family val="2"/></font></fonts><fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills><borders count="1"><border diagonalUp="false" diagonalDown="false"><left/><right/><top/><bottom/><diagonal/></border></borders><cellStyleXfs count="1"><xf numFmtId="164" fontId="0" fillId="0" borderId="0" applyFont="true" applyBorder="true" applyAlignment="true" applyProtection="true"><alignment horizontal="general" vertical="bottom" textRotation="0" wrapText="false" indent="0" shrinkToFit="false"/><protection locked="true" hidden="false"/></xf></cellStyleXfs><cellXfs count="4"><xf numFmtId="164" fontId="0" fillId="0" borderId="0" xfId="0" applyFont="false" applyBorder="false" applyAlignment="false" applyProtection="false"><alignment horizontal="general" vertical="bottom" textRotation="0" wrapText="false" indent="0" shrinkToFit="false"/><protection locked="true" hidden="false"/></xf><xf numFmtId="165" fontId="0" fillId="0" borderId="0" xfId="0" applyFont="false" applyBorder="false" applyAlignment="false" applyProtection="false"/><xf numFmtId="166" fontId="0" fillId="0" borderId="0" xfId="0" applyFont="false" applyBorder="false" applyAlignment="false" applyProtection="false"/><xf numFmtId="167" fontId="0" fillId="0" borderId="0" xfId="0" applyFont="false" applyBorder="false" applyAlignment="false" applyProtection="false"/></cellXfs><cellStyles count="1"><cellStyle name="Default" xfId="0" builtinId="0"/></cellStyles></styleSheet>`

    const strings = ['Item', 'Date', 'Amount', 'Rent', 'Food &amp; drink', 'lookup']

    return withWorkbookPart(
      withWorkbookPart(parts, 'xl/styles.xml', styles),
      'xl/sharedStrings.xml',
      `${xmlHeader}<sst xmlns="${mainNs}" count="${strings.length}" uniqueCount="${strings.length}">${strings
        .map(text =>
          google ? `<si><t>${text}</t></si>` : `<si><t xml:space="preserve">${text}</t></si>`
        )
        .join('')}</sst>`
    )
  }

  for (const variant of ['libreoffice', 'google'] as const) {
    it.effect(`extracts a ${variant}-shaped workbook like SheetJS`, () =>
      Effect.gen(function* () {
        const parts = applicationWorkbook(variant)
        const direct = readDirectly(parts)
        const { result, call } = yield* extractRecorded(parts)

        expect(result.content).toBe(directCsv(direct))
        expect(result.metadata.sheetNames).toEqual(['Sheet1', 'Lookup'])
        expect(call.workbook.Workbook?.Sheets?.map(sheet => sheet.Hidden)).toEqual([0, 1])
        expect(result.content).toBe(
          variant === 'google'
            ? '# Sheet1\nItem,Date,Amount\nRent,2024-01-15,"$1,499.90"\nFood & drink,2024-02-15,42.00%\n\n# Lookup\nlookup'
            : '# Sheet1\nItem,Date,Amount\nRent,15/01/2024,"€ 1,499.90"\nFood & drink,15/02/2024,42.00%\n\n# Lookup\nlookup'
        )
      })
    )
  }
})
