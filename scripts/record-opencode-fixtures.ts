/**
 * OpenCode Go wire-fixture probe (`pnpm conformance:opencode`).
 *
 * The Go conformance cases (`openCodeGoConformanceCases`: plain text on `chat-completions`,
 * `messages`, and `responses`, the Responses commentary replay, and the usage snapshot) are the
 * single source of truth: this script defines no requests of its own.
 *
 * Default: DRY RUN. Prints, per conformance case, the model it would use and the fixture module it
 * would write, and exits without any network call or credential read.
 *
 * `--live`: the credential is the owner's OpenCode Go API key (`OPENCODE_API_KEY`), so a live run
 * spends the owner's Go subscription allowance. **Live runs need the repository owner's explicit
 * approval**, confirmed with `--owner-approved`; never run them in CI (`--live` is refused
 * whenever the `CI` environment variable is set to any non-empty value, `0` and `false` included).
 * A live run also needs an explicit `--account <label>` (a synthetic, non-identifying label such as
 * `synthetic`, committed in public fixtures) and one real Go model id per protocol
 * (`--chat-model`, `--messages-model`, `--responses-model`): the committed defaults are synthetic
 * placeholders, and Go model ids are host-selected per protocol, never inferred.
 *
 * Each case runs with `runConformance` on a live target through the conformance recorder wrapped
 * around a real fetch `HttpClient` (request headers `content-type` and `accept` only, response
 * headers `content-type` only, so the API key is never recorded; failures are reported with the
 * runner's sanitizer). Encrypted and account-derived JSON string fields (`openCodeRedaction`) are
 * redacted value by value in text chunks only (never re-chunked); a value left in a base64 chunk
 * or split across chunks, a non-string value, a repeated redacted key, or any SSE `data:` payload
 * or body the member scanner cannot fully scan (only `[DONE]` is exempt) refuses the write. Each
 * single recorded exchange becomes a `verified` fixture dated today, then the new fixtures replay
 * through the same cases; nothing is written unless every case passes live, records cleanly, is
 * fully redacted, passes the secret scan, and passes again on replay.
 */
import { join } from 'node:path'
import process from 'node:process'
import { Data, Effect, Layer, Redacted } from 'effect'
import { FetchHttpClient, HttpClient } from 'effect/unstable/http'
import {
  OpenCodeGoConformanceConfig,
  openCodeGoConformanceBaseUrl,
  openCodeGoConformanceCases,
  openCodeGoConformanceDefaultModels,
  openCodeGoConformanceUsageUrl,
  type OpenCodeGoConformanceModels
} from '@yolk-sdk/agent/providers/opencode/conformance'
import type { ConformanceSafety } from '../packages/conformance/src/case.ts'
import type { WireFixture } from '../packages/conformance/src/fixture.ts'
import { makeWireFixture, WireRecorder } from '../packages/conformance/src/record.ts'
import { ReplayHttpClient } from '../packages/conformance/src/replay.ts'
import {
  conformanceReportFailed,
  conformanceSkipReason,
  formatConformanceReport,
  runConformance,
  type ConformanceReport,
  type ConformanceTarget
} from '../packages/conformance/src/runner.ts'
import {
  accountIdentifierFields,
  defaultFixtureWriter,
  invokedAsCli,
  isCiEnvironment,
  parseFlags,
  positiveInteger,
  redactExchange,
  redactionRefusal,
  today,
  workspaceRoot,
  type FixtureWriter,
  type ProbeEnv,
  type RedactionSpec
} from './fixture-probe-internal.ts'

export type ProbeOptions = {
  readonly live: boolean
  readonly help: boolean
  /** Explicit confirmation that the repository owner approved this live run. */
  readonly ownerApproved: boolean
  /** Model overrides; required for every protocol with `--live`. */
  readonly models: Partial<OpenCodeGoConformanceModels>
  /** The host output limit every protocol case sends. */
  readonly maxOutputTokens: number
  /** Synthetic, non-identifying fixture account label. Required with `--live`. */
  readonly account: string | undefined
}

type MutableProbeOptions = { -readonly [Key in keyof ProbeOptions]: ProbeOptions[Key] }

export const defaultProbeOptions: ProbeOptions = {
  live: false,
  help: false,
  ownerApproved: false,
  models: {},
  // Room for a reasoning model to think before its short answer.
  maxOutputTokens: 512,
  account: undefined
}

/** The API-key environment variable a live run reads. */
export const openCodeApiKeyEnv = 'OPENCODE_API_KEY'

export const command = 'pnpm conformance:opencode'

export const regenerateCommand =
  'pnpm conformance:opencode --live --owner-approved --account <label> --chat-model <id> --messages-model <id> --responses-model <id>'

export const fixtureDir = join(workspaceRoot, 'packages/agent/src/providers/opencode/conformance')

/** Where a conformance case's recording is written (stable file and export names). */
export type OpenCodeFixtureModule = {
  readonly caseId: string
  readonly fileName: string
  readonly exportName: string
  readonly doc: string
  readonly endpoint: string
  /** The protocol model the case uses; undefined for the usage case. */
  readonly model: keyof OpenCodeGoConformanceModels | undefined
}

export const openCodeFixtureModules: ReadonlyArray<OpenCodeFixtureModule> = [
  {
    caseId: 'opencode.go.chat.stream.plain-text',
    fileName: 'chat-plain-text.ts',
    exportName: 'openCodeGoChatPlainTextFixture',
    doc: 'Streamed plain-text answer from OpenCode Go Chat Completions: `chat.completion.chunk` server-sent events with a `stop` finish, a usage chunk, and `data: [DONE]`.',
    endpoint: `${openCodeGoConformanceBaseUrl}/chat/completions`,
    model: 'chat'
  },
  {
    caseId: 'opencode.go.messages.stream.plain-text',
    fileName: 'messages-plain-text.ts',
    exportName: 'openCodeGoMessagesPlainTextFixture',
    doc: 'Streamed plain-text answer from OpenCode Go Messages: Anthropic Messages events ending with `message_delta` (`end_turn`, usage) and `message_stop`.',
    endpoint: `${openCodeGoConformanceBaseUrl}/messages`,
    model: 'messages'
  },
  {
    caseId: 'opencode.go.responses.stream.plain-text',
    fileName: 'responses-plain-text.ts',
    exportName: 'openCodeGoResponsesPlainTextFixture',
    doc: 'Streamed plain-text answer from OpenCode Go Responses: Responses server-sent events ending with `response.completed` carrying the output and usage.',
    endpoint: `${openCodeGoConformanceBaseUrl}/responses`,
    model: 'responses'
  },
  {
    caseId: 'opencode.go.responses.stream.commentary-replay',
    fileName: 'responses-commentary-replay.ts',
    exportName: 'openCodeGoResponsesCommentaryReplayFixture',
    doc: 'Streamed OpenCode Go Responses answer to a request replaying one earlier tool turn with its text tagged `phase: "commentary"`.',
    endpoint: `${openCodeGoConformanceBaseUrl}/responses`,
    model: 'responses'
  },
  {
    caseId: 'opencode.go.usage.snapshot',
    fileName: 'usage-snapshot.ts',
    exportName: 'openCodeGoUsageSnapshotFixture',
    doc: 'OpenCode Go subscription-usage snapshot: `GET /zen/go/v1/usage` answering `usage.rolling`, `usage.weekly`, and `usage.monthly` as `{ percent, resetsAt }`.',
    endpoint: openCodeGoConformanceUsageUrl,
    model: undefined
  }
]

/**
 * What the probe redacts in recorded responses: encrypted reasoning and thinking data
 * (`encrypted_content`, `signature`, `data`), account-derived Responses identifiers
 * (`safety_identifier`, `prompt_cache_key`), and account identifiers a usage body may carry.
 * None is needed for replay.
 */
export const openCodeRedaction: RedactionSpec = {
  fields: [
    'encrypted_content',
    'safety_identifier',
    'prompt_cache_key',
    'signature',
    'data',
    ...accountIdentifierFields
  ],
  placeholder: 'redacted',
  permittedNonJson: ['[DONE]']
}

const usage = `Usage: pnpm conformance:opencode [--live --owner-approved --account <label> --chat-model <id> --messages-model <id> --responses-model <id>] [options]

Dry run by default: lists the OpenCode Go conformance cases and performs no network I/O and no
credential read. --live runs each case against https://opencode.ai/zen/go/v1 through the wire
recorder, replays the new fixtures through the same cases, and writes the fixture modules only if
every case passes.

The credential is the owner's OpenCode Go API key (${openCodeApiKeyEnv}): live runs spend the owner's
Go subscription allowance and need the repository owner's explicit approval (--owner-approved).
Never run them in CI: --live is refused whenever the CI environment variable is set to any
non-empty value (0 and false included).

Options:
  --live                    record against the real endpoint (needs --owner-approved, --account,
                            the three model flags, and ${openCodeApiKeyEnv})
  --owner-approved          confirm the repository owner approved this live run
  --account <label>         required with --live: synthetic, non-identifying fixture account label
  --chat-model <id>         a Go model advertised for chat-completions (required with --live)
  --messages-model <id>     a Go model advertised for messages (required with --live)
  --responses-model <id>    a Go model advertised for responses (required with --live)
  --max-output-tokens <n>   host output limit (default ${defaultProbeOptions.maxOutputTokens})
  --help

Review the rewritten fixtures before committing: they must contain synthetic content only.`

export const liveAccountRequiredMessage =
  '--live requires --account <label>: a synthetic, non-identifying label (for example synthetic) that is committed in public fixtures'

export const ownerApprovalRequiredMessage =
  "--live requires --owner-approved: live runs spend the owner's OpenCode Go subscription allowance and need the repository owner's explicit approval"

export const liveInCiMessage =
  "--live is refused in CI (the CI environment variable is set to a non-empty value): live runs spend the owner's OpenCode Go subscription allowance and must be run by hand with the repository owner's approval"

export const modelsRequiredMessage =
  '--live requires --chat-model, --messages-model, and --responses-model: real Go model ids per protocol (the committed defaults are synthetic placeholders)'

/**
 * Parse CLI arguments (without the node/script prefix). Throws on unknown flags, on `--live` in CI
 * (`env.CI` set), and on `--live` without `--owner-approved`, `--account`, or the model flags.
 */
export const parseProbeArgs = (argv: ReadonlyArray<string>, env: ProbeEnv = {}): ProbeOptions => {
  const options: MutableProbeOptions = { ...defaultProbeOptions }

  const setModel = (key: keyof OpenCodeGoConformanceModels, model: string) => {
    options.models = { ...options.models, [key]: model }
  }

  parseFlags(argv, (flag, argument, value) => {
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
      case '--chat-model':
        setModel('chat', value())
        break
      case '--messages-model':
        setModel('messages', value())
        break
      case '--responses-model':
        setModel('responses', value())
        break
      case '--max-output-tokens':
        options.maxOutputTokens = positiveInteger(flag, value())
        break
      case '--account':
        options.account = value()
        break
      default:
        throw new Error(`Unknown argument: ${argument}`)
    }
  })

  if (options.help) return options

  if (options.live && isCiEnvironment(env)) throw new Error(liveInCiMessage)

  if (options.live && !options.ownerApproved) throw new Error(ownerApprovalRequiredMessage)

  if (options.live && options.account === undefined) throw new Error(liveAccountRequiredMessage)

  if (
    options.live &&
    (options.models.chat === undefined ||
      options.models.messages === undefined ||
      options.models.responses === undefined)
  ) {
    throw new Error(modelsRequiredMessage)
  }

  return options
}

/** The models a run uses: the synthetic defaults with the CLI overrides. */
export const probeModels = (options: ProbeOptions): OpenCodeGoConformanceModels => ({
  ...openCodeGoConformanceDefaultModels,
  ...options.models
})

/** One conformance case with everything the probe needs to run, record, and write it. */
export type OpenCodeProbePlanEntry = {
  readonly caseId: string
  readonly safety: ConformanceSafety
  readonly fixtureModule: OpenCodeFixtureModule
  readonly model: string | undefined
}

/**
 * Pair every Go conformance case with its fixture module and model. Throws when a case has no
 * module: a new case needs a new fixture module entry (a programmer error).
 */
export const planOpenCodeProbe = (options: ProbeOptions): ReadonlyArray<OpenCodeProbePlanEntry> => {
  const models = probeModels(options)

  return openCodeGoConformanceCases.map(testCase => {
    const fixtureModule = openCodeFixtureModules.find(entry => entry.caseId === testCase.id)

    if (fixtureModule === undefined) {
      throw new Error(`No fixture module mapped for conformance case ${testCase.id}`)
    }

    return {
      caseId: testCase.id,
      safety: testCase.safety,
      fixtureModule,
      model: fixtureModule.model === undefined ? undefined : models[fixtureModule.model]
    }
  })
}

export const dryRunReport = (options: ProbeOptions): string =>
  [
    `DRY RUN: no network request was made and no credential was read. Pass --live --owner-approved --account <label> and the three model flags to record (needs ${openCodeApiKeyEnv}).`,
    `Endpoints: ${openCodeGoConformanceBaseUrl} (chat/completions, messages, responses) and ${openCodeGoConformanceUsageUrl} (OpenCode Go API key)`,
    "Live runs spend the owner's Go subscription allowance and need the repository owner's explicit approval; never run them in CI.",
    `Protocol cases send a host output limit of ${options.maxOutputTokens}.`,
    'Conformance cases:',
    ...planOpenCodeProbe(options).map(entry =>
      [
        `- ${entry.caseId} [${entry.safety}]`,
        entry.model === undefined ? 'no model' : `model ${entry.model}`,
        `-> ${entry.fixtureModule.fileName}`
      ].join('  ')
    ),
    'With --live, each case runs against the endpoint through the wire recorder, then all new',
    'fixtures are verified by running the same cases on replay; nothing is written unless every case passes.'
  ].join('\n')

type CaseRun = {
  readonly target: ConformanceTarget
  readonly fixtures?: ReadonlyArray<WireFixture>
  readonly caseIds?: ReadonlyArray<string>
  readonly fixtureIdsFor?: (caseId: string) => ReadonlyArray<string>
  readonly httpLayer: (caseId: string) => Layer.Layer<HttpClient.HttpClient>
}

/** Run the Go conformance cases with the given API key and per-case HttpClient. */
export const runOpenCodeCases = (
  options: ProbeOptions,
  apiKey: Redacted.Redacted<string>,
  run: CaseRun
): Effect.Effect<ConformanceReport> => {
  const config = Layer.succeed(OpenCodeGoConformanceConfig, {
    apiKey,
    maxOutputTokens: options.maxOutputTokens,
    models: probeModels(options)
  })

  const cases = openCodeGoConformanceCases.flatMap(testCase => {
    if (run.caseIds !== undefined && !run.caseIds.includes(testCase.id)) return []

    return [
      run.fixtureIdsFor === undefined
        ? testCase
        : { ...testCase, fixtures: run.fixtureIdsFor(testCase.id) }
    ]
  })

  const settings =
    run.fixtures === undefined
      ? { target: run.target }
      : { target: run.target, fixtures: run.fixtures }

  return runConformance(cases, {
    ...settings,
    layer: testCase => Layer.mergeAll(run.httpLayer(testCase.id), config)
  })
}

/**
 * Run every Go case on replay against `fixtures` (matched by `caseId`) with a synthetic key and
 * the same models and limit as the recording. A case without a fixture fails the report.
 */
export const verifyOpenCodeFixtures = (
  fixtures: ReadonlyArray<WireFixture>,
  options: ProbeOptions
): Effect.Effect<ConformanceReport> => {
  const fixturesFor = (caseId: string) => fixtures.filter(fixture => fixture.caseId === caseId)

  return runOpenCodeCases(options, Redacted.make('synthetic-replay-key'), {
    target: { kind: 'replay' },
    fixtures,
    fixtureIdsFor: caseId => fixturesFor(caseId).map(fixture => fixture.id),
    httpLayer: caseId => ReplayHttpClient.layer(fixturesFor(caseId))
  })
}

/** Case ids with no fixture, or with more than one. */
export const casesWithoutSingleFixture = (fixtures: ReadonlyArray<WireFixture>) =>
  openCodeGoConformanceCases
    .map(testCase => testCase.id)
    .filter(caseId => fixtures.filter(fixture => fixture.caseId === caseId).length !== 1)

export class ProbeFailed extends Data.TaggedError('ProbeFailed')<{
  readonly caseId: string
  readonly message: string
}> {}

const recordCase = (
  entry: OpenCodeProbePlanEntry,
  options: ProbeOptions,
  apiKey: Redacted.Redacted<string>,
  account: string
) =>
  Effect.gen(function* () {
    const caseId = entry.caseId
    const recorder = yield* WireRecorder
    const client = yield* HttpClient.HttpClient

    const report = yield* runOpenCodeCases(options, apiKey, {
      target: { kind: 'live', account },
      caseIds: [caseId],
      httpLayer: () => Layer.succeed(HttpClient.HttpClient, client)
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

    const redacted = exchanges.map(exchange => redactExchange(exchange, openCodeRedaction))
    const refusal = redactionRefusal(redacted, openCodeRedaction)

    if (refusal !== undefined) return yield* new ProbeFailed({ caseId, message: refusal })

    const fixture = {
      id: `${caseId}.recorded`,
      caseId,
      evidence: 'verified' as const,
      recordedAt: today(),
      account,
      endpoint: entry.fixtureModule.endpoint,
      note: `Recorded from OpenCode Go by running its conformance case through ${command} --live. Prompts and outputs are synthetic; encrypted and account-derived fields are redacted.`,
      exchanges: redacted
    }

    return yield* makeWireFixture(
      entry.model === undefined ? fixture : { ...fixture, model: entry.model }
    ).pipe(Effect.mapError(error => new ProbeFailed({ caseId, message: error.message })))
  }).pipe(
    Effect.provide(
      WireRecorder.layer({ responseHeaders: ['content-type'] }).pipe(
        Layer.provide(FetchHttpClient.layer)
      )
    )
  )

export const renderFixtureModule = (
  fixtureModule: OpenCodeFixtureModule,
  fixture: WireFixture
): string =>
  [
    "import type { WireFixture } from '@yolk-sdk/conformance/fixture'",
    '',
    '/**',
    ` * ${fixtureModule.doc}`,
    ' *',
    ` * Verified recording (${fixture.recordedAt}). Regenerate with`,
    ` * \`${regenerateCommand}\`.`,
    ' */',
    `export const ${fixtureModule.exportName}: WireFixture = ${JSON.stringify(fixture, null, 2)}`,
    ''
  ].join('\n')

/** A live recording paired with the plan entry (and so the fixture module) it belongs to. */
export type RecordedOpenCodeFixture = {
  readonly entry: OpenCodeProbePlanEntry
  readonly fixture: WireFixture
}

/**
 * The write gate: refuse any recording that still carries a redacted field or has a payload the
 * survivor check cannot scan, then replay `recorded` through every case and write the fixture
 * modules only when the report passes and every case has exactly one recording. On failure
 * nothing is written.
 */
export const writeVerifiedFixtures = (
  recorded: ReadonlyArray<RecordedOpenCodeFixture>,
  options: ProbeOptions,
  writer: FixtureWriter = defaultFixtureWriter
) =>
  Effect.gen(function* () {
    const fixtures = recorded.map(({ fixture }) => fixture)

    for (const fixture of fixtures) {
      const refusal = redactionRefusal(fixture.exchanges, openCodeRedaction)

      if (refusal !== undefined) {
        return yield* new ProbeFailed({
          caseId: fixture.caseId,
          message: `${refusal}; no fixture was written`
        })
      }
    }

    const report = yield* verifyOpenCodeFixtures(fixtures, options)
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

const live = (options: ProbeOptions, writer: FixtureWriter = defaultFixtureWriter) =>
  Effect.gen(function* () {
    const account = options.account

    if (isCiEnvironment(process.env)) {
      return yield* new ProbeFailed({ caseId: '*', message: liveInCiMessage })
    }

    if (!options.ownerApproved) {
      return yield* new ProbeFailed({ caseId: '*', message: ownerApprovalRequiredMessage })
    }

    if (account === undefined) {
      return yield* new ProbeFailed({ caseId: '*', message: liveAccountRequiredMessage })
    }

    const key = process.env[openCodeApiKeyEnv]

    if (key === undefined || key.trim().length === 0) {
      return yield* new ProbeFailed({
        caseId: '*',
        message: `${openCodeApiKeyEnv} is required for --live`
      })
    }

    const plan = planOpenCodeProbe(options)

    // Refuse before any network call if the live safety policy would skip a case.
    for (const entry of plan) {
      const skipReason = conformanceSkipReason(
        { kind: 'live', account },
        { id: entry.caseId, safety: entry.safety }
      )

      if (skipReason !== undefined) {
        return yield* new ProbeFailed({
          caseId: entry.caseId,
          message: `refusing to run a case the live safety policy skips (${skipReason})`
        })
      }
    }

    const apiKey = Redacted.make(key)

    // Record everything first; write nothing unless every case recorded and verified.
    const recorded = yield* Effect.forEach(plan, entry =>
      recordCase(entry, options, apiKey, account).pipe(Effect.map(fixture => ({ entry, fixture })))
    )

    const { report, files } = yield* writeVerifiedFixtures(recorded, options, writer)

    console.log(formatConformanceReport(report))
    console.log(`Wrote ${files.length} verified fixtures. Review them before committing.`)
  })

const runCli = (): void => {
  let options: ProbeOptions

  try {
    options = parseProbeArgs(process.argv.slice(2), process.env)
  } catch (error) {
    console.error(error instanceof Error ? error.message : error)
    process.exitCode = 1

    return
  }

  if (options.help) {
    console.log(usage)
  } else if (!options.live) {
    console.log(dryRunReport(options))
  } else {
    Effect.runPromise(live(options)).catch(error => {
      const scope = error instanceof ProbeFailed && error.caseId !== '*' ? `${error.caseId}: ` : ''

      console.error(`${scope}${error instanceof Error ? error.message : error}`)
      process.exitCode = 1
    })
  }
}

if (invokedAsCli(import.meta.url, process.argv[1])) runCli()
