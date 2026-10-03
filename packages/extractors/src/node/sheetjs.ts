import { Effect, Predicate } from 'effect'
import { minimumSheetJsVersion, SheetJsUnavailableError } from '../errors.ts'
import type { XlsxWorkbook } from './xlsx-text.ts'

/** Loads the SheetJS module. The default is a lazy `import('xlsx')`. */
export type SheetJsLoader = () => Promise<unknown>

export const defaultSheetJsLoader: SheetJsLoader = () => import('xlsx')

export type SheetJs = {
  readonly version: string
  /** Parse workbook bytes; the result is checked before use. */
  readonly read: (bytes: Uint8Array) => unknown
}

const versionParts = (version: string) => {
  const match = /^(\d+)\.(\d+)\.(\d+)/.exec(version)

  return match === null ? undefined : [Number(match[1]), Number(match[2]), Number(match[3])]
}

const isAtLeastMinimumVersion = (version: string) => {
  const installed = versionParts(version)
  const minimum = versionParts(minimumSheetJsVersion)

  if (installed === undefined || minimum === undefined) return false

  for (const [index, part] of installed.entries()) {
    const required = minimum[index] ?? 0

    if (part !== required) return part > required
  }

  return true
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

/** Load SheetJS lazily and refuse anything that is not SheetJS 0.20.3 or newer. */
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

    if (!isAtLeastMinimumVersion(version))
      return yield* Effect.fail(
        new SheetJsUnavailableError({ reason: 'outdated', installedVersion: version })
      )

    const sheetJs: SheetJs = {
      version,
      read: bytes => read(bytes, { type: 'array' })
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

/** The workbook title from its core properties, when SheetJS read one. */
export const workbookTitle = (parsed: unknown) => {
  if (!Predicate.hasProperty(parsed, 'Props') || !Predicate.hasProperty(parsed.Props, 'Title'))
    return undefined

  const title = parsed.Props.Title

  return Predicate.isString(title) && title.trim().length > 0 ? title : undefined
}
