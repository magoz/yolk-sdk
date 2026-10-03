import * as Schema from 'effect/Schema'

const PositiveSafeInteger = Schema.Int.pipe(
  Schema.check(Schema.isGreaterThan(0)),
  Schema.check(Schema.isLessThanOrEqualTo(Number.MAX_SAFE_INTEGER))
)

/**
 * Smallest `maxXlsxTextCharacters`: one more than the space always reserved for the
 * `[Some hyperlinks omitted: output limit and hyperlink limit]` marker (61 characters with its
 * leading blank line), so a workbook with links can still produce text.
 */
export const minimumXlsxTextCharacters = 62

/**
 * Work and output bounds for one `extract` call. Every value is a positive integer, and
 * `maxXlsxTextCharacters` is at least `minimumXlsxTextCharacters`.
 */
export const FileExtractorLimits = Schema.Struct({
  /** Input bytes accepted for any format. */
  maxInputBytes: PositiveSafeInteger,
  /** Entries in a DOCX, XLSX, or PPTX ZIP archive. */
  maxArchiveEntries: PositiveSafeInteger,
  /** Total inflated bytes of a DOCX, XLSX, or PPTX archive, counted while inflating. */
  maxExpandedBytes: PositiveSafeInteger,
  /** Worksheets in a workbook. */
  maxXlsxSheets: PositiveSafeInteger,
  /** Cells visited across all worksheet ranges (absent cells count too). */
  maxXlsxCellVisits: PositiveSafeInteger,
  /** Characters of XLSX text, including hyperlink annotations and the omitted-links marker. */
  maxXlsxTextCharacters: PositiveSafeInteger.pipe(
    Schema.check(Schema.isGreaterThanOrEqualTo(minimumXlsxTextCharacters))
  ),
  /** Hyperlinks read per workbook; later ones are ignored (still removed before SheetJS). */
  maxXlsxHyperlinks: PositiveSafeInteger
})

export type FileExtractorLimits = typeof FileExtractorLimits.Type

/** Defaults hardened in production by the 10x app. */
export const defaultFileExtractorLimits: FileExtractorLimits = {
  maxInputBytes: 50 * 1024 * 1024,
  maxArchiveEntries: 10_000,
  maxExpandedBytes: 50 * 1024 * 1024,
  maxXlsxSheets: 100,
  maxXlsxCellVisits: 100_000,
  maxXlsxTextCharacters: 512 * 1024,
  maxXlsxHyperlinks: 10_000
}
