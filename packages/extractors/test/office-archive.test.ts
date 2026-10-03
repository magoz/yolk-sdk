import { Buffer } from 'node:buffer'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { describe, expect, it } from '@effect/vitest'
import { Effect, Result } from 'effect'
import { strToU8, unzipSync, zipSync } from 'fflate'
import * as XLSX from 'xlsx'
import { normalizeOfficeArchive } from '../src/node/index.ts'
import { sheetJsReadOptions } from '../src/node/sheetjs.ts'
import { buildSheetJsInput } from '../src/node/xlsx-sheetjs-input.ts'
import {
  officeInflateChunkBytes,
  readOfficeArchive,
  utf16PartHasHyperlink
} from '../src/node/office-archive.ts'
import { defaultFileExtractorLimits } from '../src/limits.ts'
import { decode, extractWith, xlsxInput } from './fixtures.ts'

const docx = (content = 'Hello Office') =>
  zipSync({
    '[Content_Types].xml': strToU8('<Types/>'),
    'word/document.xml': strToU8(content)
  })

/** Forge BOTH size declarations; a header comparison alone cannot detect this bomb. */
const forgeExpandedSize = (zip: Uint8Array) => {
  const bytes = Buffer.from(zip)

  for (let offset = 0; offset < bytes.length - 46; offset += 1) {
    if (bytes.readUInt32LE(offset) !== 0x02014b50) continue

    const name = bytes
      .subarray(offset + 46, offset + 46 + bytes.readUInt16LE(offset + 28))
      .toString()

    if (name !== 'word/document.xml') continue

    const local = bytes.readUInt32LE(offset + 42)
    bytes.writeUInt32LE(1, offset + 24)
    bytes.writeUInt32LE(1, local + 22)
  }

  return bytes
}

const forgedOfficeBomb = () => forgeExpandedSize(docx('x'.repeat(51 * 1024 * 1024)))

const sheetJsWorkbook = (value: string) => {
  const workbook = XLSX.utils.book_new()
  XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet([[value]]), 'Sheet1')

  const written: unknown = XLSX.write(workbook, { type: 'array', bookType: 'xlsx' })

  if (!(written instanceof ArrayBuffer)) throw new Error('Expected XLSX fixture')

  return unzipSync(new Uint8Array(written))
}

describe('bounded Office archive normalization', () => {
  it.effect(
    'aborts forged tiny sizes on the first bounded inflated output, not after full expansion',
    () =>
      Effect.gen(function* () {
        const result = yield* normalizeOfficeArchive(forgedOfficeBomb(), 'docx').pipe(Effect.result)

        expect(result._tag).toBe('Failure')

        if (Result.isFailure(result)) {
          expect(result.failure.message).toContain('expansion exceeds')
          expect(result.failure.expandedBytes).toBeLessThanOrEqual(officeInflateChunkBytes + 8)
        }
      })
  )

  it.effect('stops a highly compressed bomb at the expanded-bytes limit', () =>
    Effect.gen(function* () {
      // 64 MiB of zeros deflates to ~64 KiB and declares its real size honestly.
      const bomb = zipSync({
        '[Content_Types].xml': strToU8('<Types/>'),
        'word/document.xml': new Uint8Array(64 * 1024 * 1024)
      })

      expect(bomb.byteLength).toBeLessThan(1024 * 1024)

      const result = yield* normalizeOfficeArchive(bomb, 'docx').pipe(Effect.result)

      expect(Result.isFailure(result) && result.failure.message).toContain('expansion exceeds')
    })
  )

  it.effect('honors a smaller configured expanded-bytes limit', () =>
    Effect.gen(function* () {
      const result = yield* normalizeOfficeArchive(docx('x'.repeat(4096)), 'docx', {
        maxExpandedBytes: 1024
      }).pipe(Effect.result)

      expect(result._tag).toBe('Failure')
    })
  )

  it.effect('returns a fresh stored-entry ZIP containing exactly the validated content', () =>
    Effect.gen(function* () {
      const source = Buffer.from(docx())
      const normalized = yield* normalizeOfficeArchive(source, 'docx')

      // Unzip only our normalized archive in the test, never attacker input in production.
      expect(unzipSync(normalized)).toEqual(unzipSync(source))
      expect(Buffer.from(normalized).equals(source)).toBe(false)
      expect(Buffer.from(normalized).readUInt16LE(8)).toBe(0)
    })
  )

  it.effect('rejects disagreement between local headers and central directory', () =>
    Effect.gen(function* () {
      const bytes = Buffer.from(docx())
      bytes.writeUInt32LE(0, 22)

      const result = yield* normalizeOfficeArchive(bytes, 'docx').pipe(Effect.result)

      expect(result._tag).toBe('Failure')
    })
  )

  it.effect('rejects ambiguous paths, missing entries and excess entry counts', () =>
    Effect.gen(function* () {
      for (const zip of [
        zipSync({
          '[Content_Types].xml': strToU8('types'),
          '../word/document.xml': strToU8('text')
        }),
        zipSync({ '[Content_Types].xml': strToU8('types') }),
        zipSync({ 'word/document.xml': strToU8('text') }),
        zipSync(
          Object.fromEntries(
            Array.from({ length: 10_001 }, (_, index) => [`${index}.xml`, new Uint8Array()])
          )
        )
      ]) {
        expect((yield* normalizeOfficeArchive(zip, 'docx').pipe(Effect.result))._tag).toBe(
          'Failure'
        )
      }
    })
  )

  it.effect('requires the main part of the declared format', () =>
    Effect.gen(function* () {
      expect((yield* normalizeOfficeArchive(docx(), 'pptx').pipe(Effect.result))._tag).toBe(
        'Failure'
      )
      expect((yield* normalizeOfficeArchive(docx(), 'xlsx').pipe(Effect.result))._tag).toBe(
        'Failure'
      )
    })
  )

  it.effect('rejects macro projects and non-ZIP bytes', () =>
    Effect.gen(function* () {
      const macro = zipSync({
        '[Content_Types].xml': strToU8('<Types/>'),
        'word/document.xml': strToU8('text'),
        'word/vbaProject.bin': new Uint8Array([1, 2, 3])
      })

      for (const bytes of [macro, strToU8('not a zip at all, but long enough to scan')]) {
        expect((yield* normalizeOfficeArchive(bytes, 'docx').pipe(Effect.result))._tag).toBe(
          'Failure'
        )
      }
    })
  )
})

describe('XLSX hyperlink stripping', () => {
  it.effect('strips full-grid hyperlinks before any XLSX parser sees worksheet XML', () =>
    Effect.gen(function* () {
      const entries = sheetJsWorkbook('Safe cell')
      const sheet = entries['xl/worksheets/sheet1.xml']

      if (sheet === undefined) throw new Error('Missing fixture worksheet')

      entries['xl/worksheets/sheet1.xml'] = strToU8(
        decode(sheet).replace(
          '</worksheet>',
          '<hyperlinks><hyperlink ref="A1:XFD1048576" location="A1"/></hyperlinks></worksheet>'
        )
      )

      const hostile = zipSync(entries)

      // Never pass hostile bytes directly to XLSX.read in this test: that is the vulnerability.
      const normalized = yield* normalizeOfficeArchive(hostile, 'xlsx')

      expect(decode(unzipSync(normalized)['xl/worksheets/sheet1.xml'])).not.toContain('<hyperlink ')

      const result = yield* extractWith(xlsxInput(hostile, 'links.xlsx'))

      expect(result.content).toContain('Safe cell')
    })
  )

  for (const variant of ['nested tag', 'non-XML relationship target']) {
    it.effect(`prevents XLSX hyperlink expansion through ${variant}`, () =>
      Effect.gen(function* () {
        const entries = sheetJsWorkbook('Säker cell')
        const sheetPath = 'xl/worksheets/sheet1.xml'
        const sheet = entries[sheetPath]

        if (sheet === undefined) throw new Error('Missing fixture worksheet')

        // Small ranges let a regression fail safely rather than exhaust the test runner.
        const hyperlink =
          variant === 'nested tag'
            ? '<hyper<hyperlink ref="A1" location="A1"/>link ref="A1:B2" location="A1"/>'
            : '<hyperlink ref="A1:B2" location="A1"/>'

        entries[sheetPath] = strToU8(
          decode(sheet).replace('</worksheet>', `<hyperlinks>${hyperlink}</hyperlinks></worksheet>`)
        )

        let targetPath = sheetPath

        if (variant === 'non-XML relationship target') {
          targetPath = 'xl/worksheets/sheet1.data'
          entries[targetPath] = entries[sheetPath]
          delete entries[sheetPath]

          for (const path of ['xl/_rels/workbook.xml.rels', '[Content_Types].xml']) {
            const part = entries[path]

            if (part === undefined) throw new Error('Missing worksheet relationship fixture')

            entries[path] = strToU8(decode(part).replaceAll('sheet1.xml', 'sheet1.data'))
          }
        }

        const binary = new Uint8Array([0, 255, 128, 195, 164])
        entries['custom/binary.data'] = binary

        const normalized = yield* normalizeOfficeArchive(zipSync(entries), 'xlsx')
        const parts = unzipSync(normalized)

        expect(decode(parts[targetPath])).not.toMatch(/<hyperlink\b/)
        expect(parts['custom/binary.data']).toEqual(binary)

        // SheetJS only ever reads the allowlisted rebuild, which skips non-XML worksheet parts.
        const parsed = XLSX.read(buildSheetJsInput(parts, 100).archive, { ...sheetJsReadOptions })

        expect(parsed.Sheets.Sheet1?.A1?.v).toBe(
          variant === 'nested tag' ? 'Säker cell' : undefined
        )
        expect(parsed.Sheets.Sheet1?.B2).toBeUndefined()
      })
    )
  }

  it.effect('returns the removed start tags, capped across the workbook', () =>
    Effect.gen(function* () {
      const entries = sheetJsWorkbook('cell')
      const sheet = entries['xl/worksheets/sheet1.xml']

      if (sheet === undefined) throw new Error('Missing fixture worksheet')

      const links = Array.from({ length: 5 }, (_, index) => `<x:hyperlink ref="A${index + 1}"/>`)

      entries['xl/worksheets/sheet1.xml'] = strToU8(
        decode(sheet).replace(
          '</worksheet>',
          `<x:hyperlinks>${links.join('')}</x:hyperlinks></worksheet>`
        )
      )

      const normalized = yield* readOfficeArchive(
        zipSync(entries),
        'xlsx',
        defaultFileExtractorLimits,
        { maxHyperlinkTags: 3 }
      )

      expect(normalized.hyperlinkTags.get('xl/worksheets/sheet1.xml')).toEqual(links.slice(0, 3))
      expect(decode(normalized.parts['xl/worksheets/sheet1.xml'])).not.toMatch(/hyperlink\b/)
    })
  )
})

/** SheetJS's own `hlinkregex`, read from the installed build so the parity test cannot drift. */
const sheetJsHyperlinkPattern = () => {
  const source = readFileSync(createRequire(import.meta.url).resolve('xlsx'), 'utf8')
  const literal = /var hlinkregex = \/(.+)\/(\w*);/.exec(source)

  if (literal?.[1] === undefined) throw new Error('SheetJS hlinkregex not found')

  return new RegExp(literal[1], literal[2])
}

describe('XLSX hyperlink strip pattern', () => {
  const normalizedSheet = (afterSheetData: string) =>
    Effect.gen(function* () {
      const entries = sheetJsWorkbook('cell')
      const sheet = entries['xl/worksheets/sheet1.xml']

      if (sheet === undefined) throw new Error('Missing fixture worksheet')

      entries['xl/worksheets/sheet1.xml'] = strToU8(
        decode(sheet).replace('</worksheet>', `${afterSheetData}</worksheet>`)
      )

      const normalized = yield* normalizeOfficeArchive(zipSync(entries), 'xlsx')
      const part = unzipSync(normalized)['xl/worksheets/sheet1.xml']

      return Buffer.from(part ?? new Uint8Array()).toString('latin1')
    })

  it.effect('removes everything SheetJS hlinkregex matches', () =>
    Effect.gen(function* () {
      const pattern = sheetJsHyperlinkPattern()

      const cases = [
        '<hyperlink ref="A1:B2" location="A1"/>',
        '<x:hyperlink ref="A1:B2" r:id="rId1"></x:hyperlink>',
        '<ns_1:hyperlink ref="A1" display="a>b"/>',
        '<hyper<hyperlink ref="A1"/>link ref="A1:B2"/>',
        '<hyp<x:hyperlink ref="A1"/>erlink ref="A1:B2" location="A1"/>',
        '<hyperlink\tref="A1"/><hyperlink ref="C3" location="A1" >',
        '<HYPERLINK ref="A1"/><hyperlinks><hyperlink ref="Z9"/></hyperlinks>'
      ]

      for (const tags of cases) {
        // Control: SheetJS would expand a range from this markup.
        expect(tags).toMatch(pattern)

        const stripped = yield* normalizedSheet(tags)

        expect(stripped.match(pattern)).toBeNull()
      }
    })
  )

  it.effect('never lets a tag candidate span a `<`, so the strip stays linear', () =>
    Effect.gen(function* () {
      // An unterminated start before another tag: SheetJS's `[^<>]*>` cannot match it either.
      const unterminated = '<hyperlink ref="A1:B2" <b>kept</b>'
      const stripped = yield* normalizedSheet(unterminated)

      expect(stripped).toContain(unterminated)
      expect(stripped.match(sheetJsHyperlinkPattern())).toBeNull()

      // 200k starts without `>`: a pattern that scans past the next `<` does ~2e11 steps here.
      const run = '<hyperlink '.repeat(200_000)
      const scanned = yield* normalizedSheet(run)

      expect(scanned).toContain(run)
    })
  )
})

describe('UTF-16 worksheet parts', () => {
  const sheet =
    '<worksheet><hyperlinks><hyperlink ref="A1:B2" location="A1"/></hyperlinks></worksheet>'

  it('detects hyperlink tags SheetJS would decode from BOM-marked UTF-16', () => {
    const littleEndian = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(sheet, 'utf16le')])

    const bigEndian = Buffer.concat([
      Buffer.from([0xfe, 0xff]),
      Buffer.from(sheet, 'utf16le').swap16()
    ])

    expect(utf16PartHasHyperlink(littleEndian)).toBe(true)
    expect(utf16PartHasHyperlink(bigEndian)).toBe(true)
  })

  it('ignores ordinary UTF-8 parts and UTF-16 parts without hyperlinks', () => {
    expect(utf16PartHasHyperlink(Buffer.from(sheet, 'utf8'))).toBe(false)
    expect(
      utf16PartHasHyperlink(
        Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('<worksheet/>', 'utf16le')])
      )
    ).toBe(false)
  })

  const workbookWithSheet = (sheetBytes: Buffer) => {
    const entries = sheetJsWorkbook('Safe cell')
    entries['xl/worksheets/sheet1.xml'] = new Uint8Array(sheetBytes)

    return zipSync(entries)
  }

  const normalizedTag = (sheetBytes: Buffer) =>
    normalizeOfficeArchive(workbookWithSheet(sheetBytes), 'xlsx').pipe(
      Effect.result,
      Effect.map(result => result._tag)
    )

  const utf16le = (text: string) => Buffer.from(text, 'utf16le')
  const utf16be = (text: string) => Buffer.from(text, 'utf16le').swap16()
  const link = '<hyperlink ref="A1:B2" location="A1"/>'

  it.effect('rejects a complete workbook whose worksheet hides a hyperlink in UTF-16', () =>
    Effect.gen(function* () {
      const sheetBytes = Buffer.concat([Buffer.from([0xff, 0xfe]), utf16le(sheet)])

      expect(yield* normalizedTag(sheetBytes)).toBe('Failure')
    })
  )

  it.effect('rejects it through FileExtractor too, before SheetJS runs', () =>
    Effect.gen(function* () {
      const sheetBytes = Buffer.concat([Buffer.from([0xff, 0xfe]), utf16le(sheet)])
      let loaded = false

      const error = yield* extractWith(xlsxInput(workbookWithSheet(sheetBytes)), {
        loadSheetJs: () => {
          loaded = true

          return import('xlsx')
        }
      }).pipe(Effect.flip)

      expect(error._tag).toBe('FileExtractionError')
      expect(error.message).toBe('Invalid Office archive.')
      expect(loaded).toBe(false)
    })
  )

  it.effect('checks the stripped bytes, so removing a decoy tag cannot realign UTF-16', () =>
    Effect.gen(function* () {
      const sheetBytes = Buffer.concat([
        Buffer.from([0xff, 0xfe]),
        utf16le('<worksheet><sheetData></sheetData>'),
        Buffer.from('x<hyperlink/>', 'latin1'),
        utf16le(`${link}</worksheet>`)
      ])

      expect(yield* normalizedTag(sheetBytes)).toBe('Failure')
    })
  )

  it.effect('checks the stripped bytes, so removing a decoy tag cannot create a BOM', () =>
    Effect.gen(function* () {
      const sheetBytes = Buffer.concat([
        Buffer.from('<hyperlink >', 'latin1'),
        Buffer.from([0xfe, 0xff]),
        utf16be(link)
      ])

      expect(yield* normalizedTag(sheetBytes)).toBe('Failure')
    })
  )

  it.effect('accepts a UTF-16 worksheet without hyperlinks', () =>
    Effect.gen(function* () {
      const sheetBytes = Buffer.concat([Buffer.from([0xff, 0xfe]), utf16le('<worksheet/>')])

      expect(yield* normalizedTag(sheetBytes)).toBe('Success')
    })
  )
})
