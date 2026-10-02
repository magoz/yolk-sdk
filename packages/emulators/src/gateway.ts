/**
 * Vercel AI Gateway emulator: a plain fetch handler for the OpenAI-compatible
 * `POST /v1/chat/completions` endpoint, with scripted turns, wire faults, a
 * request ledger, and an `/_emulate/*` control plane.
 *
 * It never imports SDK code: its wire shapes follow the verified live Gateway
 * conformance recordings (2026-09-30), copied as data: `chat.completion.chunk`
 * SSE with several events per network chunk, `delta.reasoning` plus
 * `reasoning_details` for DeepSeek reasoning, a finish event carrying
 * `provider_metadata`, `usage`, `system_fingerprint`, `service_tier`, and
 * `generationId`, then `data: [DONE]`, and the 404 `model_not_found`
 * envelope `{ error: { message, type, param: { modelId } } }` for unknown
 * models. Ids, costs, and routing metadata are synthetic stand-ins. The route
 * is linked to those conformance case ids in `gatewayEmulatorRoutes`
 * (`verified`). The Chat Completions machinery is shared with the OpenAI
 * emulator (`chat-completions.ts`); this module supplies the Gateway's paths,
 * models, envelope, reasoning, and wire profile.
 *
 * Not covered by a recording (synthetic): the 401 error, default fault
 * bodies, the non-streamed `chat.completion` body, and the answer to a request
 * without a `model` (404 `Model '' not found` with `param.modelId: null`).
 *
 * The same fetch handler also answers the classifier route `POST /v1/evaluate`
 * (AI Gateway calls classification "evaluation"; `emulator.evaluate`) with its
 * own manifest (`gatewayEvaluateEmulatorRoutes`, unverified), ledger, faults,
 * and turns. It is fixture-only: a request matching one of the four synthetic
 * classifier conformance recordings (boolean, choice, score, unknown-model
 * error envelope; `gateway-evaluate-recordings.ts`, copied as data) within the
 * shared request-shape latitude gets that recording's response; anything else
 * answers 400 not-emulated.
 *
 * Runtime-portable Web APIs only (`Request`, `Response`, `ReadableStream`,
 * `TextEncoder`, `URL`); no Effect runtime is required to use it.
 *
 * @experimental
 */
import { Data } from 'effect'
import type * as Schema from 'effect/Schema'
import {
  ChatFault,
  ChatFaultMatch,
  ChatScriptedReasoningCompletion,
  ChatScriptedError,
  ChatScriptedToolCall,
  ChatScriptedReasoningTurn,
  ChatScriptedUsage,
  makeChatCompletionsEmulator,
  type ChatCompletionsEmulator,
  type ChatCoverage,
  type ChatFaultKind,
  type ChatFaultState,
  type ChatLedgerEntry,
  type ChatResponseIdentity,
  type ChatRouteCoverage,
  type ChatUsageCounts,
  type ChatWireError,
  type ChatWireProfile
} from './chat-completions.ts'
import { composeFetch } from './emulator-compose.ts'
import {
  FixtureRouteFault,
  makeFixtureRouteEmulator,
  type FixtureRouteEmulator,
  type FixtureRouteFaultKind,
  type FixtureRouteLedgerEntry,
  type FixtureRouteScriptedTurn
} from './fixture-route.ts'
import { gatewayEvaluateRecordings } from './gateway-evaluate-recordings.ts'
import type { EmulatorRouteEvidence } from './route-evidence.ts'

export type { EmulatorEvidence, EmulatorRouteEvidence } from './route-evidence.ts'

export { emulatorEvidenceHeader } from './route-evidence.ts'

export const gatewayChatCompletionsPath = '/v1/chat/completions'

/** The AI Gateway classifier ("evaluation") path. */
export const gatewayEvaluatePath = '/v1/evaluate'

/** Synthetic-safe default model ids, including the Gateway conformance defaults. */
export const gatewayEmulatorDefaultModels: ReadonlyArray<string> = [
  'openai/gpt-4.1-nano',
  'openai/gpt-4.1-mini',
  'deepseek/deepseek-v3.2',
  'deepseek/deepseek-v4.1-flash'
]

/** Models that stream reasoning deltas when reasoning is requested. */
export const gatewayEmulatorDefaultReasoningModels: ReadonlyArray<string> = [
  'deepseek/deepseek-v3.2',
  'deepseek/deepseek-v4.1-flash'
]

/**
 * SSE events per network chunk by default. The live Gateway packs several
 * events into one network chunk (the recordings carry one to four, always
 * with the finish event and `data: [DONE]` together in the last chunk).
 */
export const gatewayEmulatorDefaultEventsPerChunk = 2

/**
 * Route evidence manifest: every emulated Gateway route and the conformance
 * cases whose verified live recordings (2026-09-30) its wire shapes follow.
 */
export const gatewayEmulatorRoutes: ReadonlyArray<EmulatorRouteEvidence> = [
  {
    method: 'POST',
    path: gatewayChatCompletionsPath,
    kind: 'provider',
    write: false,
    caseIds: [
      'vercel-ai-gateway.stream.plain-text',
      'vercel-ai-gateway.stream.deepseek-reasoning',
      'vercel-ai-gateway.stream.tool-call-deltas',
      'vercel-ai-gateway.stream.error-envelope'
    ],
    evidence: 'verified',
    observedAt: '2026-09-30'
  }
]

/**
 * Route evidence manifest of the classifier route (served by the same fetch handler, with its own
 * ledger, faults, and coverage). Its recordings are synthetic placeholders, so it is unverified.
 */
export const gatewayEvaluateEmulatorRoutes: ReadonlyArray<EmulatorRouteEvidence> = [
  {
    method: 'POST',
    path: gatewayEvaluatePath,
    kind: 'provider',
    write: false,
    caseIds: [
      'vercel-ai-gateway.classify.boolean',
      'vercel-ai-gateway.classify.choice',
      'vercel-ai-gateway.classify.score',
      'vercel-ai-gateway.classify.error-envelope'
    ],
    evidence: 'unverified',
    observedAt: undefined
  }
]

/** Optional fault filter; an omitted field matches every request. `path` ending in `*` is a prefix. */
export const GatewayFaultMatch = ChatFaultMatch

export type GatewayFaultMatch = ChatFaultMatch

/**
 * Wire faults for emulated routes:
 *
 * - `status`: answer with this status, headers, and body instead of a
 *   completion (for example 429 with `retry-after`). The body defaults to a
 *   Gateway error envelope. Statuses that cannot carry a body (1xx, 204, 205,
 *   304) and redirects (3xx) are rejected, as are invalid header names or
 *   values and a `location` header; scripted errors follow the same rules.
 * - `error-after-chunks`: send `chunks` body chunks, then error the body
 *   stream (a dropped connection).
 * - `truncate-after-chunks`: send `chunks` body chunks, then close the body
 *   cleanly (for example without `data: [DONE]`).
 *
 * Chunk faults count network chunks: a streamed chunk carries up to
 * `eventsPerChunk` SSE events (default 2), and a whole JSON body counts as one
 * chunk. A chunk fault that cannot take effect (`error-after-chunks` beyond
 * the chunk count, or `truncate-after-chunks` at or beyond it) answers 500
 * with an emulator error instead of silently doing nothing, and is not
 * consumed.
 */
export const GatewayFault = ChatFault

export type GatewayFault = ChatFault

export type GatewayFaultKind = ChatFaultKind

/**
 * Usage for a scripted turn, sent as the Gateway `usage` object (token counts,
 * `completion_tokens_details.reasoning_tokens` defaulting to 0, and synthetic
 * zero costs).
 */
export const GatewayScriptedUsage = ChatScriptedUsage

export type GatewayScriptedUsage = ChatScriptedUsage

/** One scripted tool call; its JSON arguments stream as these fragments. */
export const GatewayScriptedToolCall = ChatScriptedToolCall

export type GatewayScriptedToolCall = ChatScriptedToolCall

/**
 * A scripted completion. Every field is exact (nothing is filled in) except:
 * `usage` omitted is synthesized when the request asks for usage, and `null`
 * drops it; `finishReason` omitted is `tool_calls` with tool calls, else
 * `stop`. `order` defaults to `reasoning-first`; `reasoningField` defaults to
 * `reasoning` (streamed with `reasoning_details`, as recorded live); the
 * DeepSeek-native `reasoning_content` is sent alone.
 */
export const GatewayScriptedCompletion = ChatScriptedReasoningCompletion

export type GatewayScriptedCompletion = ChatScriptedReasoningCompletion

/** A scripted error response: status, body (a string is sent as is), and optional headers. */
export const GatewayScriptedError = ChatScriptedError

export type GatewayScriptedError = ChatScriptedError

/** A turn queued for the next chat completion request. */
export const GatewayScriptedTurn = ChatScriptedReasoningTurn

export type GatewayScriptedTurn = ChatScriptedReasoningTurn

/**
 * Thrown by the JS API (`faults.add`, `script.enqueue`) for invalid input, and
 * by `makeGatewayEmulator` for invalid options; a programmer error.
 */
export class GatewayEmulatorInputInvalid extends Data.TaggedError('GatewayEmulatorInputInvalid')<{
  readonly input: 'fault' | 'turn' | 'options'
  readonly reason: string
}> {
  override get message(): string {
    return `Invalid Gateway emulator ${this.input}: ${this.reason}`
  }
}

export type GatewayLedgerEntry = ChatLedgerEntry

export type GatewayFaultState = ChatFaultState

export type GatewayRouteCoverage = ChatRouteCoverage

export type GatewayCoverage = ChatCoverage

export type GatewayEmulatorOptions = {
  /** Model ids that exist. Defaults to `gatewayEmulatorDefaultModels`. */
  readonly knownModels?: ReadonlyArray<string>
  /** Model ids that stream reasoning. Defaults to `gatewayEmulatorDefaultReasoningModels`. */
  readonly reasoningModels?: ReadonlyArray<string>
  /**
   * SSE events per network chunk of a streamed body, a positive integer.
   * Defaults to `gatewayEmulatorDefaultEventsPerChunk` (2); 1 sends one event
   * per chunk. Events are packed counting from the end, so the last chunk
   * holds the finish event and `data: [DONE]` together. Chunk faults count
   * these network chunks.
   */
  readonly eventsPerChunk?: number
}

/** A classifier-route fault (`status` 400-599, `error-after-chunks`, `truncate-after-chunks`). */
export const GatewayEvaluateFault = FixtureRouteFault

export type GatewayEvaluateFault = FixtureRouteFault

export type GatewayEvaluateFaultKind = FixtureRouteFaultKind

/** A classifier-route turn: a scripted error (status 400-599) only. */
export type GatewayEvaluateScriptedTurn = FixtureRouteScriptedTurn

export type GatewayEvaluateLedgerEntry = FixtureRouteLedgerEntry

export type GatewayEvaluateEmulator = FixtureRouteEmulator

/** The chat emulator, plus `evaluate`: the classifier route's own emulator API. */
export type GatewayEmulator = ChatCompletionsEmulator<GatewayScriptedTurn> & {
  readonly evaluate: GatewayEvaluateEmulator
}

const gatewayErrorEnvelope = (error: ChatWireError): Schema.Json => ({
  error: { message: error.message, type: error.type, code: error.code }
})

// Synthetic stand-ins for the metadata the live Gateway attaches to its chunks. Keys and value
// types follow the recordings; every value is synthetic (no recorded id, fingerprint, or cost).
const syntheticFingerprint = 'fp_synthetic'

const syntheticAttemptTime = 1790000000000

const syntheticCost = '0'

const vendorOf = (model: string): string | undefined => {
  const [vendor] = model.split('/')

  return vendor === undefined || vendor.length === 0 || vendor === model ? undefined : vendor
}

// `service_tier` was recorded only for OpenAI models.
const isOpenAiModel = (model: string): boolean => vendorOf(model) === 'openai'

const syntheticResponseId = (identity: ChatResponseIdentity): string =>
  `resp_synthetic_${identity.id}`

type GatewayUpstream = { readonly provider: string; readonly entry?: Schema.JsonObject }

/**
 * The upstream provider the Gateway routes a model to, and its `provider_metadata` entry (keyed by
 * that provider), per model family as recorded: `openai/*` routes to `openai` with
 * `{ responseId, serviceTier }`; `deepseek/*` routes to `baseten` with
 * `{ acceptedPredictionTokens, rejectedPredictionTokens }` (synthetic zero counts). Other families
 * were not recorded: they route to their vendor prefix without an upstream entry.
 */
const upstreamOf = (identity: ChatResponseIdentity): GatewayUpstream => {
  const vendor = vendorOf(identity.model)

  if (vendor === 'openai') {
    return {
      provider: 'openai',
      entry: { responseId: syntheticResponseId(identity), serviceTier: 'default' }
    }
  }

  if (vendor === 'deepseek') {
    return {
      provider: 'baseten',
      entry: { acceptedPredictionTokens: 0, rejectedPredictionTokens: 0 }
    }
  }

  return { provider: vendor ?? 'synthetic' }
}

/** The `gateway` entry of `provider_metadata`: routing, costs, and the generation id. */
const gatewayRoutingMetadata = (identity: ChatResponseIdentity): Schema.JsonObject => {
  const { provider } = upstreamOf(identity)
  const responseId = syntheticResponseId(identity)

  return {
    routing: {
      originalModelId: identity.model,
      resolvedProvider: provider,
      fallbacksAvailable: ['synthetic-fallback'],
      planningReasoning: 'Synthetic: routing planned by the emulator.',
      canonicalSlug: identity.model,
      finalProvider: provider,
      modelAttemptCount: 1,
      modelAttempts: [
        {
          canonicalSlug: identity.model,
          success: true,
          providerAttemptCount: 1,
          providerAttempts: [
            {
              provider,
              credentialType: 'system',
              success: true,
              startTime: syntheticAttemptTime,
              endTime: syntheticAttemptTime + 1,
              providerRequestId: `req_synthetic_${identity.id}`,
              statusCode: 200,
              providerResponseId: responseId
            }
          ]
        }
      ],
      totalProviderAttemptCount: 1,
      affinity: { outcome: 'skipped_below_min_prefix' },
      clientSessionId: 'synthetic-client-session',
      clientSessionIdSource: 'fingerprint'
    },
    cost: syntheticCost,
    marketCost: syntheticCost,
    surchargeCost: syntheticCost,
    gatewayCost: syntheticCost,
    inferenceCost: syntheticCost,
    inputInferenceCost: syntheticCost,
    outputInferenceCost: syntheticCost,
    generationId: identity.id
  }
}

/** `provider_metadata`: the upstream provider's entry first (when its family has one), then `gateway`. */
const gatewayProviderMetadata = (identity: ChatResponseIdentity): Schema.JsonObject => {
  const metadata: Record<string, Schema.Json> = {}
  const upstream = upstreamOf(identity)

  if (upstream.entry !== undefined) {
    metadata[upstream.provider] = upstream.entry
  }

  metadata.gateway = gatewayRoutingMetadata(identity)

  return metadata
}

const gatewayUsage = (counts: ChatUsageCounts): Schema.JsonObject => ({
  prompt_tokens: counts.promptTokens,
  completion_tokens: counts.completionTokens,
  total_tokens: counts.promptTokens + counts.completionTokens,
  cost: 0,
  is_byok: false,
  prompt_tokens_details: { cached_tokens: 0, audio_tokens: 0, video_tokens: 0 },
  cost_details: {
    upstream_inference_cost: null,
    upstream_inference_prompt_cost: 0,
    upstream_inference_completions_cost: 0
  },
  completion_tokens_details: { reasoning_tokens: counts.reasoningTokens ?? 0, image_tokens: 0 },
  cache_creation_input_tokens: 0,
  market_cost: 0,
  gateway_cost: 0
})

const gatewayWireProfile = (eventsPerChunk: number): ChatWireProfile => ({
  eventsPerChunk,
  streamUsage: 'finish-event',
  openingDelta: { role: 'assistant' },
  choiceFields: { logprobs: null },
  reasoningField: 'reasoning',
  reasoningDetails: true,
  chunkFields: () => ({ system_fingerprint: syntheticFingerprint }),
  finishFields: identity => {
    const chunk: Record<string, Schema.Json> = {}

    if (isOpenAiModel(identity.model)) {
      chunk.service_tier = 'default'
    }

    chunk.generationId = identity.id

    return { delta: { provider_metadata: gatewayProviderMetadata(identity) }, chunk }
  },
  usage: gatewayUsage
})

const validEventsPerChunk = (eventsPerChunk: number | undefined): number => {
  const value = eventsPerChunk ?? gatewayEmulatorDefaultEventsPerChunk

  if (!Number.isSafeInteger(value) || value < 1) {
    throw new GatewayEmulatorInputInvalid({
      input: 'options',
      reason: `eventsPerChunk must be a positive integer, got ${String(eventsPerChunk)}`
    })
  }

  return value
}

/**
 * Create a Vercel AI Gateway emulator. Each call has independent ledger,
 * fault, and script state. Throws `GatewayEmulatorInputInvalid` for an
 * invalid `eventsPerChunk`.
 *
 * Without a script, `POST /v1/chat/completions` answers a known model with
 * synthetic text deltas. `stream: true` sends `chat.completion.chunk` SSE in
 * the recorded Gateway shape: a `{ role: 'assistant' }` opening delta, content
 * deltas, and a finish event whose delta carries `provider_metadata` and which
 * carries `usage` (when `stream_options.include_usage` is set),
 * `system_fingerprint`, `service_tier` (for `openai/*` models), and
 * `generationId`, then `data: [DONE]`; every chunk carries
 * `system_fingerprint` and `logprobs: null`, and events are packed
 * `eventsPerChunk` per network chunk. `stream: false` answers one
 * `chat.completion` JSON body. Reasoning models asked for reasoning
 * (`reasoning_effort`, or `thinking.type: 'enabled'`) stream
 * `delta.reasoning` with `delta.reasoning_details` before the text. A request
 * with `tools` gets one tool call whose arguments are synthesized from the
 * tool's JSON Schema and streamed in fragments, finishing with `tool_calls`.
 * Unknown models get the recorded 404 envelope (`type: 'model_not_found'`,
 * `param: { modelId }`, no `code`); a missing bearer credential gets a 401
 * envelope; unknown routes get a 404 JSON error. The ledger records the
 * `max_tokens` limit as `maxCompletionTokens`.
 *
 * Precedence per chat request: authentication and JSON validation, then the
 * first matching fault if it is a `status` fault, then the next scripted
 * turn, then model validation and defaults; a first matching chunk fault then
 * shapes the body. Only the first matching fault (in insertion order) applies. Credential headers are never
 * recorded, and the bearer value is never checked or stored.
 *
 * `POST /v1/evaluate` is fixture-only: a request with a non-empty bearer credential (never checked
 * or stored), the recorded `accept` and `content-type`, no query, and a body matching one of the
 * four classifier recordings (the discriminators `model` and `type` exact; any other string; the
 * same keys, so the recorded question ids, option keys, and level count) gets the recorded
 * response; anything else (another model, `providerOptions`, other questions) answers 400
 * not-emulated. Its ledger, faults (statuses 400-599), scripted errors, and coverage are
 * `emulator.evaluate` (control plane `/_emulate/evaluate/*`); `emulator.faults` and the other
 * top-level APIs stay the chat route's. `reset()` and `POST /_emulate/reset` reset both.
 */
export const makeGatewayEmulator = (options: GatewayEmulatorOptions = {}): GatewayEmulator => {
  const chat = makeChatCompletionsEmulator({
    path: gatewayChatCompletionsPath,
    routes: gatewayEmulatorRoutes,
    knownModels: options.knownModels ?? gatewayEmulatorDefaultModels,
    reasoningModels: options.reasoningModels ?? gatewayEmulatorDefaultReasoningModels,
    errorEnvelope: gatewayErrorEnvelope,
    // Copied data shape of the verified Gateway error-envelope recording (unknown model id): its
    // own envelope, with `param.modelId` and no `code`.
    unknownModel: {
      status: 404,
      body: model => ({
        error: {
          message: `Model '${model ?? ''}' not found`,
          type: 'model_not_found',
          param: { modelId: model ?? null }
        }
      })
    },
    auth: {
      unauthorized: {
        message: 'Synthetic: missing or invalid authorization.',
        type: 'authentication_error',
        code: 'unauthorized'
      }
    },
    completionTokenField: 'max_tokens',
    responseIdPrefix: 'gen-synthetic',
    defaultText: ['Hello', ' from the', ' synthetic gateway.'],
    turnSchema: GatewayScriptedTurn,
    inputInvalid: (input, reason) => new GatewayEmulatorInputInvalid({ input, reason }),
    wire: gatewayWireProfile(validEventsPerChunk(options.eventsPerChunk))
  })

  const evaluate = makeFixtureRouteEmulator({
    method: 'POST',
    path: gatewayEvaluatePath,
    routes: gatewayEvaluateEmulatorRoutes,
    recordings: gatewayEvaluateRecordings,
    credential: 'bearer',
    headers: [],
    inputInvalid: (input, reason) => new GatewayEmulatorInputInvalid({ input, reason })
  })

  return {
    ...chat,
    fetch: composeFetch({
      routes: [{ name: 'evaluate', paths: [gatewayEvaluatePath], part: evaluate }],
      fallback: chat,
      control: request => chat.fetch(request)
    }),
    reset: () => {
      chat.reset()
      evaluate.reset()
    },
    evaluate
  }
}
