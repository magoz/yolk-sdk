import { Predicate } from 'effect'
import { FileExtractionError } from '../errors.ts'
import type { FileExtractorLimits } from '../limits.ts'
import { makeHyperlinkLookup } from './xlsx-hyperlinks.ts'
import type { HyperlinkLookup, XlsxHyperlinks } from './xlsx-hyperlinks.ts'
import type { CellRange } from './xlsx-range.ts'
import { cellCount, encodeCellAddress, parseCellRange } from './xlsx-range.ts'

export type XlsxTextLimits = Pick<
  FileExtractorLimits,
  'maxXlsxCellVisits' | 'maxXlsxSheets' | 'maxXlsxTextCharacters'
>

/** The parsed workbook as SheetJS returns it; sheets and cells are read as own properties. */
export type XlsxWorkbook = {
  readonly SheetNames: ReadonlyArray<string>
  readonly Sheets: object
}

export type XlsxTextOptions = {
  readonly hyperlinks?: XlsxHyperlinks
  /** Some hyperlinks were never read because the workbook exceeded `maxXlsxHyperlinks`. */
  readonly hyperlinksTruncated?: boolean
}

const outputLimitReason = 'output limit'

const hyperlinkLimitReason = 'hyperlink limit'

const omittedHyperlinksMarker = (reasons: ReadonlyArray<string>) =>
  `\n\n[Some hyperlinks omitted: ${reasons.join(' and ')}]`

/**
 * Space reserved for the marker whenever a workbook has hyperlinks, so it always fits.
 * `maxXlsxTextCharacters` must exceed it (`minimumXlsxTextCharacters`).
 */
export const omittedHyperlinksMarkerReserve = omittedHyperlinksMarker([
  outputLimitReason,
  hyperlinkLimitReason
]).length

const invalidRange = () =>
  new FileExtractionError({ format: 'xlsx', message: 'Invalid XLSX worksheet range.' })

const tooLarge = () =>
  new FileExtractionError({
    format: 'xlsx',
    message: 'XLSX exceeds the worksheet or cell-visit limit.'
  })

const outputTooLarge = () =>
  new FileExtractionError({
    format: 'xlsx',
    message: 'XLSX extracted text exceeds the output limit.'
  })

/** Read an own property without walking the prototype chain (or trusting a polluted one). */
const ownProperty = (target: object, key: string): unknown => {
  const descriptor = Object.getOwnPropertyDescriptor(target, key)

  if (descriptor === undefined) return undefined

  return 'value' in descriptor ? descriptor.value : descriptor.get?.call(target)
}

const cellText = (cell: object): string => {
  if (ownProperty(cell, 't') === 'z') return ''

  const value = ownProperty(cell, 'v')

  // SheetJS runs with `cellFormula: false`: only cached values exist, formula-only cells are empty.
  if (value === undefined || value === null) return ''

  // Prefer parser-provided display text. Do not run an untrusted format template here.
  const display = ownProperty(cell, 'w')

  if (Predicate.isString(display)) return display

  if (Predicate.isString(value)) return value

  if (Predicate.isBoolean(value)) return value ? 'TRUE' : 'FALSE'

  if (value instanceof Date && Number.isFinite(value.getTime())) return value.toISOString()

  if (Predicate.isNumber(value) && Number.isFinite(value)) return String(value)

  throw new FileExtractionError({ format: 'xlsx', message: 'Invalid XLSX cell value.' })
}

/**
 * CSV length of `text` (quotes doubled, wrapped when needed). The scan stops once the length
 * exceeds `limit`; the returned length is then only known to be above it.
 */
const csvField = (text: string, limit = Number.POSITIVE_INFINITY) => {
  let quoteCount = 0
  let quote = text === 'ID'

  for (let index = 0; index < text.length; index += 1) {
    const character = text.charCodeAt(index)

    // '"', ',', '\n', '\r'
    if (character === 34) quoteCount += 1

    if (character === 34 || character === 44 || character === 10 || character === 13) {
      quote = true

      if (text.length + quoteCount + 2 > limit) break
    }
  }

  return { quote, length: text.length + quoteCount + (quote ? 2 : 0) }
}

type VisitedSheet = {
  readonly name: string
  readonly sheet: object | undefined
  readonly range: CellRange | undefined
}

/** Annotated text for a cell, or `undefined` to write it plain. */
type CellDecorator = (input: {
  readonly sheet: VisitedSheet
  readonly row: number
  readonly column: number
  readonly text: string
}) => string | undefined

/** Write bounded CSV for every sheet; throws once `budget` characters would be exceeded. */
const renderSheets = (
  sheets: ReadonlyArray<VisitedSheet>,
  budget: number,
  decorate?: CellDecorator
) => {
  let characters = 0
  const output: Array<string> = []

  const append = (text: string) => {
    if (text.length > budget - characters) throw outputTooLarge()

    characters += text.length
    output.push(text)
  }

  const appendCell = (text: string) => {
    if (text.length > budget - characters) throw outputTooLarge()

    const field = csvField(text, budget - characters)

    if (field.length > budget - characters) throw outputTooLarge()

    append(field.quote ? `"${text.replaceAll('"', '""')}"` : text)
  }

  for (const visited of sheets) {
    const { name, sheet, range } = visited

    if (sheet === undefined) continue

    if (output.length > 0) append('\n\n')

    append('# ')
    append(name)
    append('\n')

    if (range === undefined) continue

    for (let row = range.start.r; row <= range.end.r; row += 1) {
      if (row > range.start.r) append('\n')

      for (let column = range.start.c; column <= range.end.c; column += 1) {
        if (column > range.start.c) append(',')

        const cell = ownProperty(sheet, encodeCellAddress({ r: row, c: column }))

        if (!Predicate.isObject(cell)) {
          appendCell('')
          continue
        }

        const text = cellText(cell)

        appendCell(decorate?.({ sheet: visited, row, column, text }) ?? text)
      }
    }
  }

  return output.join('')
}

/**
 * Validate every sheet before touching any cell, then generate bounded CSV incrementally, never
 * with `sheet_to_csv` (which can walk billions of absent cells or allocate an unbounded quoted
 * string).
 *
 * Existing cells inside an external hyperlink are written as `text <url>`. Plain text is
 * rendered first, so links only use budget the plain text leaves over: in document order, an
 * annotation that no longer fits leaves its cell plain and one marker ends the output.
 */
export const extractBoundedXlsxText = (
  workbook: XlsxWorkbook,
  limits: XlsxTextLimits,
  options: XlsxTextOptions = {}
) => {
  if (workbook.SheetNames.length > limits.maxXlsxSheets) throw tooLarge()

  let visits = 0

  const sheets = workbook.SheetNames.map((name): VisitedSheet => {
    const candidate = ownProperty(workbook.Sheets, name)
    const sheet = Predicate.isObject(candidate) ? candidate : undefined
    const ref = sheet === undefined ? undefined : ownProperty(sheet, '!ref')

    if (ref !== undefined && !Predicate.isString(ref)) throw invalidRange()

    const range = ref === undefined ? undefined : parseCellRange(ref)

    if (ref !== undefined && range === undefined) throw invalidRange()

    visits += range === undefined ? 0 : cellCount(range)

    if (!Number.isSafeInteger(visits) || visits > limits.maxXlsxCellVisits) throw tooLarge()

    return { name, sheet, range }
  })

  const links = options.hyperlinks ?? new Map()
  const truncated = options.hyperlinksTruncated === true

  if (links.size === 0 && !truncated) return renderSheets(sheets, limits.maxXlsxTextCharacters)

  // Reserve the marker's space so it always fits inside the character limit.
  const budget = limits.maxXlsxTextCharacters - omittedHyperlinksMarkerReserve
  let spare = budget - renderSheets(sheets, budget).length
  let dropped = false
  const lookups = new Map<string, HyperlinkLookup>()

  const lookupFor = (sheet: VisitedSheet) => {
    const sheetLinks = links.get(sheet.name)

    if (sheetLinks === undefined || sheet.range === undefined) return undefined

    const existing = lookups.get(sheet.name)

    if (existing !== undefined) return existing

    const lookup = makeHyperlinkLookup(sheetLinks, sheet.range)
    lookups.set(sheet.name, lookup)

    return lookup
  }

  const output = renderSheets(sheets, budget, ({ sheet, row, column, text }) => {
    const link = lookupFor(sheet)?.at(row, column)

    if (link === undefined || link.target === text) return undefined

    const label = text.length > 0 ? text : (link.display ?? '')
    const plainLength = csvField(text).length
    const annotatedLength = label.length + (label.length > 0 ? 3 : 2) + link.target.length

    // Constant-time bound first (CSV escaping only adds), then a scan capped at the budget.
    if (annotatedLength - plainLength > spare) {
      dropped = true

      return undefined
    }

    const annotated = label.length > 0 ? `${label} <${link.target}>` : `<${link.target}>`
    const extra = csvField(annotated, plainLength + spare).length - plainLength

    if (extra > spare) {
      dropped = true

      return undefined
    }

    spare -= extra

    return annotated
  })

  const reasons = [
    ...(dropped ? [outputLimitReason] : []),
    ...(truncated ? [hyperlinkLimitReason] : [])
  ]

  return reasons.length === 0 ? output : output + omittedHyperlinksMarker(reasons)
}
