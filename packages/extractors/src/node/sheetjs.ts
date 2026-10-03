import { Effect, Predicate } from 'effect'
import { minimumSheetJsVersion, SheetJsUnavailableError } from '../errors.ts'
import type { XlsxWorkbook } from './xlsx-text.ts'

/** Loads the SheetJS module. The default is a lazy `import('xlsx')`. */
export type SheetJsLoader = () => Promise<unknown>

export const defaultSheetJsLoader: SheetJsLoader = () => import('xlsx')

export type SheetJs = {
  readonly version: string
  /** Parse workbook bytes with `sheetJsReadOptions`; the result is checked before use. */
  readonly read: (bytes: Uint8Array) => unknown
}

/**
 * SheetJS `read` options: cell values and display text (`cell.w`) only.
 *
 * - `cellFormula: false`: no formula text. SheetJS otherwise copies a shifted master formula onto
 *   every shared-formula dependent and scans every earlier array formula for each cell, before
 *   any extractor budget runs. Cached values still render; formula-only cells render empty.
 * - `cellHTML: false`: no rich-text HTML (`cell.h`) we never read. Inline strings ignore it
 *   (SheetJS calls `parse_si` without options), so their rich text is still rendered; the CDATA
 *   check (`sheetJsCouldReadCdata`) does not rely on this option.
 * - `cellText: true`: keep the formatted display text (`cell.w`) the CSV uses. SheetJS formats
 *   every styled cell inside `read`, with work proportional to the format code, so it only ever
 *   reads the generated `xl/styles.xml` (codes of at most 255 characters, `xlsx-styles.ts`).
 * - `cellNF`, `cellStyles`, `cellDates: false`: no format strings or style objects; dates stay
 *   serial numbers whose `cell.w` carries the formatted date (`cellStyles` would also force
 *   `sheetStubs`).
 * - `sheetStubs: false`: no objects for empty cells.
 * - `bookDeps`, `bookFiles`, `bookProps`, `bookSheets`, `bookVBA: false`: no calculation chain,
 *   raw archive, or VBA blob, and a full parse (not the properties-only or names-only modes).
 * - `dense: false`: sheets keyed by address, as `xlsx-text.ts` reads them.
 * - `WTF: false`: per-sheet parse errors skip the sheet instead of throwing.
 *
 * A fresh copy is passed on every call because SheetJS writes defaults into the options object.
 */
export const sheetJsReadOptions = {
  type: 'array',
  cellFormula: false,
  cellHTML: false,
  cellText: true,
  cellNF: false,
  cellStyles: false,
  cellDates: false,
  sheetStubs: false,
  bookDeps: false,
  bookFiles: false,
  bookProps: false,
  bookSheets: false,
  bookVBA: false,
  dense: false,
  WTF: false
} as const

/** SemVer 2.0.0: `major.minor.patch`, optional `-prerelease`, optional `+build`. */
const semver =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*)(?:\.(?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*))*))?(?:\+[0-9a-zA-Z-]+(?:\.[0-9a-zA-Z-]+)*)?$/

type ParsedVersion = {
  readonly release: readonly [number, number, number]
  readonly prerelease: boolean
}

const parseVersion = (version: string): ParsedVersion | undefined => {
  const match = semver.exec(version)

  if (match === null) return undefined

  const release = [Number(match[1]), Number(match[2]), Number(match[3])] as const

  return release.every(Number.isSafeInteger)
    ? { release, prerelease: match[4] !== undefined }
    : undefined
}

/**
 * Compare by SemVer precedence against the minimum release: a prerelease of 0.20.3 is below it,
 * prereleases of later releases are above it, and build metadata is ignored.
 */
const meetsMinimumVersion = (installed: ParsedVersion, minimum: ParsedVersion) => {
  for (const [index, part] of installed.release.entries()) {
    const required = minimum.release[index] ?? 0

    if (part !== required) return part > required
  }

  return !installed.prerelease
}

const isMissingModule = (cause: unknown) =>
  Predicate.hasProperty(cause, 'code') &&
  (cause.code === 'ERR_MODULE_NOT_FOUND' || cause.code === 'MODULE_NOT_FOUND')

/** ESM namespace, or a CommonJS interop namespace whose `default` is the module. */
const sheetJsExports = (namespace: unknown): object | undefined => {
  if (Predicate.hasProperty(namespace, 'read')) return namespace

  if (
    Predicate.hasProperty(namespace, 'default') &&
    Predicate.hasProperty(namespace.default, 'read')
  )
    return namespace.default

  return undefined
}

/**
 * Load SheetJS lazily and refuse anything that is not SheetJS 0.20.3 or newer. The version must be
 * strict SemVer; anything else fails closed as `invalid`.
 */
export const loadSheetJs = (loader: SheetJsLoader) =>
  Effect.gen(function* () {
    const namespace = yield* Effect.tryPromise({
      try: loader,
      catch: cause =>
        new SheetJsUnavailableError({
          reason: isMissingModule(cause) ? 'missing' : 'invalid',
          cause
        })
    })

    const exports = sheetJsExports(namespace)

    if (
      exports === undefined ||
      !Predicate.hasProperty(exports, 'read') ||
      !Predicate.isFunction(exports.read) ||
      !Predicate.hasProperty(exports, 'version') ||
      !Predicate.isString(exports.version)
    )
      return yield* Effect.fail(new SheetJsUnavailableError({ reason: 'invalid' }))

    const { read, version } = exports
    const installed = parseVersion(version)
    const minimum = parseVersion(minimumSheetJsVersion)

    // A version that is not strict SemVer is not a SheetJS release we can vouch for.
    if (installed === undefined || minimum === undefined)
      return yield* Effect.fail(
        new SheetJsUnavailableError({ reason: 'invalid', installedVersion: version })
      )

    if (!meetsMinimumVersion(installed, minimum))
      return yield* Effect.fail(
        new SheetJsUnavailableError({ reason: 'outdated', installedVersion: version })
      )

    const sheetJs: SheetJs = {
      version,
      read: bytes => read(bytes, { ...sheetJsReadOptions })
    }

    return sheetJs
  })

/** Check the parsed workbook shape before reading it. */
export const asXlsxWorkbook = (parsed: unknown): XlsxWorkbook | undefined => {
  if (
    !Predicate.hasProperty(parsed, 'SheetNames') ||
    !Predicate.hasProperty(parsed, 'Sheets') ||
    !Array.isArray(parsed.SheetNames) ||
    !Predicate.isObject(parsed.Sheets)
  )
    return undefined

  const sheetNames: Array<string> = []

  for (const name of parsed.SheetNames) {
    if (!Predicate.isString(name)) return undefined

    sheetNames.push(name)
  }

  return { SheetNames: sheetNames, Sheets: parsed.Sheets }
}
