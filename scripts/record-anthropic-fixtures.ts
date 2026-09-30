/**
 * Anthropic Messages wire-fixture probe.
 *
 * The Anthropic Messages conformance cases (`anthropicConformanceCases`) are the single source of
 * truth: this script defines no requests of its own.
 *
 * Default: DRY RUN. Prints, per conformance case, the model and `max_tokens` it would use, and
 * exits without any network call.
 *
 * `--live`: requires `ANTHROPIC_API_KEY` (a native Anthropic API key, sent as `x-api-key`; the
 * cases use native Messages, not a Claude subscription OAuth token) and an explicit
 * `--account <label>` (a synthetic, non-identifying label such as `synthetic`; never a real
 * organization, workspace, or person name: it is committed in public fixtures). Runs each
 * conformance case with `runConformance` on a live target against the real Anthropic API, through
 * the conformance recorder wrapped around a real fetch `HttpClient` (response headers limited to
 * `content-type`; failures are reported with the runner's sanitizer), redacts thinking-block
 * signatures and `redacted_thinking` data (text chunks only, never re-chunked; a value left in a
 * base64 chunk or split across chunks, a non-string value, or a repeated key refuses the write,
 * checked on every occurrence in the reassembled wire text; so does any SSE `data:` payload or
 * body the member scanner cannot fully scan, except a `[DONE]` `data:` sentinel; any SSE line the
 * stream parser ignores, even one that parses as JSON, and any base64 that does not decode also
 * refuse the write), turns each single recorded exchange into a `verified` fixture dated today,
 * then replays the new fixtures through the same cases. Nothing is written unless every case
 * passes live, records cleanly, is fully redacted, passes the secret scan, and passes again on
 * replay; only then are the fixture modules under
 * `packages/agent/src/providers/anthropic/conformance/` rewritten. Live runs spend Anthropic
 * credits: never run in CI.
 *
 * Model ids are CLI flags defaulting to `anthropicConformanceDefaultModels`; confirm they are
 * still available (and that the thinking model supports extended thinking) before a live probe.
 */
import { execFileSync } from 'node:child_process'
import { writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'
import { Data, Effect, Encoding, Layer, Predicate, Redacted, Result } from 'effect'
import { FetchHttpClient, HttpClient } from 'effect/unstable/http'
import {
  AnthropicConformanceConfig,
  anthropicConformanceCases,
  anthropicConformanceDefaultModels,
  anthropicConformanceMessagesUrl,
  anthropicConformanceTruncatedMaxTokens,
  type AnthropicConformanceCase,
  type AnthropicConformanceModels,
  type AnthropicConformanceSettings
} from '@yolk-sdk/agent/providers/anthropic/conformance'
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
  type ConformanceReport
} from '../packages/conformance/src/runner.ts'
import { isAllowedMember, scanJsonObjects, type JsonMember } from './json-members.ts'

export type ProbeOptions = {
  readonly live: boolean
  readonly help: boolean
  /** Model ids per case; default `anthropicConformanceDefaultModels`. */
  readonly models: AnthropicConformanceModels
  /** `max_tokens` of the plain-text, tool-use, and error cases. */
  readonly maxTokens: number
  /** `thinking.budget_tokens` of the thinking case (API minimum 1024). */
  readonly thinkingBudgetTokens: number
  /** Synthetic, non-identifying fixture account label. Required with `--live`. */
  readonly account: string | undefined
}

type MutableProbeOptions = { -readonly [Key in keyof ProbeOptions]: ProbeOptions[Key] }

export const defaultProbeOptions: ProbeOptions = {
  live: false,
  help: false,
  models: anthropicConformanceDefaultModels,
  maxTokens: 64,
  thinkingBudgetTokens: 1024,
  account: undefined
}

const defaultModels = defaultProbeOptions.models

/** The credential environment variable `--live` reads (a native Anthropic API key). */
export const anthropicApiKeyEnv = 'ANTHROPIC_API_KEY'

const usage = `Usage: pnpm conformance:anthropic [--live --account <label>] [options]

Dry run by default: lists the Anthropic Messages conformance cases it would run and performs no
network I/O. --live runs each conformance case against the Anthropic API through the wire
recorder, replays the new fixtures through the same cases, and writes the fixture modules only if
every case passes.

Options:
  --live                          Record against the real Anthropic API (needs ${anthropicApiKeyEnv} and --account)
  --plain-model <id>              default ${defaultModels.plainText} (plain text and max_tokens)
  --tool-model <id>               default ${defaultModels.toolUse}
  --thinking-model <id>           default ${defaultModels.thinking} (must support extended thinking)
  --invalid-model <id>            default ${defaultModels.invalid} (must NOT exist)
  --max-tokens <n>                default ${defaultProbeOptions.maxTokens} (max_tokens)
  --thinking-budget-tokens <n>    default ${defaultProbeOptions.thinkingBudgetTokens} (at least 1024)
  --account <label>               required with --live: synthetic, non-identifying fixture
                                  account label (for example synthetic); never a real
                                  organization, workspace, or person name
  --help

${anthropicApiKeyEnv} must be a native Anthropic API key (sent as x-api-key), not a Claude
subscription OAuth token. Confirm model ids are available before a live probe. Review the
rewritten fixtures before committing: they must contain synthetic content only.`

const positiveInteger = (flag: string, value: string, minimum = 1): number => {
  const parsed = Number(value)

  if (!Number.isSafeInteger(parsed) || parsed < minimum) {
    throw new Error(
      minimum === 1
        ? `${flag} must be a positive integer`
        : `${flag} must be an integer of at least ${minimum}`
    )
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

  const setModel = (key: keyof AnthropicConformanceModels, model: string) => {
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
      case '--tool-model':
        setModel('toolUse', value())
        break
      case '--thinking-model':
        setModel('thinking', value())
        break
      case '--invalid-model':
        setModel('invalid', value())
        break
      case '--max-tokens':
        options.maxTokens = positiveInteger(flag, value())
        break
      case '--thinking-budget-tokens':
        options.thinkingBudgetTokens = positiveInteger(flag, value(), 1024)
        break
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
 * `AnthropicConformanceModels` entry the case uses; `limit` says which `max_tokens` it sends.
 */
export type AnthropicFixtureModule = {
  readonly caseId: string
  readonly fileName: string
  readonly exportName: string
  readonly doc: string
  readonly model: keyof AnthropicConformanceModels
  readonly limit: 'default' | 'thinking' | 'truncated'
}

export const anthropicFixtureModules: ReadonlyArray<AnthropicFixtureModule> = [
  {
    caseId: 'anthropic.messages.stream.plain-text',
    fileName: 'plain-text.ts',
    exportName: 'anthropicMessagesPlainTextFixture',
    doc: 'Streamed plain-text answer from Anthropic Messages: `message_start`, a text block, `message_delta` with `stop_reason: end_turn`, and `message_stop`.',
    model: 'plainText',
    limit: 'default'
  },
  {
    caseId: 'anthropic.messages.stream.tool-use-input-deltas',
    fileName: 'tool-use-input-deltas.ts',
    exportName: 'anthropicMessagesToolUseInputDeltasFixture',
    doc: "Streamed Anthropic `tool_use` block, forced with `tool_choice: { type: 'tool', name, disable_parallel_tool_use: true }`, whose JSON input arrives as `input_json_delta` fragments that assemble into one call.",
    model: 'toolUse',
    limit: 'default'
  },
  {
    caseId: 'anthropic.messages.stream.thinking-before-text',
    fileName: 'thinking-before-text.ts',
    exportName: 'anthropicMessagesThinkingBeforeTextFixture',
    doc: 'Streamed Anthropic answer with extended thinking enabled: a `thinking` block before the text block (thinking signatures and `redacted_thinking` data redacted).',
    model: 'thinking',
    limit: 'thinking'
  },
  {
    caseId: 'anthropic.messages.stream.error-envelope',
    fileName: 'error-envelope.ts',
    exportName: 'anthropicMessagesErrorEnvelopeFixture',
    doc: 'Non-2xx Anthropic JSON error envelope (`not_found_error`) for a request with an unknown model id.',
    model: 'invalid',
    limit: 'default'
  },
  {
    caseId: 'anthropic.messages.stream.max-tokens',
    fileName: 'max-tokens.ts',
    exportName: 'anthropicMessagesMaxTokensFixture',
    doc: 'Streamed Anthropic answer cut by a small `max_tokens`: partial text and `stop_reason: max_tokens`.',
    model: 'plainText',
    limit: 'truncated'
  }
]

export const anthropicFixtureModuleFor = (caseId: string): AnthropicFixtureModule | undefined =>
  anthropicFixtureModules.find(fixtureModule => fixtureModule.caseId === caseId)

/** One conformance case with everything the probe needs to run, record, and write it. */
export type AnthropicProbePlanEntry = {
  readonly testCase: AnthropicConformanceCase
  readonly fixtureModule: AnthropicFixtureModule
  readonly model: string
  /** The `max_tokens` the case sends. */
  readonly maxTokens: number
}

const maxTokensFor = (options: ProbeOptions, limit: AnthropicFixtureModule['limit']): number => {
  switch (limit) {
    case 'default':
      return options.maxTokens
    case 'thinking':
      return options.maxTokens + options.thinkingBudgetTokens
    case 'truncated':
      return anthropicConformanceTruncatedMaxTokens
  }
}

/**
 * Pair every Anthropic Messages conformance case with its fixture module and settings. Throws
 * when a case has no module: a new case needs a new entry in `anthropicFixtureModules` (a
 * programmer error).
 */
export const planAnthropicProbe = (options: ProbeOptions): ReadonlyArray<AnthropicProbePlanEntry> =>
  anthropicConformanceCases.map(testCase => {
    const fixtureModule = anthropicFixtureModuleFor(testCase.id)

    if (fixtureModule === undefined) {
      throw new Error(`No fixture module mapped for conformance case ${testCase.id}`)
    }

    return {
      testCase,
      fixtureModule,
      model: options.models[fixtureModule.model],
      maxTokens: maxTokensFor(options, fixtureModule.limit)
    }
  })

/** Conformance settings for the given credential; every case reads its models and limits here. */
export const anthropicConformanceSettings = (
  options: ProbeOptions,
  apiKey: Redacted.Redacted<string>
): AnthropicConformanceSettings => ({
  apiKey,
  maxTokens: options.maxTokens,
  thinkingBudgetTokens: options.thinkingBudgetTokens,
  models: options.models
})

export const dryRunReport = (options: ProbeOptions): string =>
  [
    `DRY RUN: no network request was made. Pass --live --account <label> to record (needs ${anthropicApiKeyEnv}).`,
    `Endpoint: ${anthropicConformanceMessagesUrl} (native Messages, x-api-key)`,
    'Conformance cases:',
    ...planAnthropicProbe(options).map(entry =>
      [
        `- ${entry.testCase.id} [${entry.testCase.safety}]`,
        `model ${entry.model}`,
        `max_tokens ${entry.maxTokens}`,
        `-> ${entry.fixtureModule.fileName}`
      ].join('  ')
    ),
    'With --live, each case runs against the Anthropic API through the wire recorder, then all new',
    'fixtures are verified by running the same cases on replay; nothing is written unless every case passes.',
    'Confirm model ids are available before a live probe.'
  ].join('\n')

/**
 * Run every Anthropic Messages conformance case on replay against `fixtures` (matched by
 * `caseId`), with a synthetic credential and the same models and limits as the recording. Each
 * case references the fixtures it replays, so the report's fixture warnings describe `fixtures`.
 * A case without a fixture replays nothing and fails, so a missing recording fails the report.
 */
export const verifyAnthropicFixtures = (
  fixtures: ReadonlyArray<WireFixture>,
  options: ProbeOptions = defaultProbeOptions
): Effect.Effect<ConformanceReport> => {
  const configLayer = Layer.succeed(
    AnthropicConformanceConfig,
    anthropicConformanceSettings(options, Redacted.make('synthetic-replay-key'))
  )

  const fixturesFor = (caseId: string) => fixtures.filter(fixture => fixture.caseId === caseId)

  const cases = anthropicConformanceCases.map((testCase): AnthropicConformanceCase => ({
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
  anthropicConformanceCases
    .map(testCase => testCase.id)
    .filter(caseId => fixtures.filter(fixture => fixture.caseId === caseId).length !== 1)

/** Placeholder written over every recorded thinking-block signature. */
export const redactedSignature = 'redacted-thinking-signature'

/** Placeholder written over the encrypted `data` of every recorded `redacted_thinking` block. */
export const redactedThinkingData = 'redacted-thinking-data'

/** The opaque encrypted reasoning values the probe redacts, as named in failure messages. */
export type ThinkingRedactionField = 'signature' | 'redacted_thinking.data'

const thinkingRedactionFields: ReadonlyArray<ThinkingRedactionField> = [
  'signature',
  'redacted_thinking.data'
]

// A non-empty JSON string literal, escapes included.
const nonEmptyJsonString = String.raw`"(?:[^"\\]|\\.)+"`

// `"signature": "<value>"` inside JSON text. Only the value changes, so every other recorded byte
// is kept. An escaped `\"signature\"` inside another string never matches.
const signaturePattern = new RegExp(String.raw`("signature"\s*:\s*)${nonEmptyJsonString}`, 'g')

// The `data` of a `redacted_thinking` block, with its `type` just before or just after it.
const redactedDataAfterType = new RegExp(
  String.raw`("type"\s*:\s*"redacted_thinking"\s*,\s*"data"\s*:\s*)${nonEmptyJsonString}`,
  'g'
)

const redactedDataBeforeType = new RegExp(
  String.raw`("data"\s*:\s*)${nonEmptyJsonString}(\s*,\s*"type"\s*:\s*"redacted_thinking")`,
  'g'
)

const signaturePlaceholder = JSON.stringify(redactedSignature)

const dataPlaceholder = JSON.stringify(redactedThinkingData)

const redactThinkingText = (text: string): string =>
  text
    .replace(signaturePattern, (_match, prefix: string) => `${prefix}${signaturePlaceholder}`)
    .replace(redactedDataAfterType, (_match, prefix: string) => `${prefix}${dataPlaceholder}`)
    .replace(
      redactedDataBeforeType,
      (_match, prefix: string, suffix: string) => `${prefix}${dataPlaceholder}${suffix}`
    )

/**
 * JSON redaction hook: replace the opaque thinking-block `signature` values and the encrypted
 * `data` of `redacted_thinking` blocks (encrypted model reasoning, never needed for replay) in a
 * recorded exchange, in `content_block_start` / `signature_delta` events and in JSON
 * `content[]`. Only text is rewritten, value by value: each text stream chunk on its own and a
 * text body; chunk boundaries and every other byte are kept. `{ base64 }` chunks and base64 bodies
 * are never rewritten, and chunks are never merged or re-split, so a value inside one, or split
 * across network chunks, stays in place; `unredactedThinkingFields` reports it and the probe
 * refuses to write the recording. Returns the exchange itself when nothing changed.
 */
export const redactThinkingSignatures = (exchange: WireExchange): WireExchange => {
  const response = exchange.response

  if (isWireStreamResponse(response)) {
    const chunks = response.chunks.map(chunk =>
      Predicate.isString(chunk) ? redactThinkingText(chunk) : chunk
    )

    return chunks.every((chunk, index) => chunk === response.chunks[index])
      ? exchange
      : { ...exchange, response: { ...response, chunks } }
  }

  if (isWireBase64BodyResponse(response)) return exchange

  const body = redactThinkingText(response.body)

  return body === response.body ? exchange : { ...exchange, response: { ...response, body } }
}

// Exact bytes of base64 text, or undefined when it does not decode (the payload is then
// unscannable, never read as empty).
const base64Bytes = (base64: string): Uint8Array | undefined =>
  Result.getOrUndefined(Encoding.decodeBase64(base64))

const chunkBytes = (chunk: WireChunk): Uint8Array | undefined =>
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

// What a survivor check reads from one response: every SSE event's `data:` payload of the whole
// stream (all chunks, text and `{ base64 }`, reassembled as bytes and decoded, so a value inside a
// base64 chunk or split across chunks, even mid-character, is seen), or the whole body (a text
// body unchanged, never re-decoded; a base64 body decoded), plus how many parts are unscannable
// outright. An empty or whitespace-only body carries nothing to scan and yields no payload.
// The `anthropicPermittedNonJsonPayloads` sentinels are dropped here, as SSE `data:` payloads
// only: a body equal to one is scanned like any other body and refused.
type ResponsePayloads = { readonly payloads: ReadonlyArray<string>; readonly unscannable: number }

const responsePayloads = (response: WireResponse): ResponsePayloads => {
  if (!isWireStreamResponse(response)) {
    if (!isWireBase64BodyResponse(response)) {
      return { payloads: response.body.trim().length > 0 ? [response.body] : [], unscannable: 0 }
    }

    const bytes = base64Bytes(response.bodyBase64)

    if (bytes === undefined) return { payloads: [], unscannable: 1 }

    const text = lossyText(bytes)

    return { payloads: text.trim().length > 0 ? [text] : [], unscannable: 0 }
  }

  // A chunk whose base64 does not decode cannot be scanned: it is counted, never read as empty,
  // and the rest of the stream is still scanned so real survivors are reported too.
  const chunks = response.chunks.map(chunkBytes)
  const decoded = chunks.filter(Predicate.isNotUndefined)
  const payloads: Array<string> = []
  let unscannable = chunks.length - decoded.length

  for (const event of lossyText(concatBytes(decoded)).replace(/\r\n?/g, '\n').split('\n\n')) {
    const lines = event.split('\n')

    const data = lines
      .filter(line => line.startsWith('data:'))
      .map(line => line.slice('data:'.length).trim())
      .join('\n')

    if (data.length > 0 && !anthropicPermittedNonJsonPayloads.includes(data)) payloads.push(data)

    // Comments, unknown fields and malformed lines are ignored by the stream parser but would
    // still be written to the public fixture. Each one is unscannable outright, even when it
    // parses as JSON or is a bare `[DONE]`.
    unscannable += lines.filter(
      line => line.trim().length > 0 && !sseFieldLinePattern.test(line)
    ).length
  }

  return { payloads, unscannable }
}

/** SSE field lines the stream parsers understand; any other non-blank line is unscannable. */
const sseFieldLinePattern = /^(data|event|id|retry):/

// One object's members, repeats included: every `signature`, and every `data` of an object
// whose `type` (any of its `type` members) is `redacted_thinking`, must be null, "", or the
// placeholder, and neither key may repeat within the object.
const objectSurvivors = (
  members: ReadonlyArray<JsonMember>,
  found: Set<ThinkingRedactionField>
): void => {
  const signatures = members.filter(member => member.key === 'signature')
  const data = members.filter(member => member.key === 'data')

  const redactedThinking = members.some(
    member => member.key === 'type' && member.text === 'redacted_thinking'
  )

  if (
    signatures.length > 1 ||
    signatures.some(member => !isAllowedMember(member, redactedSignature))
  ) {
    found.add('signature')
  }

  if (
    redactedThinking &&
    (data.length > 1 || data.some(member => !isAllowedMember(member, redactedThinkingData)))
  ) {
    found.add('redacted_thinking.data')
  }
}

/**
 * The only non-JSON payloads the survivor check lets through: the `[DONE]` stream sentinel, which
 * the Messages stream parser ignores. Anthropic sends every Messages event (`ping` included) as
 * JSON; every other payload the member scanner cannot fully scan refuses the write.
 */
export const anthropicPermittedNonJsonPayloads: ReadonlyArray<string> = ['[DONE]']

type PayloadScan = { readonly fields: Set<ThinkingRedactionField>; unscannable: number }

// Scans the payload text itself, never through `JSON.parse` (which keeps only the last of
// repeated keys), so an earlier value of a repeated key is still seen. A payload the scanner
// cannot fully scan (invalid JSON, nesting past the depth limit) is counted as unscannable, never
// guessed at.
const scanPayload = (payload: string, scan: PayloadScan): void => {
  const found = new Set<ThinkingRedactionField>()
  const scanned = scanJsonObjects(payload, members => objectSurvivors(members, found))

  if (!scanned) {
    scan.unscannable++

    return
  }

  for (const field of found) scan.fields.add(field)
}

const scanExchanges = (exchanges: ReadonlyArray<WireExchange>): PayloadScan => {
  const scan: PayloadScan = { fields: new Set(), unscannable: 0 }

  for (const { response } of exchanges) {
    const { payloads, unscannable } = responsePayloads(response)

    scan.unscannable += unscannable

    for (const payload of payloads) scanPayload(payload, scan)
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
 * `unscannableThinkingPayloads`; the write decision uses `thinkingRedactionRefusal`, which checks
 * both. Empty when fully redacted.
 */
export const unredactedThinkingFields = (
  exchanges: ReadonlyArray<WireExchange>
): ReadonlyArray<ThinkingRedactionField> => {
  const { fields } = scanExchanges(exchanges)

  return thinkingRedactionFields.filter(field => fields.has(field))
}

/**
 * How many SSE `data:` payloads (or bodies) of the recorded responses the member scanner cannot
 * fully scan: invalid JSON, JSON nested past the scanner's depth limit, or any other scan failure.
 * Also counted: every SSE line the stream parser ignores (even valid JSON or a bare `[DONE]`) and
 * every base64 chunk or body that does not decode. Only `anthropicPermittedNonJsonPayloads`, as SSE
 * `data:` payloads, are exempt. Any count above zero refuses the write,
 * since an unscanned payload may hide a redacted field (for example under an escaped key).
 */
export const unscannableThinkingPayloads = (exchanges: ReadonlyArray<WireExchange>): number =>
  scanExchanges(exchanges).unscannable

/** Why the probe refuses to write a recording that still carries a redacted value. */
export const unredactedThinkingMessage = (fields: ReadonlyArray<ThinkingRedactionField>): string =>
  `could not redact ${fields.join(', ')} from the recording: a value survives inside a base64 body or chunk, split across network chunks, as a non-string value, or under a repeated key, which value-only redaction cannot rewrite without changing recorded chunk boundaries; refusing to write (chunks are never re-split), re-record instead`

/** Why the probe refuses to write a recording with payloads the survivor check cannot scan. */
export const unscannableThinkingMessage = (count: number): string =>
  `could not check ${count} response payload(s) for thinking signatures or redacted_thinking data: not valid JSON, nested past the scanner's depth limit, an SSE line the stream parser ignores, undecodable base64, or otherwise unscannable (only ${anthropicPermittedNonJsonPayloads.join(', ')} may be non-JSON, and only as an SSE data: payload); refusing to write, re-record instead`

/**
 * Why the recorded exchanges must not be written, or undefined when every payload was scanned and
 * no redacted field survives. Both the live recording step and the write gate use it.
 */
export const thinkingRedactionRefusal = (
  exchanges: ReadonlyArray<WireExchange>
): string | undefined => {
  const { fields, unscannable } = scanExchanges(exchanges)
  const survivors = thinkingRedactionFields.filter(field => fields.has(field))

  const reasons = [
    ...(unscannable > 0 ? [unscannableThinkingMessage(unscannable)] : []),
    ...(survivors.length > 0 ? [unredactedThinkingMessage(survivors)] : [])
  ]

  return reasons.length === 0 ? undefined : reasons.join('; ')
}

export class ProbeFailed extends Data.TaggedError('ProbeFailed')<{
  readonly caseId: string
  readonly message: string
}> {}

const workspaceRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')

const fixtureDir = join(workspaceRoot, 'packages/agent/src/providers/anthropic/conformance')

const today = () => new Date().toISOString().slice(0, 10)

// Runs the case through `runConformance` on the live target (same safety policy and sanitized
// failure report as any conformance run) with the recording client, then turns the single
// recorded exchange into a verified fixture.
const recordCase = (
  entry: AnthropicProbePlanEntry,
  settings: AnthropicConformanceSettings,
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
          Layer.succeed(AnthropicConformanceConfig, settings)
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

    const redacted = exchanges.map(redactThinkingSignatures)
    const refusal = thinkingRedactionRefusal(redacted)

    if (refusal !== undefined) {
      return yield* new ProbeFailed({ caseId, message: refusal })
    }

    return yield* makeWireFixture({
      id: `${caseId}.recorded`,
      caseId,
      evidence: 'verified',
      recordedAt: today(),
      account,
      endpoint: anthropicConformanceMessagesUrl,
      model: entry.model,
      note: 'Recorded from the live Anthropic Messages API by running its conformance case through pnpm conformance:anthropic --live. Prompts and outputs are synthetic; thinking signatures and redacted_thinking data are redacted.',
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
  fixtureModule: AnthropicFixtureModule,
  fixture: WireFixture
): string =>
  [
    "import type { WireFixture } from '@yolk-sdk/conformance/fixture'",
    '',
    '/**',
    ` * ${fixtureModule.doc}`,
    ' *',
    ` * Verified recording (${fixture.recordedAt}). Regenerate with`,
    ' * `pnpm conformance:anthropic --live --account <label>`.',
    ' */',
    `export const ${fixtureModule.exportName}: WireFixture = ${JSON.stringify(fixture, null, 2)}`,
    ''
  ].join('\n')

/** A live recording paired with the plan entry (and so the fixture module) it belongs to. */
export type RecordedAnthropicFixture = {
  readonly entry: AnthropicProbePlanEntry
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
 * The write gate: refuse any recording that still carries a thinking signature or
 * `redacted_thinking` data (checked across base64 and split chunks) or has a payload the survivor
 * check cannot scan, then replay `recorded`
 * through every case and write the fixture modules only when the report passes and every case
 * has exactly one recording. On failure nothing is written (the replay report is logged when
 * replay failed). Returns the report and the written paths.
 */
export const writeVerifiedFixtures = (
  recorded: ReadonlyArray<RecordedAnthropicFixture>,
  options: ProbeOptions,
  writer: FixtureWriter = defaultFixtureWriter
) =>
  Effect.gen(function* () {
    const fixtures = recorded.map(({ fixture }) => fixture)

    for (const fixture of fixtures) {
      const refusal = thinkingRedactionRefusal(fixture.exchanges)

      if (refusal !== undefined) {
        return yield* new ProbeFailed({
          caseId: fixture.caseId,
          message: `${refusal}; no fixture was written`
        })
      }
    }

    const report = yield* verifyAnthropicFixtures(fixtures, options)
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

    const key = process.env[anthropicApiKeyEnv]

    if (key === undefined || key.trim().length === 0) {
      return yield* new ProbeFailed({
        caseId: '*',
        message: `${anthropicApiKeyEnv} is required for --live`
      })
    }

    const plan = planAnthropicProbe(options)

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

    const settings = anthropicConformanceSettings(options, Redacted.make(key))

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
