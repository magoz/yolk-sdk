import { describe, expect, it } from '@effect/vitest'
import { Cause, Effect, Exit } from 'effect'
import { unzipSync, zipSync } from 'fflate'
import * as XLSX from 'xlsx'
import {
  FileExtractionError,
  fileFormatFor,
  sheetJsInstallCommand,
  SheetJsUnavailableError,
  UnsupportedFileFormatError
} from '../src/index.ts'
import { minimumXlsxTextCharacters } from '../src/limits.ts'
import { withAcquiredPdfDocument } from '../src/node/extract-file.ts'
import { omittedHyperlinksMarkerReserve } from '../src/node/xlsx-text.ts'
import {
  docxMediaType,
  encode,
  expectAllowlisted,
  extractWith,
  makeDocx,
  makePdf,
  makePptx,
  pptxMediaType,
  recordingSheetJs,
  workbookParts,
  xlsxInput,
  zipParts,
  zipText
} from './fixtures.ts'
import type { SheetJsCall } from './fixtures.ts'

const sheetJsBytes = () => {
  const workbook = XLSX.utils.book_new()

  const sheet = XLSX.utils.aoa_to_sheet([
    ['Name', 'Count'],
    ['Alpha', 2]
  ])

  XLSX.utils.book_append_sheet(workbook, sheet, 'Inventory')

  const written: unknown = XLSX.write(workbook, { bookType: 'xlsx', type: 'array' })

  if (!(written instanceof ArrayBuffer)) throw new Error('Expected XLSX fixture')

  return new Uint8Array(written)
}

describe('FileExtractor', () => {
  it.effect('extracts and sanitizes text files', () =>
    Effect.gen(function* () {
      const extracted = yield* extractWith({
        filename: 'notes.txt',
        mediaType: 'text/plain',
        bytes: encode('  Alpha\r\n\r\n\r\nBeta   gamma....  ')
      })

      expect(extracted.content).toBe('Alpha\n\nBeta gamma…')
      expect(extracted.metadata).toEqual({ format: 'text', title: 'notes.txt' })
    })
  )

  it.effect('extracts xlsx sheets as csv sections', () =>
    Effect.gen(function* () {
      const extracted = yield* extractWith(xlsxInput(sheetJsBytes(), 'inventory.xlsx'))

      expect(extracted.content).toBe('# Inventory\nName,Count\nAlpha,2')
      expect(extracted.metadata).toEqual({
        format: 'xlsx',
        title: 'inventory.xlsx',
        sheetNames: ['Inventory']
      })
    })
  )

  it.effect('extracts pdf text and page count without detaching the caller bytes', () =>
    Effect.gen(function* () {
      const bytes = makePdf('Hello PDF')

      const extracted = yield* extractWith({
        filename: 'paper.pdf',
        mediaType: 'application/pdf',
        bytes
      })

      expect(extracted.content).toBe('Hello PDF')
      expect(extracted.metadata.format).toBe('pdf')
      expect(extracted.metadata.pageCount).toBe(1)
      expect(bytes.byteLength).toBeGreaterThan(0)
    })
  )

  it.effect('extracts docx text', () =>
    Effect.gen(function* () {
      const extracted = yield* extractWith({
        filename: 'brief.docx',
        mediaType: docxMediaType,
        bytes: makeDocx('Hello DOCX')
      })

      expect(extracted.content).toBe('Hello DOCX')
      expect(extracted.metadata).toEqual({ format: 'docx', title: 'brief.docx' })
    })
  )

  it.effect('extracts pptx slide and notes text', () =>
    Effect.gen(function* () {
      const extracted = yield* extractWith({
        filename: 'deck.pptx',
        mediaType: pptxMediaType,
        bytes: makePptx()
      })

      expect(extracted.content).toBe('First & one\n\nSecond\n\nSpeaker note')
      expect(extracted.metadata.format).toBe('pptx')
    })
  )

  it.effect('reads PPTX text in one pass over unterminated tags', () =>
    Effect.gen(function* () {
      // 100k unterminated starts per element: a pattern scanning past the next `<`, or a lazy
      // match retried from every start, would do ~1e10 steps here.
      const runs = ['<a:p ', '<a:t ', '<a:br ', '<a:p>', '<a:t>'].map(tag => tag.repeat(100_000))

      const deck = zipSync({
        '[Content_Types].xml': zipText('<Types/>'),
        'ppt/presentation.xml': zipText('<p:presentation/>'),
        'ppt/slides/slide1.xml': zipText(runs.join('')),
        'ppt/slides/slide2.xml': zipText('<a:p><a:r><a:t>Second</a:t></a:r></a:p>')
      })

      const extracted = yield* extractWith({
        filename: 'deck.pptx',
        mediaType: pptxMediaType,
        bytes: deck
      })

      expect(extracted.content).toBe('Second')
    })
  )

  it.effect('rejects OOXML archives missing the content types or main part', () =>
    Effect.gen(function* () {
      const error = yield* extractWith({
        filename: 'deck.pptx',
        mediaType: pptxMediaType,
        bytes: zipSync({ 'ppt/slides/slide1.xml': zipText('<a:t>x</a:t>') })
      }).pipe(Effect.flip)

      expect(error).toEqual(
        new FileExtractionError({
          message: 'Invalid Office archive.',
          format: 'pptx',
          cause: expect.anything()
        })
      )
    })
  )

  it.effect('stops a DOCX zip bomb before mammoth reads it', () =>
    Effect.gen(function* () {
      const bomb = zipSync({
        '[Content_Types].xml': zipText('<Types/>'),
        'word/document.xml': new Uint8Array(80 * 1024 * 1024)
      })

      const error = yield* extractWith({
        filename: 'bomb.docx',
        mediaType: docxMediaType,
        bytes: bomb
      }).pipe(Effect.flip)

      expect(error.message).toContain('expansion exceeds')
    })
  )

  it.effect('rejects files over the input byte limit for every format', () =>
    Effect.gen(function* () {
      const error = yield* extractWith(
        { filename: 'big.txt', mediaType: 'text/plain', bytes: encode('x'.repeat(11)) },
        { limits: { maxInputBytes: 10 } }
      ).pipe(Effect.flip)

      expect(error).toEqual(
        new FileExtractionError({
          message: 'File exceeds the extraction size limit',
          format: 'text'
        })
      )
    })
  )

  it.effect('fails empty content', () =>
    Effect.gen(function* () {
      const error = yield* extractWith({
        filename: 'blank.md',
        mediaType: 'text/markdown',
        bytes: encode(' \n\t ')
      }).pipe(Effect.flip)

      expect(error.message).toBe('Extracted file content is empty')
    })
  )

  it.effect('rejects unsupported files', () =>
    Effect.gen(function* () {
      const error = yield* extractWith({
        filename: 'archive.zip',
        mediaType: 'application/zip',
        bytes: encode('zip')
      }).pipe(Effect.flip)

      expect(error).toEqual(
        new UnsupportedFileFormatError({ filename: 'archive.zip', mediaType: 'application/zip' })
      )
      expect(error.message).toBe('Unsupported file format: archive.zip')
    })
  )

  it.effect('treats invalid limits as a defect when the layer is built', () =>
    Effect.gen(function* () {
      const exit = yield* extractWith(
        { filename: 'a.txt', mediaType: 'text/plain', bytes: encode('a') },
        { limits: { maxXlsxCellVisits: 0 } }
      ).pipe(Effect.exit)

      expect(Exit.isFailure(exit) && Cause.hasDies(exit.cause)).toBe(true)
    })
  )

  it.effect('treats an XLSX text limit too small for the omitted-links marker as a defect', () =>
    Effect.gen(function* () {
      const input = { filename: 'a.txt', mediaType: 'text/plain', bytes: encode('a') }

      const tooSmall = yield* extractWith(input, {
        limits: { maxXlsxTextCharacters: omittedHyperlinksMarkerReserve }
      }).pipe(Effect.exit)

      expect(Exit.isFailure(tooSmall) && Cause.hasDies(tooSmall.cause)).toBe(true)

      const smallest = yield* extractWith(input, {
        limits: { maxXlsxTextCharacters: omittedHyperlinksMarkerReserve + 1 }
      })

      expect(smallest.content).toBe('a')
      expect(minimumXlsxTextCharacters).toBe(omittedHyperlinksMarkerReserve + 1)
    })
  )
})

describe('SheetJS loading', () => {
  const missingModule = () =>
    Promise.reject(
      Object.assign(new Error("Cannot find package 'xlsx'"), { code: 'ERR_MODULE_NOT_FOUND' })
    )

  it.effect('reports a missing SheetJS with the CDN install command', () =>
    Effect.gen(function* () {
      const error = yield* extractWith(xlsxInput(sheetJsBytes()), {
        loadSheetJs: missingModule
      }).pipe(Effect.flip)

      expect(error._tag).toBe('SheetJsUnavailableError')
      expect(error instanceof SheetJsUnavailableError && error.reason).toBe('missing')
      expect(error.message).toContain(sheetJsInstallCommand)
    })
  )

  it.effect('refuses SheetJS releases older than 0.20.3', () =>
    Effect.gen(function* () {
      for (const version of ['0.18.5', '0.19.3', '0.20.2']) {
        const error = yield* extractWith(xlsxInput(sheetJsBytes()), {
          loadSheetJs: async () => ({ version, read: XLSX.read })
        }).pipe(Effect.flip)

        expect(error.message).toContain(`SheetJS ${version} is older than 0.20.3`)
      }
    })
  )

  it.effect('refuses prereleases of 0.20.3 and fails closed on malformed versions', () =>
    Effect.gen(function* () {
      const refused = [
        ['0.20.3-rc.0', 'outdated'],
        ['0.20.3-0', 'outdated'],
        ['0.20.3junk', 'invalid'],
        ['0.20.3.1', 'invalid'],
        ['v0.20.3', 'invalid'],
        ['00.20.3', 'invalid'],
        ['0.20.3-', 'invalid'],
        ['1.0', 'invalid'],
        ['', 'invalid']
      ] as const

      for (const [version, reason] of refused) {
        const error = yield* extractWith(xlsxInput(sheetJsBytes()), {
          loadSheetJs: async () => ({ version, read: XLSX.read })
        }).pipe(Effect.flip)

        expect([version, error instanceof SheetJsUnavailableError && error.reason]).toEqual([
          version,
          reason
        ])
      }
    })
  )

  it.effect('accepts 0.20.3 and later releases, build metadata, and later prereleases', () =>
    Effect.gen(function* () {
      for (const version of ['0.20.3', '0.20.3+build.7', '0.20.4', '0.21.0-rc.1', '1.0.0']) {
        const result = yield* extractWith(xlsxInput(sheetJsBytes()), {
          loadSheetJs: async () => ({ version, read: XLSX.read })
        })

        expect(result.content).toContain('Alpha,2')
      }
    })
  )

  it.effect('accepts newer SheetJS releases and CommonJS-style default exports', () =>
    Effect.gen(function* () {
      const result = yield* extractWith(xlsxInput(sheetJsBytes()), {
        loadSheetJs: async () => ({ default: { version: '0.21.0', read: XLSX.read } })
      })

      expect(result.content).toContain('Alpha,2')
    })
  )

  it.effect('refuses modules that are not SheetJS', () =>
    Effect.gen(function* () {
      const error = yield* extractWith(xlsxInput(sheetJsBytes()), {
        loadSheetJs: async () => ({ read: 'nope' })
      }).pipe(Effect.flip)

      expect(error instanceof SheetJsUnavailableError && error.reason).toBe('invalid')
    })
  )

  it.effect('never loads SheetJS for other formats', () =>
    Effect.gen(function* () {
      const result = yield* extractWith(
        { filename: 'a.csv', mediaType: 'text/csv', bytes: encode('a,b') },
        { loadSheetJs: missingModule }
      )

      expect(result.content).toBe('a,b')
    })
  )

  it.effect('does not let a crafted comment pollute Object.prototype (CVE-2023-30533)', () =>
    Effect.gen(function* () {
      // SheetJS before 0.19.3 inserted comments with `sheet[ref]`, so `ref="__proto__"` made
      // `Object.prototype.c` a comment list. Comments never reach SheetJS now, and 0.20.3 itself
      // is checked separately on the crafted file.
      const parts = workbookParts([
        {
          name: 'Sheet1',
          rows: [['safe']],
          relationships: [['rId9', 'comments', '../comments1.xml', false]]
        }
      ])

      parts['xl/comments1.xml'] = zipText(
        '<?xml version="1.0"?><comments xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><authors><author>a</author></authors><commentList><comment ref="__proto__" authorId="0"><text><t>polluted</t></text></comment></commentList></comments>'
      )

      const calls: Array<SheetJsCall> = []

      const result = yield* extractWith(xlsxInput(zipParts(parts)), {
        loadSheetJs: recordingSheetJs(calls)
      })

      expect(result.content).toBe('# Sheet1\nsafe')
      expect(calls).toHaveLength(1)
      expectAllowlisted(calls[0]?.names ?? [])

      // The crafted comment and the worksheet relationship naming it never reach SheetJS.
      const handed = Object.values(unzipSync(calls[0]?.bytes ?? new Uint8Array()))

      expect(handed.some(part => new TextDecoder().decode(part).includes('__proto__'))).toBe(false)
      expect(Object.hasOwn(Object.prototype, 'c')).toBe(false)

      // SheetJS 0.20.3 on its own: parsing the crafted file directly does not pollute either.
      const direct = XLSX.read(zipParts(parts), { type: 'array' })

      expect(direct.Sheets.Sheet1?.A1?.v).toBe('safe')
      expect(Object.getOwnPropertyNames(Object.prototype)).not.toContain('c')
      expect(Object.hasOwn(Object.prototype, 'c')).toBe(false)
    })
  )
})

describe('fileFormatFor', () => {
  it.each([
    ['notes.TXT', '', 'text'],
    ['a.md', '', 'markdown'],
    ['a.markdown', '', 'markdown'],
    ['a.csv', '', 'csv'],
    ['a.json', '', 'json'],
    ['a.pdf', '', 'pdf'],
    ['a.docx', '', 'docx'],
    ['a.xlsx', '', 'xlsx'],
    ['a.pptx', '', 'pptx'],
    ['download', 'application/pdf', 'pdf'],
    ['download', 'text/x-log', 'text'],
    ['report.pdf', 'text/plain', 'pdf']
  ])('maps %s (%s) to %s', (filename, mediaType, format) => {
    expect(fileFormatFor({ filename, mediaType })).toBe(format)
  })

  it('returns undefined for unsupported files', () => {
    expect(fileFormatFor({ filename: 'a.zip', mediaType: 'application/zip' })).toBeUndefined()
    expect(fileFormatFor({ filename: 'old.xls', mediaType: '' })).toBeUndefined()
  })
})

describe('PDF extraction lifecycle', () => {
  it.effect('destroys documents after both successful and failed extraction', () =>
    Effect.gen(function* () {
      let destroyCount = 0

      const open = Effect.succeed({
        loadingTask: {
          destroy: async () => {
            destroyCount += 1
          }
        }
      })

      expect(yield* withAcquiredPdfDocument(open, () => Effect.succeed('PDF text'), 'pdf')).toBe(
        'PDF text'
      )

      const failed = yield* withAcquiredPdfDocument(
        open,
        () =>
          Effect.fail(
            new FileExtractionError({ message: 'private parser payload', format: 'pdf' })
          ),
        'pdf'
      ).pipe(Effect.exit)

      expect(Exit.isFailure(failed)).toBe(true)
      expect(destroyCount).toBe(2)
    })
  )
})
