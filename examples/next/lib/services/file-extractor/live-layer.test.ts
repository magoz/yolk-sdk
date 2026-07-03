import { strToU8, zipSync } from 'fflate'
import * as XLSX from 'xlsx'
import { Effect } from 'effect'
import { describe, expect, it } from '@effect/vitest'
import { FileExtractor } from './live-layer'

const encode = (text: string) => new TextEncoder().encode(text)
const zipText = (text: string) => Uint8Array.from(strToU8(text))

const makeDocx = (text: string) =>
  zipSync({
    '[Content_Types].xml': zipText(
      '<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>'
    ),
    '_rels/.rels': zipText(
      '<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>'
    ),
    'word/document.xml': zipText(
      `<?xml version="1.0" encoding="UTF-8"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>${text}</w:t></w:r></w:p></w:body></w:document>`
    )
  })

const makePdf = (text: string) => {
  const stream = `BT /F1 24 Tf 72 720 Td (${text}) Tj ET`
  const objects = [
    '1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj',
    '2 0 obj<</Type/Pages/Count 1/Kids[3 0 R]>>endobj',
    '3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 612 792]/Contents 4 0 R/Resources<</Font<</F1 5 0 R>>>>>>endobj',
    `4 0 obj<</Length ${stream.length}>>stream\n${stream}\nendstream endobj`,
    '5 0 obj<</Type/Font/Subtype/Type1/BaseFont/Helvetica>>endobj'
  ]
  let body = '%PDF-1.4\n'
  const offsets: Array<number> = []

  for (const object of objects) {
    offsets.push(body.length)
    body += `${object}\n`
  }

  const startXref = body.length
  const rows = [
    '0000000000 65535 f ',
    ...offsets.map(offset => `${offset.toString().padStart(10, '0')} 00000 n `)
  ]

  return encode(
    `${body}xref\n0 6\n${rows.join('\n')}\ntrailer<</Size 6/Root 1 0 R>>\nstartxref\n${startXref}\n%%EOF`
  )
}

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
    })
  )

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
    })
  )

  it.effect('extracts pdf text and page count', () =>
    Effect.gen(function* () {
      const extracted = yield* extract({
        filename: 'paper.pdf',
        mediaType: 'application/pdf',
        bytes: makePdf('Hello PDF')
      })

      expect(extracted.content).toBe('Hello PDF')
      expect(extracted.metadata.format).toBe('pdf')
      expect(extracted.metadata.pageCount).toBe(1)
    })
  )

  it.effect('extracts docx text', () =>
    Effect.gen(function* () {
      const extracted = yield* extract({
        filename: 'brief.docx',
        mediaType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        bytes: makeDocx('Hello DOCX')
      })

      expect(extracted.content).toBe('Hello DOCX')
      expect(extracted.metadata).toEqual({ format: 'docx', title: 'brief.docx' })
    })
  )

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
    })
  )

  it.effect('rejects unsupported files', () =>
    Effect.gen(function* () {
      const error = yield* extract({
        filename: 'archive.zip',
        mediaType: 'application/zip',
        bytes: encode('zip')
      }).pipe(Effect.flip)

      expect(error._tag).toBe('UnsupportedFileFormatError')
    })
  )
})
