/**
 * Pure decisions for `pnpm models:check` (`patterns/FORMAL_VERIFICATION.md`): what a model's
 * manifest must hold, whether its checks came out as declared, and whether the code it covers
 * changed since the model was last confirmed against it. Not a CLI; `check-formal-models.ts` runs
 * it.
 */
import { createHash } from 'node:crypto'
import { Data, Schema } from 'effect'

const CoveredFile = Schema.Struct({ path: Schema.String, sha256: Schema.String })

/** One configuration of the model, and what everystate must answer for it. */
const ModelCheck = Schema.Struct({
  config: Schema.String,
  /** The invariant this configuration must break; absent, the configuration must pass. */
  violates: Schema.optional(Schema.String)
})

const ModelManifest = Schema.Struct({
  spec: Schema.String,
  promise: Schema.String,
  covers: Schema.Array(CoveredFile),
  checks: Schema.Array(ModelCheck)
})

export type ModelManifest = typeof ModelManifest.Type

export type ModelCheck = typeof ModelCheck.Type

export const ModelManifestJson = Schema.fromJsonString(ModelManifest)

/** The one JSON line `everystate -json` prints, as far as the check reads it. */
const EverystateResult = Schema.Struct({
  status: Schema.String,
  name: Schema.optional(Schema.String),
  distinct: Schema.optional(Schema.Number),
  message: Schema.optional(Schema.String)
})

export type EverystateResult = typeof EverystateResult.Type

export const EverystateResultJson = Schema.fromJsonString(EverystateResult)

export const sha256 = (text: string) => createHash('sha256').update(text).digest('hex')

// Names inside the manifest's own folder: no path separators, so a manifest cannot point outside.
const isPlainFileName = (name: string) =>
  name !== '' && !name.includes('/') && !name.includes('\\') && name !== '.' && name !== '..'

// Repository-relative paths only.
const isRepositoryPath = (path: string) =>
  path !== '' &&
  !path.startsWith('/') &&
  !path.includes('\\') &&
  path.split('/').every(segment => segment !== '' && segment !== '.' && segment !== '..')

/** What a manifest itself must hold, before anything is run. */
export const manifestProblems = (manifest: ModelManifest): ReadonlyArray<string> => [
  ...(isPlainFileName(manifest.spec) ? [] : [`spec \`${manifest.spec}\` is not a file name`]),
  ...(manifest.promise.trim() === '' ? ['the promise is empty'] : []),
  ...(manifest.covers.length === 0 ? ['covers no code'] : []),
  ...manifest.covers.flatMap(file =>
    isRepositoryPath(file.path) ? [] : [`covered path \`${file.path}\` is not repository-relative`]
  ),
  ...manifest.covers.flatMap((file, index) =>
    manifest.covers.findIndex(other => other.path === file.path) === index
      ? []
      : [`covered path \`${file.path}\` is listed twice`]
  ),
  ...manifest.checks.flatMap(check =>
    isPlainFileName(check.config) ? [] : [`config \`${check.config}\` is not a file name`]
  ),
  ...(manifest.checks.some(check => check.violates === undefined)
    ? []
    : ['no configuration that must pass']),
  ...(manifest.checks.some(check => check.violates !== undefined)
    ? []
    : ['no configuration that must fail (a check never seen failing proves nothing)'])
]

export type CheckVerdict = Data.TaggedEnum<{
  /** everystate answered as the manifest declares: a pass, or the declared violation. */
  Matched: {
    readonly config: string
    readonly violates: string | undefined
    readonly states: number | undefined
  }
  /** It answered something else, or could not run the model. */
  Unexpected: { readonly config: string; readonly message: string }
}>

export const CheckVerdict = Data.taggedEnum<CheckVerdict>()

const describeResult = (result: EverystateResult) =>
  [result.status, result.name, result.message].filter(part => part !== undefined).join(': ')

/** Compares one configuration's result with what its manifest declares. */
export const checkVerdict = (check: ModelCheck, result: EverystateResult): CheckVerdict => {
  if (check.violates === undefined) {
    return result.status === 'ok'
      ? CheckVerdict.Matched({ config: check.config, violates: undefined, states: result.distinct })
      : CheckVerdict.Unexpected({
          config: check.config,
          message: `must pass, got ${describeResult(result)}`
        })
  }

  return result.status === 'invariant' && result.name === check.violates
    ? CheckVerdict.Matched({
        config: check.config,
        violates: check.violates,
        states: result.distinct
      })
    : CheckVerdict.Unexpected({
        config: check.config,
        message: `must violate ${check.violates}, got ${describeResult(result)}`
      })
}

/** A covered file as it is now: its text, or undefined when it no longer exists. */
export type CoveredFileNow = { readonly path: string; readonly text: string | undefined }

export type CoverageDrift = Data.TaggedEnum<{
  Changed: { readonly path: string; readonly recorded: string; readonly current: string }
  Missing: { readonly path: string }
}>

export const CoverageDrift = Data.taggedEnum<CoverageDrift>()

/** Covered files whose content differs from the hash recorded when the model was last confirmed. */
export const coverageDrift = (
  manifest: ModelManifest,
  current: ReadonlyArray<CoveredFileNow>
): ReadonlyArray<CoverageDrift> =>
  manifest.covers.flatMap<CoverageDrift>(covered => {
    const text = current.find(file => file.path === covered.path)?.text

    if (text === undefined) return [CoverageDrift.Missing({ path: covered.path })]

    const now = sha256(text)

    return now === covered.sha256
      ? []
      : [CoverageDrift.Changed({ path: covered.path, recorded: covered.sha256, current: now })]
  })

const escapeRegExp = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/**
 * The manifest text with each changed file's hash replaced in place, matched by its path, so the
 * file keeps its formatting. Undefined when a covered file is missing (a moved or deleted file
 * needs `covers` edited) or an entry is not written as `"path": ..., "sha256": ...`.
 */
export const syncedManifestText = (text: string, drift: ReadonlyArray<CoverageDrift>) =>
  drift.reduce<string | undefined>(
    (synced, entry) =>
      synced === undefined
        ? undefined
        : CoverageDrift.$match(entry, {
            Missing: () => undefined,
            Changed: ({ path, recorded, current }) => {
              const pattern = new RegExp(
                `("path"\\s*:\\s*"${escapeRegExp(path)}"\\s*,\\s*"sha256"\\s*:\\s*")` +
                  `${escapeRegExp(recorded)}"`
              )

              return pattern.test(synced) ? synced.replace(pattern, `$1${current}"`) : undefined
            }
          }),
    text
  )
