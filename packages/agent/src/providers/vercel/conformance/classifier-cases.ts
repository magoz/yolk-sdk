/**
 * Vercel AI Gateway classifier conformance cases for `@yolk-sdk/conformance/runner`.
 *
 * Each case builds the public Gateway classifier (`makeVercelAiGatewayClassifierLayer`, default
 * `https://ai-gateway.vercel.sh/v1/evaluate`) from `VercelAiGatewayClassifierConformanceConfig`,
 * sends one classification through the typed `classify`, and asserts one wire claim from the
 * result (or the typed error). Cases need only `HttpClient.HttpClient` and the config service, so
 * the same case runs against replayed fixtures (`ReplayHttpClient`), the
 * `@yolk-sdk/emulators/gateway` `/v1/evaluate` route, or a host's live `HttpClient`. All four are
 * `read` cases; none is observed live yet (`observed` absent = unverified), and their fixtures are
 * synthetic placeholders until an owner-approved live probe records them.
 */
import { Context, Effect, Predicate, Result, type Redacted } from 'effect'
import type { HttpClient } from 'effect/unstable/http'
import {
  defineConformanceCase,
  expectConformance,
  expectEqual,
  type ConformanceCase,
  type ConformanceMismatch
} from '@yolk-sdk/conformance/case'
import {
  ClassificationProviderError,
  classify,
  type ClassificationError,
  type ClassificationRequestFor,
  type ClassificationResultFor,
  type ClassifierQuestionsInput
} from '@yolk-sdk/agent/classification'
import { makeVercelAiGatewayClassifierLayer } from '../ai-gateway-classifier.ts'
import { vercelAiGatewayClassifierBooleanFixture } from './classifier-boolean.ts'
import { vercelAiGatewayClassifierChoiceFixture } from './classifier-choice.ts'
import { vercelAiGatewayClassifierErrorEnvelopeFixture } from './classifier-error-envelope.ts'
import { vercelAiGatewayClassifierScoreFixture } from './classifier-score.ts'

/** Model ids for the classifier cases. `invalid` must NOT exist on the Gateway. */
export type VercelAiGatewayClassifierConformanceModels = {
  readonly classifier: string
  readonly invalid: string
}

/** The model ids of the committed synthetic fixtures (`classifier` is the provider default). */
export const vercelAiGatewayClassifierConformanceDefaultModels: VercelAiGatewayClassifierConformanceModels =
  {
    classifier: 'typesafe-ai/jev',
    invalid: 'yolk-conformance/model-does-not-exist'
  }

export type VercelAiGatewayClassifierConformanceSettings = {
  /** Gateway API key (or Vercel OIDC token). Any value works under replay or an emulator. */
  readonly apiKey: Redacted.Redacted<string>
  readonly models: VercelAiGatewayClassifierConformanceModels
}

/** Host-supplied settings for the Gateway classifier conformance cases. */
export class VercelAiGatewayClassifierConformanceConfig extends Context.Service<
  VercelAiGatewayClassifierConformanceConfig,
  VercelAiGatewayClassifierConformanceSettings
>()('@yolk-sdk/agent/providers/vercel/conformance/VercelAiGatewayClassifierConformanceConfig') {}

/** What every Gateway classifier conformance case requires from the host. */
export type VercelAiGatewayClassifierConformanceRequirements =
  | HttpClient.HttpClient
  | VercelAiGatewayClassifierConformanceConfig

export type VercelAiGatewayClassifierConformanceCase = ConformanceCase<
  ClassificationError | ConformanceMismatch,
  VercelAiGatewayClassifierConformanceRequirements
>

const approvalQuestions = {
  approves: {
    type: 'boolean',
    instructions: 'Does the reply approve the delivered result?',
    criteria: {
      true: 'The reply accepts or approves the result.',
      false: 'The reply rejects or questions the result.'
    }
  }
} as const

const approvalState = 'Synthetic reply: thanks, the fix works on my side.'

const routeOptions = {
  billing: 'Payments, invoices, and refunds.',
  bug: 'Product defects and errors.',
  other: 'Anything else.'
} as const

const routeQuestions = {
  route: {
    type: 'choice',
    instructions: 'Which team should handle this ticket?',
    criteria: routeOptions
  }
} as const

const urgencyLevels = ['Not urgent.', 'Somewhat urgent.', 'Urgent.', 'Critical outage.'] as const

const urgencyQuestions = {
  urgency: {
    type: 'score',
    instructions: 'How urgent is this report?',
    criteria: urgencyLevels
  }
} as const

const classifyWith = <const Q extends ClassifierQuestionsInput>(
  model: string,
  request: ClassificationRequestFor<Q>
): Effect.Effect<
  ClassificationResultFor<Q>,
  ClassificationError,
  HttpClient.HttpClient | VercelAiGatewayClassifierConformanceConfig
> =>
  Effect.gen(function* () {
    const settings = yield* VercelAiGatewayClassifierConformanceConfig

    return yield* classify(request).pipe(
      Effect.provide(makeVercelAiGatewayClassifierLayer({ apiKey: settings.apiKey, model }))
    )
  })

const isProbability = (value: unknown): boolean =>
  Predicate.isNumber(value) && Number.isFinite(value) && value >= 0 && value <= 1

/** Claims shared by every successful classification: a model id and billed token usage. */
const expectModelAndUsage = (result: {
  readonly model: string
  readonly usage?: { readonly inputTokens: number; readonly costUsd?: number }
}) =>
  Effect.gen(function* () {
    yield* expectConformance(result.model.trim().length > 0, 'expected the answering model id')
    yield* expectConformance(
      result.usage !== undefined && result.usage.inputTokens > 0,
      'expected token usage with input tokens'
    )
  })

export const vercelAiGatewayClassifierBooleanCase: VercelAiGatewayClassifierConformanceCase =
  defineConformanceCase({
    id: 'vercel-ai-gateway.classify.boolean',
    title: 'A boolean question gets a probability, token usage, and a cost',
    safety: 'read',
    docs: 'AI Gateway `POST /v1/evaluate` answers named questions about one `state`; a `boolean` answer is `{ type: "boolean", probability }`. The response carries `usage: { inputTokens, outputTokens }` and the request cost in `providerMetadata.gateway.cost` (US dollars).',
    wire: 'A string state with one boolean question succeeds: the result has exactly that question id, answered `boolean` with a probability in [0, 1], the answering model id, token usage with input tokens, and a non-negative `usage.costUsd` from the Gateway cost.',
    fixtures: [vercelAiGatewayClassifierBooleanFixture.id],
    run: Effect.gen(function* () {
      const settings = yield* VercelAiGatewayClassifierConformanceConfig

      const result = yield* classifyWith(settings.models.classifier, {
        state: approvalState,
        questions: approvalQuestions
      })

      yield* expectEqual(
        Object.keys(result.answers),
        ['approves'],
        'expected one answer per question'
      )
      yield* expectEqual(result.answers.approves.type, 'boolean', 'expected a boolean answer')
      yield* expectConformance(
        isProbability(result.answers.approves.probability),
        'expected a probability in [0, 1]'
      )
      yield* expectModelAndUsage(result)

      const costUsd = result.usage?.costUsd

      yield* expectConformance(
        costUsd !== undefined && Number.isFinite(costUsd) && costUsd >= 0,
        'expected a non-negative cost in US dollars'
      )
    })
  })

export const vercelAiGatewayClassifierChoiceCase: VercelAiGatewayClassifierConformanceCase =
  defineConformanceCase({
    id: 'vercel-ai-gateway.classify.choice',
    title: 'A choice question picks one named option with per-option probabilities',
    safety: 'read',
    docs: 'A `choice` question names its options in `criteria`; its answer is `{ type: "choice", choice, probabilities }`. Confidence is documented by the AI SDK under `providerMetadata.typesafe.confidence[questionId]`; it may also appear on the answer.',
    wire: 'A JSON object state with one choice question succeeds: the answer is `choice`, names one of the offered option keys, has probabilities in [0, 1] keyed only by offered options, and has a confidence in [0, 1] (on the answer or in `providerMetadata.typesafe.confidence`), plus token usage.',
    fixtures: [vercelAiGatewayClassifierChoiceFixture.id],
    run: Effect.gen(function* () {
      const settings = yield* VercelAiGatewayClassifierConformanceConfig

      const result = yield* classifyWith(settings.models.classifier, {
        state: {
          subject: 'Synthetic invoice question',
          body: 'I was charged twice for the synthetic plan.'
        },
        questions: routeQuestions
      })

      const answer = result.answers.route
      const options = Object.keys(routeOptions)
      const keys = Object.keys(answer.probabilities)

      yield* expectEqual(Object.keys(result.answers), ['route'], 'expected one answer per question')
      yield* expectEqual(answer.type, 'choice', 'expected a choice answer')
      yield* expectConformance(options.includes(answer.choice), 'expected an offered option', {
        expected: options,
        actual: answer.choice
      })
      yield* expectConformance(
        keys.length > 0 && keys.every(key => options.includes(key)),
        'expected probabilities keyed by offered options',
        { expected: options, actual: keys }
      )
      yield* expectConformance(
        Object.values(answer.probabilities).every(isProbability),
        'expected probabilities in [0, 1]'
      )
      yield* expectConformance(isProbability(answer.confidence), 'expected a confidence in [0, 1]')
      yield* expectModelAndUsage(result)
    })
  })

export const vercelAiGatewayClassifierScoreCase: VercelAiGatewayClassifierConformanceCase =
  defineConformanceCase({
    id: 'vercel-ai-gateway.classify.score',
    title: 'A score question picks one ordinal level with per-level probabilities',
    safety: 'read',
    docs: 'A `score` question lists 2 to 10 ordinal levels in `criteria`, lowest first; its answer is `{ type: "score", score, probabilities }`.',
    wire: 'A JSON array state with one four-level score question succeeds: the answer is `score` with an integer `score`, between one and four probabilities in [0, 1], and a confidence in [0, 1] (on the answer or in `providerMetadata.typesafe.confidence`), plus token usage. Whether levels count from 0 or 1 is not part of the claim.',
    fixtures: [vercelAiGatewayClassifierScoreFixture.id],
    run: Effect.gen(function* () {
      const settings = yield* VercelAiGatewayClassifierConformanceConfig

      const result = yield* classifyWith(settings.models.classifier, {
        state: [
          { author: 'synthetic-user', text: 'The synthetic dashboard is down for everyone.' }
        ],
        questions: urgencyQuestions
      })

      const answer = result.answers.urgency
      const probabilities = Object.values(answer.probabilities)

      yield* expectEqual(
        Object.keys(result.answers),
        ['urgency'],
        'expected one answer per question'
      )
      yield* expectEqual(answer.type, 'score', 'expected a score answer')
      yield* expectConformance(Number.isInteger(answer.score), 'expected an integer score level', {
        actual: answer.score
      })
      yield* expectConformance(
        probabilities.length > 0 &&
          probabilities.length <= urgencyLevels.length &&
          probabilities.every(isProbability),
        'expected at most one probability in [0, 1] per level',
        { actual: Object.keys(answer.probabilities) }
      )
      yield* expectConformance(isProbability(answer.confidence), 'expected a confidence in [0, 1]')
      yield* expectModelAndUsage(result)
    })
  })

const sanitizedStatusMessage = /^Vercel AI Gateway returned \d{3}$/

// Statuses a Gateway may use to reject an unknown model. 401/403 (authentication/permission) and
// every other 4xx are not a model rejection.
const modelRejectionStatuses: ReadonlyArray<number> = [400, 404, 422]

export const vercelAiGatewayClassifierErrorEnvelopeCase: VercelAiGatewayClassifierConformanceCase =
  defineConformanceCase({
    id: 'vercel-ai-gateway.classify.error-envelope',
    title: 'Unknown classifier model ids fail with a sanitized non-retryable error',
    safety: 'read',
    docs: 'AI Gateway errors use the envelope `{ message, error_type }` with a non-2xx status.',
    wire: 'An unknown model id is rejected as a model error (400, 404, or 422; never a 401/403 authentication or permission failure) with a JSON envelope: the classifier fails with a non-retryable `ClassificationProviderError` that is not classified as `auth`, keeps the status and the Gateway error type as the provider code, and whose message is status-only (no upstream body text).',
    fixtures: [vercelAiGatewayClassifierErrorEnvelopeFixture.id],
    run: Effect.gen(function* () {
      const settings = yield* VercelAiGatewayClassifierConformanceConfig

      const outcome = yield* classifyWith(settings.models.invalid, {
        state: approvalState,
        questions: approvalQuestions
      }).pipe(Effect.result)

      if (Result.isSuccess(outcome)) {
        return yield* expectConformance(false, 'expected an error envelope, the request succeeded')
      }

      const error = outcome.failure

      if (!(error instanceof ClassificationProviderError)) {
        return yield* expectConformance(false, 'expected a ClassificationProviderError', {
          actual: error._tag
        })
      }

      const status = error.provider.status
      const providerCode = error.provider.providerCode

      yield* expectEqual(error.retryable, false, 'expected a non-retryable error')
      yield* expectConformance(
        status !== 401 && status !== 403 && error.provider.kind !== 'auth',
        'expected a model rejection, not an authentication or permission failure',
        { actual: status ?? null }
      )
      yield* expectConformance(
        status !== undefined && modelRejectionStatuses.includes(status),
        'expected a 400, 404, or 422 model-rejection status',
        { expected: [...modelRejectionStatuses], actual: status ?? null }
      )
      yield* expectConformance(
        providerCode !== undefined && providerCode.length > 0,
        'expected the Gateway error type to be preserved'
      )
      yield* expectConformance(
        sanitizedStatusMessage.test(error.message),
        'expected a status-only message without upstream body text'
      )
    })
  })

/** Every Vercel AI Gateway classifier conformance case, in fixture order. */
export const vercelAiGatewayClassifierConformanceCases: ReadonlyArray<VercelAiGatewayClassifierConformanceCase> =
  [
    vercelAiGatewayClassifierBooleanCase,
    vercelAiGatewayClassifierChoiceCase,
    vercelAiGatewayClassifierScoreCase,
    vercelAiGatewayClassifierErrorEnvelopeCase
  ]
