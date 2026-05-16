import { strToU8, zipSync } from 'fflate'
import * as XLSX from 'xlsx'
import { Effect } from 'effect'
import { describe, expect, it } from '@effect/vitest'
import { FileExtractor } from './live-layer'

const encode = (text: string) => new TextEncoder().encode(text)
const zipText = (text: string) => Uint8Array.from(strToU8(text))

const extract = (input: {
  readonly filename: string
  readonly mediaType: string
  readonly bytes: Uint8Array
}) =>
  Effect.gen(function* () {
    const extractor = yield* FileExtractor
    return yield* extractor.extract(input)
  }).pipe(Effect.provide(FileExtractor.layer))

describe('FileExtractor', () => {
  it.effect('extracts and sanitizes text files', () =>
    Effect.gen(function* () {
      const extracted = yield* extract({
        filename: 'notes.txt',
        mediaType: 'text/plain',
        bytes: encode('  Alpha\r\n\r\n\r\nBeta   gamma....  ')
      })

      expect(extracted.content).toBe('Alpha\n\nBeta gamma…')
      expect(extracted.metadata).toEqual({ format: 'text', title: 'notes.txt' })
    }))

  it.effect('extracts xlsx sheets as csv sections', () =>
    Effect.gen(function* () {
      const workbook = XLSX.utils.book_new()
      const sheet = XLSX.utils.aoa_to_sheet([
        ['Name', 'Count'],
        ['Alpha', 2]
      ])
      XLSX.utils.book_append_sheet(workbook, sheet, 'Inventory')
      const bytes = XLSX.write(workbook, { bookType: 'xlsx', type: 'array' })

      const extracted = yield* extract({
        filename: 'inventory.xlsx',
        mediaType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        bytes
      })

      expect(extracted.content).toContain('# Inventory')
      expect(extracted.content).toContain('Name,Count')
      expect(extracted.content).toContain('Alpha,2')
      expect(extracted.metadata.sheetNames).toEqual(['Inventory'])
    }))

  it.effect('extracts pptx slide and notes text', () =>
    Effect.gen(function* () {
      const bytes = zipSync({
        'ppt/slides/slide2.xml': zipText('<a:p><a:r><a:t>Second</a:t></a:r></a:p>'),
        'ppt/slides/slide1.xml': zipText('<a:p><a:r><a:t>First &amp; one</a:t></a:r></a:p>'),
        'ppt/notesSlides/notesSlide1.xml': zipText('<a:p><a:r><a:t>Speaker note</a:t></a:r></a:p>')
      })

      const extracted = yield* extract({
        filename: 'deck.pptx',
        mediaType: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
        bytes
      })

      expect(extracted.content).toBe('First & one\n\nSecond\n\nSpeaker note')
      expect(extracted.metadata.format).toBe('pptx')
    }))

  it.effect('rejects unsupported files', () =>
    Effect.gen(function* () {
      const error = yield* extract({
        filename: 'archive.zip',
        mediaType: 'application/zip',
        bytes: encode('zip')
      }).pipe(Effect.flip)

      expect(error._tag).toBe('UnsupportedFileFormatError')
    }))
})
