/**
 * Vercel AI Gateway wire-fixture probe.
 *
 * The Gateway conformance cases (`vercelAiGatewayConformanceCases`) are the single source of
 * truth: this script defines no requests of its own.
 *
 * Default: DRY RUN. Prints, per conformance case, the model, token limit, and reasoning effort it
 * would use, and exits without any network call.
 *
 * `--live`: requires `AI_GATEWAY_API_KEY` and an explicit `--account <label>` (a synthetic,
 * non-identifying label such as `synthetic`; never a real team, project, or person name: it is
 * committed in public fixtures). Runs each conformance case with `runConformance` on a live target
 * against the real Gateway, through the conformance recorder wrapped around a real fetch
 * `HttpClient` (failures are reported with the runner's sanitizer), turns each single recorded
 * exchange into a `verified` fixture dated today, then replays the new fixtures through the same
 * cases. Recorded bodies and chunks have machine-identifying JSON fields (`gatewayJsonRedactions`,
 * for example the Gateway's fingerprint-derived `clientSessionId`) replaced by fixed placeholders
 * before anything is written. Nothing is written unless every case passes live, records cleanly,
 * is fully redacted, passes the secret scan, and passes again on replay; only then are the
 * fixture modules under
 * `packages/agent/src/providers/vercel/conformance/` rewritten. Live runs spend Gateway credits:
 * never run in CI.
 *
 * Model ids are CLI flags defaulting to `vercelAiGatewayConformanceDefaultModels`; confirm they
 * are still available on the Gateway before a live probe.
 */
import { execFileSync } from 'node:child_process'
import { writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'
import { Data, Effect, Layer, Predicate, Redacted } from 'effect'
import type * as Schema from 'effect/Schema'
import { FetchHttpClient, HttpClient } from 'effect/unstable/http'
import type { AgentReasoningEffort } from '@yolk-sdk/agent/protocol'
import { vercelAiGatewayChatCompletionsUrl } from '@yolk-sdk/agent/providers/vercel/ai-gateway-provider'
import {
  VercelAiGatewayConformanceConfig,
  vercelAiGatewayConformanceCases,
  vercelAiGatewayConformanceDefaultModels,
  type VercelAiGatewayConformanceCase,
  type VercelAiGatewayConformanceModels,
  type VercelAiGatewayConformanceSettings
} from '@yolk-sdk/agent/providers/vercel/conformance'
import {
  isWireBase64BodyResponse,
  isWireStreamResponse,
  type WireExchange,
  type WireFixture,
  type WireResponse
} from '../packages/conformance/src/fixture.ts'
import { makeWireFixture, WireRecorder } from '../packages/conformance/src/record.ts'
import { ReplayHttpClient } from '../packages/conformance/src/replay.ts'
import {
  conformanceReportFailed,
  conformanceSkipReason,
  formatConformanceReport,
  runConformance,
  type ConformanceReport
} from '../packages/conformance/src/runner.ts'

export type ProbeOptions = {
  readonly live: boolean
  readonly help: boolean
  /** Model ids per case; default `vercelAiGatewayConformanceDefaultModels`. */
  readonly models: VercelAiGatewayConformanceModels
  readonly maxTokens: number
  readonly reasoningMaxTokens: number
  readonly reasoningEffort: AgentReasoningEffort
  /** Synthetic, non-identifying fixture account label. Required with `--live`. */
  readonly account: string | undefined
}

type MutableProbeOptions = { -readonly [Key in keyof ProbeOptions]: ProbeOptions[Key] }

export const defaultProbeOptions: ProbeOptions = {
  live: false,
  help: false,
  models: vercelAiGatewayConformanceDefaultModels,
  maxTokens: 64,
  reasoningMaxTokens: 512,
  reasoningEffort: 'low',
  account: undefined
}

const reasoningEfforts: ReadonlyArray<AgentReasoningEffort> = [
  'minimal',
  'low',
  'medium',
  'high',
  'xhigh'
]

const defaultModels = defaultProbeOptions.models

const usage = `Usage: pnpm conformance:gateway [--live --account <label>] [options]

Dry run by default: lists the Gateway conformance cases it would run and performs no network I/O.
--live runs each conformance case against the Gateway through the wire recorder, replays the new
fixtures through the same cases, and writes the fixture modules only if every case passes.

Options:
  --live                          Record against the real Gateway (needs AI_GATEWAY_API_KEY and --account)
  --plain-model <id>              default ${defaultModels.plainText}
  --reasoning-model <id>          default ${defaultModels.reasoning} (DeepSeek-style streamed reasoning)
  --tool-model <id>               default ${defaultModels.toolCall}
  --invalid-model <id>            default ${defaultModels.invalid} (must NOT exist)
  --max-tokens <n>                default ${defaultProbeOptions.maxTokens}
  --reasoning-max-tokens <n>      default ${defaultProbeOptions.reasoningMaxTokens}
  --reasoning-effort <effort>     default ${defaultProbeOptions.reasoningEffort}
  --account <label>               required with --live: synthetic, non-identifying fixture
                                  account label (for example synthetic); never a real team,
                                  project, or person name
  --help

Confirm model ids are available on the Gateway before a live probe. Review the
rewritten fixtures before committing: they must contain synthetic content only.`

const positiveInteger = (flag: string, value: string): number => {
  const parsed = Number(value)

  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error(`${flag} must be a positive integer`)
  }

  return parsed
}

export const liveAccountRequiredMessage =
  '--live requires --account <label>: a synthetic, non-identifying label (for example synthetic) that is committed in public fixtures'

/**
 * Parse CLI arguments (without the node/script prefix). Throws on unknown
 * flags, and on `--live` without an explicit `--account`.
 */
export const parseProbeArgs = (argv: ReadonlyArray<string>): ProbeOptions => {
  const options: MutableProbeOptions = { ...defaultProbeOptions }

  const setModel = (key: keyof VercelAiGatewayConformanceModels, model: string) => {
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
      case '--help':
      case '-h':
        options.help = true
        break
      case '--plain-model':
        setModel('plainText', value())
        break
      case '--reasoning-model':
        setModel('reasoning', value())
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
      case '--reasoning-max-tokens':
        options.reasoningMaxTokens = positiveInteger(flag, value())
        break
      case '--reasoning-effort': {
        const effort = value()
        const known = reasoningEfforts.find(candidate => candidate === effort)

        if (known === undefined) {
          throw new Error(`--reasoning-effort must be one of ${reasoningEfforts.join(', ')}`)
        }

        options.reasoningEffort = known
        break
      }

      case '--account':
        options.account = value()
        break
      default:
        throw new Error(`Unknown argument: ${argument}`)
    }
  }

  if (options.live && !options.help && options.account === undefined) {
    throw new Error(liveAccountRequiredMessage)
  }

  return options
}

/**
 * Where a conformance case's recording is written. File and export names are stable so the
 * fixture modules and the conformance `index.ts` never change shape. `model` names the
 * `VercelAiGatewayConformanceModels` entry the case uses; `reasoning` marks the case that uses the
 * reasoning token limit and effort.
 */
export type GatewayFixtureModule = {
  readonly caseId: string
  readonly fileName: string
  readonly exportName: string
  readonly doc: string
  readonly model: keyof VercelAiGatewayConformanceModels
  readonly reasoning: boolean
}

export const gatewayFixtureModules: ReadonlyArray<GatewayFixtureModule> = [
  {
    caseId: 'vercel-ai-gateway.stream.plain-text',
    fileName: 'plain-text.ts',
    exportName: 'vercelAiGatewayPlainTextFixture',
    doc: 'Streamed plain-text answer: text deltas, a `stop` finish with usage (`stream_options.include_usage`), and `data: [DONE]`.',
    model: 'plainText',
    reasoning: false
  },
  {
    caseId: 'vercel-ai-gateway.stream.deepseek-reasoning',
    fileName: 'deepseek-reasoning.ts',
    exportName: 'vercelAiGatewayDeepSeekReasoningFixture',
    doc: 'DeepSeek-style streamed reasoning (the Gateway-normalized `delta.reasoning`, or `delta.reasoning_content`) before the answer text, requested with `reasoning_effort` and a `thinking` toggle.',
    model: 'reasoning',
    reasoning: true
  },
  {
    caseId: 'vercel-ai-gateway.stream.tool-call-deltas',
    fileName: 'tool-call-deltas.ts',
    exportName: 'vercelAiGatewayToolCallDeltasFixture',
    doc: 'Streamed tool call whose JSON arguments arrive as `delta.tool_calls` fragments that assemble into one call.',
    model: 'toolCall',
    reasoning: false
  },
  {
    caseId: 'vercel-ai-gateway.stream.error-envelope',
    fileName: 'error-envelope.ts',
    exportName: 'vercelAiGatewayErrorEnvelopeFixture',
    doc: 'Non-2xx JSON error envelope for a request with an invalid model id.',
    model: 'invalid',
    reasoning: false
  }
]

export const gatewayFixtureModuleFor = (caseId: string): GatewayFixtureModule | undefined =>
  gatewayFixtureModules.find(fixtureModule => fixtureModule.caseId === caseId)

/** One conformance case with everything the probe needs to run, record, and write it. */
export type GatewayProbePlanEntry = {
  readonly testCase: VercelAiGatewayConformanceCase
  readonly fixtureModule: GatewayFixtureModule
  readonly model: string
  readonly maxTokens: number
  /** Only for the reasoning case. */
  readonly reasoningEffort: AgentReasoningEffort | undefined
}

/**
 * Pair every Gateway conformance case with its fixture module and settings. Throws when a case
 * has no module: a new case needs a new entry in `gatewayFixtureModules` (a programmer error).
 */
export const planGatewayProbe = (options: ProbeOptions): ReadonlyArray<GatewayProbePlanEntry> =>
  vercelAiGatewayConformanceCases.map(testCase => {
    const fixtureModule = gatewayFixtureModuleFor(testCase.id)

    if (fixtureModule === undefined) {
      throw new Error(`No fixture module mapped for conformance case ${testCase.id}`)
    }

    return {
      testCase,
      fixtureModule,
      model: options.models[fixtureModule.model],
      maxTokens: fixtureModule.reasoning ? options.reasoningMaxTokens : options.maxTokens,
      reasoningEffort: fixtureModule.reasoning ? options.reasoningEffort : undefined
    }
  })

/** Conformance settings for the given credential; every case reads its models and limits here. */
export const gatewayConformanceSettings = (
  options: ProbeOptions,
  apiKey: Redacted.Redacted<string>
): VercelAiGatewayConformanceSettings => ({
  apiKey,
  maxCompletionTokens: options.maxTokens,
  reasoningMaxCompletionTokens: options.reasoningMaxTokens,
  reasoningEffort: options.reasoningEffort,
  models: options.models
})

export const dryRunReport = (options: ProbeOptions): string =>
  [
    'DRY RUN: no network request was made. Pass --live --account <label> to record (needs AI_GATEWAY_API_KEY).',
    `Endpoint: ${vercelAiGatewayChatCompletionsUrl}`,
    'Conformance cases:',
    ...planGatewayProbe(options).map(entry =>
      [
        `- ${entry.testCase.id} [${entry.testCase.safety}]`,
        `model ${entry.model}`,
        `max tokens ${entry.maxTokens}`,
        `reasoning effort ${entry.reasoningEffort ?? 'none'}`,
        `-> ${entry.fixtureModule.fileName}`
      ].join('  ')
    ),
    'With --live, each case runs against the Gateway through the wire recorder, then all new fixtures',
    'are verified by running the same cases on replay; nothing is written unless every case passes.',
    'Confirm model ids are available on the Gateway before a live probe.'
  ].join('\n')

/**
 * Run every Gateway conformance case on replay against `fixtures` (matched by `caseId`), with a
 * synthetic credential and the same models and limits as the recording. Each case references the
 * fixtures it replays, so the report's fixture warnings describe `fixtures`. A case without a
 * fixture replays nothing and fails, so a missing recording fails the report.
 */
export const verifyGatewayFixtures = (
  fixtures: ReadonlyArray<WireFixture>,
  options: ProbeOptions = defaultProbeOptions
): Effect.Effect<ConformanceReport> => {
  const configLayer = Layer.succeed(
    VercelAiGatewayConformanceConfig,
    gatewayConformanceSettings(options, Redacted.make('synthetic-replay-key'))
  )

  const fixturesFor = (caseId: string) => fixtures.filter(fixture => fixture.caseId === caseId)

  const cases = vercelAiGatewayConformanceCases.map((testCase): VercelAiGatewayConformanceCase => ({
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
  vercelAiGatewayConformanceCases
    .map(testCase => testCase.id)
    .filter(caseId => fixtures.filter(fixture => fixture.caseId === caseId).length !== 1)

/** JSON field name to the fixed placeholder that replaces its string value before writing. */
export type JsonFieldRedactions = Readonly<Record<string, string>>

/**
 * Fields redacted from every Gateway recording. The Gateway's routing metadata carries a
 * `clientSessionId` derived from a client fingerprint (`clientSessionIdSource: "fingerprint"`),
 * which may identify the machine that ran the probe; fixtures are public.
 */
export const gatewayJsonRedactions = {
  clientSessionId: 'redacted-client-session'
} satisfies JsonFieldRedactions

const escapeRegExp = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

// `"field": "value"` inside JSON text (a string value, escapes included). Only the value changes,
// so every other recorded byte (whitespace, key order, neighbours) is preserved.
const jsonFieldPattern = (field: string): RegExp =>
  new RegExp(`("${escapeRegExp(field)}"\\s*:\\s*)"(?:[^"\\\\]|\\\\.)*"`, 'g')

const redactJsonText = (text: string, redactions: JsonFieldRedactions): string =>
  Object.entries(redactions).reduce(
    (current, [field, placeholder]) =>
      current.replace(
        jsonFieldPattern(field),
        (_match, prefix: string) => `${prefix}${JSON.stringify(placeholder)}`
      ),
    text
  )

const isJsonArray = (value: Schema.JsonArray | Schema.JsonObject): value is Schema.JsonArray =>
  Array.isArray(value)

const redactJsonValue = (value: Schema.Json, redactions: JsonFieldRedactions): Schema.Json => {
  if (Predicate.isString(value)) {
    return redactJsonText(value, redactions)
  }

  if (value === null || Predicate.isNumber(value) || Predicate.isBoolean(value)) {
    return value
  }

  if (isJsonArray(value)) {
    return value.map(item => redactJsonValue(item, redactions))
  }

  return Object.fromEntries(
    Object.entries(value).map(([key, item]) => {
      const placeholder = Object.hasOwn(redactions, key) ? redactions[key] : undefined

      return [
        key,
        placeholder !== undefined && Predicate.isString(item)
          ? placeholder
          : redactJsonValue(item, redactions)
      ]
    })
  )
}

const redactResponse = (response: WireResponse, redactions: JsonFieldRedactions): WireResponse => {
  if (isWireStreamResponse(response)) {
    return {
      ...response,
      chunks: response.chunks.map(chunk =>
        Predicate.isString(chunk) ? redactJsonText(chunk, redactions) : chunk
      )
    }
  }

  return isWireBase64BodyResponse(response)
    ? response
    : { ...response, body: redactJsonText(response.body, redactions) }
}

// The response text a redaction applies to: the text body, or the text chunks joined.
const responseText = (response: WireResponse): string => {
  if (isWireStreamResponse(response)) {
    return response.chunks.filter(Predicate.isString).join('')
  }

  return isWireBase64BodyResponse(response) ? '' : response.body
}

/**
 * Replace the string value of every redacted JSON field in recorded exchanges: request bodies
 * (parsed JSON, or JSON text), text response bodies, and text stream chunks (SSE `data:` JSON).
 * Chunk boundaries and all other bytes are kept. Base64 bodies and chunks are left untouched.
 */
export const redactJsonFields = (
  exchanges: ReadonlyArray<WireExchange>,
  redactions: JsonFieldRedactions
): ReadonlyArray<WireExchange> =>
  exchanges.map(({ request, response }) => ({
    request:
      request.body === undefined
        ? request
        : { ...request, body: redactJsonValue(request.body, redactions) },
    response: redactResponse(response, redactions)
  }))

/**
 * Redacted fields still carrying another value, checked on each exchange's whole text (stream
 * chunks joined), so a value split across network chunks is caught. Empty when fully redacted.
 */
export const unredactedJsonFields = (
  exchanges: ReadonlyArray<WireExchange>,
  redactions: JsonFieldRedactions
): ReadonlyArray<string> => {
  const texts = exchanges.flatMap(({ request, response }) => [
    JSON.stringify(request.body ?? null),
    responseText(response)
  ])

  return Object.entries(redactions).flatMap(([field, placeholder]) =>
    texts.some(text => redactJsonText(text, { [field]: placeholder }) !== text) ? [field] : []
  )
}

/** The redacted exchanges, the fields that were redacted, and any field left unredacted. */
export type RedactedRecording = {
  readonly exchanges: ReadonlyArray<WireExchange>
  readonly redactedFields: ReadonlyArray<string>
  readonly unredactedFields: ReadonlyArray<string>
}

export const redactRecording = (
  exchanges: ReadonlyArray<WireExchange>,
  redactions: JsonFieldRedactions = gatewayJsonRedactions
): RedactedRecording => {
  const redacted = redactJsonFields(exchanges, redactions)

  return {
    exchanges: redacted,
    redactedFields: unredactedJsonFields(exchanges, redactions),
    unredactedFields: unredactedJsonFields(redacted, redactions)
  }
}

/** The note written into every recorded fixture, naming the fields redacted from it. */
export const gatewayFixtureNote = (redactedFields: ReadonlyArray<string>): string =>
  [
    'Recorded from the live Vercel AI Gateway by running its conformance case through pnpm conformance:gateway --live. Prompts and outputs are synthetic.',
    ...redactedFields.map(field => `${field} redacted after recording.`)
  ].join(' ')

export class ProbeFailed extends Data.TaggedError('ProbeFailed')<{
  readonly caseId: string
  readonly message: string
}> {}

const workspaceRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')

const fixtureDir = join(workspaceRoot, 'packages/agent/src/providers/vercel/conformance')

const today = () => new Date().toISOString().slice(0, 10)

// Runs the case through `runConformance` on the live target (same safety policy and sanitized
// failure report as any conformance run) with the recording client, then redacts the single
// recorded exchange (`gatewayJsonRedactions`) and turns it into a verified fixture.
const recordCase = (
  entry: GatewayProbePlanEntry,
  settings: VercelAiGatewayConformanceSettings,
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
          Layer.succeed(VercelAiGatewayConformanceConfig, settings)
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

    const redacted = redactRecording(exchanges)

    if (redacted.unredactedFields.length > 0) {
      return yield* new ProbeFailed({
        caseId,
        message: `could not redact ${redacted.unredactedFields.join(', ')} from the recording`
      })
    }

    return yield* makeWireFixture({
      id: `${caseId}.recorded`,
      caseId,
      evidence: 'verified',
      recordedAt: today(),
      account,
      endpoint: vercelAiGatewayChatCompletionsUrl,
      model: entry.model,
      note: gatewayFixtureNote(redacted.redactedFields),
      exchanges: redacted.exchanges
    }).pipe(Effect.mapError(error => new ProbeFailed({ caseId, message: error.message })))
  }).pipe(Effect.provide(WireRecorder.layer().pipe(Layer.provide(FetchHttpClient.layer))))

export const renderFixtureModule = (
  fixtureModule: GatewayFixtureModule,
  fixture: WireFixture
): string =>
  [
    "import type { WireFixture } from '@yolk-sdk/conformance/fixture'",
    '',
    '/**',
    ` * ${fixtureModule.doc}`,
    ' *',
    ` * Verified recording (${fixture.recordedAt}). Regenerate with`,
    ' * `pnpm conformance:gateway --live --account <label>`.',
    ' */',
    `export const ${fixtureModule.exportName}: WireFixture = ${JSON.stringify(fixture, null, 2)}`,
    ''
  ].join('\n')

/** A live recording paired with the plan entry (and so the fixture module) it belongs to. */
export type RecordedGatewayFixture = {
  readonly entry: GatewayProbePlanEntry
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
  recorded: ReadonlyArray<RecordedGatewayFixture>,
  options: ProbeOptions,
  writer: FixtureWriter = defaultFixtureWriter
) =>
  Effect.gen(function* () {
    const fixtures = recorded.map(({ fixture }) => fixture)
    const report = yield* verifyGatewayFixtures(fixtures, options)
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

    if (account === undefined) {
      return yield* new ProbeFailed({ caseId: '*', message: liveAccountRequiredMessage })
    }

    const key = process.env.AI_GATEWAY_API_KEY

    if (key === undefined || key.trim().length === 0) {
      return yield* new ProbeFailed({
        caseId: '*',
        message: 'AI_GATEWAY_API_KEY is required for --live'
      })
    }

    const plan = planGatewayProbe(options)

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

    const settings = gatewayConformanceSettings(options, Redacted.make(key))

    // Record everything first; write nothing unless every case recorded and verified.
    const recorded = yield* Effect.forEach(plan, entry =>
      recordCase(entry, settings, account).pipe(Effect.map(fixture => ({ entry, fixture })))
    )

    const { report, files } = yield* writeVerifiedFixtures(recorded, options, writer)

    console.log(formatConformanceReport(report))
    console.log(`Wrote ${files.length} verified fixtures. Review them before committing.`)
  })

const invokedAsCli = (): boolean => {
  const invoked = process.argv[1]

  return invoked !== undefined && resolve(invoked) === fileURLToPath(import.meta.url)
}

const parseCliArgs = (): ProbeOptions | undefined => {
  try {
    return parseProbeArgs(process.argv.slice(2))
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
    Effect.runPromise(live(options)).catch(error => {
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
