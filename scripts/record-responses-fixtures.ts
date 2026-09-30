/**
 * OpenAI Responses wire-fixture probe for the subscription providers, one family per run:
 * `--family codex` (`pnpm conformance:codex`, the ChatGPT Codex endpoint) or `--family grok`
 * (`pnpm conformance:grok`, the xAI Grok CLI proxy).
 *
 * The family's conformance cases (`openAiCodexConformanceCases` / `xAiGrokConformanceCases`) are
 * the single source of truth: this script defines no requests of its own.
 *
 * Default: DRY RUN. Prints, per conformance case, the model it would use, and exits without any
 * network call or credential read.
 *
 * `--live`: the credentials are consumer subscription OAuth access tokens, so a live run spends
 * the owner's subscription allowance and must follow the provider's terms. **Live runs need the
 * repository owner's explicit approval**, confirmed with `--owner-approved`; never run them in
 * CI (`--live` is refused whenever the `CI` environment variable is set to any non-empty value,
 * `0` and `false` included). A live run also needs an explicit `--account <label>` (a synthetic,
 * non-identifying label such as `synthetic`; never a real organization, workspace, or person
 * name: it is committed in public fixtures) and the family's token:
 *
 * - codex: `OPENAI_CODEX_ACCESS_TOKEN` (a ChatGPT OAuth access token; the optional
 *   `OPENAI_CODEX_ACCOUNT_ID` is sent as `ChatGPT-Account-Id` and never recorded);
 * - grok: `XAI_GROK_ACCESS_TOKEN` (a Grok OAuth access token) plus `--client-version <v>`, the
 *   truthful host client version sent as `x-grok-client-version` (never impersonate an official
 *   Grok client version).
 *
 * Each conformance case runs with `runConformance` on a live target through the conformance
 * recorder wrapped around a real fetch `HttpClient` (default request headers `content-type` and
 * `accept` only, response headers `content-type` only, so credentials, account ids, and the Grok
 * headers are never recorded; failures are reported with the runner's sanitizer). Account-derived
 * and encrypted JSON string fields (`responsesRedactedFields`) are redacted value by value in text
 * chunks only (never re-chunked); a value left in a base64 chunk or split across chunks, a
 * non-string value, or a repeated redacted key refuses the write (checked on every occurrence in
 * the reassembled wire text, never through `JSON.parse`, which collapses repeated keys). So does
 * any SSE `data:` payload or body the member scanner cannot fully scan (invalid JSON, nesting past
 * its depth limit), except the `[DONE]` sentinel. Each single recorded exchange becomes a
 * `verified` fixture dated today, then the new fixtures replay through the same cases. Nothing is
 * written unless every case passes live, records cleanly, is fully redacted, passes the secret
 * scan, and passes again on replay; only then are the family's fixture modules rewritten.
 *
 * Model ids are CLI flags defaulting to the family's conformance default models; confirm they are
 * still available on the subscription before a live probe.
 */
import { execFileSync } from 'node:child_process'
import { writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'
import { Data, Effect, Encoding, Layer, Predicate, Result } from 'effect'
import { FetchHttpClient, HttpClient } from 'effect/unstable/http'
import { OAuthAccessToken } from '@yolk-sdk/agent/oauth'
import {
  OpenAiCodexConformanceConfig,
  openAiCodexConformanceCases,
  openAiCodexConformanceDefaultModels,
  openAiCodexConformanceResponsesUrl,
  type OpenAiCodexConformanceCase
} from '@yolk-sdk/agent/providers/openai/conformance'
import {
  XAiGrokConformanceConfig,
  xAiGrokConformanceCases,
  xAiGrokConformanceDefaultModels,
  xAiGrokConformanceResponsesUrl,
  type XAiGrokConformanceCase
} from '@yolk-sdk/agent/providers/xai/conformance'
import type { ConformanceSafety } from '../packages/conformance/src/case.ts'
import {
  isWireBase64BodyResponse,
  isWireStreamResponse,
  type WireChunk,
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
  type ConformanceReport,
  type ConformanceTarget
} from '../packages/conformance/src/runner.ts'
import { unredactedMembers } from './json-members.ts'

export type ResponsesFamily = 'codex' | 'grok'

/** Model ids per case (the same shape for both families). */
export type ResponsesProbeModels = {
  readonly plainText: string
  readonly toolCall: string
  readonly invalid: string
}

export type ProbeOptions = {
  readonly family: ResponsesFamily | undefined
  readonly live: boolean
  readonly help: boolean
  /** Explicit confirmation that the repository owner approved this live run. */
  readonly ownerApproved: boolean
  /** Model overrides; each missing entry defaults to the family's conformance default. */
  readonly models: Partial<ResponsesProbeModels>
  /** Grok only: the `max_output_tokens` the cases send. */
  readonly maxOutputTokens: number
  /** Grok only: the truthful host client version. Required with `--live --family grok`. */
  readonly clientVersion: string | undefined
  /** Synthetic, non-identifying fixture account label. Required with `--live`. */
  readonly account: string | undefined
}

type MutableProbeOptions = { -readonly [Key in keyof ProbeOptions]: ProbeOptions[Key] }

export const defaultProbeOptions: ProbeOptions = {
  family: undefined,
  live: false,
  help: false,
  ownerApproved: false,
  models: {},
  // Room for a reasoning model to think before its short answer (a smaller limit can end the
  // stream with `response.incomplete`, which fails the live cases and writes nothing).
  maxOutputTokens: 512,
  clientVersion: undefined,
  account: undefined
}

/** Client version the replay verification sends (replay matches method and URL only). */
export const replayClientVersion = '0.0.0-conformance-replay'

/**
 * Where a conformance case's recording is written. File and export names are stable so the
 * fixture modules and the conformance `index.ts` never change shape.
 */
export type ResponsesFixtureModule = {
  readonly caseId: string
  readonly fileName: string
  readonly exportName: string
  readonly doc: string
  readonly model: keyof ResponsesProbeModels
}

/** One family's endpoint, credential variables, default models, and fixture modules. */
export type ResponsesFamilySpec = {
  readonly family: ResponsesFamily
  readonly label: string
  readonly command: string
  /** The full command that regenerates the family's fixtures, with every required live flag. */
  readonly regenerateCommand: string
  readonly endpoint: string
  readonly tokenEnv: string
  readonly accountIdEnv: string | undefined
  readonly tokenProvider: string
  readonly defaultModels: ResponsesProbeModels
  readonly fixtureDir: string
  readonly fixtureModules: ReadonlyArray<ResponsesFixtureModule>
}

const fixtureModulesFor = (
  idPrefix: string,
  filePrefix: string,
  exportPrefix: string,
  label: string
): ReadonlyArray<ResponsesFixtureModule> => [
  {
    caseId: `${idPrefix}.stream.plain-text`,
    fileName: `${filePrefix}plain-text.ts`,
    exportName: `${exportPrefix}PlainTextFixture`,
    doc: `Streamed plain-text answer from ${label}: Responses server-sent events ending in \`response.completed\` with the output and usage.`,
    model: 'plainText'
  },
  {
    caseId: `${idPrefix}.stream.function-call-arguments`,
    fileName: `${filePrefix}function-call-arguments.ts`,
    exportName: `${exportPrefix}FunctionCallArgumentsFixture`,
    doc: `Streamed \`function_call\` item from ${label} whose \`response.function_call_arguments.delta\` fragments assemble into the tool arguments.`,
    model: 'toolCall'
  },
  {
    caseId: `${idPrefix}.stream.error-envelope`,
    fileName: `${filePrefix}error-envelope.ts`,
    exportName: `${exportPrefix}ErrorEnvelopeFixture`,
    doc: `Non-2xx JSON error body from ${label} for a request with an unknown model id.`,
    model: 'invalid'
  },
  {
    caseId: `${idPrefix}.stream.terminal-event`,
    fileName: `${filePrefix}terminal-event.ts`,
    exportName: `${exportPrefix}TerminalEventFixture`,
    doc: `Streamed plain-text answer from ${label} that ends with exactly one \`response.completed\` event as its last server-sent event.`,
    model: 'plainText'
  }
]

const workspaceRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')

export const responsesFamilies: Readonly<Record<ResponsesFamily, ResponsesFamilySpec>> = {
  codex: {
    family: 'codex',
    label: 'the ChatGPT Codex Responses endpoint',
    command: 'pnpm conformance:codex',
    regenerateCommand: 'pnpm conformance:codex --live --owner-approved --account <label>',
    endpoint: openAiCodexConformanceResponsesUrl,
    tokenEnv: 'OPENAI_CODEX_ACCESS_TOKEN',
    accountIdEnv: 'OPENAI_CODEX_ACCOUNT_ID',
    tokenProvider: 'openai-codex',
    defaultModels: openAiCodexConformanceDefaultModels,
    fixtureDir: join(workspaceRoot, 'packages/agent/src/providers/openai/conformance'),
    fixtureModules: fixtureModulesFor(
      'openai.codex',
      'codex-',
      'openAiCodex',
      'the ChatGPT Codex Responses endpoint'
    )
  },
  grok: {
    family: 'grok',
    label: 'the xAI Grok CLI proxy',
    command: 'pnpm conformance:grok',
    regenerateCommand:
      'pnpm conformance:grok --live --owner-approved --account <label> --client-version <version>',
    endpoint: xAiGrokConformanceResponsesUrl,
    tokenEnv: 'XAI_GROK_ACCESS_TOKEN',
    accountIdEnv: undefined,
    tokenProvider: 'xai-grok',
    defaultModels: xAiGrokConformanceDefaultModels,
    fixtureDir: join(workspaceRoot, 'packages/agent/src/providers/xai/conformance'),
    fixtureModules: fixtureModulesFor('xai.grok', '', 'xAiGrok', 'the xAI Grok CLI proxy')
  }
}

const usage = `Usage: pnpm conformance:codex|conformance:grok [--live --owner-approved --account <label>] [options]
       tsx scripts/record-responses-fixtures.ts --family codex|grok [...]

Dry run by default: lists the family's Responses conformance cases and performs no network I/O
and no credential read. --live runs each case against the real endpoint through the wire
recorder, replays the new fixtures through the same cases, and writes the fixture modules only if
every case passes.

The credentials are consumer subscription OAuth access tokens: live runs spend the owner's
subscription allowance and need the repository owner's explicit approval (--owner-approved).
Never run them in CI: --live is refused whenever the CI environment variable is set to any
non-empty value (0 and false included).

Options:
  --family codex|grok             required (set by the pnpm scripts)
  --live                          record against the real endpoint (needs --owner-approved,
                                  --account, and the family's token)
  --owner-approved                confirm the repository owner approved this live run
  --account <label>               required with --live: synthetic, non-identifying fixture
                                  account label (for example synthetic)
  --plain-model <id>              plain-text and terminal-event model (family default)
  --tool-model <id>               function-call model (family default)
  --invalid-model <id>            must NOT exist (default yolk-conformance-model-does-not-exist)
  --client-version <v>            grok only, required with --live: truthful host client version
                                  sent as x-grok-client-version (never an official Grok version)
  --max-output-tokens <n>         grok only: max_output_tokens (default ${defaultProbeOptions.maxOutputTokens})
  --help

Tokens:
  codex: ${responsesFamilies.codex.tokenEnv} (ChatGPT OAuth access token); optional ${responsesFamilies.codex.accountIdEnv ?? ''}
  grok:  ${responsesFamilies.grok.tokenEnv} (Grok OAuth access token)

Review the rewritten fixtures before committing: they must contain synthetic content only.`

const positiveInteger = (flag: string, value: string): number => {
  const parsed = Number(value)

  if (!Number.isSafeInteger(parsed) || parsed < 1) {
    throw new Error(`${flag} must be a positive integer`)
  }

  return parsed
}

const parseFamily = (family: string): ResponsesFamily => {
  if (family !== 'codex' && family !== 'grok') {
    throw new Error(`Unknown family: ${family} (expected codex or grok)`)
  }

  return family
}

export const familyRequiredMessage = '--family codex|grok is required'

export const liveAccountRequiredMessage =
  '--live requires --account <label>: a synthetic, non-identifying label (for example synthetic) that is committed in public fixtures'

export const ownerApprovalRequiredMessage =
  "--live requires --owner-approved: live runs spend a subscription OAuth allowance and need the repository owner's explicit approval"

export const liveInCiMessage =
  "--live is refused in CI (the CI environment variable is set to a non-empty value): live runs spend a subscription OAuth allowance and must be run by hand with the repository owner's approval"

/** The environment the argument check reads (only `CI`). */
export type ProbeEnv = Readonly<Record<string, string | undefined>>

/**
 * True when `CI` is set to any non-empty value, `0` and `false` included: only an unset or empty
 * `CI` allows a live run.
 */
export const isCiEnvironment = (env: ProbeEnv): boolean => env.CI !== undefined && env.CI.length > 0

export const clientVersionRequiredMessage =
  '--live --family grok requires --client-version <v>: the truthful host client version sent as x-grok-client-version'

/**
 * Parse CLI arguments (without the node/script prefix). Throws on unknown flags, a missing or
 * unknown family, on `--live` in CI (`env.CI` set), and on `--live` without `--owner-approved`,
 * `--account`, or (Grok) `--client-version`.
 */
export const parseProbeArgs = (argv: ReadonlyArray<string>, env: ProbeEnv = {}): ProbeOptions => {
  const options: MutableProbeOptions = { ...defaultProbeOptions }

  const setModel = (key: keyof ResponsesProbeModels, model: string) => {
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
      case '--family':
        options.family = parseFamily(value())
        break
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
      case '--client-version':
        options.clientVersion = value()
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
  }

  if (options.help) {
    return options
  }

  if (options.family === undefined) {
    throw new Error(familyRequiredMessage)
  }

  if (options.live && isCiEnvironment(env)) {
    throw new Error(liveInCiMessage)
  }

  if (options.live && !options.ownerApproved) {
    throw new Error(ownerApprovalRequiredMessage)
  }

  if (options.live && options.account === undefined) {
    throw new Error(liveAccountRequiredMessage)
  }

  if (options.live && options.family === 'grok' && options.clientVersion === undefined) {
    throw new Error(clientVersionRequiredMessage)
  }

  return options
}

/** The family a run targets; throws without one (parsed options always carry it). */
export const familySpecOf = (options: ProbeOptions): ResponsesFamilySpec => {
  if (options.family === undefined) {
    throw new Error(familyRequiredMessage)
  }

  return responsesFamilies[options.family]
}

/** The models a run uses: the family defaults with the CLI overrides. */
export const probeModels = (options: ProbeOptions): ResponsesProbeModels => ({
  ...familySpecOf(options).defaultModels,
  ...options.models
})

type CaseSummary = { readonly id: string; readonly safety: ConformanceSafety }

const familyCases = (family: ResponsesFamily): ReadonlyArray<CaseSummary> =>
  family === 'codex' ? openAiCodexConformanceCases : xAiGrokConformanceCases

export const responsesFixtureModuleFor = (
  family: ResponsesFamily,
  caseId: string
): ResponsesFixtureModule | undefined =>
  responsesFamilies[family].fixtureModules.find(fixtureModule => fixtureModule.caseId === caseId)

/** One conformance case with everything the probe needs to run, record, and write it. */
export type ResponsesProbePlanEntry = {
  readonly caseId: string
  readonly safety: ConformanceSafety
  readonly fixtureModule: ResponsesFixtureModule
  readonly model: string
}

/**
 * Pair every conformance case of the family with its fixture module and model. Throws when a case
 * has no module: a new case needs a new fixture module entry (a programmer error).
 */
export const planResponsesProbe = (
  options: ProbeOptions
): ReadonlyArray<ResponsesProbePlanEntry> => {
  const spec = familySpecOf(options)
  const models = probeModels(options)

  return familyCases(spec.family).map(testCase => {
    const fixtureModule = responsesFixtureModuleFor(spec.family, testCase.id)

    if (fixtureModule === undefined) {
      throw new Error(`No fixture module mapped for conformance case ${testCase.id}`)
    }

    return {
      caseId: testCase.id,
      safety: testCase.safety,
      fixtureModule,
      model: models[fixtureModule.model]
    }
  })
}

export const dryRunReport = (options: ProbeOptions): string => {
  const spec = familySpecOf(options)

  const credentials =
    spec.accountIdEnv === undefined
      ? `${spec.tokenEnv} and --client-version`
      : `${spec.tokenEnv}; optional ${spec.accountIdEnv}`

  return [
    `DRY RUN: no network request was made and no credential was read. Pass --live --owner-approved --account <label> to record (needs ${credentials}).`,
    `Endpoint: ${spec.endpoint} (${spec.label}; subscription OAuth bearer)`,
    "Live runs spend the owner's subscription allowance and need the repository owner's explicit approval; never run them in CI.",
    ...(spec.family === 'grok'
      ? [
          `Grok cases send max_output_tokens ${options.maxOutputTokens}; raise it with --max-output-tokens <n> if a live case ends with response.incomplete.`
        ]
      : []),
    'Conformance cases:',
    ...planResponsesProbe(options).map(entry =>
      [
        `- ${entry.caseId} [${entry.safety}]`,
        `model ${entry.model}`,
        `-> ${entry.fixtureModule.fileName}`
      ].join('  ')
    ),
    'With --live, each case runs against the endpoint through the wire recorder, then all new',
    'fixtures are verified by running the same cases on replay; nothing is written unless every case passes.',
    'Confirm model ids are available on the subscription before a live probe.'
  ].join('\n')
}

/** The OAuth credential a run sends (read from the environment only with `--live`). */
export type ProbeCredential = {
  readonly accessToken: string
  /** Local expiry for the provider's token check; the real expiry is the issuer's. */
  readonly expiresAt: number
  readonly accountId?: string | undefined
}

const probeToken = (options: ProbeOptions, credential: ProbeCredential) =>
  new OAuthAccessToken({
    provider: familySpecOf(options).tokenProvider,
    accessToken: credential.accessToken,
    expiresAt: credential.expiresAt,
    accountId: credential.accountId
  })

type FamilyRun = {
  readonly target: ConformanceTarget
  /** Fixtures the report checks referenced ids against. */
  readonly fixtures?: ReadonlyArray<WireFixture>
  /** Only these case ids (default: every case of the family). */
  readonly caseIds?: ReadonlyArray<string>
  /** Replace each case's fixture ids (default: the committed ids). */
  readonly fixtureIdsFor?: (caseId: string) => ReadonlyArray<string>
  /** The HttpClient each case runs over. */
  readonly httpLayer: (caseId: string) => Layer.Layer<HttpClient.HttpClient>
}

const selectCases = <C extends { readonly id: string; readonly fixtures: ReadonlyArray<string> }>(
  cases: ReadonlyArray<C>,
  run: FamilyRun
): ReadonlyArray<C> =>
  cases.flatMap(testCase => {
    if (run.caseIds !== undefined && !run.caseIds.includes(testCase.id)) return []

    return [
      run.fixtureIdsFor === undefined
        ? testCase
        : { ...testCase, fixtures: run.fixtureIdsFor(testCase.id) }
    ]
  })

/** Run the family's conformance cases with the given credential and per-case HttpClient. */
export const runFamilyCases = (
  options: ProbeOptions,
  credential: ProbeCredential,
  run: FamilyRun
): Effect.Effect<ConformanceReport> => {
  const spec = familySpecOf(options)
  const models = probeModels(options)
  const token = probeToken(options, credential)

  const settings =
    run.fixtures === undefined
      ? { target: run.target }
      : { target: run.target, fixtures: run.fixtures }

  if (spec.family === 'codex') {
    const config = Layer.succeed(OpenAiCodexConformanceConfig, { token, models })

    return runConformance(
      selectCases<OpenAiCodexConformanceCase>(openAiCodexConformanceCases, run),
      {
        ...settings,
        layer: testCase => Layer.mergeAll(run.httpLayer(testCase.id), config)
      }
    )
  }

  const config = Layer.succeed(XAiGrokConformanceConfig, {
    token,
    clientVersion: options.clientVersion ?? replayClientVersion,
    maxOutputTokens: options.maxOutputTokens,
    models
  })

  return runConformance(selectCases<XAiGrokConformanceCase>(xAiGrokConformanceCases, run), {
    ...settings,
    layer: testCase => Layer.mergeAll(run.httpLayer(testCase.id), config)
  })
}

// Synthetic credential for replay verification: far-future expiry so the provider check passes.
const replayCredential: ProbeCredential = {
  accessToken: 'synthetic-replay-token',
  expiresAt: 4_000_000_000_000
}

/**
 * Run every conformance case of the family on replay against `fixtures` (matched by `caseId`),
 * with a synthetic credential and the same models and limits as the recording. Each case
 * references the fixtures it replays, so the report's fixture warnings describe `fixtures`. A
 * case without a fixture replays nothing and fails, so a missing recording fails the report.
 */
export const verifyResponsesFixtures = (
  fixtures: ReadonlyArray<WireFixture>,
  options: ProbeOptions
): Effect.Effect<ConformanceReport> => {
  const fixturesFor = (caseId: string) => fixtures.filter(fixture => fixture.caseId === caseId)

  return runFamilyCases(options, replayCredential, {
    target: { kind: 'replay' },
    fixtures,
    fixtureIdsFor: caseId => fixturesFor(caseId).map(fixture => fixture.id),
    httpLayer: caseId => ReplayHttpClient.layer(fixturesFor(caseId))
  })
}

/** Case ids with no fixture, or with more than one (a recording must map to exactly one case). */
export const casesWithoutSingleFixture = (
  fixtures: ReadonlyArray<WireFixture>,
  options: ProbeOptions
): ReadonlyArray<string> =>
  familyCases(familySpecOf(options).family)
    .map(testCase => testCase.id)
    .filter(caseId => fixtures.filter(fixture => fixture.caseId === caseId).length !== 1)

/**
 * JSON string fields the probe redacts in recorded responses: encrypted reasoning
 * (`encrypted_content`) and account-derived identifiers (`safety_identifier`, `prompt_cache_key`,
 * `user`). None is needed for replay.
 */
export const responsesRedactedFields: ReadonlyArray<string> = [
  'encrypted_content',
  'safety_identifier',
  'prompt_cache_key',
  'user'
]

/** Placeholder written over every redacted value. */
export const responsesRedactedValue = 'redacted'

// A non-empty JSON string literal, escapes included.
const nonEmptyJsonString = String.raw`"(?:[^"\\]|\\.)+"`

// `"<field>": "<value>"` inside JSON text. Only the value changes, so every other recorded byte is
// kept. An escaped `\"field\"` inside another string never matches.
const redactionPattern = new RegExp(
  String.raw`("(?:${responsesRedactedFields.join('|')})"\s*:\s*)${nonEmptyJsonString}`,
  'g'
)

const placeholder = JSON.stringify(responsesRedactedValue)

const redactText = (text: string): string =>
  text.replace(redactionPattern, (_match, prefix: string) => `${prefix}${placeholder}`)

/**
 * JSON redaction hook: replace the values of `responsesRedactedFields` in a recorded exchange.
 * Only text is rewritten, value by value: each text stream chunk on its own and a text body;
 * chunk boundaries and every other byte are kept. `{ base64 }` chunks and base64 bodies are never
 * rewritten, and chunks are never merged or re-split, so a value inside one, or split across
 * network chunks, stays in place; `unredactedResponsesFields` reports it and the probe refuses to
 * write the recording. Returns the exchange itself when nothing changed.
 */
export const redactResponsesFields = (exchange: WireExchange): WireExchange => {
  const response = exchange.response

  if (isWireStreamResponse(response)) {
    const chunks = response.chunks.map(chunk =>
      Predicate.isString(chunk) ? redactText(chunk) : chunk
    )

    return chunks.every((chunk, index) => chunk === response.chunks[index])
      ? exchange
      : { ...exchange, response: { ...response, chunks } }
  }

  if (isWireBase64BodyResponse(response)) return exchange

  const body = redactText(response.body)

  return body === response.body ? exchange : { ...exchange, response: { ...response, body } }
}

// Exact bytes of base64 text; undecodable base64 yields no bytes (the recorder never writes it).
const base64Bytes = (base64: string): Uint8Array =>
  Result.getOrElse(Encoding.decodeBase64(base64), () => new Uint8Array())

const chunkBytes = (chunk: WireChunk): Uint8Array =>
  Predicate.isString(chunk) ? new TextEncoder().encode(chunk) : base64Bytes(chunk.base64)

const concatBytes = (parts: ReadonlyArray<Uint8Array>): Uint8Array => {
  const joined = new Uint8Array(parts.reduce((total, part) => total + part.length, 0))
  let offset = 0

  for (const part of parts) {
    joined.set(part, offset)
    offset += part.length
  }

  return joined
}

// Non-fatal UTF-8 decode: invalid bytes become U+FFFD, the rest of the text stays checkable.
const lossyText = (bytes: Uint8Array): string => new TextDecoder().decode(bytes)

// The JSON payloads a survivor check reads: every SSE event's `data:` of the whole stream (all
// chunks, text and `{ base64 }`, reassembled as bytes and decoded, so a value inside a base64
// chunk or split across chunks, even mid-character, is seen), or the whole decoded body. An empty
// or whitespace-only body carries nothing to scan and yields no payload.
const responsePayloads = (response: WireResponse): ReadonlyArray<string> => {
  if (!isWireStreamResponse(response)) {
    const body = isWireBase64BodyResponse(response)
      ? lossyText(base64Bytes(response.bodyBase64))
      : response.body

    return body.trim().length > 0 ? [body] : []
  }

  return lossyText(concatBytes(response.chunks.map(chunkBytes)))
    .replace(/\r\n?/g, '\n')
    .split('\n\n')
    .flatMap(event => {
      const lines = event.split('\n')

      const data = lines
        .filter(line => line.startsWith('data:'))
        .map(line => line.slice('data:'.length).trim())
        .join('\n')

      // Comments, unknown fields and malformed lines are ignored by the stream parser but would
      // still be written to the public fixture, so each one is returned as its own payload: the
      // member scanner cannot parse it and the write is refused.
      const unparsedLines = lines.filter(
        line => line.trim().length > 0 && !sseFieldLinePattern.test(line)
      )

      return data.length > 0 ? [data, ...unparsedLines] : unparsedLines
    })
}

/** SSE field lines the stream parsers understand; any other non-blank line is unscannable. */
const sseFieldLinePattern = /^(data|event|id|retry):/

/**
 * The only non-JSON payloads the survivor check lets through: the `[DONE]` stream sentinel, which
 * the Responses stream parser ignores. Neither the Codex endpoint nor the Grok CLI proxy is known
 * to send any other non-JSON `data:` payload; every other payload the member scanner cannot fully
 * scan refuses the write.
 */
export const responsesPermittedNonJsonPayloads: ReadonlyArray<string> = ['[DONE]']

type PayloadScan = { readonly fields: Set<string>; unscannable: number }

// Every occurrence of every redacted field in the payload text, without `JSON.parse` (which keeps
// only the last of repeated keys): any value but null, "", or the placeholder, and any repeat of a
// redacted key within one object, is a survivor. A payload the scanner cannot fully scan (invalid
// JSON, nesting past the depth limit) is counted as unscannable, never guessed at.
const scanPayload = (payload: string, scan: PayloadScan): void => {
  if (responsesPermittedNonJsonPayloads.includes(payload)) return

  const survivors = unredactedMembers(payload, responsesRedactedFields, responsesRedactedValue)

  if (survivors === undefined) {
    scan.unscannable++

    return
  }

  for (const field of survivors) scan.fields.add(field)
}

const scanExchanges = (exchanges: ReadonlyArray<WireExchange>): PayloadScan => {
  const scan: PayloadScan = { fields: new Set(), unscannable: 0 }

  for (const { response } of exchanges) {
    for (const payload of responsePayloads(response)) scanPayload(payload, scan)
  }

  return scan
}

/**
 * Redacted fields still carrying a real value in recorded responses, checked on each response's
 * whole decoded text: every stream chunk (text and base64) reassembled as bytes and decoded
 * non-fatally, or the text or decoded base64 body. Every SSE `data:` payload (or the body) is
 * scanned member by member without collapsing repeated keys: any value other than `null`, `""`,
 * or the placeholder (a string, number, boolean, object, or array), and any repeated redacted key
 * in one object, is reported. A value in a base64 chunk or body, or split across network chunks,
 * is therefore caught. Payloads the scanner cannot fully scan are not reported here but by
 * `unscannableResponsesPayloads`; the write decision uses `responsesRedactionRefusal`, which
 * checks both. Empty when fully redacted.
 */
export const unredactedResponsesFields = (
  exchanges: ReadonlyArray<WireExchange>
): ReadonlyArray<string> => {
  const { fields } = scanExchanges(exchanges)

  return responsesRedactedFields.filter(field => fields.has(field))
}

/**
 * How many SSE `data:` payloads (or bodies) of the recorded responses the member scanner cannot
 * fully scan: invalid JSON, JSON nested past the scanner's depth limit, or any other scan failure.
 * Only `responsesPermittedNonJsonPayloads` are exempt. Any count above zero refuses the write,
 * since an unscanned payload may hide a redacted field (for example under an escaped key).
 */
export const unscannableResponsesPayloads = (exchanges: ReadonlyArray<WireExchange>): number =>
  scanExchanges(exchanges).unscannable

/** Why the probe refuses to write a recording that still carries a redacted value. */
export const unredactedMessage = (fields: ReadonlyArray<string>): string =>
  `could not redact ${fields.join(', ')} from the recording: a value survives inside a base64 body or chunk, split across network chunks, as a non-string value, or under a repeated key, which value-only redaction cannot rewrite without changing recorded chunk boundaries; refusing to write (chunks are never re-split), re-record instead`

/** Why the probe refuses to write a recording with payloads the survivor check cannot scan. */
export const unscannableMessage = (count: number): string =>
  `could not check ${count} response payload(s) for redacted fields: not valid JSON, nested past the scanner's depth limit, or otherwise unscannable (only ${responsesPermittedNonJsonPayloads.join(', ')} may be non-JSON); refusing to write, re-record instead`

/**
 * Why the recorded exchanges must not be written, or undefined when every payload was scanned and
 * no redacted field survives. Both the live recording step and the write gate use it.
 */
export const responsesRedactionRefusal = (
  exchanges: ReadonlyArray<WireExchange>
): string | undefined => {
  const { fields, unscannable } = scanExchanges(exchanges)
  const survivors = responsesRedactedFields.filter(field => fields.has(field))

  const reasons = [
    ...(unscannable > 0 ? [unscannableMessage(unscannable)] : []),
    ...(survivors.length > 0 ? [unredactedMessage(survivors)] : [])
  ]

  return reasons.length === 0 ? undefined : reasons.join('; ')
}

export class ProbeFailed extends Data.TaggedError('ProbeFailed')<{
  readonly caseId: string
  readonly message: string
}> {}

const today = () => new Date().toISOString().slice(0, 10)

// Runs the case through `runConformance` on the live target (same safety policy and sanitized
// failure report as any conformance run) with the recording client, then turns the single
// recorded exchange into a verified fixture.
const recordCase = (
  entry: ResponsesProbePlanEntry,
  options: ProbeOptions,
  credential: ProbeCredential,
  account: string
) =>
  Effect.gen(function* () {
    const spec = familySpecOf(options)
    const caseId = entry.caseId
    const recorder = yield* WireRecorder
    const client = yield* HttpClient.HttpClient

    const report = yield* runFamilyCases(options, credential, {
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

    const redacted = exchanges.map(redactResponsesFields)
    const refusal = responsesRedactionRefusal(redacted)

    if (refusal !== undefined) {
      return yield* new ProbeFailed({ caseId, message: refusal })
    }

    return yield* makeWireFixture({
      id: `${caseId}.recorded`,
      caseId,
      evidence: 'verified',
      recordedAt: today(),
      account,
      endpoint: spec.endpoint,
      model: entry.model,
      note: `Recorded from ${spec.label} by running its conformance case through ${spec.command} --live. Prompts and outputs are synthetic; account-derived and encrypted fields are redacted.`,
      exchanges: redacted
    }).pipe(Effect.mapError(error => new ProbeFailed({ caseId, message: error.message })))
  }).pipe(
    Effect.provide(
      WireRecorder.layer({ responseHeaders: ['content-type'] }).pipe(
        Layer.provide(FetchHttpClient.layer)
      )
    )
  )

export const renderFixtureModule = (
  options: ProbeOptions,
  fixtureModule: ResponsesFixtureModule,
  fixture: WireFixture
): string =>
  [
    "import type { WireFixture } from '@yolk-sdk/conformance/fixture'",
    '',
    '/**',
    ` * ${fixtureModule.doc}`,
    ' *',
    ` * Verified recording (${fixture.recordedAt}). Regenerate with`,
    ` * \`${familySpecOf(options).regenerateCommand}\`.`,
    ' */',
    `export const ${fixtureModule.exportName}: WireFixture = ${JSON.stringify(fixture, null, 2)}`,
    ''
  ].join('\n')

/** A live recording paired with the plan entry (and so the fixture module) it belongs to. */
export type RecordedResponsesFixture = {
  readonly entry: ResponsesProbePlanEntry
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
 * The write gate: refuse any recording that still carries a redacted field (checked across base64
 * and split chunks) or has a payload the survivor check cannot scan, then replay `recorded`
 * through every case and write the fixture modules only when the report passes and every case has
 * exactly one recording. On failure nothing is written (the replay report is logged when replay
 * failed). Returns the report and the written paths.
 */
export const writeVerifiedFixtures = (
  recorded: ReadonlyArray<RecordedResponsesFixture>,
  options: ProbeOptions,
  writer: FixtureWriter = defaultFixtureWriter
) =>
  Effect.gen(function* () {
    const spec = familySpecOf(options)
    const fixtures = recorded.map(({ fixture }) => fixture)

    for (const fixture of fixtures) {
      const refusal = responsesRedactionRefusal(fixture.exchanges)

      if (refusal !== undefined) {
        return yield* new ProbeFailed({
          caseId: fixture.caseId,
          message: `${refusal}; no fixture was written`
        })
      }
    }

    const report = yield* verifyResponsesFixtures(fixtures, options)
    const unmatched = casesWithoutSingleFixture(fixtures, options)

    if (conformanceReportFailed(report) || unmatched.length > 0) {
      yield* Effect.sync(() => console.error(formatConformanceReport(report)))

      return yield* new ProbeFailed({
        caseId: unmatched.length === 0 ? '*' : unmatched.join(', '),
        message: 'recorded fixtures failed replay verification; no fixture was written'
      })
    }

    const files = yield* Effect.sync(() =>
      recorded.map(({ entry, fixture }) => {
        const file = join(spec.fixtureDir, entry.fixtureModule.fileName)

        writer.writeFile(file, renderFixtureModule(options, entry.fixtureModule, fixture))

        return file
      })
    )

    yield* Effect.sync(() => writer.formatFiles(files))

    return { report, files }
  })

const live = (options: ProbeOptions, writer: FixtureWriter = defaultFixtureWriter) =>
  Effect.gen(function* () {
    const spec = familySpecOf(options)
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

    const accessToken = process.env[spec.tokenEnv]

    if (accessToken === undefined || accessToken.trim().length === 0) {
      return yield* new ProbeFailed({
        caseId: '*',
        message: `${spec.tokenEnv} is required for --live`
      })
    }

    const plan = planResponsesProbe(options)

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

    const accountId = spec.accountIdEnv === undefined ? undefined : process.env[spec.accountIdEnv]

    const credential: ProbeCredential = {
      accessToken,
      // The issuer owns the real expiry; this only satisfies the provider's local check.
      expiresAt: Date.now() + 60 * 60 * 1000,
      accountId: accountId === undefined || accountId.trim().length === 0 ? undefined : accountId
    }

    // Record everything first; write nothing unless every case recorded and verified.
    const recorded = yield* Effect.forEach(plan, entry =>
      recordCase(entry, options, credential, account).pipe(
        Effect.map(fixture => ({ entry, fixture }))
      )
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
