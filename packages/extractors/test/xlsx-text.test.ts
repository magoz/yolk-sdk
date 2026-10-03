import { describe, expect, it } from 'vitest'
import { defaultFileExtractorLimits } from '../src/limits.ts'
import { extractBoundedXlsxText } from '../src/node/xlsx-text.ts'
import type { XlsxWorkbook } from '../src/node/xlsx-text.ts'

const limits = defaultFileExtractorLimits

const workbook = (...sheets: ReadonlyArray<object>): XlsxWorkbook => ({
  SheetNames: sheets.map((_, index) => `Sheet${index + 1}`),
  Sheets: Object.fromEntries(sheets.map((sheet, index) => [`Sheet${index + 1}`, sheet]))
})

const unreadableSheet = (ref: string) =>
  Object.defineProperty({ '!ref': ref }, 'A1', {
    get: () => {
      throw new Error('CSV cell iteration must not start')
    }
  })

const extract = (book: XlsxWorkbook) => extractBoundedXlsxText(book, limits)

describe('bounded XLSX extraction', () => {
  it('rejects the full Excel grid without visiting cells', () => {
    expect(() => extract(workbook(unreadableSheet('A1:XFD1048576')))).toThrow('cell-visit limit')
  })

  it('preflights the aggregate across all sheets before visiting the first cell', () => {
    expect(limits.maxXlsxCellVisits).toBe(100_000)
    expect(() =>
      extract(workbook(...Array.from({ length: 3 }, () => unreadableSheet('A1:CV500'))))
    ).toThrow('cell-visit limit')
    expect(() =>
      extract(workbook(...Array.from({ length: limits.maxXlsxSheets + 1 }, () => ({}))))
    ).toThrow('worksheet or cell-visit limit')
  })

  it('applies configured limits', () => {
    expect(() =>
      extractBoundedXlsxText(workbook(unreadableSheet('A1:B2')), {
        ...limits,
        maxXlsxCellVisits: 3
      })
    ).toThrow('cell-visit limit')
  })

  it.each([
    'A0',
    'A1:',
    'A1:B0',
    'B2:A1',
    'AAAA1',
    'XFE1',
    'A1048577',
    'A1:A9007199254740993',
    'A1:Infinity',
    '1:1048576',
    'A1:B2:C3',
    'A1'.repeat(100)
  ])('rejects invalid/overflowed range %s', ref => {
    expect(() => extract(workbook(unreadableSheet(ref)))).toThrow('Invalid XLSX worksheet range')
  })

  it('accepts finite nonzero-origin ranges at Excel bounds without scanning preceding cells', () => {
    expect(
      extract(workbook({ '!ref': 'XFD1048576', XFD1048576: { t: 's', v: 'last cell' } }))
    ).toContain('last cell')
  })

  it('preserves readable displayed values and bounded CSV quoting', () => {
    expect(
      extract(
        workbook({
          '!ref': 'A1:C2',
          A1: { t: 's', v: 'a,b' },
          B1: { t: 's', v: 'quoted "text"' },
          C1: { t: 'n', v: 42 },
          A2: { t: 'b', v: true },
          B2: { t: 's', v: 'line\nbreak' },
          C2: { t: 'n', v: 0.5, w: '50%' }
        })
      )
    ).toBe('# Sheet1\n"a,b","quoted ""text""",42\nTRUE,"line\nbreak",50%')
  })

  it('writes formulas without cached values and skips stub cells', () => {
    expect(
      extract(
        workbook({
          '!ref': 'A1:C1',
          A1: { t: 'n', f: 'SUM(B1:C1)' },
          B1: { t: 'z' },
          C1: { t: 'd', v: new Date(Date.UTC(2026, 0, 2)) }
        })
      )
    ).toBe('# Sheet1\n=SUM(B1:C1),,2026-01-02T00:00:00.000Z')
  })

  it('rejects non-finite numeric cells and keeps Infinity out of CSV', () => {
    expect(() => extract(workbook({ '!ref': 'A1', A1: { t: 'n', v: Number.NaN } }))).toThrow(
      'Invalid XLSX cell value'
    )
    expect(() => extract(workbook({ '!ref': 'A1', A1: { t: 'n', v: Infinity } }))).toThrow(
      'Invalid XLSX cell value'
    )
  })

  it('ignores cells inherited through a polluted prototype', () => {
    const sheet = Object.create({ A1: { t: 's', v: 'inherited' } })
    sheet['!ref'] = 'A1'

    expect(extract(workbook(sheet))).toBe('# Sheet1\n')
  })

  it('rejects huge cell text before allocating escaped copies', () => {
    expect(() =>
      extract(
        workbook({ '!ref': 'A1', A1: { t: 's', v: '"'.repeat(limits.maxXlsxTextCharacters) } })
      )
    ).toThrow('text exceeds the output limit')
  })

  it('counts CSV quote expansion against the budget before generating it', () => {
    expect(() =>
      extract(
        workbook({ '!ref': 'A1', A1: { t: 's', v: '"'.repeat(limits.maxXlsxTextCharacters / 2) } })
      )
    ).toThrow('text exceeds the output limit')
  })

  it('stops generation once aggregate text would exceed the cap, before later cells', () => {
    let visited = 0
    const sheet = { '!ref': 'A1:A1000' }

    for (let row = 1; row <= 1000; row += 1) {
      Object.defineProperty(sheet, `A${row}`, {
        get: () => {
          visited += 1

          if (row >= 300) throw new Error('Must stop before reaching row 300')

          return { t: 's', v: 'x'.repeat(2000) }
        }
      })
    }

    expect(() => extract(workbook(sheet))).toThrow('text exceeds the output limit')
    expect(visited).toBeGreaterThan(0)
    expect(visited).toBeLessThan(300)
  })
})
