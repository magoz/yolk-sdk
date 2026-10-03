import { Buffer } from 'node:buffer'
import { expect } from '@effect/vitest'
import { strToU8, unzipSync, zipSync } from 'fflate'
import { Effect } from 'effect'
import * as XLSX from 'xlsx'
import { FileExtractor } from '../src/service.ts'
import type { FileInput } from '../src/format.ts'
import { makeFileExtractorLayer } from '../src/node/live-layer.ts'
import type { FileExtractorOptions } from '../src/node/live-layer.ts'
import type { FileExtractorLimits } from '../src/limits.ts'
import type { SheetJsLoader } from '../src/node/sheetjs.ts'
import { isSheetJsInputName } from '../src/node/xlsx-sheetjs-input.ts'

export const xlsxMediaType = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'

export const encode = (text: string) => new TextEncoder().encode(text)

export const decode = (bytes: Uint8Array | undefined) => new TextDecoder().decode(bytes)

/**
 * The worker entry from source, run with Node's type stripping. Worker tests pass it as
 * `workerUrl` so they exercise the code under test; the layer's default is the built
 * `dist/node/extraction-worker.mjs`, covered by `pnpm packages:smoke`.
 */
export const sourceWorkerUrl = new URL('../src/node/extraction-worker.ts', import.meta.url)

/**
 * Extract through the Node layer. Parsing runs in the test thread (`isolation: 'none'`) unless
 * the options choose a worker, so the recording SheetJS loader can observe every call;
 * `test/extraction-worker.test.ts` covers the worker.
 */
export const extractWith = (input: FileInput, options: FileExtractorOptions = {}) =>
  Effect.gen(function* () {
    const extractor = yield* FileExtractor

    return yield* extractor.extract(input)
  }).pipe(Effect.provide(makeFileExtractorLayer({ isolation: 'none', ...options })))

export const xlsxInput = (bytes: Uint8Array, filename = 'book.xlsx'): FileInput => ({
  filename,
  mediaType: xlsxMediaType,
  bytes
})

const xmlHeader = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'

const mainNs = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main'

const relNs = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships'

const packageRelNs = 'http://schemas.openxmlformats.org/package/2006/relationships'

export type FixtureSheet = {
  readonly name: string
  /** Rows of inline string cells starting at A1; `undefined` leaves a cell absent. */
  readonly rows?: ReadonlyArray<ReadonlyArray<string | undefined>>
  /** Raw XML placed after `</sheetData>` (for example `<hyperlinks>…</hyperlinks>`). */
  readonly afterSheetData?: string
  /** Worksheet relationships as `[id, type suffix, target, external]`. */
  readonly relationships?: ReadonlyArray<readonly [string, string, string, boolean]>
  /** Override the worksheet part path (default `xl/worksheets/sheet<n>.xml`). */
  readonly path?: string
}

const escapeXml = (text: string) =>
  text.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')

const columnName = (index: number) => {
  let name = ''
  let remaining = index + 1

  while (remaining > 0) {
    name = String.fromCharCode(65 + ((remaining - 1) % 26)) + name
    remaining = Math.floor((remaining - 1) / 26)
  }

  return name
}

const sheetXml = (sheet: FixtureSheet) => {
  const rows = sheet.rows ?? []
  const width = Math.max(1, ...rows.map(row => row.length))

  const dimension =
    rows.length === 0 ? '' : `<dimension ref="A1:${columnName(width - 1)}${rows.length}"/>`

  const rowXml = rows
    .map((row, rowIndex) => {
      const cells = row
        .map((value, columnIndex) =>
          value === undefined
            ? ''
            : `<c r="${columnName(columnIndex)}${rowIndex + 1}" t="inlineStr"><is><t>${escapeXml(value)}</t></is></c>`
        )
        .join('')

      return `<row r="${rowIndex + 1}">${cells}</row>`
    })
    .join('')

  return `${xmlHeader}<worksheet xmlns="${mainNs}" xmlns:r="${relNs}">${dimension}<sheetData>${rowXml}</sheetData>${sheet.afterSheetData ?? ''}</worksheet>`
}

const relationshipsXml = (
  relationships: ReadonlyArray<readonly [string, string, string, boolean]>
) =>
  `${xmlHeader}<Relationships xmlns="${packageRelNs}">${relationships
    .map(
      ([id, type, target, external]) =>
        `<Relationship Id="${id}" Type="${relNs}/${type}" Target="${escapeXml(target)}"${external ? ' TargetMode="External"' : ''}/>`
    )
    .join('')}</Relationships>`

/** Hand-built workbook parts (no SheetJS writer), so tests control every byte. */
export const workbookParts = (sheets: ReadonlyArray<FixtureSheet>) => {
  const parts: Record<string, Uint8Array> = {}

  const paths = sheets.map((sheet, index) => sheet.path ?? `xl/worksheets/sheet${index + 1}.xml`)

  parts['[Content_Types].xml'] = strToU8(
    `${xmlHeader}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>${paths
      .map(
        path =>
          `<Override PartName="/${path}" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`
      )
      .join(
        ''
      )}<Override PartName="/xl/comments1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.comments+xml"/></Types>`
  )

  parts['_rels/.rels'] = strToU8(
    relationshipsXml([['rId1', 'officeDocument', 'xl/workbook.xml', false]])
  )

  parts['xl/workbook.xml'] = strToU8(
    `${xmlHeader}<workbook xmlns="${mainNs}" xmlns:r="${relNs}"><sheets>${sheets
      .map(
        (sheet, index) =>
          `<sheet name="${escapeXml(sheet.name)}" sheetId="${index + 1}" r:id="rId${index + 1}"/>`
      )
      .join('')}</sheets></workbook>`
  )

  parts['xl/_rels/workbook.xml.rels'] = strToU8(
    relationshipsXml(
      paths.map(
        (path, index) => [`rId${index + 1}`, 'worksheet', path.replace(/^xl\//, ''), false] as const
      )
    )
  )

  for (const [index, sheet] of sheets.entries()) {
    const path = paths[index] ?? ''
    parts[path] = strToU8(sheetXml(sheet))

    if (sheet.relationships !== undefined) {
      const directory = path.slice(0, path.lastIndexOf('/') + 1)
      const file = path.slice(path.lastIndexOf('/') + 1)
      parts[`${directory}_rels/${file}.rels`] = strToU8(relationshipsXml(sheet.relationships))
    }
  }

  return parts
}

export const zipParts = (parts: Record<string, Uint8Array>, level: 0 | 6 = 6) =>
  zipSync(parts, { level })

export const workbook = (sheets: ReadonlyArray<FixtureSheet>) => zipParts(workbookParts(sheets))

export const hyperlinks = (...tags: ReadonlyArray<string>) =>
  `<hyperlinks>${tags.join('')}</hyperlinks>`

/** A single-sheet workbook whose `ref` range carries an internal or external link. */
export const linkedRangeWorkbook = (ref: string, external = false) =>
  workbook([
    {
      name: 'Sheet1',
      rows: [
        ['Name', 'Site'],
        ['Acme', 'acme.example']
      ],
      afterSheetData: hyperlinks(
        external
          ? `<hyperlink ref="${ref}" r:id="rId1" display="x"/>`
          : `<hyperlink ref="${ref}" location="Sheet1!A1" display="x"/>`
      ),
      relationships: [['rId1', 'hyperlink', 'https://range.example/', true]]
    }
  ])

export const unzipText = (archive: Uint8Array) =>
  Object.fromEntries(
    Object.entries(unzipSync(archive)).map(([name, bytes]) => [
      name,
      Buffer.from(bytes).toString('latin1')
    ])
  )

const littleEndian32 = (value: number) => {
  const bytes = Buffer.alloc(4)
  bytes.writeUInt32LE(value)

  return bytes
}

const xlsbWideString = (text: string) =>
  Buffer.concat([littleEndian32(text.length), Buffer.from(text, 'utf16le')])

/** One BIFF12 record: variable-length type and size, then the payload. */
const xlsbRecord = (type: number, payload: Uint8Array = new Uint8Array()) =>
  Buffer.concat([
    Buffer.from(type < 0x80 ? [type] : [(type & 0x7f) | 0x80, type >> 7]),
    Buffer.from([payload.length]),
    payload
  ])

/**
 * A binary (XLSB) worksheet stream whose single `BrtHLink` record (0x01EE) covers rows and
 * columns `0..last`. SheetJS's `parse_ws_bin` creates one cell object per covered cell, so tests
 * keep `last` small: a regression then fails instead of exhausting the runner.
 */
export const xlsbHyperlinkSheet = (last: number) =>
  Buffer.concat([
    xlsbRecord(0x81),
    xlsbRecord(0x91),
    xlsbRecord(0x92),
    xlsbRecord(
      0x1ee,
      Buffer.concat([
        littleEndian32(0),
        littleEndian32(last),
        littleEndian32(0),
        littleEndian32(last),
        xlsbWideString('rId1'),
        xlsbWideString(''),
        xlsbWideString(''),
        xlsbWideString('')
      ])
    ),
    xlsbRecord(0x82)
  ])

/** One `read` call made through a recording loader. */
export type SheetJsCall = {
  readonly bytes: Uint8Array
  readonly names: ReadonlyArray<string>
  /** The options the extractor passed, copied before SheetJS adds its defaults. */
  readonly options: XLSX.ParsingOptions
  readonly workbook: XLSX.WorkBook
}

/** Real SheetJS 0.20.3 behind the extractor's loader, recording every call. */
export const recordingSheetJs =
  (calls: Array<SheetJsCall>): SheetJsLoader =>
  async () => ({
    version: XLSX.version,
    read: (bytes: Uint8Array, options: XLSX.ParsingOptions) => {
      const requested = { ...options }
      const workbook = XLSX.read(bytes, options)

      // Unzip only the archive the extractor built, never attacker input.
      calls.push({ bytes, names: Object.keys(unzipSync(bytes)), options: requested, workbook })

      return workbook
    }
  })

/** Every entry SheetJS received is one of the canonical names the allowlist emits. */
export const expectAllowlisted = (names: ReadonlyArray<string>) => {
  expect(names.filter(name => !isSheetJsInputName(name))).toEqual([])
  expect(names).toContain('xl/workbook.xml')
}

/** Cells SheetJS created for a sheet (own keys that are not `!` metadata). */
export const cellCount = (sheet: object | undefined) =>
  sheet === undefined ? 0 : Object.keys(sheet).filter(key => !key.startsWith('!')).length

/** Every cell object SheetJS created across the workbook. */
export const allCells = (workbook: XLSX.WorkBook): ReadonlyArray<XLSX.CellObject> =>
  Object.values(workbook.Sheets).flatMap(sheet =>
    Object.entries(sheet).flatMap(([key, cell]: [string, XLSX.CellObject]) =>
      key.startsWith('!') ? [] : [cell]
    )
  )

/** A worksheet part with a `dimension` and raw `sheetData` (and XML after it). */
export const worksheet = (sheetData: string, dimension: string, after = '') =>
  strToU8(
    `${xmlHeader}<worksheet xmlns="${mainNs}" xmlns:r="${relNs}"><dimension ref="${dimension}"/><sheetData>${sheetData}</sheetData>${after}</worksheet>`
  )

/** A one-sheet workbook whose worksheet XML is `sheet`, plus any extra parts. */
export const singleSheetParts = (sheet: Uint8Array, extra: Record<string, Uint8Array> = {}) => {
  const parts = workbookParts([{ name: 'Sheet1' }])

  parts['xl/worksheets/sheet1.xml'] = sheet

  return { ...parts, ...extra }
}

/** Unprotected SheetJS with its defaults (formulas on): the control for each attack. */
export const readDirectly = (parts: Record<string, Uint8Array>) =>
  XLSX.read(zipParts(parts), { type: 'array' })

/** Extract with the recording loader; SheetJS ran once on an allowlisted archive. */
export const extractRecorded = (parts: Record<string, Uint8Array>) =>
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

/** Extraction fails with `message` before SheetJS is loaded. */
export const expectRejected = (
  parts: Record<string, Uint8Array>,
  message: string,
  limits: Partial<FileExtractorLimits> = {}
) =>
  Effect.gen(function* () {
    const calls: Array<SheetJsCall> = []

    const error = yield* extractWith(xlsxInput(zipParts(parts)), {
      limits,
      loadSheetJs: recordingSheetJs(calls)
    }).pipe(Effect.flip)

    expect(error._tag).toBe('FileExtractionError')
    expect(error.message).toBe(message)
    expect(calls).toHaveLength(0)
  })

export const zipText = (text: string) => Uint8Array.from(strToU8(text))

export const docxMediaType =
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document'

export const pptxMediaType =
  'application/vnd.openxmlformats-officedocument.presentationml.presentation'

export const makeDocx = (text: string) =>
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

export const makePptx = () =>
  zipSync({
    '[Content_Types].xml': zipText('<Types/>'),
    'ppt/presentation.xml': zipText('<p:presentation/>'),
    'ppt/slides/slide2.xml': zipText('<a:p><a:r><a:t>Second</a:t></a:r></a:p>'),
    'ppt/slides/slide1.xml': zipText('<a:p><a:r><a:t>First &amp; one</a:t></a:r></a:p>'),
    'ppt/notesSlides/notesSlide1.xml': zipText('<a:p><a:r><a:t>Speaker note</a:t></a:r></a:p>')
  })

export const makePdf = (text: string) => {
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
