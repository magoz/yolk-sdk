/**
 * OpenAI Chat Completions wire-fixture probe.
 *
 * The OpenAI chat conformance cases (`openAiConformanceCases`) are the single source of truth:
 * this script defines no requests of its own.
 *
 * Default: DRY RUN. Prints, per conformance case, the model and token limit it would use, and
 * exits without any network call or credential read.
 *
 * `--live`: the credential is the owner's OpenAI API key (`OPENAI_API_KEY`), so a live run spends
 * the owner's OpenAI credits. **Live runs need the repository owner's explicit approval**,
 * confirmed with `--owner-approved`; never run them in CI (`--live` is refused whenever the `CI`
 * environment variable is set to any non-empty value, `0` and `false` included). Both gates are
 * checked when the arguments are parsed and again right before the credential is read. A live run
 * also needs an explicit `--account <label>` (a synthetic, non-identifying label such as
 * `synthetic`; never a real organization, project, or person name: it is committed in public
 * fixtures). Runs each conformance case with `runConformance` on a live
 * target against the real OpenAI API, through the conformance recorder wrapped around a real fetch
 * `HttpClient` (failures are reported with the runner's sanitizer), turns each single recorded
 * exchange into a `verified` fixture dated today, then replays the new fixtures through the same
 * cases. Nothing is written unless every case passes live, records cleanly, passes the secret
 * scan, and passes again on replay; only then are the fixture modules under
 * `packages/agent/src/providers/openai/conformance/` rewritten.
 *
 * Model ids are CLI flags defaulting to `openAiConformanceDefaultModels`; confirm they are still
 * available before a live probe.
 */
import { execFileSync } from 'node:child_process'
import { writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'
import { Data, Effect, Layer, Redacted } from 'effect'
import { FetchHttpClient, HttpClient } from 'effect/http'
import {
  OpenAiConformanceConfig,
  openAiConformanceCases,
  openAiConformanceChatCompletionsUrl,
  openAiConformanceDefaultModels,
  type OpenAiConformanceCase,
  type OpenAiConformanceModels,
  type OpenAiConformanceSettings
} from '@yolk-sdk/agent/providers/openai/conformance'
import type { WireFixture } from '../packages/conformance/src/fixture.ts'
import { makeWireFixture, WireRecorder } from '../packages/conformance/src/record.ts'
import { ReplayHttpClient } from '../packages/conformance/src/replay.ts'
import {
  conformanceReportFailed,
  conformanceSkipReason,
  formatConformanceReport,
  runConformance,
  type ConformanceReport
} from '../packages/conformance/src/runner.ts'
import { isCiEnvironment, type ProbeEnv } from './fixture-probe-internal.ts'

export type ProbeOptions = {
  readonly live: boolean
  readonly help: boolean
  /** Explicit confirmation that the repository owner approved this live run. */
  readonly ownerApproved: boolean
  /** Model ids per case; default `openAiConformanceDefaultModels`. */
  readonly models: OpenAiConformanceModels
  /** Sent as `max_completion_tokens`. */
  readonly maxTokens: number
  /** Synthetic, non-identifying fixture account label. Required with `--live`. */
  readonly account: string | undefined
}

type MutableProbeOptions = { -readonly [Key in keyof ProbeOptions]: ProbeOptions[Key] }

export const defaultProbeOptions: ProbeOptions = {
  live: false,
  help: false,
  ownerApproved: false,
  models: openAiConformanceDefaultModels,
  maxTokens: 64,
  account: undefined
}

const defaultModels = defaultProbeOptions.models

/** The credential environment variable `--live` reads. */
export const openAiApiKeyEnv = 'OPENAI_API_KEY'

const usage = `Usage: pnpm conformance:openai [--live --owner-approved --account <label>] [options]

Dry run by default: lists the OpenAI chat conformance cases it would run and performs no network
I/O and no credential read. --live runs each conformance case against the OpenAI API through the
wire recorder, replays the new fixtures through the same cases, and writes the fixture modules
only if every case passes.

The credential is the owner's OpenAI API key (${openAiApiKeyEnv}): live runs spend the owner's
OpenAI credits and need the repository owner's explicit approval (--owner-approved). Never run
them in CI: --live is refused whenever the CI environment variable is set to any non-empty value
(0 and false included).

Options:
  --live                          Record against the real OpenAI API (needs --owner-approved,
                                  --account, and ${openAiApiKeyEnv})
  --owner-approved                confirm the repository owner approved this live run
  --plain-model <id>              default ${defaultModels.plainText} (streamed and JSON plain text)
  --tool-model <id>               default ${defaultModels.toolCall}
  --invalid-model <id>            default ${defaultModels.invalid} (must NOT exist)
  --max-tokens <n>                default ${defaultProbeOptions.maxTokens} (max_completion_tokens)
  --account <label>               required with --live: synthetic, non-identifying fixture
                                  account label (for example synthetic); never a real
                                  organization, project, or person name
  --help

Confirm model ids are available before a live probe. Review the rewritten fixtures before
committing: they must contain synthetic content only.`

const positiveInteger = (flag: string, value: string): number => {
  const parsed = Number(value)

  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error(`${flag} must be a positive integer`)
  }

  return parsed
}

export const liveAccountRequiredMessage =
  '--live requires --account <label>: a synthetic, non-identifying label (for example synthetic) that is committed in public fixtures'

export const ownerApprovalRequiredMessage =
  "--live requires --owner-approved: live runs spend the owner's OpenAI API credits and need the repository owner's explicit approval"

export const liveInCiMessage =
  "--live is refused in CI (the CI environment variable is set to a non-empty value): live runs spend the owner's OpenAI API credits and must be run by hand with the repository owner's approval"

/**
 * Parse CLI arguments (without the node/script prefix). Throws on unknown flags, on `--live` in CI
 * (`env.CI` set to any non-empty value), and on `--live` without `--owner-approved` or an explicit
 * `--account`.
 */
export const parseProbeArgs = (argv: ReadonlyArray<string>, env: ProbeEnv = {}): ProbeOptions => {
  const options: MutableProbeOptions = { ...defaultProbeOptions }

  const setModel = (key: keyof OpenAiConformanceModels, model: string) => {
    options.models = { ...options.models, [key]: model }
  }

  for (let index = 0; index < argv.length; index++) {
    const argument = argv[index] ?? ''
    const equals = argument.indexOf('=')
    const flag = equals === -1 ? argument : argument.slice(0, equals)
    const inline = equals === -1 ? undefined : argument.slice(equals + 1)

    const value = () => {
      const next = inline ?? argv[++index]

      if (next === undefined || next.length === 0) {
        throw new Error(`${flag} requires a value`)
      }

      return next
    }

    switch (flag) {
      case '--live':
        options.live = true
        break
      case '--owner-approved':
        options.ownerApproved = true
        break
      case '--help':
      case '-h':
        options.help = true
        break
      case '--plain-model':
        setModel('plainText', value())
        break
      case '--tool-model':
        setModel('toolCall', value())
        break
      case '--invalid-model':
        setModel('invalid', value())
        break
      case '--max-tokens':
        options.maxTokens = positiveInteger(flag, value())
        break
      case '--account':
        options.account = value()
        break
      default:
        throw new Error(`Unknown argument: ${argument}`)
    }
  }

  if (options.help) return options

  if (options.live && isCiEnvironment(env)) throw new Error(liveInCiMessage)

  if (options.live && !options.ownerApproved) throw new Error(ownerApprovalRequiredMessage)

  if (options.live && options.account === undefined) throw new Error(liveAccountRequiredMessage)

  return options
}

/**
 * Where a conformance case's recording is written. File and export names are stable so the
 * fixture modules and the conformance `index.ts` never change shape. `model` names the
 * `OpenAiConformanceModels` entry the case uses.
 */
export type OpenAiFixtureModule = {
  readonly caseId: string
  readonly fileName: string
  readonly exportName: string
  readonly doc: string
  readonly model: keyof OpenAiConformanceModels
}

export const openAiFixtureModules: ReadonlyArray<OpenAiFixtureModule> = [
  {
    caseId: 'openai.chat.stream.plain-text',
    fileName: 'plain-text.ts',
    exportName: 'openAiChatPlainTextFixture',
    doc: 'Streamed plain-text answer from OpenAI Chat Completions: text deltas, a finish chunk, a usage chunk, and `data: [DONE]`.',
    model: 'plainText'
  },
  {
    caseId: 'openai.chat.stream.tool-call-deltas',
    fileName: 'tool-call-deltas.ts',
    exportName: 'openAiChatToolCallDeltasFixture',
    doc: 'Streamed OpenAI tool call, forced with `tool_choice`, whose JSON arguments arrive as `delta.tool_calls` fragments that assemble into one call.',
    model: 'toolCall'
  },
  {
    caseId: 'openai.chat.stream.error-envelope',
    fileName: 'error-envelope.ts',
    exportName: 'openAiChatErrorEnvelopeFixture',
    doc: 'Non-2xx OpenAI JSON error envelope (`model_not_found`) for a request with an unknown model id.',
    model: 'invalid'
  },
  {
    caseId: 'openai.chat.json.plain-text',
    fileName: 'json-plain-text.ts',
    exportName: 'openAiChatJsonPlainTextFixture',
    doc: 'Non-streamed OpenAI plain-text answer: one `chat.completion` JSON body.',
    model: 'plainText'
  }
]

export const openAiFixtureModuleFor = (caseId: string): OpenAiFixtureModule | undefined =>
  openAiFixtureModules.find(fixtureModule => fixtureModule.caseId === caseId)

/** One conformance case with everything the probe needs to run, record, and write it. */
export type OpenAiProbePlanEntry = {
  readonly testCase: OpenAiConformanceCase
  readonly fixtureModule: OpenAiFixtureModule
  readonly model: string
  readonly maxTokens: number
}

/**
 * Pair every OpenAI chat conformance case with its fixture module and settings. Throws when a
 * case has no module: a new case needs a new entry in `openAiFixtureModules` (a programmer
 * error).
 */
export const planOpenAiProbe = (options: ProbeOptions): ReadonlyArray<OpenAiProbePlanEntry> =>
  openAiConformanceCases.map(testCase => {
    const fixtureModule = openAiFixtureModuleFor(testCase.id)

    if (fixtureModule === undefined) {
      throw new Error(`No fixture module mapped for conformance case ${testCase.id}`)
    }

    return {
      testCase,
      fixtureModule,
      model: options.models[fixtureModule.model],
      maxTokens: options.maxTokens
    }
  })

/** Conformance settings for the given credential; every case reads its models and limits here. */
export const openAiConformanceSettings = (
  options: ProbeOptions,
  apiKey: Redacted.Redacted<string>
): OpenAiConformanceSettings => ({
  apiKey,
  maxCompletionTokens: options.maxTokens,
  models: options.models
})

export const dryRunReport = (options: ProbeOptions): string =>
  [
    `DRY RUN: no network request was made and no credential was read. Pass --live --owner-approved --account <label> to record (needs ${openAiApiKeyEnv}).`,
    `Endpoint: ${openAiConformanceChatCompletionsUrl}`,
    "Live runs spend the owner's OpenAI credits and need the repository owner's explicit approval; never run them in CI.",
    'Conformance cases:',
    ...planOpenAiProbe(options).map(entry =>
      [
        `- ${entry.testCase.id} [${entry.testCase.safety}]`,
        `model ${entry.model}`,
        `max completion tokens ${entry.maxTokens}`,
        `-> ${entry.fixtureModule.fileName}`
      ].join('  ')
    ),
    'With --live, each case runs against the OpenAI API through the wire recorder, then all new',
    'fixtures are verified by running the same cases on replay; nothing is written unless every case passes.',
    'Confirm model ids are available before a live probe.'
  ].join('\n')

/**
 * Run every OpenAI chat conformance case on replay against `fixtures` (matched by `caseId`), with
 * a synthetic credential and the same models and limits as the recording. Each case references
 * the fixtures it replays, so the report's fixture warnings describe `fixtures`. A case without a
 * fixture replays nothing and fails, so a missing recording fails the report.
 */
export const verifyOpenAiFixtures = (
  fixtures: ReadonlyArray<WireFixture>,
  options: ProbeOptions = defaultProbeOptions
): Effect.Effect<ConformanceReport> => {
  const configLayer = Layer.succeed(
    OpenAiConformanceConfig,
    openAiConformanceSettings(options, Redacted.make('synthetic-replay-key'))
  )

  const fixturesFor = (caseId: string) => fixtures.filter(fixture => fixture.caseId === caseId)

  const cases = openAiConformanceCases.map((testCase): OpenAiConformanceCase => ({
    ...testCase,
    fixtures: fixturesFor(testCase.id).map(fixture => fixture.id)
  }))

  return runConformance(cases, {
    target: { kind: 'replay' },
    fixtures,
    layer: testCase => Layer.mergeAll(ReplayHttpClient.layer(fixturesFor(testCase.id)), configLayer)
  })
}

/** Case ids with no fixture, or with more than one (a recording must map to exactly one case). */
export const casesWithoutSingleFixture = (
  fixtures: ReadonlyArray<WireFixture>
): ReadonlyArray<string> =>
  openAiConformanceCases
    .map(testCase => testCase.id)
    .filter(caseId => fixtures.filter(fixture => fixture.caseId === caseId).length !== 1)

/** The note written into every recorded fixture (names the owner-approved live command). */
export const openAiFixtureNote =
  'Recorded from the live OpenAI Chat Completions API by running its conformance case through pnpm conformance:openai --live --owner-approved. Prompts and outputs are synthetic.'

export class ProbeFailed extends Data.TaggedError('ProbeFailed')<{
  readonly caseId: string
  readonly message: string
}> {}

const workspaceRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')

const fixtureDir = join(workspaceRoot, 'packages/agent/src/providers/openai/conformance')

const today = () => new Date().toISOString().slice(0, 10)

// Runs the case through `runConformance` on the live target (same safety policy and sanitized
// failure report as any conformance run) with the recording client, then turns the single
// recorded exchange into a verified fixture.
const recordCase = (
  entry: OpenAiProbePlanEntry,
  settings: OpenAiConformanceSettings,
  account: string
) =>
  Effect.gen(function* () {
    const caseId = entry.testCase.id
    const recorder = yield* WireRecorder
    const client = yield* HttpClient.HttpClient

    const report = yield* runConformance([entry.testCase], {
      target: { kind: 'live', account },
      layer: () =>
        Layer.mergeAll(
          Layer.succeed(HttpClient.HttpClient, client),
          Layer.succeed(OpenAiConformanceConfig, settings)
        )
    })

    if (report.summary.passed !== 1) {
      const [line] = formatConformanceReport(report).split('\n')

      return yield* new ProbeFailed({ caseId, message: `conformance case failed live: ${line}` })
    }

    const exchanges = yield* recorder.drain.pipe(
      Effect.mapError(error => new ProbeFailed({ caseId, message: error.message }))
    )

    if (exchanges.length !== 1) {
      return yield* new ProbeFailed({
        caseId,
        message: `expected exactly one exchange, recorded ${exchanges.length}`
      })
    }

    return yield* makeWireFixture({
      id: `${caseId}.recorded`,
      caseId,
      evidence: 'verified',
      recordedAt: today(),
      account,
      endpoint: openAiConformanceChatCompletionsUrl,
      model: entry.model,
      note: openAiFixtureNote,
      exchanges
    }).pipe(Effect.mapError(error => new ProbeFailed({ caseId, message: error.message })))
  }).pipe(
    Effect.provide(
      WireRecorder.layer({ responseHeaders: ['content-type'] }).pipe(
        Layer.provide(FetchHttpClient.layer)
      )
    )
  )

export const renderFixtureModule = (
  fixtureModule: OpenAiFixtureModule,
  fixture: WireFixture
): string =>
  [
    "import type { WireFixture } from '@yolk-sdk/conformance/fixture'",
    '',
    '/**',
    ` * ${fixtureModule.doc}`,
    ' *',
    ` * Verified recording (${fixture.recordedAt}). Regenerate with`,
    ' * `pnpm conformance:openai --live --owner-approved --account <label>`.',
    ' */',
    `export const ${fixtureModule.exportName}: WireFixture = ${JSON.stringify(fixture, null, 2)}`,
    ''
  ].join('\n')

/** A live recording paired with the plan entry (and so the fixture module) it belongs to. */
export type RecordedOpenAiFixture = {
  readonly entry: OpenAiProbePlanEntry
  readonly fixture: WireFixture
}

/** File side effects of the probe; injectable so the write gate can be tested without writing. */
export type FixtureWriter = {
  readonly writeFile: (path: string, contents: string) => void
  /** Formats the written files (default: `pnpm exec oxfmt --write`). */
  readonly formatFiles: (paths: ReadonlyArray<string>) => void
}

export const defaultFixtureWriter: FixtureWriter = {
  writeFile: (path, contents) => writeFileSync(path, contents),
  formatFiles: paths => {
    execFileSync('pnpm', ['exec', 'oxfmt', '--write', ...paths], {
      cwd: workspaceRoot,
      stdio: 'inherit'
    })
  }
}

/**
 * The write gate: replay `recorded` through every case and write the fixture modules only when
 * the report passes and every case has exactly one recording. On failure nothing is written and
 * the formatted report is logged. Returns the report and the written paths.
 */
export const writeVerifiedFixtures = (
  recorded: ReadonlyArray<RecordedOpenAiFixture>,
  options: ProbeOptions,
  writer: FixtureWriter = defaultFixtureWriter
) =>
  Effect.gen(function* () {
    const fixtures = recorded.map(({ fixture }) => fixture)
    const report = yield* verifyOpenAiFixtures(fixtures, options)
    const unmatched = casesWithoutSingleFixture(fixtures)

    if (conformanceReportFailed(report) || unmatched.length > 0) {
      yield* Effect.sync(() => console.error(formatConformanceReport(report)))

      return yield* new ProbeFailed({
        caseId: unmatched.length === 0 ? '*' : unmatched.join(', '),
        message: 'recorded fixtures failed replay verification; no fixture was written'
      })
    }

    const files = yield* Effect.sync(() =>
      recorded.map(({ entry, fixture }) => {
        const file = join(fixtureDir, entry.fixtureModule.fileName)

        writer.writeFile(file, renderFixtureModule(entry.fixtureModule, fixture))

        return file
      })
    )

    yield* Effect.sync(() => writer.formatFiles(files))

    return { report, files }
  })

/** What a live run reads and writes; injectable so the gates are testable without credentials. */
export type LiveProbeIo = {
  /** The environment the CI gate reads (only `CI`). */
  readonly env: ProbeEnv
  /** Reads the credential variable; called only after every gate passes. */
  readonly readCredential: (name: string) => string | undefined
  readonly writer: FixtureWriter
}

export const defaultLiveProbeIo: LiveProbeIo = {
  env: process.env,
  readCredential: name => process.env[name],
  writer: defaultFixtureWriter
}

/**
 * The live run. Re-checks the CI and owner-approval gates (and the account label) before the
 * credential is read or any request is made, whatever the options were built by.
 */
export const runLive = (options: ProbeOptions, io: LiveProbeIo = defaultLiveProbeIo) =>
  Effect.gen(function* () {
    const account = options.account

    if (isCiEnvironment(io.env)) {
      return yield* new ProbeFailed({ caseId: '*', message: liveInCiMessage })
    }

    if (!options.ownerApproved) {
      return yield* new ProbeFailed({ caseId: '*', message: ownerApprovalRequiredMessage })
    }

    if (account === undefined) {
      return yield* new ProbeFailed({ caseId: '*', message: liveAccountRequiredMessage })
    }

    const key = io.readCredential(openAiApiKeyEnv)

    if (key === undefined || key.trim().length === 0) {
      return yield* new ProbeFailed({
        caseId: '*',
        message: `${openAiApiKeyEnv} is required for --live`
      })
    }

    const plan = planOpenAiProbe(options)

    // Refuse before any network call if the live safety policy would skip a case.
    for (const entry of plan) {
      const skipReason = conformanceSkipReason({ kind: 'live', account }, entry.testCase)

      if (skipReason !== undefined) {
        return yield* new ProbeFailed({
          caseId: entry.testCase.id,
          message: `refusing to run a case the live safety policy skips (${skipReason})`
        })
      }
    }

    const settings = openAiConformanceSettings(options, Redacted.make(key))

    // Record everything first; write nothing unless every case recorded and verified.
    const recorded = yield* Effect.forEach(plan, entry =>
      recordCase(entry, settings, account).pipe(Effect.map(fixture => ({ entry, fixture })))
    )

    const { report, files } = yield* writeVerifiedFixtures(recorded, options, io.writer)

    console.log(formatConformanceReport(report))
    console.log(`Wrote ${files.length} verified fixtures. Review them before committing.`)
  })

const invokedAsCli = (): boolean => {
  const invoked = process.argv[1]

  return invoked !== undefined && resolve(invoked) === fileURLToPath(import.meta.url)
}

const parseCliArgs = (): ProbeOptions | undefined => {
  try {
    return parseProbeArgs(process.argv.slice(2), process.env)
  } catch (error) {
    console.error(error instanceof Error ? error.message : error)
    process.exitCode = 1

    return undefined
  }
}

const runCli = (options: ProbeOptions): void => {
  if (options.help) {
    console.log(usage)
  } else if (!options.live) {
    console.log(dryRunReport(options))
  } else {
    Effect.runPromise(runLive(options)).catch(error => {
      const scope = error instanceof ProbeFailed && error.caseId !== '*' ? `${error.caseId}: ` : ''

      console.error(`${scope}${error instanceof Error ? error.message : error}`)
      process.exitCode = 1
    })
  }
}

if (invokedAsCli()) {
  const options = parseCliArgs()

  if (options !== undefined) {
    runCli(options)
  }
}
