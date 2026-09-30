/**
 * Shared pieces of the Dropbox and Notion connector conformance runners
 * (`run-dropbox-conformance.ts`, `run-notion-conformance.ts`; not a CLI). Each runner supplies a
 * `ConnectorConformanceRunner` (its cases, seed sources, fixture modules, credential, and ports)
 * and gets the same behaviour as the Microsoft runner, plus the owner-approval and CI gates:
 *
 * - DRY RUN by default: prints every case id, its safety, whether it would run under the chosen
 *   flags, and the seeds it still needs; no network call and no credential read.
 * - `--live --owner-approved --account <label>`: runs against the real API with a
 *   `FetchHttpClient`. `--live` is refused whenever the `CI` environment variable is set to any
 *   non-empty value (`0` and `false` included) and without `--owner-approved` (the repository
 *   owner's explicit approval). The token comes from the environment only, never a flag. The label
 *   is synthetic and non-identifying (it is printed in reports and recorded in fixtures). Read cases
 *   always run; `--allow-writes reversible` adds the write-reversible cases. There is no flag for
 *   write-irreversible cases: neither runner has one.
 * - `--record` (with `--live`) wraps the live client with the conformance `WireRecorder`. After
 *   the run it builds `verified` fixtures for the cases that passed, re-runs each case on replay
 *   against its new fixture, and renders every fixture module plus the seeds module. Only if every
 *   recorded case verified and passed the secret scan does it write them, all or nothing, to a NEW
 *   run directory under the GITIGNORED root `.conformance-recordings/<provider>/<run>/` (a sibling
 *   temp directory published with one rename; an existing destination is refused). It never writes
 *   committed sources, and it prints a review checklist. The staging containment check (lstat per
 *   component; symlinks, dangling ones included, are refused; re-checked before the rename) guards
 *   against accidental misconfiguration such as a symlinked recordings directory, NOT against a
 *   concurrent local process that can already write the workspace: plain Node has no per-component
 *   `openat`/`O_NOFOLLOW`, so a check-then-write window remains.
 * - Live runs are interruptible: the first SIGINT/SIGTERM interrupts the run fiber, so the cases'
 *   uninterruptible cleanups still run; a second signal force-exits (cleanup may be skipped). Before
 *   any write case, a runner's read-only `leftovers` lookup warns about items earlier runs left
 *   behind; nothing is deleted automatically.
 *
 * Promotion is manual: scrub the staged files of practice-account data, copy them into
 * `packages/connectors/src/<provider>/conformance/`, run `pnpm format:fix`, and update the
 * provider's conformance tests (package and runner) in the same change.
 */
import { randomBytes } from 'node:crypto'
import {
  existsSync,
  lstatSync,
  mkdirSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync
} from 'node:fs'
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path'
import process from 'node:process'
import { Cause, Effect, Exit, Fiber, Layer, Option, Predicate, Ref } from 'effect'
import * as Schema from 'effect/Schema'
import { FetchHttpClient, HttpClient } from 'effect/unstable/http'
import type { ConformanceCase, ConformanceSafety } from '../packages/conformance/src/case.ts'
import {
  isWireBase64BodyResponse,
  isWireStreamResponse,
  type WireFixture
} from '../packages/conformance/src/fixture.ts'
import {
  defaultRecordedRequestHeaders,
  makeRecordingHttpClient,
  makeWireFixture,
  type WireRecorderApi
} from '../packages/conformance/src/record.ts'
import { ReplayHttpClient } from '../packages/conformance/src/replay.ts'
import {
  conformanceReportFailed,
  conformanceSkipReason,
  formatConformanceReport,
  runConformance,
  type ConformanceReport,
  type ConformanceSkipReason,
  type ConformanceTarget
} from '../packages/conformance/src/runner.ts'
import {
  isCiEnvironment,
  parseFlags,
  workspaceRoot,
  type ProbeEnv
} from './fixture-probe-internal.ts'

export type SeedSource<K extends string> = {
  readonly key: K
  readonly flag: string
  readonly env: string
  readonly description: string
}

export type CaseSpec<K extends string> = {
  readonly caseId: string
  /** Seeds the case cannot run without. */
  readonly seeds: ReadonlyArray<K>
  /** Seeds the case uses when present (they change the recorded requests). */
  readonly optionalSeeds: ReadonlyArray<K>
  readonly fileName: string
  readonly exportName: string
  readonly doc: string
}

/** Seed identities as plain optional strings, keyed by seed key. */
export type SeedRecord<K extends string> = { readonly [P in K]?: string }

/** Everything a provider runner supplies. `R` is what its cases need from their layer. */
export type ConnectorConformanceRunner<K extends string, S extends SeedRecord<K>, E, R> = {
  /** Lower-case provider name: the recordings directory and `pnpm conformance:<provider>`. */
  readonly provider: string
  /** Display name, for example `Dropbox`. */
  readonly displayName: string
  /** What to run against, for example `a practice Dropbox account`. */
  readonly practiceTarget: string
  /** Environment variable holding the access token (never a flag). */
  readonly tokenEnv: string
  /** What the token must grant, for the usage text. */
  readonly tokenScopes: string
  /** The API base URL recorded as each fixture `endpoint`. */
  readonly endpoint: string
  /** What the write cases do, for the dry-run footer and usage. */
  readonly writeNote: string
  readonly cases: ReadonlyArray<ConformanceCase<E, R>>
  readonly seedSources: ReadonlyArray<SeedSource<K>>
  /**
   * Seeds the live runner generates itself, fresh per invocation (never flags or environment), for
   * example Dropbox's invocation-unique `runId`. Case specs may list them; they are never reported
   * missing, and they are rendered into the staged seeds module like any other seed.
   */
  readonly generatedSeeds?: {
    readonly keys: ReadonlyArray<K>
    readonly generate: () => Partial<Record<K, string>>
  }
  readonly caseSpecs: ReadonlyArray<CaseSpec<K>>
  readonly fixtureSeeds: S
  /** Word for the seeds in the seeds module doc (`paths` or `ids`). */
  readonly seedNoun: string
  /** Type and export names of the committed seeds module, and the config service name. */
  readonly seedsTypeName: string
  readonly seedsExportName: string
  readonly configName: string
  /** Validate raw seed strings into the seeds type (`None` when any is invalid). */
  readonly decodeSeeds: (raw: unknown) => Option.Option<S>
  /** Why seeds are invalid, shown when `decodeSeeds` answers `None`. */
  readonly invalidSeedsMessage: string
  /** The case layer over an `HttpClient`, the access token, and the seeds. */
  readonly casePorts: (
    http: Layer.Layer<HttpClient.HttpClient>,
    accessToken: string,
    seeds: S
  ) => Layer.Layer<R>
  /** Extra request headers the recorder keeps (credential headers are always dropped). */
  readonly recordedRequestHeaders: ReadonlyArray<string>
  /**
   * READ-ONLY lookup of items earlier runs left behind (for example `yolk-conformance-run-*`
   * folders), run over the case ports before any write case; each result becomes one WARN line.
   * Never deletes anything.
   */
  readonly leftovers?: Effect.Effect<ReadonlyArray<string>, E, R>
  /** What to do about a leftover, appended to each WARN line. */
  readonly leftoverAdvice?: string
  /** JSON keys whose string values usually name a person, a file, or a page. */
  readonly nameKeys: RegExp
  /** JSON keys whose string values hold document or message text. */
  readonly textKeys: RegExp
}

/** A runner of any error and requirement type (only its data is read). */
type RunnerData<K extends string, S extends SeedRecord<K>> = Omit<
  ConnectorConformanceRunner<K, S, unknown, never>,
  'cases' | 'casePorts' | 'leftovers'
> & {
  readonly cases: ReadonlyArray<Pick<ConformanceCase<unknown, never>, 'id' | 'safety'>>
}

export type RunOptions<K extends string> = {
  readonly live: boolean
  readonly help: boolean
  readonly record: boolean
  /** Explicit confirmation that the repository owner approved this live run. */
  readonly ownerApproved: boolean
  /** Synthetic, non-identifying account label. Required with `--live`. */
  readonly account: string | undefined
  readonly allowWrites: 'none' | 'reversible'
  /** Raw seed identities from flags or environment (validated before a live run). */
  readonly seeds: Readonly<Partial<Record<K, string>>>
}

export const defaultRunOptions: RunOptions<never> = {
  live: false,
  help: false,
  record: false,
  ownerApproved: false,
  account: undefined,
  allowWrites: 'none',
  seeds: {}
}

const accountLabelPattern = /^[a-z0-9]+(?:-[a-z0-9]+)*$/

export const liveAccountRequiredMessage =
  '--live requires --account <label>: a synthetic, non-identifying label (for example practice)'

export const ownerApprovalRequiredMessage =
  "--live requires --owner-approved: live runs touch a real practice account and need the repository owner's explicit approval"

export const liveInCiMessage =
  "--live is refused in CI (the CI environment variable is set to a non-empty value): live runs touch a real practice account and must be run by hand with the repository owner's approval"

export const accessTokenRequiredMessage = (runner: { readonly tokenEnv: string }) =>
  `${runner.tokenEnv} is required for --live`

export const usage = <K extends string, S extends SeedRecord<K>>(runner: RunnerData<K, S>) =>
  `Usage: pnpm conformance:${runner.provider} [--live --owner-approved --account <label>] [options]

Dry run by default: prints each case, its safety, and whether it would run. No network I/O and no
credential read.

Options:
  --live                          Run against the real ${runner.displayName} API (needs
                                  --owner-approved, ${runner.tokenEnv}, --account, and the seeds
                                  of every case that will run; refused whenever CI is non-empty)
  --owner-approved                confirm the repository owner approved this live run
  --account <label>               required with --live: synthetic, non-identifying label
                                  (lower-case letters, digits, hyphens; for example practice)
  --allow-writes <none|reversible>
                                  default none; reversible runs the write-reversible cases
                                  (they ${runner.writeNote})
  --record                        with --live: record the cases that passed, verify on replay,
                                  and stage them in a new run directory under
                                  .conformance-recordings/${runner.provider}/ (gitignored) for manual
                                  scrubbing and promotion
${runner.seedSources
  .map(
    source =>
      `  ${`${source.flag} <value>`.padEnd(32)}${source.description}\n${' '.repeat(34)}(env ${source.env})`
  )
  .join('\n')}
  --help

${runner.tokenEnv} is read from the environment only: ${runner.tokenScopes}. Use
${runner.practiceTarget}, never a real one, and never run live in CI. Recordings are never written
over committed fixtures: scrub the staged files, copy them into
packages/connectors/src/${runner.provider}/conformance/, and update the ${runner.displayName} conformance
tests in the same change (fixture ids, evidence, and account change).`

/**
 * Parse CLI arguments (without the node/script prefix) and seed environment variables. Throws on
 * unknown flags, missing values, invalid labels, `--record` without `--live`, and `--live` in CI
 * (`CI` non-empty), without `--owner-approved`, or without `--account`.
 */
export const parseRunArgs = <K extends string, S extends SeedRecord<K>>(
  runner: RunnerData<K, S>,
  argv: ReadonlyArray<string>,
  env: ProbeEnv = {}
): RunOptions<K> => {
  let live = false
  let help = false
  let record = false
  let ownerApproved = false
  let account: string | undefined
  let allowWrites: RunOptions<K>['allowWrites'] = 'none'
  const seeds: Partial<Record<K, string>> = {}

  for (const source of runner.seedSources) {
    const value = env[source.env]?.trim()

    if (value !== undefined && value.length > 0) {
      seeds[source.key] = value
    }
  }

  parseFlags(argv, (flag, argument, value) => {
    const seed = runner.seedSources.find(source => source.flag === flag)

    if (seed !== undefined) {
      seeds[seed.key] = value()

      return
    }

    switch (flag) {
      case '--live':
        live = true
        break
      case '--owner-approved':
        ownerApproved = true
        break
      case '--help':
      case '-h':
        help = true
        break
      case '--record':
        record = true
        break
      case '--account': {
        const label = value()

        if (!accountLabelPattern.test(label) || label.length > 40) {
          throw new Error(
            '--account must be a short synthetic label of lower-case letters, digits, and hyphens'
          )
        }

        account = label
        break
      }

      case '--allow-writes': {
        const mode = value()

        if (mode !== 'none' && mode !== 'reversible') {
          throw new Error('--allow-writes must be none or reversible')
        }

        allowWrites = mode
        break
      }

      default:
        throw new Error(`Unknown argument: ${argument}`)
    }
  })

  const options: RunOptions<K> = { live, help, record, ownerApproved, account, allowWrites, seeds }

  if (help) {
    return options
  }

  if (record && !live) {
    throw new Error('--record requires --live')
  }

  if (live && isCiEnvironment(env)) {
    throw new Error(liveInCiMessage)
  }

  if (live && !ownerApproved) {
    throw new Error(ownerApprovalRequiredMessage)
  }

  if (live && account === undefined) {
    throw new Error(liveAccountRequiredMessage)
  }

  return options
}

/** The live target the chosen flags describe (the dry run plans against the same target). */
export const liveTarget = <K extends string>(options: RunOptions<K>): ConformanceTarget => ({
  kind: 'live',
  account: options.account ?? 'dry-run',
  allowWrites: options.allowWrites,
  allowIrreversible: []
})

const generatedKeys = <K extends string, S extends SeedRecord<K>>(
  runner: RunnerData<K, S>
): ReadonlyArray<K> => runner.generatedSeeds?.keys ?? []

/** Every seed key, in seeds-module order: flag/environment seeds, then generated seeds. */
const allSeedKeys = <K extends string, S extends SeedRecord<K>>(
  runner: RunnerData<K, S>
): ReadonlyArray<K> => [...runner.seedSources.map(source => source.key), ...generatedKeys(runner)]

const specFor = <K extends string, S extends SeedRecord<K>>(
  runner: RunnerData<K, S>,
  caseId: string
): CaseSpec<K> | undefined => runner.caseSpecs.find(spec => spec.caseId === caseId)

export type PlannedCase<K extends string> = {
  readonly id: string
  readonly safety: ConformanceSafety
  readonly skipReason: ConformanceSkipReason | undefined
  /** Seeds this case needs that the flags/environment do not supply. */
  readonly missingSeeds: ReadonlyArray<K>
}

/** Pure plan: which cases run live under these flags, and which seeds they still need. */
export const planRun = <K extends string, S extends SeedRecord<K>>(
  runner: RunnerData<K, S>,
  options: RunOptions<K>
): ReadonlyArray<PlannedCase<K>> =>
  runner.cases.map(testCase => ({
    id: testCase.id,
    safety: testCase.safety,
    skipReason: conformanceSkipReason(liveTarget(options), testCase),
    missingSeeds: (specFor(runner, testCase.id)?.seeds ?? []).filter(
      key => options.seeds[key] === undefined && !generatedKeys(runner).includes(key)
    )
  }))

const seedFlag = <K extends string, S extends SeedRecord<K>>(runner: RunnerData<K, S>, key: K) =>
  runner.seedSources.find(source => source.key === key)?.flag ?? key

export const dryRunReport = <K extends string, S extends SeedRecord<K>>(
  runner: RunnerData<K, S>,
  options: RunOptions<K>
): string => {
  const lines = planRun(runner, options).map(entry => {
    const status = entry.skipReason === undefined ? 'RUN ' : 'SKIP'
    const detail = entry.skipReason ?? ''

    const missing =
      entry.skipReason === undefined && entry.missingSeeds.length > 0
        ? `needs ${entry.missingSeeds.map(key => seedFlag(runner, key)).join(', ')}`
        : ''

    return [status, entry.id, `[${entry.safety}]`, detail, missing]
      .filter(part => part.length > 0)
      .join('  ')
  })

  return [
    `DRY RUN: no network request was made and no credential was read. Pass --live --owner-approved --account <label> to run (needs ${runner.tokenEnv}).`,
    `Plan for a live target: allowWrites=${options.allowWrites}${options.record ? ', record' : ''}`,
    ...lines,
    `Use ${runner.practiceTarget} only, with the repository owner's approval; never in CI. Write cases ${runner.writeNote}.`
  ].join('\n')
}

export type LiveInputs<S> = {
  readonly account: string
  readonly accessToken: string
  readonly seeds: S
}

/**
 * Everything a live run needs, or why it must refuse (before any network): CI, a missing owner
 * approval, account label, or access token, missing seeds for cases that will run, or seeds that
 * are not valid. `generated` (fresh from `runner.generatedSeeds` by default) is merged over the
 * flag/environment seeds.
 */
export const liveInputs = <K extends string, S extends SeedRecord<K>>(
  runner: RunnerData<K, S>,
  options: RunOptions<K>,
  env: ProbeEnv,
  generated: Partial<Record<K, string>> = runner.generatedSeeds?.generate() ?? {}
): { readonly refusal: string } | { readonly inputs: LiveInputs<S> } => {
  if (isCiEnvironment(env)) {
    return { refusal: liveInCiMessage }
  }

  if (!options.ownerApproved) {
    return { refusal: ownerApprovalRequiredMessage }
  }

  if (options.account === undefined) {
    return { refusal: liveAccountRequiredMessage }
  }

  const accessToken = env[runner.tokenEnv]?.trim()

  if (accessToken === undefined || accessToken.length === 0) {
    return { refusal: accessTokenRequiredMessage(runner) }
  }

  const missing = planRun(runner, options)
    .filter(entry => entry.skipReason === undefined)
    .flatMap(entry => entry.missingSeeds)

  if (missing.length > 0) {
    const flags = [...new Set(missing)].map(key => seedFlag(runner, key))

    return { refusal: `Missing seed identities for the cases that would run: ${flags.join(', ')}` }
  }

  const seeds = runner.decodeSeeds({ ...options.seeds, ...generated })

  if (Option.isNone(seeds)) {
    return { refusal: runner.invalidSeedsMessage }
  }

  return { inputs: { account: options.account, accessToken, seeds: seeds.value } }
}

export class ConnectorRunFailed extends Schema.TaggedError<ConnectorRunFailed>()(
  'ConnectorRunFailed',
  { message: Schema.String }
) {}

/** Gitignored root of a provider's staged recordings; one new directory per `--record` run. */
export const recordingsRootFor = (provider: string) =>
  join(workspaceRoot, '.conformance-recordings', provider)

const committedSources = join(workspaceRoot, 'packages')

const isInside = (child: string, parent: string): boolean => {
  const path = relative(resolve(parent), resolve(child))

  return path === '' || (!path.startsWith('..') && !isAbsolute(path))
}

export const renderFixtureModule = <K extends string, S extends SeedRecord<K>>(
  runner: RunnerData<K, S>,
  spec: CaseSpec<K>,
  fixture: WireFixture
): string =>
  [
    "import type { WireFixture } from '@yolk-sdk/conformance/fixture'",
    '',
    '/**',
    ` * ${spec.doc}`,
    ' *',
    ` * Verified recording (${fixture.recordedAt}), scrubbed and promoted by hand from`,
    ` * \`pnpm conformance:${runner.provider} --live --owner-approved --account <label> --record\`.`,
    ' */',
    `export const ${spec.exportName}: WireFixture = ${JSON.stringify(fixture, null, 2)}`,
    ''
  ].join('\n')

const quoted = (value: string): string =>
  /^[\w .:/@+=!%-]*$/.test(value) ? `'${value}'` : JSON.stringify(value)

/** The seeds module, in the exact committed format. */
export const renderSeedsModule = <K extends string, S extends SeedRecord<K>>(
  runner: RunnerData<K, S>,
  seeds: SeedRecord<K>
): string => {
  const entries = allSeedKeys(runner).flatMap(key => {
    const value = seeds[key]

    return value === undefined ? [] : [`  ${key}: ${quoted(value)}`]
  })

  return [
    `import type { ${runner.seedsTypeName} } from './cases.ts'`,
    '',
    '/**',
    ` * Seed ${runner.seedNoun} used by the committed ${runner.displayName} fixtures (synthetic until a scrubbed recording is`,
    ` * promoted). Replaying the fixtures needs these exact seeds in \`${runner.configName}\`.`,
    ` * \`pnpm conformance:${runner.provider} --live --owner-approved --account <label> --record\` stages an`,
    ' * updated copy for manual promotion together with the fixtures it records.',
    ' */',
    `export const ${runner.seedsExportName}: ${runner.seedsTypeName} = {`,
    entries.join(',\n'),
    '}',
    ''
  ].join('\n')
}

const seedsUsedBy = <K extends string, S extends SeedRecord<K>>(
  runner: RunnerData<K, S>,
  caseId: string
): ReadonlyArray<K> => {
  const spec = specFor(runner, caseId)

  return spec === undefined ? [] : [...spec.seeds, ...spec.optionalSeeds]
}

/** Seeds for the committed fixtures after recording `recorded` with `live` seeds. */
export const mergedFixtureSeeds = <K extends string, S extends SeedRecord<K>>(
  runner: RunnerData<K, S>,
  current: SeedRecord<K>,
  live: SeedRecord<K>,
  recorded: ReadonlyArray<string>
): Partial<Record<K, string>> => {
  const keys = new Set(recorded.flatMap(caseId => seedsUsedBy(runner, caseId)))
  const merged: Partial<Record<K, string>> = {}

  for (const key of allSeedKeys(runner)) {
    const value = keys.has(key) ? live[key] : current[key]

    if (value !== undefined) {
      merged[key] = value
    }
  }

  return merged
}

/**
 * Seeds that changed in the merged seeds module but are also used by committed fixtures that were
 * NOT recorded in this run: those fixtures no longer replay with the new seeds.
 */
export const staleSharedSeeds = <K extends string, S extends SeedRecord<K>>(
  runner: RunnerData<K, S>,
  current: SeedRecord<K>,
  merged: SeedRecord<K>,
  recorded: ReadonlyArray<string>
): ReadonlyArray<{ readonly key: K; readonly cases: ReadonlyArray<string> }> =>
  runner.seedSources.flatMap(({ key }) => {
    // Generated seeds (a run id) are rewritten to the committed value instead; see the checklist.
    if (current[key] === merged[key]) {
      return []
    }

    const cases = runner.caseSpecs.flatMap(spec =>
      !recorded.includes(spec.caseId) && seedsUsedBy(runner, spec.caseId).includes(key)
        ? [spec.caseId]
        : []
    )

    return cases.length === 0 ? [] : [{ key, cases }]
  })

/**
 * Directory-level file side effects of `--record`; injectable so the staging gate is tested
 * offline without touching the filesystem.
 */
export type RecordingWriter = {
  readonly exists: (path: string) => boolean
  /** Create a directory and any missing parents. */
  readonly mkdir: (path: string) => void
  readonly writeFile: (path: string, contents: string) => void
  /** Rename a directory in one step (same filesystem). */
  readonly rename: (from: string, to: string) => void
  /** Remove a directory and everything in it. */
  readonly rm: (path: string) => void
  /** The canonical physical path (symlinks resolved) of an existing path; `undefined` when absent. */
  readonly realpath: (path: string) => string | undefined
  /**
   * What is at `path` WITHOUT following it (lstat): nothing, something refused (a symbolic link,
   * dangling ones included, or an entry that cannot be inspected), or an entry and its canonical path.
   */
  readonly inspect: (path: string) => PathInspection
}

export type PathInspection =
  | { readonly kind: 'missing' }
  | { readonly kind: 'refused' }
  | { readonly kind: 'present'; readonly realpath: string }

const errnoCode = (error: unknown): unknown =>
  Predicate.hasProperty(error, 'code') ? error.code : undefined

export const nodeRecordingWriter: RecordingWriter = {
  exists: path => existsSync(path),
  mkdir: path => {
    mkdirSync(path, { recursive: true })
  },
  writeFile: (path, contents) => {
    writeFileSync(path, contents, { flag: 'wx' })
  },
  rename: (from, to) => {
    renameSync(from, to)
  },
  rm: path => {
    rmSync(path, { recursive: true, force: true })
  },
  realpath: path => (existsSync(path) ? realpathSync(path) : undefined),
  inspect: path => {
    try {
      return lstatSync(path).isSymbolicLink()
        ? { kind: 'refused' }
        : { kind: 'present', realpath: realpathSync(path) }
    } catch (error) {
      return errnoCode(error) === 'ENOENT' ? { kind: 'missing' } : { kind: 'refused' }
    }
  }
}

/** A unique run directory name, `<YYYY-MM-DD>T<HHMMSS>Z-<suffix>` (UTC). */
export const recordingRunId = (now: Date, suffix: string): string => {
  const iso = now.toISOString()

  return `${iso.slice(0, 10)}T${iso.slice(11, 19).replaceAll(':', '')}Z-${suffix}`
}

const randomRunSuffix = (): string => randomBytes(4).toString('hex')

/** Email-address domains the committed fixtures may contain. */
const allowedEmailDomains = ['example.test', 'example.com']

const emailPattern = /[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g

const isAllowedEmail = (email: string): boolean => {
  const domain = email.slice(email.lastIndexOf('@') + 1).toLowerCase()

  return allowedEmailDomains.some(allowed => domain === allowed || domain.endsWith(`.${allowed}`))
}

type ReviewKeys = { readonly nameKeys: RegExp; readonly textKeys: RegExp }

type ReviewFindings = {
  readonly emails: Set<string>
  readonly names: Set<string>
  readonly texts: Set<string>
}

const collectStrings = (
  value: unknown,
  key: string | undefined,
  keys: ReviewKeys,
  found: ReviewFindings
): void => {
  if (Predicate.isString(value)) {
    for (const email of value.match(emailPattern) ?? []) {
      if (!isAllowedEmail(email)) {
        found.emails.add(email)
      }
    }

    if (key !== undefined && value.trim().length > 0) {
      if (keys.textKeys.test(key)) found.texts.add(value)
      else if (keys.nameKeys.test(key)) found.names.add(value)
    }

    return
  }

  if (Array.isArray(value)) {
    for (const item of value) collectStrings(item, key, keys, found)

    return
  }

  if (Predicate.isObject(value)) {
    for (const [childKey, child] of Object.entries(value)) {
      collectStrings(child, childKey, keys, found)
    }
  }
}

/** Text as JSON when it parses, otherwise the raw text (still scanned for emails). */
const parsedText = (text: string): unknown => {
  try {
    return JSON.parse(text)
  } catch {
    return text
  }
}

const quotedList = (values: ReadonlySet<string>): string =>
  [...values].map(value => JSON.stringify(value)).join(', ')

/**
 * What a person must check in each staged fixture before promoting it: email-like strings outside
 * `example.test`/`example.com`, names (files, pages, people), document text, and binary bodies. The
 * script only lists candidates; it does not decide what is personal data.
 */
export const recordingReviewChecklist = <K extends string, S extends SeedRecord<K>>(
  runner: RunnerData<K, S>,
  recorded: ReadonlyArray<{ readonly spec: CaseSpec<K>; readonly fixture: WireFixture }>,
  seeds?: SeedRecord<K>
): ReadonlyArray<string> => {
  const lines = [
    'REVIEW before promoting (staged files hold practice-account data):',
    '  also check ids, paths, URLs, cursors, and request ids by hand'
  ]

  for (const { spec, fixture } of recorded) {
    const found: ReviewFindings = { emails: new Set(), names: new Set(), texts: new Set() }
    let binaryBodies = 0

    for (const exchange of fixture.exchanges) {
      collectStrings(exchange.request.url, undefined, runner, found)
      collectStrings(
        Object.values(exchange.request.headers ?? {}).map(parsedText),
        undefined,
        runner,
        found
      )
      collectStrings(exchange.request.body, undefined, runner, found)
      collectStrings(Object.values(exchange.response.headers), undefined, runner, found)

      const { response } = exchange

      if (isWireBase64BodyResponse(response)) {
        binaryBodies += 1
      } else if (isWireStreamResponse(response)) {
        const text = response.chunks.map(chunk => (Predicate.isString(chunk) ? chunk : '')).join('')

        binaryBodies += response.chunks.some(chunk => !Predicate.isString(chunk)) ? 1 : 0
        collectStrings(parsedText(text), undefined, runner, found)
      } else {
        collectStrings(parsedText(response.body), undefined, runner, found)
      }
    }

    const items = [
      found.emails.size > 0
        ? `emails outside ${allowedEmailDomains.join('/')}: ${quotedList(found.emails)}`
        : undefined,
      found.names.size > 0 ? `names: ${quotedList(found.names)}` : undefined,
      found.texts.size > 0 ? `text: ${quotedList(found.texts)}` : undefined,
      binaryBodies > 0 ? `${binaryBodies} binary body: open it and check its content` : undefined
    ].filter(Predicate.isNotUndefined)

    lines.push(
      `  ${spec.fileName}: ${items.length === 0 ? 'no candidates found; still read it' : ''}`.trimEnd(),
      ...items.map(item => `    - ${item}`)
    )
  }

  if (seeds !== undefined) {
    const values = runner.seedSources.flatMap(({ key }) => {
      const value = seeds[key]

      return value === undefined ? [] : [`${key}=${JSON.stringify(value)}`]
    })

    // Generated seeds (a run id) are random, not account data: rewrite them to the committed value.
    const generated = generatedKeys(runner).flatMap(key => {
      const value = seeds[key]
      const committed = runner.fixtureSeeds[key]

      return value === undefined || committed === undefined || value === committed
        ? []
        : [
            `    - ${key}=${JSON.stringify(value)} is generated per run, not account data: rewrite it to ${JSON.stringify(committed)} in the staged fixtures and seeds.ts before promoting`
          ]
    })

    lines.push(
      `  seeds.ts: ${values.length === 0 ? 'no account seeds' : 'every account seed names practice-account data; replace each with a synthetic value'}`,
      ...(values.length === 0 ? [] : [`    - seeds: ${values.join(', ')}`]),
      ...generated
    )
  }

  lines.push(
    `PROMOTE by hand: scrub, copy into packages/connectors/src/${runner.provider}/conformance/, run pnpm format:fix,`,
    `  and update the ${runner.displayName} conformance tests in the same change (fixture ids, evidence, account change).`
  )

  return lines
}

type RecordedFixture<K extends string> = {
  readonly caseId: string
  readonly spec: CaseSpec<K>
  readonly fixture: WireFixture
}

/** Build a verified fixture for one passed case and prove it replays with the same case. */
const verifiedFixture = <K extends string, S extends SeedRecord<K>, E, R>(
  runner: ConnectorConformanceRunner<K, S, E, R>,
  testCase: ConformanceCase<E, R>,
  recorder: WireRecorderApi,
  inputs: LiveInputs<S>,
  recordedAt: string
) =>
  Effect.gen(function* () {
    const spec = specFor(runner, testCase.id)

    if (spec === undefined) {
      return yield* new ConnectorRunFailed({ message: `No fixture module for ${testCase.id}` })
    }

    const exchanges = yield* recorder.drain

    const fixture = yield* makeWireFixture({
      id: `${testCase.id}.recorded`,
      caseId: testCase.id,
      evidence: 'verified',
      recordedAt,
      account: inputs.account,
      endpoint: runner.endpoint,
      note: `Recorded from ${runner.practiceTarget} by pnpm conformance:${runner.provider} --live --record.`,
      exchanges
    })

    const replayed = yield* runConformance([testCase], {
      target: { kind: 'replay' },
      layer: () =>
        runner.casePorts(ReplayHttpClient.layer([fixture]), 'replay-access-token', inputs.seeds)
    })

    if (conformanceReportFailed(replayed)) {
      return yield* new ConnectorRunFailed({
        message: `${testCase.id} did not pass on replay of its recording; nothing was written`
      })
    }

    const recorded: RecordedFixture<K> = { caseId: testCase.id, spec, fixture }

    return recorded
  }).pipe(
    Effect.mapError(error =>
      error instanceof ConnectorRunFailed
        ? error
        : new ConnectorRunFailed({
            message: `${testCase.id}: recording rejected (${error._tag}); nothing was written`
          })
    )
  )

export type StageRecordingsOptions = {
  readonly writer: RecordingWriter
  /** The gitignored recordings root (defaults to the provider's `recordingsRootFor`). */
  readonly recordingsRoot?: string
  /**
   * The directory the recordings root must physically stay inside (defaults to the workspace
   * root): every existing component between it and the run directory must resolve to exactly that
   * lexical location, so no symlink can redirect the writes.
   */
  readonly containmentRoot?: string
  /** The run directory to publish; must be a new, direct child of the recordings root. */
  readonly stagingDir: string
  /** `recordedAt` of the staged fixtures (`YYYY-MM-DD`). */
  readonly recordedAt: string
}

/**
 * True when every existing component of each path below `base` is a real entry (never a symbolic
 * link, dangling ones included) whose canonical path is exactly its lexical location under the
 * canonical `base`. A path outside `base` never is. This guards against accidental
 * misconfiguration, not a concurrent local process that can already write the workspace.
 */
export const physicallyContained = (
  writer: Pick<RecordingWriter, 'realpath' | 'inspect'>,
  base: string,
  paths: ReadonlyArray<string>
): boolean => {
  const canonicalBase = writer.realpath(base)

  if (canonicalBase === undefined) {
    return false
  }

  return paths.every(path => {
    const rest = relative(base, resolve(path))

    if (rest.startsWith('..') || isAbsolute(rest)) {
      return false
    }

    let current = base

    for (const part of rest.split(/[\\/]/).filter(segment => segment.length > 0)) {
      current = join(current, part)

      const inspected = writer.inspect(current)

      if (inspected.kind === 'missing') {
        return true
      }

      if (
        inspected.kind === 'refused' ||
        inspected.realpath !== join(canonicalBase, relative(base, current))
      ) {
        return false
      }
    }

    return true
  })
}

export type StagedRecordings = {
  readonly stagingDir: string
  readonly files: ReadonlyArray<string>
  readonly checklist: ReadonlyArray<string>
}

/**
 * The `--record` gate. Verifies every passed case's recording on replay (and the secret scan), then
 * renders every fixture module and the seeds module, writes them all into a sibling temp directory
 * (`<root>/.tmp-<run>`), and publishes that directory to `options.stagingDir` with one rename.
 * All or nothing: any failure leaves no staging directory, and the temp directory is removed (best
 * effort). A staging directory that is not a direct child of the recordings root, or that already
 * exists, is refused. Returns `undefined` when no case passed.
 */
export const stageRecordings = <K extends string, S extends SeedRecord<K>, E, R>(
  runner: ConnectorConformanceRunner<K, S, E, R>,
  report: ConformanceReport,
  recorders: ReadonlyMap<string, WireRecorderApi>,
  inputs: LiveInputs<S>,
  options: StageRecordingsOptions
): Effect.Effect<StagedRecordings | undefined, ConnectorRunFailed> =>
  Effect.gen(function* () {
    const root = resolve(options.recordingsRoot ?? recordingsRootFor(runner.provider))
    const stagingDir = resolve(options.stagingDir)
    const runName = basename(stagingDir)

    if (isInside(root, committedSources)) {
      return yield* new ConnectorRunFailed({
        message: `Refusing a recordings root inside committed package sources (${root}); nothing was written`
      })
    }

    if (dirname(stagingDir) !== root || runName.startsWith('.')) {
      return yield* new ConnectorRunFailed({
        message: `Refusing to stage recordings outside the recordings root (${root}); nothing was written`
      })
    }

    const { writer } = options
    const tempDir = join(root, `.tmp-${runName}`)
    const base = resolve(options.containmentRoot ?? workspaceRoot)

    const refuseRedirect = Effect.suspend(() =>
      physicallyContained(writer, base, [root, tempDir, stagingDir])
        ? Effect.void
        : Effect.fail(
            new ConnectorRunFailed({
              message: `Refusing recordings under a symlinked or redirected directory (${root}); nothing was written`
            })
          )
    )

    yield* refuseRedirect

    const refuseExisting = Effect.suspend(() =>
      writer.exists(stagingDir) || writer.exists(tempDir)
        ? Effect.fail(
            new ConnectorRunFailed({
              message: `Refusing to overwrite ${stagingDir}; nothing was written`
            })
          )
        : Effect.void
    )

    yield* refuseExisting

    const recorded: Array<RecordedFixture<K>> = []

    for (const result of report.results.filter(entry => entry.status === 'passed')) {
      const testCase = runner.cases.find(candidate => candidate.id === result.id)
      const recorder = recorders.get(result.id)

      if (testCase === undefined || recorder === undefined) {
        return yield* new ConnectorRunFailed({ message: `No recording for ${result.id}` })
      }

      recorded.push(yield* verifiedFixture(runner, testCase, recorder, inputs, options.recordedAt))
    }

    if (recorded.length === 0) {
      return undefined
    }

    const recordedIds = recorded.map(({ caseId }) => caseId)
    const seeds = mergedFixtureSeeds(runner, runner.fixtureSeeds, inputs.seeds, recordedIds)

    // Everything verified: render every file before writing any of them.
    const files = [
      ...recorded.map(({ spec, fixture }) => ({
        name: spec.fileName,
        contents: renderFixtureModule(runner, spec, fixture)
      })),
      { name: 'seeds.ts', contents: renderSeedsModule(runner, seeds) }
    ]

    yield* refuseExisting
    yield* refuseRedirect

    yield* Effect.try({
      try: () => {
        writer.mkdir(tempDir)

        // Re-check after creating the temp directory, before any file is written.
        if (!physicallyContained(writer, base, [tempDir])) {
          throw new Error('recordings directory redirected')
        }

        for (const file of files) {
          writer.writeFile(join(tempDir, file.name), file.contents)
        }

        // Re-check the temp and target directories immediately before publishing.
        if (!physicallyContained(writer, base, [tempDir, stagingDir])) {
          throw new Error('recordings directory redirected')
        }

        // Publish the complete batch in one step, only after every file is written.
        writer.rename(tempDir, stagingDir)
      },
      catch: () => {
        try {
          writer.rm(tempDir)
        } catch {
          // Best effort: the temp directory is gitignored and never read as a staged run.
        }

        return new ConnectorRunFailed({
          message: `Writing the staged recordings failed; nothing was staged in ${stagingDir}`
        })
      }
    })

    const stale = staleSharedSeeds(runner, runner.fixtureSeeds, seeds, recordedIds)

    return {
      stagingDir,
      files: files.map(file => join(stagingDir, file.name)),
      checklist: [
        ...recordingReviewChecklist(runner, recorded, seeds),
        ...stale.map(
          ({ key, cases }) =>
            `SHARED SEED ${key} changed: the committed fixtures of ${cases.join(', ')} still use the old value; re-record them or keep the old seed.`
        )
      ]
    }
  })

/**
 * WARN lines for items earlier runs left behind, from the runner's READ-ONLY `leftovers` lookup.
 * Runs only when a write case would run under these flags; a failed lookup becomes one WARN line
 * (it never stops the run), and nothing is ever deleted.
 */
export const leftoverWarnings = <K extends string, S extends SeedRecord<K>, E, R>(
  runner: ConnectorConformanceRunner<K, S, E, R>,
  options: RunOptions<K>,
  inputs: LiveInputs<S>,
  http: Layer.Layer<HttpClient.HttpClient>
): Effect.Effect<ReadonlyArray<string>> => {
  const lookup = runner.leftovers

  const writes = planRun(runner, options).some(
    entry => entry.skipReason === undefined && entry.safety !== 'read'
  )

  if (lookup === undefined || !writes) {
    return Effect.succeed([])
  }

  const advice = runner.leftoverAdvice ?? 'check it and remove it by hand'

  return lookup.pipe(
    Effect.provide(runner.casePorts(http, inputs.accessToken, inputs.seeds)),
    Effect.exit,
    Effect.map(exit =>
      Exit.isSuccess(exit)
        ? exit.value.map(
            item =>
              `WARN leftover from an earlier run: ${item}; ${advice} (nothing is deleted automatically)`
          )
        : [
            'WARN could not look for leftovers of earlier runs (lookup failed); check for them by hand'
          ]
    )
  )
}

const runLive = <K extends string, S extends SeedRecord<K>, E, R>(
  runner: ConnectorConformanceRunner<K, S, E, R>,
  options: RunOptions<K>,
  env: ProbeEnv
) =>
  Effect.gen(function* () {
    const checked = liveInputs(runner, options, env)

    if ('refusal' in checked) {
      return yield* new ConnectorRunFailed({ message: checked.refusal })
    }

    const inputs = checked.inputs
    const recorders = yield* Ref.make(new Map<string, WireRecorderApi>())

    const recorderOptions = {
      requestHeaders: [...defaultRecordedRequestHeaders, ...runner.recordedRequestHeaders]
    }

    const httpFor = (testCase: ConformanceCase<E, R>): Layer.Layer<HttpClient.HttpClient> =>
      options.record
        ? Layer.unwrap(
            Effect.gen(function* () {
              const upstream = yield* HttpClient.HttpClient
              const { client, recorder } = yield* makeRecordingHttpClient(upstream, recorderOptions)

              yield* Ref.update(recorders, current => new Map(current).set(testCase.id, recorder))

              return Layer.succeed(HttpClient.HttpClient, client)
            })
          ).pipe(Layer.provide(FetchHttpClient.layer))
        : FetchHttpClient.layer

    for (const line of yield* leftoverWarnings(runner, options, inputs, FetchHttpClient.layer)) {
      console.log(line)
    }

    const report = yield* runConformance(runner.cases, {
      target: liveTarget(options),
      layer: testCase => runner.casePorts(httpFor(testCase), inputs.accessToken, inputs.seeds)
    })

    console.log(formatConformanceReport(report))

    if (options.record) {
      const now = new Date()
      const root = recordingsRootFor(runner.provider)

      const staged = yield* stageRecordings(runner, report, yield* Ref.get(recorders), inputs, {
        writer: nodeRecordingWriter,
        stagingDir: join(root, recordingRunId(now, randomRunSuffix())),
        recordedAt: now.toISOString().slice(0, 10)
      })

      if (staged === undefined) {
        console.log('No passed case to record.')
      } else {
        console.log(
          [
            `Staged ${staged.files.length} files (gitignored) in ${relative(workspaceRoot, staged.stagingDir)}; nothing committed was changed.`,
            ...staged.checklist
          ].join('\n')
        )
      }
    }

    if (conformanceReportFailed(report)) {
      process.exitCode = 1
    }
  })

/** Parse `process.argv`, then print usage, the dry run, or run live. Sets `process.exitCode`. */
export const runConnectorConformanceCli = <K extends string, S extends SeedRecord<K>, E, R>(
  runner: ConnectorConformanceRunner<K, S, E, R>
): void => {
  let options: RunOptions<K>

  try {
    options = parseRunArgs(runner, process.argv.slice(2), process.env)
  } catch (error) {
    console.error(error instanceof Error ? error.message : error)
    process.exitCode = 1

    return
  }

  if (options.help) {
    console.log(usage(runner))
  } else if (!options.live) {
    console.log(dryRunReport(runner, options))
  } else {
    void runInterruptibly(runLive(runner, options, process.env), processSignals, processCliIo)
  }
}

export type CliSignal = 'SIGINT' | 'SIGTERM'

/** Where termination signals come from; injectable so tests never send real signals. */
export type SignalSource = {
  readonly on: (signal: CliSignal, handler: () => void) => void
  readonly off: (signal: CliSignal, handler: () => void) => void
}

/** Console output and process exit; injectable for tests. */
export type CliIo = {
  readonly error: (message: string) => void
  readonly setExitCode: (code: number) => void
  readonly forceExit: (code: number) => void
}

const processSignals: SignalSource = {
  on: (signal, handler) => {
    process.on(signal, handler)
  },
  off: (signal, handler) => {
    process.off(signal, handler)
  }
}

const processCliIo: CliIo = {
  error: message => console.error(message),
  setExitCode: code => {
    process.exitCode = code
  },
  forceExit: code => process.exit(code)
}

const cliSignals: ReadonlyArray<CliSignal> = ['SIGINT', 'SIGTERM']

/**
 * Run `program` so that the first SIGINT/SIGTERM INTERRUPTS its fiber (the cases' uninterruptible
 * cleanups then still run, and the run waits for them) instead of killing the process, and a second
 * signal force-exits with a message that cleanup may have been skipped. Resolves when the program
 * ends: an interruption sets exit code 130, a failure prints its message and sets exit code 1.
 */
export const runInterruptibly = <E>(
  program: Effect.Effect<void, E>,
  signals: SignalSource,
  io: CliIo
): Promise<void> => {
  const fiber = Effect.runFork(program)
  let interrupting = false

  const handlers = cliSignals.map(signal => {
    const handler = () => {
      if (interrupting) {
        io.error(
          `Second ${signal}: exiting now. Cleanup of case-created items may not have run; the next live run warns about leftovers, or check for yolk-conformance items by hand.`
        )
        io.forceExit(130)

        return
      }

      interrupting = true
      io.error(
        `${signal}: interrupting the run; cleanup of case-created items still runs. Send ${signal} again to exit without waiting.`
      )
      Effect.runFork(Fiber.interrupt(fiber))
    }

    signals.on(signal, handler)

    return { signal, handler }
  })

  return Effect.runPromise(Fiber.await(fiber)).then(exit => {
    for (const { signal, handler } of handlers) {
      signals.off(signal, handler)
    }

    if (Exit.isSuccess(exit)) {
      return
    }

    if (Cause.hasInterruptsOnly(exit.cause)) {
      io.error('Interrupted: the run stopped after the cleanups of the running case.')
      io.setExitCode(130)

      return
    }

    const error = Cause.squash(exit.cause)

    io.error(error instanceof Error ? error.message : String(error))
    io.setExitCode(1)
  })
}
