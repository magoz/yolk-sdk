import { Buffer } from 'node:buffer'
import { Readable } from 'node:stream'
import { createInflateRaw } from 'node:zlib'
import { Effect } from 'effect'
import { zipSync } from 'fflate'
import { OfficeArchiveError } from '../errors.ts'
import type { OfficeFileFormat } from '../format.ts'
import { defaultFileExtractorLimits } from '../limits.ts'
import type { FileExtractorLimits } from '../limits.ts'
import {
  contentTypesRouteToBinary,
  isAlternateFormatEntry,
  relationshipsRouteToBinary,
  sheetJsTextViews
} from './xlsx-routing.ts'

export type OfficeArchiveLimits = Pick<
  FileExtractorLimits,
  'maxArchiveEntries' | 'maxExpandedBytes' | 'maxInputBytes'
>

const invalid = () => new OfficeArchiveError({ message: 'Invalid Office archive.' })

const tooLargeMessage = 'Office archive expansion exceeds its declared size or limit.'

const tooLarge = (expandedBytes?: number) =>
  expandedBytes === undefined
    ? new OfficeArchiveError({ message: tooLargeMessage })
    : new OfficeArchiveError({ message: tooLargeMessage, expandedBytes })

const compressedChunkBytes = 1024

/** Inflated output is counted in slices of at most this many bytes. */
export const officeInflateChunkBytes = 16 * 1024

const mainParts: Readonly<Record<OfficeFileFormat, string>> = {
  docx: 'word/document.xml',
  pptx: 'ppt/presentation.xml',
  xlsx: 'xl/workbook.xml'
}

type ArchiveEntry = {
  readonly name: string
  readonly start: number
  readonly compressedSize: number
  readonly originalSize: number
  readonly method: number
}

/** Read the directory only as a bounded index. Its sizes are never trusted for allocation. */
const archiveEntries = (bytes: Buffer, limits: OfficeArchiveLimits) => {
  let end = bytes.length - 22
  const earliest = Math.max(0, end - 65535)

  while (end >= earliest && bytes.readUInt32LE(end) !== 0x06054b50) end -= 1

  if (end < earliest || end + 22 + bytes.readUInt16LE(end + 20) !== bytes.length) throw invalid()

  const count = bytes.readUInt16LE(end + 10)
  const directorySize = bytes.readUInt32LE(end + 12)
  const directoryOffset = bytes.readUInt32LE(end + 16)

  if (
    bytes.readUInt32LE(end + 4) !== 0 ||
    bytes.readUInt16LE(end + 8) !== count ||
    count === 0 ||
    count > limits.maxArchiveEntries ||
    directoryOffset + directorySize !== end
  )
    throw invalid()

  const entries: Array<ArchiveEntry> = []
  // OPC part names are case-insensitive, and SheetJS looks entries up ignoring case.
  const names = new Set<string>()
  let offset = directoryOffset
  let declaredTotal = 0

  for (let index = 0; index < count; index += 1) {
    if (offset + 46 > end || bytes.readUInt32LE(offset) !== 0x02014b50) throw invalid()

    const flags = bytes.readUInt16LE(offset + 8)
    const method = bytes.readUInt16LE(offset + 10)
    const compressedSize = bytes.readUInt32LE(offset + 20)
    const originalSize = bytes.readUInt32LE(offset + 24)
    const nameSize = bytes.readUInt16LE(offset + 28)
    const extraSize = bytes.readUInt16LE(offset + 30)
    const commentSize = bytes.readUInt16LE(offset + 32)
    const local = bytes.readUInt32LE(offset + 42)
    const next = offset + 46 + nameSize + extraSize + commentSize

    // Reject encryption, unsupported methods, split/ZIP64 archives, and ambiguous paths.
    if (
      next > end ||
      nameSize === 0 ||
      nameSize > 1024 ||
      (flags & ~0x080e) !== 0 ||
      (method !== 0 && method !== 8) ||
      bytes.readUInt16LE(offset + 34) !== 0 ||
      compressedSize === 0xffffffff ||
      originalSize === 0xffffffff ||
      local + 30 > directoryOffset
    )
      throw invalid()

    const nameBytes = bytes.subarray(offset + 46, offset + 46 + nameSize)
    const name = new TextDecoder('utf-8', { fatal: true }).decode(nameBytes)

    // `//` is rejected (SheetJS collapses the first one), but directory entries ending in `/` stay.
    if (
      /[\\\u0000-\u001f]/.test(name) ||
      name.startsWith('/') ||
      name.includes('//') ||
      name.split('/').some(part => part === '..' || part === '.') ||
      names.has(name.toLowerCase()) ||
      /vbaProject\.bin$/i.test(name)
    )
      throw invalid()

    names.add(name.toLowerCase())

    if (
      bytes.readUInt32LE(local) !== 0x04034b50 ||
      bytes.readUInt16LE(local + 6) !== flags ||
      bytes.readUInt16LE(local + 8) !== method ||
      bytes.readUInt16LE(local + 26) !== nameSize
    )
      throw invalid()

    const start = local + 30 + nameSize + bytes.readUInt16LE(local + 28)

    if (
      start + compressedSize > directoryOffset ||
      !bytes.subarray(local + 30, local + 30 + nameSize).equals(nameBytes)
    )
      throw invalid()

    // Data descriptors may leave local sizes zero; all nonzero declarations must agree.
    for (const [position, expected] of [
      [18, compressedSize],
      [22, originalSize]
    ] as const) {
      const value = bytes.readUInt32LE(local + position)

      if (value !== expected && !((flags & 8) !== 0 && value === 0)) throw invalid()
    }

    declaredTotal += originalSize

    if (declaredTotal > limits.maxExpandedBytes) throw tooLarge()

    entries.push({ name, start, compressedSize, originalSize, method })
    offset = next
  }

  if (offset !== end) throw invalid()

  return entries
}

/**
 * A superset of SheetJS's `hlinkregex` (`/<(?:\w+:)?hyperlink [^<>]*>/`). A candidate never spans
 * a `<`, so each scan stops at the next tag and the strip stays linear in the part size.
 */
const hyperlinkTag = /<\/?(?:[\w.-]+:)?hyperlink\b[^<>]*>/gi

const hyperlinkTagStart = /<\/?(?:[\w.-]+:)?hyperlink\b/i

/**
 * Whether a part SheetJS would decode as BOM-marked UTF-16 contains a hyperlink tag. Covers
 * SheetJS `cc2str` UTF-16 BOM decoding (little- and big-endian from byte 2, including its
 * `arr[1]/arr[2]` Buffer check) plus an extra odd-offset big-endian decode.
 */
export const utf16PartHasHyperlink = (content: Uint8Array) =>
  sheetJsTextViews(content)
    .slice(1)
    .some(text => hyperlinkTagStart.test(text))

const unsupportedXlsxParts = () =>
  new OfficeArchiveError({
    message: 'XLSX archive contains binary (XLSB), ODS, or Numbers parts.'
  })

/** Hyperlink start tags (Latin-1 text of the original bytes) found while stripping, per part. */
export type StrippedHyperlinkTags = ReadonlyMap<string, ReadonlyArray<string>>

export type NormalizedOfficeArchive = {
  /** Every validated (and, for XLSX, hyperlink-stripped) part by entry name. */
  readonly parts: Readonly<Record<string, Uint8Array>>
  /** XLSX only: removed hyperlink tags, at most `maxHyperlinkTags` across the workbook. */
  readonly hyperlinkTags: StrippedHyperlinkTags
}

const inflateEntry = async (compressed: Buffer, record: (chunk: Buffer) => void): Promise<void> => {
  function* inputChunks() {
    for (let offset = 0; offset < compressed.length; offset += compressedChunkBytes) {
      yield compressed.subarray(offset, offset + compressedChunkBytes)
    }
  }

  const source = Readable.from(inputChunks(), { highWaterMark: 1 })

  // Stream high-water marks are valid Transform options that `ZlibOptions` does not declare.
  const inflateOptions = {
    chunkSize: officeInflateChunkBytes,
    readableHighWaterMark: officeInflateChunkBytes,
    writableHighWaterMark: compressedChunkBytes
  }

  const inflater = createInflateRaw(inflateOptions)

  source.pipe(inflater)

  try {
    // Async iteration may combine buffered chunks; bound accounting slices explicitly.
    for await (const value of inflater) {
      if (!Buffer.isBuffer(value)) throw invalid()

      for (let offset = 0; offset < value.length; offset += officeInflateChunkBytes) {
        record(value.subarray(offset, offset + officeInflateChunkBytes))
      }
    }

    if (inflater.bytesWritten !== compressed.length) throw invalid()
  } finally {
    source.destroy()
    inflater.destroy()
  }
}

export type ReadOfficeArchiveOptions = {
  /** XLSX: hyperlink start tags to capture across the workbook (default 0). */
  readonly maxHyperlinkTags?: number
}

/** A fresh stored-entry ZIP of validated parts; the attacker's ZIP index is never reused. */
export const storedArchive = (parts: Readonly<Record<string, Uint8Array>>) =>
  zipSync({ ...parts }, { level: 0 })

/**
 * Inflate bounded input chunks, count actual output, and return the validated parts. The
 * attacker's ZIP index is discarded: parsers only get archives rebuilt from these parts.
 *
 * For XLSX, every part loses its `<hyperlink>` tags: SheetJS expands each hyperlink range into
 * per-cell objects before any budget runs, so one `ref="A1:XFD1048576"` exhausts memory. The
 * removed tags are returned so links can still be shown. XLSX input that SheetJS would route to
 * its binary (XLSB), ODS, or Numbers parsers is rejected early with a clear error; the guarantee
 * is that SheetJS only receives `buildSheetJsInput`'s allowlisted archive.
 */
export const readOfficeArchive = (
  input: Uint8Array,
  format: OfficeFileFormat,
  limits: OfficeArchiveLimits,
  options: ReadOfficeArchiveOptions = {}
) =>
  Effect.tryPromise({
    try: async (): Promise<NormalizedOfficeArchive> => {
      const bytes = Buffer.from(input.buffer, input.byteOffset, input.byteLength)

      if (bytes.length < 22 || bytes.length > limits.maxInputBytes) throw invalid()

      const entries = archiveEntries(bytes, limits)
      const mainPart = mainParts[format]
      const maxHyperlinkTags = options.maxHyperlinkTags ?? 0

      if (format === 'xlsx' && entries.some(entry => isAlternateFormatEntry(entry.name)))
        throw unsupportedXlsxParts()

      if (
        !entries.some(entry => entry.name === '[Content_Types].xml') ||
        !entries.some(entry => entry.name === mainPart)
      )
        throw invalid()

      const validated: Record<string, Uint8Array> = Object.create(null)
      const hyperlinkTags = new Map<string, Array<string>>()
      let capturedTags = 0
      let expandedBytes = 0

      for (const entry of entries) {
        const chunks: Array<Buffer> = []
        let entryBytes = 0

        const record = (chunk: Buffer) => {
          entryBytes += chunk.length
          expandedBytes += chunk.length

          if (expandedBytes > limits.maxExpandedBytes || entryBytes > entry.originalSize)
            throw tooLarge(expandedBytes)

          chunks.push(chunk)
        }

        const compressed = bytes.subarray(entry.start, entry.start + entry.compressedSize)

        if (entry.method === 0) record(compressed)
        else await inflateEntry(compressed, record)

        if (entryBytes !== entry.originalSize) throw invalid()

        const content = Buffer.concat(chunks, entryBytes)

        if (format !== 'xlsx') {
          validated[entry.name] = content
          continue
        }

        // Relationship targets need not end in .xml, so scan every entry without changing other
        // bytes (including UTF-8 and binary parts). A space prevents removal from joining
        // attacker-controlled fragments into a new parser-accepted hyperlink tag.
        const tags: Array<string> = []

        const rewritten = Buffer.from(
          content.toString('latin1').replace(hyperlinkTag, tag => {
            if (!tag.startsWith('</') && capturedTags < maxHyperlinkTags) {
              capturedTags += 1
              tags.push(tag)
            }

            return ' '
          }),
          'latin1'
        )

        // SheetJS also decodes BOM-marked UTF-16 parts, which the Latin-1 strip cannot see
        // through, and the strip itself can shift byte alignment or create a BOM. Check the exact
        // bytes SheetJS will parse; Excel never writes UTF-16 parts, so reject rather than rewrite.
        if (utf16PartHasHyperlink(rewritten)) throw invalid()

        // Content types and relationships decide which parser SheetJS runs on each part.
        const lowerName = entry.name.toLowerCase()

        if (
          (lowerName === '[content_types].xml' && contentTypesRouteToBinary(rewritten)) ||
          (lowerName.endsWith('.rels') && relationshipsRouteToBinary(rewritten))
        )
          throw unsupportedXlsxParts()

        if (tags.length > 0) hyperlinkTags.set(entry.name, tags)

        validated[entry.name] = rewritten
      }

      return { parts: validated, hyperlinkTags }
    },
    // Out-of-range header reads (RangeError) and inflate failures are malformed archives too.
    catch: error => (error instanceof OfficeArchiveError ? error : invalid())
  })

/**
 * Validate a DOCX, XLSX, or PPTX archive with bounded inflation and return a rebuilt stored-entry
 * ZIP of every validated part, for storage or for other parsers. XLSX parts lose their hyperlink
 * tags, and XLSX input with ODS or Numbers marker entries or XLSB parts is rejected; `.bin` parts
 * SheetJS never parses (printer settings, OLE objects) are kept so stored files still open.
 *
 * The output is not SheetJS input. Never run SheetJS on it directly: extract XLSX text through
 * `FileExtractor`, which hands SheetJS only an allowlisted archive it builds itself (worksheet,
 * shared-string, style, and core-property parts with generated content types and relationships).
 */
export const normalizeOfficeArchive = (
  bytes: Uint8Array,
  format: OfficeFileFormat,
  limits: Partial<OfficeArchiveLimits> = {}
) =>
  readOfficeArchive(bytes, format, {
    maxArchiveEntries: limits.maxArchiveEntries ?? defaultFileExtractorLimits.maxArchiveEntries,
    maxExpandedBytes: limits.maxExpandedBytes ?? defaultFileExtractorLimits.maxExpandedBytes,
    maxInputBytes: limits.maxInputBytes ?? defaultFileExtractorLimits.maxInputBytes
  }).pipe(Effect.map(normalized => storedArchive(normalized.parts)))
