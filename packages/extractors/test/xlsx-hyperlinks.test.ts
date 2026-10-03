import { describe, expect, it } from '@effect/vitest'
import { Effect } from 'effect'
import { unzipSync } from 'fflate'
import * as XLSX from 'xlsx'
import { makeHyperlinkLookup } from '../src/node/xlsx-hyperlinks.ts'
import type { XlsxHyperlink } from '../src/node/xlsx-hyperlinks.ts'
import type { SheetJsLoader } from '../src/node/sheetjs.ts'
import {
  decode,
  extractWith,
  hyperlinks,
  linkedRangeWorkbook,
  workbook,
  xlsxInput
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

const sawHyperlinkTag = (archives: ReadonlyArray<Uint8Array>) =>
  archives.some(archive =>
    Object.values(unzipSync(archive)).some(part =>
      /<\/?(?:[\w.-]+:)?hyperlink\b/i.test(decode(part))
    )
  )

const external = (id: string, target: string) => ['rId' + id, 'hyperlink', target, true] as const

describe('XLSX hyperlinks', () => {
  it.effect('keeps external links as `text <url>` on the cells they cover', () =>
    Effect.gen(function* () {
      const book = workbook([
        {
          name: 'Sheet1',
          rows: [
            ['Name', 'Site'],
            ['Acme', 'acme.example'],
            ['Beta', 'beta.example'],
            ['Mail', 'write us']
          ],
          afterSheetData: hyperlinks(
            '<hyperlink ref="B2" r:id="rId1"/>',
            '<hyperlink ref="B3" r:id="rId2" location="pricing"/>',
            '<hyperlink ref="B4" r:id="rId3"/>'
          ),
          relationships: [
            external('1', 'https://acme.example/'),
            external('2', 'https://beta.example/a?b=1&c=2'),
            external('3', 'mailto:hello@example.com')
          ]
        }
      ])

      const result = yield* extractWith(xlsxInput(book))

      expect(result.content).toBe(
        [
          '# Sheet1',
          'Name,Site',
          'Acme,acme.example <https://acme.example/>',
          'Beta,beta.example <https://beta.example/a?b=1&c=2#pricing>',
          'Mail,write us <mailto:hello@example.com>'
        ].join('\n')
      )
    })
  )

  it.effect('omits internal locations, non-web schemes, and non-external relationships', () =>
    Effect.gen(function* () {
      const book = workbook([
        {
          name: 'Sheet1',
          rows: [['internal', 'script', 'file', 'part']],
          afterSheetData: hyperlinks(
            '<hyperlink ref="A1" location="Sheet2!A1" display="Go"/>',
            '<hyperlink ref="B1" r:id="rId1"/>',
            '<hyperlink ref="C1" r:id="rId2"/>',
            '<hyperlink ref="D1" r:id="rId3"/>'
          ),
          relationships: [
            external('1', 'javascript:alert(1)'),
            external('2', 'file:///etc/passwd'),
            ['rId3', 'hyperlink', 'https://not-external.example/', false]
          ]
        }
      ])

      const result = yield* extractWith(xlsxInput(book))

      expect(result.content).toBe('# Sheet1\ninternal,script,file,part')
    })
  )

  it.effect('does not repeat a URL the cell already shows, and labels empty cells', () =>
    Effect.gen(function* () {
      const book = workbook([
        {
          name: 'Sheet1',
          rows: [['https://acme.example/', '']],
          afterSheetData: hyperlinks(
            '<hyperlink ref="A1" r:id="rId1"/>',
            '<hyperlink ref="B1" r:id="rId1" display="Acme site"/>'
          ),
          relationships: [external('1', 'https://acme.example/')]
        }
      ])

      const result = yield* extractWith(xlsxInput(book))

      expect(result.content).toBe(
        '# Sheet1\nhttps://acme.example/,Acme site <https://acme.example/>'
      )
    })
  )

  it.effect('lets the later link win where ranges overlap, as SheetJS does', () =>
    Effect.gen(function* () {
      const book = workbook([
        {
          name: 'Sheet1',
          rows: [['a', 'b', 'c']],
          afterSheetData: hyperlinks(
            '<hyperlink ref="A1:C1" r:id="rId1"/>',
            '<hyperlink ref="B1" r:id="rId2"/>'
          ),
          relationships: [
            external('1', 'https://one.example/'),
            external('2', 'https://two.example/')
          ]
        }
      ])

      const result = yield* extractWith(xlsxInput(book))

      expect(result.content).toBe(
        '# Sheet1\na <https://one.example/>,b <https://two.example/>,c <https://one.example/>'
      )
    })
  )

  it.effect('maps links to sheets by workbook relationships, names, and tag prefixes', () =>
    Effect.gen(function* () {
      const book = workbook([
        { name: 'Plain', rows: [['no links']] },
        {
          name: 'R&D <2026>',
          path: 'xl/worksheets/research.data',
          rows: [['paper']],
          afterSheetData:
            '<x:hyperlinks xmlns:x="urn:x"><x:hyperlink ref="A1" rel:id="rId7"/></x:hyperlinks>',
          relationships: [external('7', 'https://papers.example/ä')]
        }
      ])

      const result = yield* extractWith(xlsxInput(book))

      expect(result.metadata.sheetNames).toEqual(['Plain', 'R&D <2026>'])
      expect(result.content).toBe(
        '# Plain\nno links\n\n# R&D <2026>\npaper <https://papers.example/%C3%A4>'
      )
    })
  )

  for (const ref of ['A1:XFD1048576', 'B1:B1048576', 'A1:Z100000']) {
    it.effect(`annotates existing cells under ${ref}; SheetJS never sees the tag`, () =>
      Effect.gen(function* () {
        const seen: Array<Uint8Array> = []

        const result = yield* extractWith(xlsxInput(linkedRangeWorkbook(ref, true)), {
          loadSheetJs: recordingSheetJs(seen)
        })

        expect(seen).toHaveLength(1)
        expect(sawHyperlinkTag(seen)).toBe(false)

        const link = '<https://range.example/>'

        expect(result.content).toBe(
          ref.startsWith('B')
            ? `# Sheet1\nName,Site ${link}\nAcme,acme.example ${link}`
            : `# Sheet1\nName ${link},Site ${link}\nAcme ${link},acme.example ${link}`
        )
      })
    )

    it.effect(`drops internal ${ref} links without expanding them`, () =>
      Effect.gen(function* () {
        const seen: Array<Uint8Array> = []

        const result = yield* extractWith(xlsxInput(linkedRangeWorkbook(ref)), {
          loadSheetJs: recordingSheetJs(seen)
        })

        expect(sawHyperlinkTag(seen)).toBe(false)
        expect(result.content).toBe('# Sheet1\nName,Site\nAcme,acme.example')
      })
    )
  }

  it.effect('keeps output within the budget and marks dropped annotations', () =>
    Effect.gen(function* () {
      const rows = Array.from({ length: 20 }, (_, index) => [`row ${index}`])

      const book = workbook([
        {
          name: 'Sheet1',
          rows,
          afterSheetData: hyperlinks('<hyperlink ref="A1:A20" r:id="rId1"/>'),
          relationships: [external('1', `https://example.com/${'x'.repeat(60)}`)]
        }
      ])

      const maxXlsxTextCharacters = 600

      const result = yield* extractWith(xlsxInput(book), { limits: { maxXlsxTextCharacters } })

      expect(result.content.length).toBeLessThanOrEqual(maxXlsxTextCharacters)
      expect(result.content).toContain('row 0 <https://example.com/')
      expect(result.content).toContain('\nrow 19\n')
      expect(result.content.endsWith('[Some hyperlinks omitted: output limit]')).toBe(true)
    })
  )

  it.effect('caps a huge display label at parse time before labelling empty cells', () =>
    Effect.gen(function* () {
      const size = 20
      const rows = Array.from({ length: size }, () => Array.from({ length: size }, () => ''))

      const book = workbook([
        {
          name: 'Sheet1',
          rows,
          afterSheetData: hyperlinks(
            `<hyperlink ref="A1:T20" r:id="rId1" display="${'d'.repeat(1024 * 1024)}"/>`
          ),
          relationships: [external('1', 'https://label.example/')]
        }
      ])

      const result = yield* extractWith(xlsxInput(book))
      const cell = `${'d'.repeat(1023)}\u2026 <https://label.example/>`
      const row = Array.from({ length: size }, () => cell).join(',')

      expect(result.content).toBe(`# Sheet1\n${Array.from({ length: size }, () => row).join('\n')}`)
    })
  )

  it.effect('reads attributes in one pass over a long run of name characters', () =>
    Effect.gen(function* () {
      // Retrying an attribute name from every position of this run would take ~5e10 steps.
      const book = workbook([
        {
          name: 'Sheet1',
          rows: [['site']],
          afterSheetData: hyperlinks(`<hyperlink ref="A1" r:id="rId1" ${'a'.repeat(300_000)}/>`),
          relationships: [external('1', 'https://run.example/')]
        }
      ])

      const result = yield* extractWith(xlsxInput(book))

      expect(result.content).toBe('# Sheet1\nsite <https://run.example/>')
    })
  )

  it.effect('drops links whose target exceeds 2,048 characters', () =>
    Effect.gen(function* () {
      const book = workbook([
        {
          name: 'Sheet1',
          rows: [['short', 'long']],
          afterSheetData: hyperlinks(
            '<hyperlink ref="A1" r:id="rId1"/>',
            `<hyperlink ref="B1" r:id="rId1" location="${'x'.repeat(2048)}"/>`
          ),
          relationships: [external('1', 'https://target.example/')]
        }
      ])

      const result = yield* extractWith(xlsxInput(book))

      expect(result.content).toBe('# Sheet1\nshort <https://target.example/>,long')
    })
  )

  it.effect('marks links beyond the per-workbook hyperlink cap', () =>
    Effect.gen(function* () {
      const book = workbook([
        {
          name: 'Sheet1',
          rows: [['a', 'b', 'c']],
          afterSheetData: hyperlinks(
            '<hyperlink ref="A1" r:id="rId1"/>',
            '<hyperlink ref="B1" r:id="rId1"/>',
            '<hyperlink ref="C1" r:id="rId1"/>'
          ),
          relationships: [external('1', 'https://one.example/')]
        }
      ])

      const result = yield* extractWith(xlsxInput(book), { limits: { maxXlsxHyperlinks: 2 } })

      expect(result.content).toBe(
        '# Sheet1\na <https://one.example/>,b <https://one.example/>,c\n\n[Some hyperlinks omitted: hyperlink limit]'
      )
    })
  )

  it.effect('handles thousands of links on one sheet with an indexed lookup', () =>
    Effect.gen(function* () {
      const count = 10_000
      const rows = Array.from({ length: count }, (_, index) => [`r${index}`])

      const tags = Array.from(
        { length: count },
        (_, index) => `<hyperlink ref="A${index + 1}:A${count}" r:id="rId1"/>`
      )

      const book = workbook([
        {
          name: 'Sheet1',
          rows,
          afterSheetData: hyperlinks(...tags),
          relationships: [external('1', 'https://many.example/')]
        }
      ])

      const result = yield* extractWith(xlsxInput(book))

      expect(result.content.split('\n')).toHaveLength(count + 1)
      expect(result.content).toContain('\nr9999 <https://many.example/>')
    })
  )
})

describe('makeHyperlinkLookup', () => {
  const link = (r0: number, c0: number, r1: number, c1: number, target: string): XlsxHyperlink => ({
    range: { start: { r: r0, c: c0 }, end: { r: r1, c: c1 } },
    target
  })

  it('matches a brute-force scan for random overlapping ranges', () => {
    let seed = 7

    const random = (max: number) => {
      seed = (seed * 1_103_515_245 + 12_345) % 2_147_483_648

      return seed % max
    }

    for (let round = 0; round < 50; round += 1) {
      const visited = { start: { r: random(5), c: random(5) }, end: { r: 0, c: 0 } }
      const end = { r: visited.start.r + random(12), c: visited.start.c + random(12) }
      const range = { start: visited.start, end }

      const links = Array.from({ length: random(30) }, (_, index) => {
        const r0 = random(20)
        const c0 = random(20)

        return link(r0, c0, r0 + random(8), c0 + random(8), `https://${index}.example/`)
      })

      const lookup = makeHyperlinkLookup(links, range)

      for (let row = range.start.r; row <= range.end.r; row += 1) {
        for (let column = range.start.c; column <= range.end.c; column += 1) {
          const expected = links.findLast(
            candidate =>
              row >= candidate.range.start.r &&
              row <= candidate.range.end.r &&
              column >= candidate.range.start.c &&
              column <= candidate.range.end.c
          )

          expect(lookup.at(row, column)).toBe(expected)
        }
      }
    }
  })
})
