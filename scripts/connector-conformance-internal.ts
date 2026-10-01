/**
 * Shared pieces of the Dropbox, Notion, Todoist, Telegram, GitHub, and Google connector conformance
 * runners (`run-dropbox-conformance.ts`, `run-notion-conformance.ts`, `run-todoist-conformance.ts`,
 * `run-telegram-conformance.ts`, `run-github-conformance.ts`, `run-google-conformance.ts`; not a
 * CLI). Each runner supplies a
 * `ConnectorConformanceRunner` (its cases, seed sources, fixture modules, credential, and ports)
 * and gets the same behaviour as the Microsoft runner, plus the owner-approval and CI gates. The
 * Fortnox runner (`run-fortnox-conformance.ts`) keeps its own module and imports individual exports
 * from here (its import list is the only list of them; see `scripts/AGENTS.md`):
 *
 * - DRY RUN by default: prints every case id, its safety, whether it would run under the chosen
 *   flags, and the seeds it still needs; no network call and no credential read.
 * - `--live --owner-approved --account <label>`: runs against the real API with a
 *   `FetchHttpClient`. `--live` is refused whenever the `CI` environment variable is set to any
 *   non-empty value (`0` and `false` included) and without `--owner-approved` (the repository
 *   owner's explicit approval). The token comes from the environment only, never a flag. The label
 *   is synthetic and non-identifying (it is printed in reports and recorded in fixtures). Read cases
 *   always run; `--allow-writes reversible` adds the write-reversible cases. A write-irreversible
 *   case runs only when named by its exact id with `--allow-irreversible <case-id>` (repeatable),
 *   independent of `--allow-writes`; the flag exists only for runners that have such a case (today
 *   Telegram, GitHub, and Google), and is an unknown argument everywhere else.
 * - A runner whose provider puts the credential in request URLs (Telegram's `/bot<token>/`)
 *   supplies `scrubRecording` and `replayAccessToken`: recorded exchanges have the live token
 *   replaced before the fixture is built, and replay verification resolves the replay token.
 *   For every runner, staging then refuses (before any fixture or checklist is built) a recording
 *   in which the live access token, or a long `:`-separated part of it, survives anywhere it could
 *   be written or printed (see `inspectRecordingForAccessToken`), or that holds a body the guard
 *   cannot inspect (only strict UTF-8 text without NUL characters is inspectable: an allowlist,
 *   not a list of refused formats); a last check refuses rendered files or checklist lines carrying
 *   it.
 * - Every line a live run prints (the report, cleanup WARN lines, leftover warnings, the run's own
 *   failure, staging output) goes through `redactAccessToken`: a provider can echo the live token
 *   into a field a case reports, before any staging guard runs. Raw, percent-encoded, and base64
 *   forms are replaced by `<redacted live token>`; a line still holding an escaped form is withheld
 *   whole, and so is a line holding 16 or more consecutive token characters, raw or base64 (a
 *   report truncated inside an echoed token). The whole message is withheld when the token only
 *   appears once its lines are joined with whitespace removed (a token folded across lines).
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
 *   uninterruptible cleanups are attempted; a cleanup that fails meanwhile prints a WARN line (the
 *   cases' `ConformanceCleanupReporter`). After an interrupt-only exit (130) the read-only
 *   `leftovers` lookup runs again and lists what is still present; a cleanup failure ends the run
 *   with exit 1. A duplicate signal within a second (one Ctrl-C reaches every process of the
 *   foreground group, and the wrappers relay it) is ignored; a later one force-exits (cleanup may
 *   be skipped). Under `pnpm exec tsx` the prompt returns at the first Ctrl-C; the first-signal
 *   message names the pid to `kill -TERM`. Before any write case, the `leftovers` lookup warns about items earlier runs left
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
  type WireExchange,
  type WireFixture,
  type WireResponse
} from '../packages/conformance/src/fixture.ts'
import {
  defaultRecordedRequestHeaders,
  defaultRecordedResponseHeaders,
  makeRecordingHttpClient,
  makeWireFixture,
  type WireRecorderOptions,
  type WireRecorderApi
} from '../packages/conformance/src/record.ts'
import { ReplayHttpClient } from '../packages/conformance/src/replay.ts'
import { decodeBase64Bytes } from '../packages/conformance/src/wire-internal.ts'
import {
  ConformanceCleanupReporter,
  type ConformanceCleanupReporterApi
} from '../packages/connectors/src/conformance/cleanup-reporter.ts'
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
  /** What the write-reversible cases do, for the dry-run footer and usage (runners with some). */
  readonly writeNote?: string
  /**
   * What the write-irreversible cases do and why they need `--allow-irreversible`, for the
   * dry-run footer. Only runners with such cases set it.
   */
  readonly irreversibleNote?: string
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
  /**
   * Branded seeds: the schema (exported from the provider's `cases.ts`) whose `make` the rendered
   * seeds module calls for that seed's value, for example Google's `GooglePracticeAddress`.
   */
  readonly seedConstructors?: Partial<Record<K, string>>
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
   * Extra response headers the recorder keeps beyond `defaultRecordedResponseHeaders` (credential
   * headers are always dropped), for claims that read a header, such as GitHub's `link` paging.
   */
  readonly recordedResponseHeaders?: ReadonlyArray<string>
  /**
   * Rewrites recorded exchanges before the fixture is built, for providers that put the live
   * credential where the recorder cannot drop it (Telegram's `/bot<token>/` URL path). Staging
   * still refuses a recording that contains the live access token afterwards.
   */
  readonly scrubRecording?: (
    exchanges: ReadonlyArray<WireExchange>,
    accessToken: string
  ) => ReadonlyArray<WireExchange>
  /**
   * The access token replay verification resolves (default `replay-access-token`); it must match
   * whatever `scrubRecording` writes into the fixtures.
   */
  readonly replayAccessToken?: string
  /**
   * READ-ONLY lookup of items earlier runs left behind (for example `yolk-conformance-run-*`
   * folders), run over the case ports before any write case; each result becomes one WARN line.
   * Never deletes anything.
   */
  readonly leftovers?: Effect.Effect<ReadonlyArray<string>, E, R>
  /** What to do about a leftover, appended to each WARN line. */
  readonly leftoverAdvice?: string
  /**
   * What an interrupted run may have left behind and where to look, for the interruption and
   * forced-exit messages. Default: `yolk-conformance` items, which a later write run warns about.
   */
  readonly recoveryAdvice?: string
  /**
   * The format a live access token must have (checked before any request; the token is never
   * printed). `description` completes "<tokenEnv> must be ...".
   */
  readonly tokenFormat?: { readonly pattern: RegExp; readonly description: string }
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
  /**
   * Exact ids of write-irreversible cases a person explicitly started (`--allow-irreversible`).
   * Present only when at least one was given.
   */
  readonly allowIrreversible?: ReadonlyArray<string>
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

/** Ids of the runner's write-irreversible cases (the only values `--allow-irreversible` takes). */
export const irreversibleCaseIds = <K extends string, S extends SeedRecord<K>>(
  runner: RunnerData<K, S>
): ReadonlyArray<string> =>
  runner.cases
    .filter(testCase => testCase.safety === 'write-irreversible')
    .map(testCase => testCase.id)

const hasReversibleCases = <K extends string, S extends SeedRecord<K>>(runner: RunnerData<K, S>) =>
  runner.cases.some(testCase => testCase.safety === 'write-reversible')

const irreversibleUsage = <K extends string, S extends SeedRecord<K>>(runner: RunnerData<K, S>) => {
  const ids = irreversibleCaseIds(runner)

  return ids.length === 0
    ? ''
    : `
  --allow-irreversible <case-id>  run this exact write-irreversible case, which cannot be undone
                                  (repeatable; independent of --allow-writes):
                                  ${ids.join(', ')}`
}

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
                                  (${hasReversibleCases(runner) ? `they ${runner.writeNote ?? 'restore what they change'}` : 'this runner has none'})${irreversibleUsage(runner)}
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
 * unknown flags (`--allow-irreversible` included, for a runner without write-irreversible cases),
 * missing values, invalid labels, an `--allow-irreversible` value that is not the exact id of one
 * of the runner's write-irreversible cases, `--record` without `--live`, and `--live` in CI (`CI`
 * non-empty), without `--owner-approved`, or without `--account`.
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
  const allowIrreversible: Array<string> = []
  const irreversibleIds = irreversibleCaseIds(runner)
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

    if (flag === '--allow-irreversible' && irreversibleIds.length > 0) {
      const caseId = value()

      if (!irreversibleIds.includes(caseId)) {
        throw new Error(
          `--allow-irreversible takes an exact write-irreversible case id: ${irreversibleIds.join(', ')}`
        )
      }

      if (!allowIrreversible.includes(caseId)) {
        allowIrreversible.push(caseId)
      }

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

  const parsed: RunOptions<K> = { live, help, record, ownerApproved, account, allowWrites, seeds }

  // `allowIrreversible` is present only when a case was named, so runners without write-irreversible
  // cases keep their exact option shape.
  const options: RunOptions<K> =
    allowIrreversible.length === 0 ? parsed : { ...parsed, allowIrreversible }

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
  allowIrreversible: options.allowIrreversible ?? []
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

  const irreversible =
    irreversibleCaseIds(runner).length === 0
      ? ''
      : `, allowIrreversible=[${(options.allowIrreversible ?? []).join(', ')}]`

  const notes = [
    hasReversibleCases(runner)
      ? `Write cases ${runner.writeNote ?? 'restore what they change'}.`
      : undefined,
    irreversibleCaseIds(runner).length > 0 && runner.irreversibleNote !== undefined
      ? `${runner.irreversibleNote}.`
      : undefined
  ].filter(Predicate.isNotUndefined)

  return [
    `DRY RUN: no network request was made and no credential was read. Pass --live --owner-approved --account <label> to run (needs ${runner.tokenEnv}).`,
    `Plan for a live target: allowWrites=${options.allowWrites}${irreversible}${options.record ? ', record' : ''}`,
    ...lines,
    [
      `Use ${runner.practiceTarget} only, with the repository owner's approval; never in CI.`,
      ...notes
    ].join(' ')
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

  if (runner.tokenFormat !== undefined && !runner.tokenFormat.pattern.test(accessToken)) {
    return { refusal: `${runner.tokenEnv} must be ${runner.tokenFormat.description}` }
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
  const constructors: Partial<Record<K, string>> = runner.seedConstructors ?? {}

  const entries = allSeedKeys(runner).flatMap(key => {
    const value = seeds[key]
    const constructor = constructors[key]

    return value === undefined
      ? []
      : [
          `  ${key}: ${constructor === undefined ? quoted(value) : `${constructor}.make(${quoted(value)})`}`
        ]
  })

  const names = [
    ...new Set(
      allSeedKeys(runner).flatMap(key => {
        const constructor = constructors[key]

        return constructor === undefined || seeds[key] === undefined ? [] : [constructor]
      })
    )
  ].sort()

  // The committed module's import, formatted as the formatter prints it (one line up to 100 columns).
  const oneLineImport =
    names.length === 0
      ? `import type { ${runner.seedsTypeName} } from './cases.ts'`
      : `import { ${[...names, `type ${runner.seedsTypeName}`].join(', ')} } from './cases.ts'`

  const seedsImport =
    oneLineImport.length <= 100
      ? oneLineImport
      : [
          'import {',
          [...names, `type ${runner.seedsTypeName}`].map(name => `  ${name}`).join(',\n'),
          "} from './cases.ts'"
        ].join('\n')

  return [
    seedsImport,
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

// The live-token guard. The fixture secret scan knows credential headers and common token shapes,
// not every provider's token (a Telegram bot token sits in the URL path, and a response can echo
// it anywhere), so staging looks for the live token itself in everything a staged file or the
// review checklist could contain, decoded every way it can be written.

/** A `:`-separated part of a token this long is a secret on its own (a bot token's secret part). */
const secretPartMinLength = 16

/** Shortest base64 run searched: shorter runs would match unrelated text by chance. */
const base64CoreMinLength = 12

/**
 * The base64 characters that encode `form` whatever bytes surround it: standard and URL-safe, at
 * each of the 3 byte alignments it can start at inside a larger encoded value. The groups shared
 * with the surrounding bytes (the first after a misaligned start, and a trailing partial one) are
 * left out.
 */
const base64Cores = (form: string): ReadonlyArray<string> =>
  [0, 1, 2].flatMap(offset => {
    const bytes = Buffer.concat([Buffer.alloc(offset), Buffer.from(form, 'utf8')])
    const encoded = bytes.toString('base64')
    const start = offset === 0 ? 0 : 4
    const end = bytes.byteLength % 3 === 0 ? encoded.length : encoded.length - 4
    const core = encoded.slice(start, end)

    return core.length < base64CoreMinLength
      ? []
      : [core, core.replaceAll('+', '-').replaceAll('/', '_')]
  })

/**
 * What the guard looks for: the token, and every `:`-separated part of it long enough to be a
 * secret on its own (Telegram's `<bot id>:<secret>`: the secret; the bot id is public and appears
 * in every `sendMessage` answer as `from.id`, so it alone is not searched), each verbatim,
 * percent-encoded, and base64-encoded (standard and URL-safe, at every byte alignment, and
 * whitespace-folded as MIME folds it).
 */
export const accessTokenForms = (accessToken: string): ReadonlyArray<string> => {
  const parts = accessToken.split(':')

  const secrets = parts.length > 1 ? parts.filter(part => part.length >= secretPartMinLength) : []

  return [
    ...new Set(
      [accessToken, ...secrets].flatMap(form => [
        form,
        encodeURIComponent(form),
        ...base64Cores(form)
      ])
    )
  ].filter(form => form.length > 0)
}

const percentEscape = /%([0-9A-Fa-f]{2})/g

/** Replace `%XX` escapes (repeatedly, for double encoding) with their characters. */
const percentDecoded = (text: string): string => {
  let current = text

  for (let round = 0; round < 3 && /%[0-9A-Fa-f]{2}/.test(current); round++) {
    current = current.replace(percentEscape, (_match, hex: string) =>
      String.fromCharCode(Number.parseInt(hex, 16))
    )
  }

  return current
}

// One backslash escape: an escaped backslash, `\uXXXX`, or `\xXX`.
const backslashEscape = /\\(?:(\\)|u([0-9A-Fa-f]{4})|x([0-9A-Fa-f]{2}))/g

const escapesDecodedOnce = (text: string): string =>
  text
    .replace(
      backslashEscape,
      (
        _match,
        backslash: string | undefined,
        unicode: string | undefined,
        hex: string | undefined
      ) => backslash ?? String.fromCharCode(Number.parseInt(unicode ?? hex ?? '', 16))
    )
    .replace(/&#x([0-9A-Fa-f]+);?/g, (_match, hex: string) =>
      String.fromCodePoint(Math.min(Number.parseInt(hex, 16), 0x10ffff))
    )
    .replace(/&#([0-9]+);?/g, (_match, decimal: string) =>
      String.fromCodePoint(Math.min(Number.parseInt(decimal, 10), 0x10ffff))
    )

/**
 * Replace `\uXXXX`, `\xXX`, and numeric HTML character references with their characters, and `\\`
 * with `\`, repeatedly (up to 3 rounds): a rendered fixture module escapes a recorded escape again
 * (`\\u0037`), which the next round decodes.
 */
const escapesDecoded = (text: string): string => {
  let current = text

  for (let round = 0; round < 3; round++) {
    const next = escapesDecodedOnce(current)

    if (next === current) break

    current = next
  }

  return current
}

// Whitespace and JSON whitespace escapes (`\r`, `\n`, `\t`): MIME-style base64 is folded at 76
// columns, so a fold can fall inside the encoded token.
const unfolded = (text: string): string => text.replace(/\s+|\\[rnt]/g, '')

/**
 * True when `text`, raw or with its escapes decoded, contains any form of the token. Each variant
 * is also searched with whitespace removed, so folded (MIME-style) base64 is found too.
 */
const textHasToken = (text: string, forms: ReadonlyArray<string>): boolean => {
  const decoded = [
    text,
    percentDecoded(text),
    escapesDecoded(text),
    percentDecoded(escapesDecoded(text)),
    escapesDecoded(percentDecoded(text))
  ]

  const variants = decoded.flatMap(variant => [variant, unfolded(variant)])

  return variants.some(variant => forms.some(form => variant.includes(form)))
}

/** True when `text` holds the token (see `accessTokenForms`), raw, escaped, or encoded. */
export const textContainsAccessToken = (text: string, accessToken: string): boolean =>
  textHasToken(text, accessTokenForms(accessToken))

/** What a printed line carries instead of the live access token. */
export const redactedLiveTokenMarker = '<redacted live token>'

/** A printed line that still held the token after redaction (escaped, folded, double-encoded). */
export const withheldTokenLine =
  '<line withheld: it carried an encoded form of the live access token>'

/**
 * `text` with every form of the live access token that `textContainsAccessToken` looks for (see
 * `accessTokenForms`: raw, percent-encoded, base64) replaced by `redactedLiveTokenMarker`; a line
 * that still holds the token afterwards (escaped, folded, or double-encoded) is replaced whole by
 * `withheldTokenLine`, and the whole message is withheld when the token (or a fragment of it, see
 * `tokenFragmentForms`) only appears once the lines are joined with whitespace removed. Live runs
 * print every line through it: a provider can echo the token into a field a case reports (a
 * refused item's name, a leftover's title, a failure message).
 */
export const redactAccessToken = (text: string, accessToken: string): string => {
  const forms = accessTokenForms(accessToken)
  const longestFirst = [...forms].sort((left, right) => right.length - left.length)

  const replacedLines = text
    .split('\n')
    .map(line =>
      longestFirst.reduce(
        (current, form) => current.replaceAll(form, redactedLiveTokenMarker),
        line
      )
    )

  // A token folded across lines passes every single-line check, so the whole message is checked
  // with all whitespace removed, before any line is withheld (a withheld line would split the
  // token and hide its short first and last pieces). When the joined text holds the full token (or
  // a fragment) but no single line does, the match spans lines and the whole message is withheld.
  const joined = unfolded(replacedLines.join('\n'))
  const lineHasToken = (line: string) => textHasToken(line, forms)
  const lineHasFragment = (line: string) => hasTokenFragment(line, accessToken)

  const spansLines =
    (textHasToken(joined, forms) && !replacedLines.some(lineHasToken)) ||
    (hasTokenFragment(joined, accessToken) && !replacedLines.some(lineHasFragment))

  if (spansLines) return withheldTokenLine

  return replacedLines
    .map(line => (lineHasToken(line) || lineHasFragment(line) ? withheldTokenLine : line))
    .join('\n')
}

/** Shortest run of consecutive token characters treated as a leaked fragment. */
const tokenFragmentMinLength = 16

/**
 * True when `line` holds any of `tokenFragmentForms`: a report or warning that a length cap cut
 * in the middle of an echoed token still leaks a usable part of it, so such a line is withheld
 * whole.
 */
const hasTokenFragment = (line: string, accessToken: string): boolean =>
  tokenFragmentForms(accessToken).some(form => line.includes(form))

/**
 * Every `tokenFragmentMinLength` window of the token, verbatim and base64-encoded (standard and
 * URL-safe, every byte alignment), so a capped report that cut a raw or base64 echo short is
 * still recognised. A base64 core drops the groups it shares with the surrounding bytes, so an
 * encoded fragment can match text that encodes as few as 12 consecutive token characters: this
 * errs toward withholding.
 */
const tokenFragmentForms = (accessToken: string): ReadonlyArray<string> => {
  if (accessToken.length < tokenFragmentMinLength) return []

  const windows = Array.from(
    { length: accessToken.length - tokenFragmentMinLength + 1 },
    (_, start) => accessToken.slice(start, start + tokenFragmentMinLength)
  )

  return [...new Set(windows.flatMap(window => [window, ...base64Cores(window)]))]
}

/** Every string (keys included) of a parsed JSON value. */
const jsonStrings = (value: unknown): ReadonlyArray<string> => {
  if (Predicate.isString(value)) return [value]

  if (Array.isArray(value)) return value.flatMap(jsonStrings)

  if (Predicate.isObject(value)) {
    return Object.entries(value).flatMap(([key, child]) => [key, ...jsonStrings(child)])
  }

  return []
}

const parsedJson = (text: string): { readonly value: unknown } | undefined => {
  try {
    return { value: JSON.parse(text) }
  } catch {
    return undefined
  }
}

type TokenVerdict = 'clean' | 'token' | 'uninspectable'

/**
 * The inspectable-text allowlist: text without NUL characters. A NUL marks binary data or a
 * wide encoding (UTF-16 text is valid UTF-8 byte for byte when it is ASCII), which substring
 * searches cannot read.
 */
const isPlainText = (text: string): boolean => !text.includes('\u0000')

/** Bytes as text when they are strict UTF-8 plain text (see `isPlainText`), else `undefined`. */
const strictUtf8Text = (bytes: Uint8Array): string | undefined => {
  try {
    const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes)

    return isPlainText(text) ? text : undefined
  } catch {
    return undefined
  }
}

/**
 * Inspect text: raw and escape-decoded, every `data:` line of an event stream, and every JSON string
 * value after parsing (so `\u0039` escapes are unescaped).
 */
const inspectText = (text: string, forms: ReadonlyArray<string>): TokenVerdict => {
  if (textHasToken(text, forms)) return 'token'

  if (!isPlainText(text)) return 'uninspectable'

  const payloads = [
    text,
    ...text.split(/\r\n|\r|\n/).flatMap(line => (line.startsWith('data:') ? [line.slice(5)] : []))
  ]

  for (const payload of payloads) {
    const json = parsedJson(payload.trim())

    if (json !== undefined && jsonStrings(json.value).some(value => textHasToken(value, forms))) {
      return 'token'
    }
  }

  return 'clean'
}

/**
 * What to do with a body that is not strict UTF-8 plain text: `refuse` it as `uninspectable` (the
 * strict guard), or `search` its bytes as latin1 and lossy UTF-8 text and call it `clean` when no
 * form is found (for runners that must record binary bodies; a token inside compressed, UTF-16, or
 * hex-encoded data is not found that way).
 */
type BinaryBodies = 'refuse' | 'search'

/**
 * Inspect bytes. Allowlist: only strict UTF-8 plain text can be inspected; anything else (binary,
 * compressed, UTF-16, ...) is `uninspectable`, whatever its magic bytes, unless `binary` is
 * `search`. The raw bytes (one character per byte) are searched first, so a token in bytes that are
 * refused anyway still reports `token`.
 */
const inspectBytes = (
  bytes: Uint8Array,
  forms: ReadonlyArray<string>,
  binary: BinaryBodies
): TokenVerdict => {
  const raw = Array.from(bytes, byte => String.fromCharCode(byte)).join('')

  if (textHasToken(raw, forms)) return 'token'

  const text = strictUtf8Text(bytes)

  if (text !== undefined) return inspectText(text, forms)

  if (binary === 'refuse') return 'uninspectable'

  return textHasToken(new TextDecoder('utf-8').decode(bytes), forms) ? 'token' : 'clean'
}

const worst = (verdicts: ReadonlyArray<TokenVerdict>): TokenVerdict =>
  verdicts.includes('token')
    ? 'token'
    : verdicts.includes('uninspectable')
      ? 'uninspectable'
      : 'clean'

const inspectResponse = (
  response: WireResponse,
  forms: ReadonlyArray<string>,
  binary: BinaryBodies
): TokenVerdict => {
  if (isWireBase64BodyResponse(response)) {
    const bytes = decodeBase64Bytes(response.bodyBase64)

    if (Option.isSome(bytes)) return inspectBytes(bytes.value, forms, binary)

    return binary === 'refuse' ? 'uninspectable' : inspectText(response.bodyBase64, forms)
  }

  if (isWireStreamResponse(response)) {
    const chunks: Array<Uint8Array> = []

    for (const chunk of response.chunks) {
      if (Predicate.isString(chunk)) {
        chunks.push(new TextEncoder().encode(chunk))
        continue
      }

      const bytes = decodeBase64Bytes(chunk.base64)

      if (Option.isSome(bytes)) {
        chunks.push(bytes.value)
      } else if (binary === 'refuse') {
        return 'uninspectable'
      } else {
        // Undecodable: the base64 text itself is what a fixture would carry.
        chunks.push(new TextEncoder().encode(chunk.base64))
      }
    }

    // Reassembled, so a token split across chunks is still found.
    const joined = new Uint8Array(chunks.reduce((total, chunk) => total + chunk.byteLength, 0))

    chunks.reduce((offset, chunk) => {
      joined.set(chunk, offset)

      return offset + chunk.byteLength
    }, 0)

    return inspectBytes(joined, forms, binary)
  }

  return inspectText(response.body, forms)
}

const inspectExchanges = (
  exchanges: ReadonlyArray<WireExchange>,
  accessToken: string,
  binary: BinaryBodies
): TokenVerdict => {
  const forms = accessTokenForms(accessToken)

  const headerTexts = (headers: Readonly<Record<string, string>> | undefined) =>
    Object.entries(headers ?? {}).flat()

  return worst(
    exchanges.flatMap(({ request, response }) => [
      ...[request.method, request.url, ...headerTexts(request.headers)].map(text =>
        inspectText(text, forms)
      ),
      request.body === undefined
        ? 'clean'
        : Predicate.isString(request.body)
          ? inspectText(request.body, forms)
          : inspectText(JSON.stringify(request.body), forms),
      ...headerTexts(response.headers).map(text => inspectText(text, forms)),
      inspectResponse(response, forms, binary)
    ])
  )
}

/**
 * Look for the live access token everywhere a staged fixture or the review checklist could carry
 * it: request URLs, header names and values, request bodies (every JSON string value), and response
 * headers and bodies (text, decoded `bodyBase64`, and reassembled stream chunks). `token` when any
 * form of it is found (see `accessTokenForms`); `uninspectable` when a body is outside the
 * allowlist of what the guard can read, strict UTF-8 text without NUL characters (so binary,
 * compressed, and UTF-16 bodies, and undecodable base64, are refused whatever they contain);
 * otherwise `clean`.
 */
export const inspectRecordingForAccessToken = (
  exchanges: ReadonlyArray<WireExchange>,
  accessToken: string
): TokenVerdict => inspectExchanges(exchanges, accessToken, 'refuse')

/**
 * The same search as `inspectRecordingForAccessToken`, over the recorded exchanges before any
 * fixture is rendered, for runners that record binary bodies (the Fortnox preview PDF): a body that
 * is not strict UTF-8 text is searched as latin1 and lossy UTF-8 text instead of being refused, so
 * a token inside compressed, UTF-16, or hex-encoded data (a compressed PDF stream, for example) is
 * NOT found; the final
 * check on the rendered text and the manual review remain. True when any form is found.
 */
export const recordingContainsAccessToken = (
  exchanges: ReadonlyArray<WireExchange>,
  accessToken: string
): boolean => inspectExchanges(exchanges, accessToken, 'search') === 'token'

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

    const drained = yield* recorder.drain

    const exchanges =
      runner.scrubRecording === undefined
        ? drained
        : runner.scrubRecording(drained, inputs.accessToken)

    // Before anything printable is built from the recording: refuse any trace of the live token,
    // and any body outside the guard's inspectable allowlist.
    switch (inspectRecordingForAccessToken(exchanges, inputs.accessToken)) {
      case 'token':
        return yield* new ConnectorRunFailed({
          message: `${testCase.id}: the recording still contains the live access token; nothing was written`
        })
      case 'uninspectable':
        return yield* new ConnectorRunFailed({
          message: `${testCase.id}: the recording holds a body the token guard cannot inspect (only strict UTF-8 text without NUL characters is inspectable); nothing was written`
        })
      case 'clean':
        break
    }

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
        runner.casePorts(
          ReplayHttpClient.layer([fixture]),
          runner.replayAccessToken ?? 'replay-access-token',
          inputs.seeds
        )
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

    const stale = staleSharedSeeds(runner, runner.fixtureSeeds, seeds, recordedIds)

    const checklist = [
      ...recordingReviewChecklist(runner, recorded, seeds),
      ...stale.map(
        ({ key, cases }) =>
          `SHARED SEED ${key} changed: the committed fixtures of ${cases.join(', ')} still use the old value; re-record them or keep the old seed.`
      )
    ]

    // Last line of defence, over exactly what would be written and printed (seeds included).
    if (
      [...files.map(file => file.contents), ...checklist].some(text =>
        textContainsAccessToken(text, inputs.accessToken)
      )
    ) {
      return yield* new ConnectorRunFailed({
        message:
          'The staged files or the review checklist would contain the live access token; nothing was written'
      })
    }

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

    return {
      stagingDir,
      files: files.map(file => join(stagingDir, file.name)),
      checklist
    }
  })

/** `code` (plus `HTTP status`) of a failure, for WARN lines; never provider bodies or URLs. */
const failureCode = (cause: Cause.Cause<unknown>): string => {
  const error = Cause.findErrorOption(cause)

  if (Option.isNone(error)) {
    return Cause.hasInterruptsOnly(cause) ? 'interrupted' : 'defect'
  }

  const value = error.value

  const code = ['code', 'cause', '_tag']
    .map(key => (Predicate.hasProperty(value, key) ? value[key] : undefined))
    .find(Predicate.isString)

  const status =
    Predicate.hasProperty(value, 'status') && Predicate.isNumber(value.status)
      ? ` HTTP ${value.status}`
      : ''

  return `${code ?? 'unknown'}${status}`
}

/** When a leftover lookup runs: before the cases, or after an interruption stopped them. */
export type LeftoverLookupMoment = 'before-run' | 'after-interrupt'

/**
 * WARN lines for items earlier runs left behind, from the runner's READ-ONLY `leftovers` lookup.
 * Runs only when a write case would run under these flags; a failed lookup becomes one WARN line
 * naming the failure code (it never stops the run), and nothing is ever deleted. After an
 * interruption the same lookup lists what is still present, this run's items included.
 */
export const leftoverWarnings = <K extends string, S extends SeedRecord<K>, E, R>(
  runner: ConnectorConformanceRunner<K, S, E, R>,
  options: RunOptions<K>,
  inputs: LiveInputs<S>,
  http: Layer.Layer<HttpClient.HttpClient>,
  moment: LeftoverLookupMoment = 'before-run'
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
        ? exit.value.map(item =>
            moment === 'before-run'
              ? `WARN leftover from an earlier run: ${item}; ${advice} (nothing is deleted automatically)`
              : `WARN still present after the interruption (from this or an earlier run): ${item}; ${advice} (nothing is deleted automatically)`
          )
        : [
            `WARN could not look for leftovers (lookup failed: ${failureCode(exit.cause)}); check for yolk-conformance items by hand`
          ]
    )
  )
}

/**
 * When a write-irreversible case will run, the generated seeds it names in what it leaves behind
 * (the run id), printed before any case so the owner can find its traces even after a forced exit.
 */
export const generatedSeedLines = <K extends string, S extends SeedRecord<K>>(
  runner: RunnerData<K, S>,
  options: RunOptions<K>,
  inputs: LiveInputs<S>
): ReadonlyArray<string> => {
  const irreversible = planRun(runner, options).some(
    entry => entry.skipReason === undefined && entry.safety === 'write-irreversible'
  )

  return irreversible
    ? generatedKeys(runner).flatMap(key => {
        const value = inputs.seeds[key]

        return value === undefined
          ? []
          : [
              `${key} for this run: ${value} (write-irreversible cases name it in what they leave behind)`
            ]
      })
    : []
}

/** Where a live run talks to the provider and prints; injectable so tests need no network. */
export type LiveRunIo = {
  readonly http: Layer.Layer<HttpClient.HttpClient>
  /** stdout lines: leftover warnings before the run, the report, and staging output. */
  readonly out: (line: string) => void
  /** stderr lines: cleanup problems a case reports while being interrupted. */
  readonly err: (line: string) => void
}

export const processLiveRunIo: LiveRunIo = {
  http: FetchHttpClient.layer,
  out: line => console.log(line),
  err: line => console.error(line)
}

/** `io` printing every line through `redactAccessToken` with the live `accessToken`. */
export const redactingLiveRunIo = (io: LiveRunIo, accessToken: string): LiveRunIo => ({
  http: io.http,
  out: line => io.out(redactAccessToken(line, accessToken)),
  err: line => io.err(redactAccessToken(line, accessToken))
})

/** `io` printing every message through `redactAccessToken` with the live `accessToken`. */
export const redactingCliIo = (io: CliIo, accessToken: string): CliIo => ({
  error: message => io.error(redactAccessToken(message, accessToken)),
  setExitCode: io.setExitCode,
  forceExit: io.forceExit
})

/** Cleanup problems a case reports during an interruption, printed to `err` as WARN lines. */
export const stderrCleanupReporter = (
  err: (line: string) => void
): ConformanceCleanupReporterApi => ({
  warn: message => Effect.sync(() => err(`WARN ${message}`))
})

/**
 * What the `--record` recorder keeps: the default request and response header allowlists plus the
 * runner's extras. Credential headers (`authorization`, cookies, API-key headers) are always dropped
 * by the recorder, whatever the lists say.
 */
export const recorderOptionsFor = <K extends string, S extends SeedRecord<K>, E, R>(
  runner: Pick<
    ConnectorConformanceRunner<K, S, E, R>,
    'recordedRequestHeaders' | 'recordedResponseHeaders'
  >
): WireRecorderOptions => ({
  requestHeaders: [...defaultRecordedRequestHeaders, ...runner.recordedRequestHeaders],
  responseHeaders: [...defaultRecordedResponseHeaders, ...(runner.recordedResponseHeaders ?? [])]
})

/**
 * One live run: the leftover warnings, every case (with the WARN cleanup reporter provided around
 * `runConformance`), the report, and the `--record` staging.
 */
export const runLive = <K extends string, S extends SeedRecord<K>, E, R>(
  runner: ConnectorConformanceRunner<K, S, E, R>,
  options: RunOptions<K>,
  inputs: LiveInputs<S>,
  liveIo: LiveRunIo = processLiveRunIo
) =>
  Effect.gen(function* () {
    const io = redactingLiveRunIo(liveIo, inputs.accessToken)
    const recorders = yield* Ref.make(new Map<string, WireRecorderApi>())

    const recorderOptions = recorderOptionsFor(runner)

    const httpFor = (testCase: ConformanceCase<E, R>): Layer.Layer<HttpClient.HttpClient> =>
      options.record
        ? Layer.unwrap(
            Effect.gen(function* () {
              const upstream = yield* HttpClient.HttpClient
              const { client, recorder } = yield* makeRecordingHttpClient(upstream, recorderOptions)

              yield* Ref.update(recorders, current => new Map(current).set(testCase.id, recorder))

              return Layer.succeed(HttpClient.HttpClient, client)
            })
          ).pipe(Layer.provide(io.http))
        : io.http

    for (const line of generatedSeedLines(runner, options, inputs)) {
      io.out(line)
    }

    for (const line of yield* leftoverWarnings(runner, options, inputs, io.http)) {
      io.out(line)
    }

    const report = yield* runConformance(runner.cases, {
      target: liveTarget(options),
      layer: testCase => runner.casePorts(httpFor(testCase), inputs.accessToken, inputs.seeds)
    }).pipe(Effect.provideService(ConformanceCleanupReporter, stderrCleanupReporter(io.err)))

    io.out(formatConformanceReport(report))

    if (options.record) {
      const now = new Date()
      const root = recordingsRootFor(runner.provider)

      const staged = yield* stageRecordings(runner, report, yield* Ref.get(recorders), inputs, {
        writer: nodeRecordingWriter,
        stagingDir: join(root, recordingRunId(now, randomRunSuffix())),
        recordedAt: now.toISOString().slice(0, 10)
      })

      if (staged === undefined) {
        io.out('No passed case to record.')
      } else {
        io.out(
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
    const checked = liveInputs(runner, options, process.env)

    if ('refusal' in checked) {
      console.error(checked.refusal)
      process.exitCode = 1

      return
    }

    // The run's own failure and the after-interrupt leftover lines are redacted too.
    const cliIo = redactingCliIo(processCliIo, checked.inputs.accessToken)

    void runInterruptibly(runLive(runner, options, checked.inputs), processSignals, cliIo, {
      afterInterrupt: leftoverWarnings(
        runner,
        options,
        checked.inputs,
        FetchHttpClient.layer,
        'after-interrupt'
      ),
      ...interruptOptionsFor(runner)
    })
  }
}

/**
 * The runner-specific parts of `runInterruptibly`'s messages: its `recoveryAdvice`, and whether its
 * cases clean up (write-reversible cases or a leftover lookup) rather than only complete writes.
 */
export const interruptOptionsFor = <K extends string, S extends SeedRecord<K>, E, R>(
  runner: ConnectorConformanceRunner<K, S, E, R>
): Pick<RunInterruptiblyOptions, 'recoveryAdvice' | 'hasCleanups'> => ({
  recoveryAdvice: runner.recoveryAdvice,
  hasCleanups: hasReversibleCases(runner) || runner.leftovers !== undefined
})

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

/** The process's own SIGINT/SIGTERM. */
export const processSignals: SignalSource = {
  on: (signal, handler) => {
    process.on(signal, handler)
  },
  off: (signal, handler) => {
    process.off(signal, handler)
  }
}

export const processCliIo: CliIo = {
  error: message => console.error(message),
  setExitCode: code => {
    process.exitCode = code
  },
  forceExit: code => process.exit(code)
}

const cliSignals: ReadonlyArray<CliSignal> = ['SIGINT', 'SIGTERM']

/** A second signal sooner than this after the first is a duplicate of the same keypress. */
export const duplicateSignalWindowMs = 1000

export type RunInterruptiblyOptions = {
  /**
   * Run (in a fresh fiber) after an interrupt-only exit; each line is printed. Live runners pass
   * the read-only leftover lookup, so the owner sees what the interrupted run left behind.
   */
  readonly afterInterrupt?: Effect.Effect<ReadonlyArray<string>>
  /** Clock for the duplicate-signal window (milliseconds); injectable for tests. */
  readonly now?: () => number
  /** The runner's process id, named in the first-signal message (default `process.pid`). */
  readonly pid?: number
  /**
   * The runner's `recoveryAdvice`: what an interrupted run may have left and where to look. When
   * absent, the messages advise looking for `yolk-conformance` items, which a later write run's
   * leftover lookup warns about.
   */
  readonly recoveryAdvice?: string | undefined
  /**
   * Whether the runner's cases clean up after themselves (write-reversible cases or a leftover
   * lookup), which decides the first-signal wording: cleanups attempted, or writes in flight
   * completing. Default `true`.
   */
  readonly hasCleanups?: boolean
}

/**
 * Run `program` so that the first SIGINT/SIGTERM INTERRUPTS its fiber (the cases' uninterruptible
 * cleanups are attempted, and the run waits for them) instead of killing the process. One Ctrl-C
 * reaches every process of the foreground group (pnpm, tsx, node) and the wrappers relay it, so a
 * second signal within `duplicateSignalWindowMs` of the first is ignored as a duplicate; a later
 * one force-exits with a message that cleanup may have been skipped. `pnpm exec tsx …` returns to
 * the prompt at the first Ctrl-C (observed; `pnpm <script>` and `tsx` itself wait), so the
 * first-signal message names the pid to `kill -TERM` from there. Resolves when the program ends:
 * an interrupt-only exit prints a not-confirmed note plus the `afterInterrupt` lines and sets
 * exit code 130; any other failure (including a cleanup failure raised during the interruption)
 * prints its message and sets exit code 1. The signal handlers stay installed until everything, `afterInterrupt` included, is done.
 */
export const runInterruptibly = <E>(
  program: Effect.Effect<void, E>,
  signals: SignalSource,
  io: CliIo,
  options: RunInterruptiblyOptions = {}
): Promise<void> => {
  const now = options.now ?? Date.now
  const pid = options.pid ?? process.pid
  const advice = options.recoveryAdvice
  const hasCleanups = options.hasCleanups ?? true
  const fiber = Effect.runFork(program)
  let firstSignalAt: number | undefined

  const handlers = cliSignals.map(signal => {
    const handler = () => {
      const at = now()

      if (firstSignalAt !== undefined) {
        if (at - firstSignalAt < duplicateSignalWindowMs) {
          return
        }

        io.error(
          `Second ${signal}: exiting now without waiting for cleanup. ${
            advice ??
            'Case-created items may remain: look for yolk-conformance items by hand (a later live run with --allow-writes reversible warns about the ones it finds).'
          }`
        )
        io.forceExit(130)

        return
      }

      firstSignalAt = at
      io.error(
        `${signal}: interrupting the run (pid ${pid}); ${
          hasCleanups
            ? "the running case's cleanup is attempted before exit, and a cleanup that fails prints a WARN line"
            : 'a write already in flight completes before exit, and a problem it leaves prints a WARN line'
        }. Send ${signal} again, at least a second later, to exit without waiting; if the prompt has returned, stop it with \`kill -TERM ${pid}\` (at least 1s later).`
      )
      Effect.runFork(Fiber.interrupt(fiber))
    }

    signals.on(signal, handler)

    return { signal, handler }
  })

  const removeHandlers = () => {
    for (const { signal, handler } of handlers) {
      signals.off(signal, handler)
    }
  }

  const finish = async (exit: Exit.Exit<void, E>) => {
    if (Exit.isSuccess(exit)) {
      return
    }

    if (Cause.hasInterruptsOnly(exit.cause)) {
      io.error(
        advice === undefined
          ? "Interrupted. The running case's cleanup was attempted but is not confirmed: read the WARN lines, and look for yolk-conformance items by hand if in doubt."
          : `Interrupted. Read the WARN lines. ${advice}`
      )

      const lines =
        options.afterInterrupt === undefined ? [] : await Effect.runPromise(options.afterInterrupt)

      for (const line of lines) {
        io.error(line)
      }

      io.setExitCode(130)

      return
    }

    const error = Cause.squash(exit.cause)

    io.error(error instanceof Error ? error.message : String(error))
    io.setExitCode(1)
  }

  // Keep the handlers until the after-interrupt lookup has resolved, so a late relayed duplicate
  // is still absorbed instead of killing the lookup through Node's default handler.
  return Effect.runPromise(Fiber.await(fiber)).then(finish).finally(removeHandlers)
}
