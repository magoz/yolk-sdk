import { Buffer } from 'node:buffer'
import { strToU8, unzipSync, zipSync } from 'fflate'
import { Effect } from 'effect'
import { FileExtractor } from '../src/service.ts'
import type { FileInput } from '../src/format.ts'
import { makeFileExtractorLayer } from '../src/node/live-layer.ts'
import type { FileExtractorOptions } from '../src/node/live-layer.ts'

export const xlsxMediaType = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'

export const encode = (text: string) => new TextEncoder().encode(text)

export const decode = (bytes: Uint8Array | undefined) => new TextDecoder().decode(bytes)

export const extractWith = (input: FileInput, options: FileExtractorOptions = {}) =>
  Effect.gen(function* () {
    const extractor = yield* FileExtractor

    return yield* extractor.extract(input)
  }).pipe(Effect.provide(makeFileExtractorLayer(options)))

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
