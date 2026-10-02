/**
 * Vercel AI Gateway classifier models: a `ClassifierModel` layer over AI Gateway
 * `POST /v1/evaluate` (Gateway calls classification "evaluation").
 *
 * The request body is `{ model, state, questions, providerOptions? }` (questions as the core
 * contract defines them; `providerOptions` passed through unchanged, so
 * `providerOptions.gateway` reaches Gateway routing as is). The response
 * `{ model, answers, usage: { inputTokens, outputTokens }, providerMetadata }` is decoded into a
 * `ClassificationResult`: every answer is checked against its question (core
 * `decodeClassifierAnswers`), probabilities are kept as returned, `providerMetadata.gateway.cost`
 * (US dollars, a decimal string) becomes `usage.costUsd`, and `x-ai-gateway-evaluation-fallback-*`
 * response headers are kept in `providerMetadata.evaluationFallbackHeaders`.
 *
 * Unverified wire detail: where `choice` and `score` confidence lives. A `confidence` on the
 * answer wins; otherwise `providerMetadata.typesafe.confidence[questionId]` is used.
 */
import { Effect, Layer, Option, Predicate, Redacted, Result } from 'effect'
import * as Schema from 'effect/Schema'
import { FetchHttpClient, HttpClient, HttpClientRequest } from 'effect/unstable/http'
import {
  ClassificationProviderError,
  ClassificationResponseInvalid,
  ClassifierModel,
  decodeClassificationRequest,
  decodeClassifierAnswers,
  type ClassificationError,
  type ClassificationRequest,
  type ClassificationResult,
  type ClassificationUsage,
  type ClassificationResponseIssue
} from '@yolk-sdk/agent/classification'
import { replaceLoneSurrogatesDeep, type ProviderFailureKind } from '@yolk-sdk/agent/protocol'
import {
  classifyProviderFailure,
  providerErrorInfo,
  providerFailureRetryable
} from '../provider-error.ts'
import { vercelAiGatewayProviderId } from './ai-gateway-provider.ts'
import { vercelAiGatewayCredentialConfig } from './ai-gateway-credential-internal.ts'

/** The AI Gateway origin the classifier calls by default. */
export const vercelAiGatewayBaseUrl = 'https://ai-gateway.vercel.sh'

/** AI Gateway's classification ("evaluation") path. */
export const vercelAiGatewayEvaluatePath = '/v1/evaluate'

export const vercelAiGatewayEvaluateUrl = `${vercelAiGatewayBaseUrl}${vercelAiGatewayEvaluatePath}`

/** TypeSafe's Jev classifier model, the default. */
export const vercelAiGatewayClassifierDefaultModel = 'typesafe-ai/jev'

/** Response headers kept in `providerMetadata.evaluationFallbackHeaders`. */
export const vercelAiGatewayEvaluationFallbackHeaderPrefix = 'x-ai-gateway-evaluation-fallback-'

const providerName = 'Vercel AI Gateway'

export type VercelAiGatewayClassifierConfig = {
  /** Accepts either an AI Gateway API key or a Vercel OIDC token. */
  readonly apiKey: Redacted.Redacted<string>
  /** Classifier model id. Defaults to `vercelAiGatewayClassifierDefaultModel`. */
  readonly model?: string
  /**
   * Gateway origin; `/v1/evaluate` is appended. Override only with a trusted proxy or a local
   * emulator because the bearer credential is sent to this URL.
   */
  readonly baseUrl?: string
  /** Extra request headers; the auth and content-negotiation headers always win. */
  readonly extraHeaders?: Readonly<Record<string, string>>
}

const evaluateUrl = (baseUrl: string | undefined): string =>
  baseUrl === undefined
    ? vercelAiGatewayEvaluateUrl
    : `${baseUrl.replace(/\/+$/, '')}${vercelAiGatewayEvaluatePath}`

const UnknownFromJsonString = Schema.fromJsonString(Schema.Unknown)

const JsonFromJsonString = Schema.fromJsonString(Schema.Json)

const EvaluateUsageWire = Schema.Struct({
  inputTokens: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  outputTokens: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))
})

const EvaluateResponseWire = Schema.Struct({
  model: Schema.optionalKey(Schema.NonEmptyString),
  answers: Schema.Record(Schema.String, Schema.Unknown),
  providerMetadata: Schema.optionalKey(Schema.JsonObject)
})

// The documented Gateway error envelope is `{ message, error_type }`; the OpenAI-compatible
// `{ error: { message, type, code } }` envelope of the chat endpoint is read too.
const EvaluateErrorWire = Schema.Struct({
  message: Schema.optionalKey(Schema.String),
  error_type: Schema.optionalKey(Schema.String),
  error: Schema.optionalKey(
    Schema.Struct({
      message: Schema.optionalKey(Schema.String),
      type: Schema.optionalKey(Schema.String),
      code: Schema.optionalKey(Schema.String)
    })
  )
})

type EvaluateResponseWire = typeof EvaluateResponseWire.Type

/** An own field of a JSON object, never an inherited one. */
const field = (value: unknown, key: string): unknown =>
  Predicate.isObject(value) && Object.hasOwn(value, key) && Predicate.hasProperty(value, key)
    ? value[key]
    : undefined

const transportError = (kind: ProviderFailureKind, message: string) =>
  ClassificationProviderError.make({
    message,
    retryable: providerFailureRetryable(kind),
    provider: providerErrorInfo({ provider: vercelAiGatewayProviderId, kind })
  })

const responseInvalid = (
  reason: ClassificationResponseIssue,
  usage: ClassificationUsage | undefined,
  questionId?: string
) =>
  ClassificationResponseInvalid.make({
    message:
      questionId === undefined
        ? `${providerName} classification response is invalid: ${reason}`
        : `${providerName} classification answer for question "${questionId}" is invalid: ${reason}`,
    provider: vercelAiGatewayProviderId,
    reason,
    questionId,
    usage
  })

/** `providerMetadata.gateway.cost` (a decimal US dollar string, or a number) as dollars. */
const gatewayCostUsd = (providerMetadata: unknown): number | undefined => {
  const cost = field(field(providerMetadata, 'gateway'), 'cost')

  const value = Predicate.isString(cost)
    ? cost.trim().length === 0
      ? Number.NaN
      : Number(cost)
    : Predicate.isNumber(cost)
      ? cost
      : Number.NaN

  return Number.isFinite(value) && value >= 0 ? value : undefined
}

/** Usage from the response body; omitted when the body has no readable token counts. */
const usageOf = (body: unknown): ClassificationUsage | undefined =>
  Option.getOrUndefined(
    Schema.decodeUnknownOption(EvaluateUsageWire)(field(body, 'usage')).pipe(
      Option.map(tokens => {
        const costUsd = gatewayCostUsd(field(body, 'providerMetadata'))

        return costUsd === undefined
          ? { inputTokens: tokens.inputTokens, outputTokens: tokens.outputTokens }
          : { inputTokens: tokens.inputTokens, outputTokens: tokens.outputTokens, costUsd }
      })
    )
  )

/** Answers with `confidence` filled from `providerMetadata.typesafe.confidence` where absent. */
const withMetadataConfidence = (
  answers: EvaluateResponseWire['answers'],
  providerMetadata: EvaluateResponseWire['providerMetadata']
) => {
  const confidence = field(field(providerMetadata, 'typesafe'), 'confidence')

  return Object.fromEntries(
    Object.entries(answers).map(([questionId, answer]) => {
      const type = field(answer, 'type')
      const value = field(confidence, questionId)

      return Predicate.isObject(answer) &&
        (type === 'choice' || type === 'score') &&
        !Object.hasOwn(answer, 'confidence') &&
        value !== undefined
        ? [questionId, { ...answer, confidence: value }]
        : [questionId, answer]
    })
  )
}

const fallbackHeaders = (
  headers: Readonly<Record<string, string>>
): Schema.JsonObject | undefined => {
  const entries = Object.entries(headers)
    .map(([name, value]): [string, string] => [name.toLowerCase(), value])
    .filter(([name]) => name.startsWith(vercelAiGatewayEvaluationFallbackHeaderPrefix))
    .sort(([left], [right]) => left.localeCompare(right))

  return entries.length === 0 ? undefined : Object.fromEntries(entries)
}

type ClassificationResultFields = {
  model: string
  answers: ClassificationResult['answers']
  usage?: ClassificationUsage
  providerMetadata?: Schema.JsonObject
}

/**
 * Decode a 2xx `/v1/evaluate` body (already read as text) for `request`. Usage is decoded first,
 * so every later failure keeps it.
 */
const decodeEvaluateResponse = (
  text: string,
  headers: Readonly<Record<string, string>>,
  request: ClassificationRequest,
  requestedModel: string
): Effect.Effect<ClassificationResult, ClassificationResponseInvalid> =>
  Effect.gen(function* () {
    const body = yield* Schema.decodeUnknownEffect(UnknownFromJsonString)(text).pipe(
      Effect.mapError(() => responseInvalid('malformed_response', undefined))
    )

    const usage = usageOf(body)

    const wire = yield* Schema.decodeUnknownEffect(EvaluateResponseWire)(body).pipe(
      Effect.mapError(() => responseInvalid('malformed_response', usage))
    )

    const answers = decodeClassifierAnswers(
      request.questions,
      withMetadataConfidence(wire.answers, wire.providerMetadata)
    )

    if (Result.isFailure(answers)) {
      return yield* Effect.fail(
        responseInvalid(answers.failure.reason, usage, answers.failure.questionId)
      )
    }

    const fields: ClassificationResultFields = {
      model: wire.model ?? requestedModel,
      answers: answers.success
    }

    if (usage !== undefined) fields.usage = usage

    const evaluationFallbackHeaders = fallbackHeaders(headers)

    if (wire.providerMetadata !== undefined || evaluationFallbackHeaders !== undefined) {
      const providerMetadata = wire.providerMetadata ?? {}

      fields.providerMetadata =
        evaluationFallbackHeaders === undefined
          ? providerMetadata
          : { ...providerMetadata, evaluationFallbackHeaders }
    }

    return fields
  })

type StatusFailureInput = {
  readonly provider: string
  readonly status: number
  readonly headers: Readonly<Record<string, string>>
  providerCode?: string
  message?: string
}

/** Classify a non-2xx answer: status, Gateway error type, and retry delay; never the body text. */
const statusError = (
  status: number,
  headers: Readonly<Record<string, string>>,
  text: string
): Effect.Effect<ClassificationProviderError> =>
  Schema.decodeUnknownEffect(Schema.fromJsonString(EvaluateErrorWire))(text).pipe(
    Effect.option,
    Effect.map(envelope => {
      const decoded = Option.getOrUndefined(envelope)
      const providerCode = decoded?.error_type ?? decoded?.error?.code ?? decoded?.error?.type
      const message = decoded?.message ?? decoded?.error?.message

      const failure: StatusFailureInput = { provider: vercelAiGatewayProviderId, status, headers }

      if (providerCode !== undefined) failure.providerCode = providerCode

      if (message !== undefined) failure.message = message

      const provider = classifyProviderFailure(failure)

      return ClassificationProviderError.make({
        message: `${providerName} returned ${status}`,
        retryable: providerFailureRetryable(provider.kind),
        provider
      })
    })
  )

const encodeRequestBody = (
  request: ClassificationRequest,
  model: string
): Effect.Effect<string, ClassificationError> => {
  const body =
    request.providerOptions === undefined
      ? { model, state: request.state, questions: request.questions }
      : {
          model,
          state: request.state,
          questions: request.questions,
          providerOptions: request.providerOptions
        }

  return Schema.decodeUnknownEffect(Schema.Json)(replaceLoneSurrogatesDeep(body)).pipe(
    Effect.flatMap(Schema.encodeEffect(JsonFromJsonString)),
    Effect.mapError(() =>
      transportError('unknown', `Could not serialize ${providerName} classification request`)
    )
  )
}

const classifyWith =
  (config: VercelAiGatewayClassifierConfig, client: HttpClient.HttpClient) =>
  (input: ClassificationRequest): Effect.Effect<ClassificationResult, ClassificationError> =>
    Effect.gen(function* () {
      const request = yield* decodeClassificationRequest(input)
      const model = config.model ?? vercelAiGatewayClassifierDefaultModel
      const body = yield* encodeRequestBody(request, model)

      const httpRequest = HttpClientRequest.post(evaluateUrl(config.baseUrl)).pipe(
        HttpClientRequest.setHeaders({
          ...config.extraHeaders,
          accept: 'application/json',
          authorization: `Bearer ${Redacted.value(config.apiKey)}`,
          'content-type': 'application/json'
        }),
        HttpClientRequest.bodyText(body, 'application/json')
      )

      const response = yield* client
        .execute(httpRequest)
        .pipe(
          Effect.mapError(() =>
            transportError('network', `${providerName} classification request failed`)
          )
        )

      const text = yield* response.text.pipe(
        Effect.mapError(() =>
          transportError('network', `Could not read ${providerName} classification response`)
        )
      )

      if (response.status < 200 || response.status >= 300) {
        return yield* Effect.fail(yield* statusError(response.status, response.headers, text))
      }

      return yield* decodeEvaluateResponse(text, response.headers, request, model)
    }).pipe(Effect.withSpan('VercelAiGatewayClassifier.classify'))

/**
 * AI Gateway classifier layer for `ClassifierModel`. Hosts provide the `HttpClient` and the
 * credential; no env reads happen here.
 */
export const makeVercelAiGatewayClassifierLayer = (
  config: VercelAiGatewayClassifierConfig
): Layer.Layer<ClassifierModel, never, HttpClient.HttpClient> =>
  Layer.effect(
    ClassifierModel,
    Effect.gen(function* () {
      const client = yield* HttpClient.HttpClient

      return ClassifierModel.of({ classify: classifyWith(config, client) })
    })
  )

const vercelAiGatewayClassifierEnvironmentConfig = Effect.gen(function* () {
  const apiKey = yield* vercelAiGatewayCredentialConfig

  return { apiKey }
}).pipe(
  Effect.mapError(() =>
    ClassificationProviderError.make({
      message: `${providerName} environment configuration missing`,
      retryable: false,
      provider: providerErrorInfo({ provider: vercelAiGatewayProviderId, kind: 'auth' })
    })
  )
)

/**
 * AI Gateway classifier layer from the environment: `AI_GATEWAY_API_KEY`, falling back to
 * `VERCEL_OIDC_TOKEN` (the same credential as the Gateway chat provider), the default model, and
 * the Fetch `HttpClient`.
 */
export const VercelAiGatewayClassifierLayer = Layer.unwrap(
  vercelAiGatewayClassifierEnvironmentConfig.pipe(Effect.map(makeVercelAiGatewayClassifierLayer))
).pipe(Layer.provide(FetchHttpClient.layer))
