import { Clock, ConfigProvider, Effect, Exit, Fiber, Layer, Random, Redacted } from 'effect'
import { TestClock } from 'effect/testing'
import { HttpClient, HttpClientError, HttpClientResponse } from 'effect/unstable/http'
import type { HttpClientRequest } from 'effect/unstable/http'
import { describe, expect, it } from '@effect/vitest'
import {
  ClassificationProviderError,
  ClassificationRequestInvalid,
  ClassificationResponseInvalid,
  ClassifierModel,
  classify,
  type ClassificationRequest
} from '@yolk-sdk/agent/classification'
import { decodeWireFixture, scanFixtureForSecrets } from '@yolk-sdk/conformance/fixture'
import { ReplayHttpClient } from '@yolk-sdk/conformance/replay'
import {
  VercelAiGatewayClassifierLayer,
  makeVercelAiGatewayClassifierLayer,
  vercelAiGatewayClassifierDefaultMaxRetries,
  vercelAiGatewayClassifierDefaultModel,
  vercelAiGatewayEvaluateUrl,
  type VercelAiGatewayClassifierConfig
} from '../../../src/providers/vercel/ai-gateway-classifier.ts'
import {
  vercelAiGatewayClassifierBooleanFixture,
  vercelAiGatewayClassifierChoiceFixture,
  vercelAiGatewayClassifierConformanceFixtures,
  vercelAiGatewayClassifierScoreFixture
} from '../../../src/providers/vercel/conformance/index.ts'

const secret = 'synthetic-classifier-secret-0001'

const config: VercelAiGatewayClassifierConfig = { apiKey: Redacted.make(secret) }

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

const routeQuestions = {
  route: {
    type: 'choice',
    instructions: 'Which team should handle this ticket?',
    criteria: { billing: 'Payments.', bug: 'Defects.', other: 'Anything else.' }
  }
} as const

const urgencyQuestions = {
  urgency: {
    type: 'score',
    instructions: 'How urgent is this report?',
    criteria: ['Not urgent.', 'Somewhat urgent.', 'Urgent.', 'Critical outage.']
  }
} as const

type Captured = { readonly request: HttpClientRequest.HttpClientRequest }

type Answer = {
  readonly status?: number
  readonly body: string
  readonly headers?: Readonly<Record<string, string>>
}

const answering = (answer: Answer, captured: Array<Captured>) =>
  Layer.succeed(
    HttpClient.HttpClient,
    HttpClient.make(request =>
      Effect.sync(() => {
        captured.push({ request })

        return HttpClientResponse.fromWeb(
          request,
          new Response(answer.body, {
            status: answer.status ?? 200,
            headers: { 'content-type': 'application/json', ...answer.headers }
          })
        )
      })
    )
  )

const runClassify = (
  request: ClassificationRequest,
  answer: Answer,
  captured: Array<Captured> = [],
  classifierConfig: VercelAiGatewayClassifierConfig = config
) =>
  Effect.gen(function* () {
    const model = yield* ClassifierModel

    return yield* model.classify(request)
  }).pipe(
    Effect.provide(makeVercelAiGatewayClassifierLayer(classifierConfig)),
    Effect.provide(answering(answer, captured))
  )

const sentBody = (captured: ReadonlyArray<Captured>): unknown => {
  const body = captured[0]?.request.body

  if (body?._tag !== 'Uint8Array') {
    return expect.fail('expected a JSON request body')
  }

  return JSON.parse(new TextDecoder().decode(body.body))
}

const success = (answers: string, extra = '') =>
  `{"model":"typesafe-ai/jev","answers":${answers},"usage":{"inputTokens":40,"outputTokens":0},"providerMetadata":{"gateway":{"cost":"0.00000168"}${extra}}}`

const billedUsage = { inputTokens: 40, outputTokens: 0, costUsd: 0.00000168 }

const textOf = (value: unknown): string => JSON.stringify(value) ?? ''

describe('Vercel AI Gateway classifier request lowering', () => {
  it.effect('posts the model, state, questions, and provider options to /v1/evaluate', () =>
    Effect.gen(function* () {
      const captured: Array<Captured> = []

      yield* runClassify(
        {
          state: { ticket: 'Synthetic ticket.' },
          questions: routeQuestions,
          providerOptions: {
            gateway: {
              zeroDataRetention: true,
              only: ['typesafe'],
              models: [{ model: 'openai/gpt-4.1-nano', when: { confidenceBelow: 0.6 } }]
            }
          }
        },
        {
          body: success('{"route":{"type":"choice","choice":"bug","probabilities":{"bug":1}}}')
        },
        captured
      )

      const request = captured[0]?.request ?? expect.fail('no request')

      expect(request.method).toBe('POST')
      expect(request.url).toBe(vercelAiGatewayEvaluateUrl)
      expect(request.url).toBe('https://ai-gateway.vercel.sh/v1/evaluate')
      expect(request.headers).toMatchObject({
        accept: 'application/json',
        authorization: `Bearer ${secret}`,
        'content-type': 'application/json'
      })
      expect(sentBody(captured)).toEqual({
        model: vercelAiGatewayClassifierDefaultModel,
        state: { ticket: 'Synthetic ticket.' },
        questions: routeQuestions,
        providerOptions: {
          gateway: {
            zeroDataRetention: true,
            only: ['typesafe'],
            models: [{ model: 'openai/gpt-4.1-nano', when: { confidenceBelow: 0.6 } }]
          }
        }
      })
      expect(vercelAiGatewayClassifierDefaultModel).toBe('typesafe-ai/jev')
    })
  )

  it.effect('honors the model, a trusted base URL, and extra headers without auth overrides', () =>
    Effect.gen(function* () {
      const captured: Array<Captured> = []

      yield* runClassify(
        { state: 'Synthetic.', questions: approvalQuestions },
        { body: success('{"approves":{"type":"boolean","probability":0.5}}') },
        captured,
        {
          ...config,
          model: 'synthetic/classifier',
          baseUrl: 'http://127.0.0.1:4010/',
          extraHeaders: { authorization: 'Bearer other', 'x-synthetic': 'kept' }
        }
      )

      const request = captured[0]?.request ?? expect.fail('no request')

      expect(request.url).toBe('http://127.0.0.1:4010/v1/evaluate')
      expect(request.headers).toMatchObject({
        authorization: `Bearer ${secret}`,
        'x-synthetic': 'kept'
      })
      expect(sentBody(captured)).toMatchObject({ model: 'synthetic/classifier' })
      expect(sentBody(captured)).not.toHaveProperty('providerOptions')
    })
  )

  it.effect('rejects an invalid request before sending anything', () =>
    Effect.gen(function* () {
      const captured: Array<Captured> = []

      const criteria = Object.fromEntries(
        Array.from({ length: 256 }, (_, index) => [`option-${index}`, 'An option.'])
      )

      const error = yield* Effect.flip(
        runClassify(
          {
            state: 'Synthetic.',
            questions: { route: { type: 'choice', instructions: 'Pick.', criteria } }
          },
          { body: '{}' },
          captured
        )
      )

      expect(error).toBeInstanceOf(ClassificationRequestInvalid)
      expect(captured).toEqual([])
    })
  )
})

describe('Vercel AI Gateway classifier response decoding', () => {
  // One replay layer for all three calls: the replay consumes the fixtures' exchanges in order.
  it.effect('round-trips every question type through the synthetic fixtures', () =>
    Effect.gen(function* () {
      const approval = yield* classify({
        state: 'Synthetic reply: thanks, the fix works on my side.',
        questions: approvalQuestions
      })

      expect(approval).toEqual({
        model: 'typesafe-ai/jev',
        answers: { approves: { type: 'boolean', probability: 0.93 } },
        usage: { inputTokens: 58, outputTokens: 0, costUsd: 0.000002436 },
        providerMetadata: { gateway: { cost: '0.000002436' } }
      })

      const route = yield* classify({
        state: { subject: 'Synthetic invoice question', body: 'Charged twice.' },
        questions: routeQuestions
      })

      // Confidence under `providerMetadata.typesafe.confidence` is moved onto the answer.
      expect(route.answers).toEqual({
        route: {
          type: 'choice',
          choice: 'billing',
          probabilities: { billing: 0.91, bug: 0.06, other: 0.03 },
          confidence: 0.88
        }
      })
      expect(route.usage).toEqual({ inputTokens: 74, outputTokens: 0, costUsd: 0.000003108 })

      const urgency = yield* classify({
        state: [{ text: 'Synthetic outage.' }],
        questions: urgencyQuestions
      })

      expect(urgency.answers).toEqual({
        urgency: {
          type: 'score',
          score: 2.74,
          probabilities: { '0': 0.01, '1': 0.04, '2': 0.15, '3': 0.8 },
          confidence: 0.77
        }
      })
    }).pipe(
      Effect.provide(
        makeVercelAiGatewayClassifierLayer(config).pipe(
          Layer.provide(ReplayHttpClient.layer(vercelAiGatewayClassifierConformanceFixtures))
        )
      )
    )
  )

  it.effect('keeps probabilities exactly as returned (never renormalized)', () =>
    Effect.gen(function* () {
      const result = yield* runClassify(
        { state: 'Synthetic.', questions: routeQuestions },
        {
          body: success(
            '{"route":{"type":"choice","choice":"bug","probabilities":{"billing":0.33,"bug":0.33,"other":0.33}}}'
          )
        }
      )

      expect(result.answers.route).toEqual({
        type: 'choice',
        choice: 'bug',
        probabilities: { billing: 0.33, bug: 0.33, other: 0.33 }
      })
    })
  )

  it.effect('prefers confidence on the answer over provider metadata', () =>
    Effect.gen(function* () {
      const result = yield* runClassify(
        { state: 'Synthetic.', questions: urgencyQuestions },
        {
          body: success(
            '{"urgency":{"type":"score","score":1,"probabilities":{"1":0.9},"confidence":0.7}}',
            ',"typesafe":{"confidence":{"urgency":0.2}}'
          )
        }
      )

      expect(result.answers.urgency).toMatchObject({ confidence: 0.7 })
    })
  )

  it.effect('maps the Gateway cost to usage.costUsd and fallback headers to metadata', () =>
    Effect.gen(function* () {
      const result = yield* runClassify(
        { state: 'Synthetic.', questions: approvalQuestions },
        {
          body: success('{"approves":{"type":"boolean","probability":0.61}}'),
          headers: {
            'x-ai-gateway-evaluation-fallback-used': 'true',
            'x-ai-gateway-evaluation-fallback-model': 'openai/gpt-4.1-nano',
            'x-unrelated': 'dropped'
          }
        }
      )

      expect(result.usage).toEqual(billedUsage)
      expect(result.providerMetadata).toEqual({
        gateway: { cost: '0.00000168' },
        evaluationFallbackHeaders: {
          'x-ai-gateway-evaluation-fallback-model': 'openai/gpt-4.1-nano',
          'x-ai-gateway-evaluation-fallback-used': 'true'
        }
      })
    })
  )

  it.effect('omits costUsd when the cost is missing or unreadable, and usage when absent', () =>
    Effect.gen(function* () {
      for (const cost of ['', '"free"', '"-1"', 'null']) {
        const result = yield* runClassify(
          { state: 'Synthetic.', questions: approvalQuestions },
          {
            body: `{"model":"typesafe-ai/jev","answers":{"approves":{"type":"boolean","probability":0.5}},"usage":{"inputTokens":3,"outputTokens":0}${cost === '' ? '' : `,"providerMetadata":{"gateway":{"cost":${cost}}}`}}`
          }
        )

        expect(result.usage, cost).toEqual({ inputTokens: 3, outputTokens: 0 })
      }

      const numeric = yield* runClassify(
        { state: 'Synthetic.', questions: approvalQuestions },
        {
          body: '{"model":"typesafe-ai/jev","answers":{"approves":{"type":"boolean","probability":0.5}},"usage":{"inputTokens":3,"outputTokens":0},"providerMetadata":{"gateway":{"cost":0.25}}}'
        }
      )

      expect(numeric.usage).toEqual({ inputTokens: 3, outputTokens: 0, costUsd: 0.25 })

      const unbilled = yield* runClassify(
        { state: 'Synthetic.', questions: approvalQuestions },
        { body: '{"answers":{"approves":{"type":"boolean","probability":0.5}}}' }
      )

      expect(unbilled).toEqual({
        model: vercelAiGatewayClassifierDefaultModel,
        answers: { approves: { type: 'boolean', probability: 0.5 } }
      })
    })
  )

  const invalidAnswer = (answers: string, questions: ClassificationRequest['questions']) =>
    Effect.flip(runClassify({ state: 'Synthetic.', questions }, { body: success(answers) }))

  it.effect(
    'fails a missing answer, a type mismatch, or a non-finite probability, keeping usage',
    () =>
      Effect.gen(function* () {
        const missing = yield* invalidAnswer('{}', approvalQuestions)

        expect(missing).toBeInstanceOf(ClassificationResponseInvalid)
        expect(missing).toMatchObject({
          reason: 'missing_answer',
          questionId: 'approves',
          provider: 'vercel_ai_gateway',
          usage: billedUsage
        })

        expect(
          yield* invalidAnswer(
            '{"approves":{"type":"choice","choice":"billing","probabilities":{}}}',
            approvalQuestions
          )
        ).toMatchObject({ reason: 'type_mismatch', questionId: 'approves', usage: billedUsage })

        // `1e999` is valid JSON syntax that parses to Infinity.
        expect(
          yield* invalidAnswer(
            '{"approves":{"type":"boolean","probability":1e999}}',
            approvalQuestions
          )
        ).toMatchObject({
          reason: 'invalid_probability',
          questionId: 'approves',
          usage: billedUsage
        })

        expect(
          yield* invalidAnswer(
            '{"route":{"type":"choice","choice":"refunds","probabilities":{"refunds":1}}}',
            routeQuestions
          )
        ).toMatchObject({ reason: 'invalid_choice', questionId: 'route', usage: billedUsage })

        expect(
          yield* invalidAnswer(
            '{"approves":{"type":"boolean","probability":0.5},"extra":{"type":"boolean","probability":0.5}}',
            approvalQuestions
          )
        ).toMatchObject({ reason: 'unexpected_answer', questionId: 'extra', usage: billedUsage })
      })
  )

  it.effect('fails a malformed body as malformed_response, keeping usage when readable', () =>
    Effect.gen(function* () {
      const notJson = yield* Effect.flip(
        runClassify({ state: 'Synthetic.', questions: approvalQuestions }, { body: 'not json' })
      )

      expect(notJson).toBeInstanceOf(ClassificationResponseInvalid)
      expect(notJson).toMatchObject({ reason: 'malformed_response' })
      expect(notJson).not.toHaveProperty('usage', expect.anything())

      const noAnswers = yield* Effect.flip(
        runClassify(
          { state: 'Synthetic.', questions: approvalQuestions },
          { body: '{"usage":{"inputTokens":9,"outputTokens":0},"answers":[]}' }
        )
      )

      expect(noAnswers).toMatchObject({
        reason: 'malformed_response',
        usage: { inputTokens: 9, outputTokens: 0 }
      })
    })
  )
})

describe('Vercel AI Gateway classifier errors', () => {
  const statusFailure = (answer: Answer) =>
    Effect.flip(
      runClassify({ state: 'Synthetic.', questions: approvalQuestions }, answer, [], {
        ...config,
        maxRetries: 0
      })
    )

  it.effect('maps the Gateway error envelope to a sanitized typed error', () =>
    Effect.gen(function* () {
      const error = yield* statusFailure({
        status: 404,
        body: `{"message":"Model not found; synthetic detail ${secret}","error_type":"model_not_found"}`
      })

      expect(error).toBeInstanceOf(ClassificationProviderError)
      expect(error).toMatchObject({
        message: 'Vercel AI Gateway returned 404',
        retryable: false,
        provider: {
          provider: 'vercel_ai_gateway',
          kind: 'unknown',
          status: 404,
          providerCode: 'model_not_found'
        }
      })
      expect(textOf(error)).not.toContain(secret)
      expect(error.message).not.toContain('synthetic detail')
    })
  )

  it.effect('reads the OpenAI-compatible envelope and classifies auth and rate limits', () =>
    Effect.gen(function* () {
      expect(
        yield* statusFailure({
          status: 401,
          body: '{"error":{"message":"Synthetic: invalid key","type":"authentication_error"}}'
        })
      ).toMatchObject({
        retryable: false,
        provider: { kind: 'auth', status: 401, providerCode: 'authentication_error' }
      })

      expect(
        yield* statusFailure({
          status: 429,
          body: '{"message":"Synthetic: slow down","error_type":"rate_limit_exceeded"}',
          headers: { 'retry-after': '2' }
        })
      ).toMatchObject({
        message: 'Vercel AI Gateway returned 429',
        retryable: true,
        provider: { kind: 'rate_limit', status: 429, retryAfterMs: 2000 }
      })

      expect(yield* statusFailure({ status: 503, body: 'upstream unavailable' })).toMatchObject({
        message: 'Vercel AI Gateway returned 503',
        retryable: true
      })
    })
  )

  it.effect('maps a transport failure to a retryable network error without details', () =>
    Effect.gen(function* () {
      const failing = Layer.succeed(
        HttpClient.HttpClient,
        HttpClient.make(request =>
          Effect.fail(
            new HttpClientError.HttpClientError({
              reason: new HttpClientError.TransportError({
                request,
                description: `synthetic socket failure ${secret}`
              })
            })
          )
        )
      )

      const error = yield* Effect.flip(
        Effect.gen(function* () {
          const model = yield* ClassifierModel

          return yield* model.classify({ state: 'Synthetic.', questions: approvalQuestions })
        }).pipe(
          Effect.provide(makeVercelAiGatewayClassifierLayer({ ...config, maxRetries: 0 })),
          Effect.provide(failing)
        )
      )

      expect(error).toMatchObject({
        _tag: 'ClassificationProviderError',
        message: 'Vercel AI Gateway classification request failed',
        retryable: true,
        provider: { kind: 'network' }
      })
      expect(textOf(error)).not.toContain(secret)
    })
  )
})

describe('Vercel AI Gateway classifier retries', () => {
  const okBody = success('{"approves":{"type":"boolean","probability":0.8}}')

  type Step = Answer | 'transport'

  /** Answers each request with the next step (the last step repeats), counting requests. */
  const scripted = (steps: ReadonlyArray<Step>, sent: { count: number }) =>
    Layer.succeed(
      HttpClient.HttpClient,
      HttpClient.make(request =>
        Effect.suspend(() => {
          const step = steps[Math.min(sent.count, steps.length - 1)] ?? 'transport'

          sent.count++

          if (step === 'transport') {
            return Effect.fail(
              new HttpClientError.HttpClientError({
                reason: new HttpClientError.TransportError({ request, description: 'synthetic' })
              })
            )
          }

          return Effect.succeed(
            HttpClientResponse.fromWeb(
              request,
              new Response(step.body, {
                status: step.status ?? 200,
                headers: { 'content-type': 'application/json', ...step.headers }
              })
            )
          )
        })
      )
    )

  const classifyScripted = (
    steps: ReadonlyArray<Step>,
    sent: { count: number },
    classifierConfig: VercelAiGatewayClassifierConfig = config
  ) =>
    Effect.gen(function* () {
      const model = yield* ClassifierModel

      return yield* model.classify({ state: 'Synthetic.', questions: approvalQuestions })
    }).pipe(
      Effect.provide(makeVercelAiGatewayClassifierLayer(classifierConfig)),
      Effect.provide(scripted(steps, sent))
    )

  const rateLimited = (headers: Readonly<Record<string, string>>): Answer => ({
    status: 429,
    body: '{"message":"Synthetic: slow down","error_type":"rate_limit_exceeded"}',
    headers
  })

  const unavailable: Answer = { status: 503, body: 'upstream unavailable' }

  it.effect('waits for Retry-After (delta-seconds) after a 429, then succeeds', () =>
    Effect.gen(function* () {
      const sent = { count: 0 }

      const fiber = yield* Effect.forkChild(
        classifyScripted([rateLimited({ 'retry-after': '2' }), { body: okBody }], sent)
      )

      yield* TestClock.adjust('1999 millis')
      expect(sent.count).toBe(1)

      yield* TestClock.adjust('1 millis')

      const result = yield* Fiber.join(fiber)

      expect(sent.count).toBe(2)
      expect(result.answers).toEqual({ approves: { type: 'boolean', probability: 0.8 } })
    })
  )

  it.effect('reads an HTTP-date Retry-After against the clock and caps it at 10 s', () =>
    Effect.gen(function* () {
      const sent = { count: 0 }
      const nowMs = yield* Clock.currentTimeMillis

      const fiber = yield* Effect.forkChild(
        classifyScripted(
          [
            rateLimited({ 'retry-after': new Date(nowMs + 3_000).toUTCString() }),
            rateLimited({ 'retry-after': '120' }),
            { body: okBody }
          ],
          sent
        )
      )

      yield* TestClock.adjust('2999 millis')
      expect(sent.count).toBe(1)
      yield* TestClock.adjust('1 millis')
      expect(sent.count).toBe(2)

      // 120 s is capped at 10 s.
      yield* TestClock.adjust('9999 millis')
      expect(sent.count).toBe(2)
      yield* TestClock.adjust('1 millis')

      yield* Fiber.join(fiber)
      expect(sent.count).toBe(3)
    })
  )

  it.effect('retries 503 twice with jittered backoff within 250 ms and 500 ms, then succeeds', () =>
    Effect.gen(function* () {
      const sent = { count: 0 }

      // Pin full jitter at its upper bound (249 ms, then 499 ms) so the timeline is deterministic;
      // with free jitter both retries can land inside the first 250 ms.
      const fiber = yield* Effect.forkChild(
        classifyScripted([unavailable, unavailable, { body: okBody }], sent).pipe(
          Effect.provideService(Random.Random, {
            nextDoubleUnsafe: () => 0.999,
            nextIntUnsafe: () => 0
          })
        )
      )

      yield* TestClock.adjust('248 millis')
      expect(sent.count).toBe(1)
      yield* TestClock.adjust('2 millis')
      expect(sent.count).toBe(2)
      yield* TestClock.adjust('497 millis')
      expect(sent.count).toBe(2)
      yield* TestClock.adjust('3 millis')

      const result = yield* Fiber.join(fiber)

      expect(sent.count).toBe(3)
      expect(result.usage).toEqual(billedUsage)
    })
  )

  it.effect('retries 408 and transport failures', () =>
    Effect.gen(function* () {
      const sent = { count: 0 }

      const fiber = yield* Effect.forkChild(
        classifyScripted([{ status: 408, body: '' }, 'transport', { body: okBody }], sent)
      )

      yield* TestClock.adjust('1 second')
      yield* Fiber.join(fiber)
      expect(sent.count).toBe(3)
    })
  )

  it.effect('never retries other 4xx statuses or undecodable responses', () =>
    Effect.gen(function* () {
      for (const status of [400, 401, 404, 413, 422]) {
        const sent = { count: 0 }

        const error = yield* Effect.flip(
          classifyScripted([{ status, body: '{"message":"Synthetic"}' }, { body: okBody }], sent)
        )

        expect(error, String(status)).toMatchObject({
          _tag: 'ClassificationProviderError',
          provider: { status }
        })
        expect(sent.count, String(status)).toBe(1)
      }

      const sent = { count: 0 }

      const malformed = yield* Effect.flip(
        classifyScripted([{ body: 'not json' }, { body: okBody }], sent)
      )

      expect(malformed).toBeInstanceOf(ClassificationResponseInvalid)
      expect(sent.count).toBe(1)
    })
  )

  it.effect('fails with the last typed error after exhausting retries', () =>
    Effect.gen(function* () {
      const sent = { count: 0 }
      const fiber = yield* Effect.forkChild(Effect.flip(classifyScripted([unavailable], sent)))

      yield* TestClock.adjust('1 second')

      const error = yield* Fiber.join(fiber)

      expect(sent.count).toBe(3)
      expect(error).toBeInstanceOf(ClassificationProviderError)
      expect(error).toMatchObject({
        message: 'Vercel AI Gateway returned 503',
        retryable: true,
        provider: { provider: 'vercel_ai_gateway', kind: 'server_error', status: 503 }
      })

      // `maxRetries` is configurable.
      const once = { count: 0 }

      const configured = yield* Effect.forkChild(
        Effect.flip(classifyScripted([unavailable], once, { ...config, maxRetries: 1 }))
      )

      yield* TestClock.adjust('1 second')
      yield* Fiber.join(configured)
      expect(once.count).toBe(2)
      expect(vercelAiGatewayClassifierDefaultMaxRetries).toBe(2)
    })
  )

  it.effect('stops retrying when interrupted during backoff', () =>
    Effect.gen(function* () {
      const sent = { count: 0 }

      const fiber = yield* Effect.forkChild(
        classifyScripted([rateLimited({ 'retry-after': '5' })], sent)
      )

      yield* TestClock.adjust('1 second')
      expect(sent.count).toBe(1)

      const exit = yield* Fiber.interrupt(fiber).pipe(Effect.andThen(Fiber.await(fiber)))

      yield* TestClock.adjust('1 minute')
      expect(Exit.hasInterrupts(exit)).toBe(true)
      expect(sent.count).toBe(1)
    })
  )
})

describe('Vercel AI Gateway classifier environment layer', () => {
  const resolve = (env: Record<string, string>) =>
    Effect.gen(function* () {
      return yield* ClassifierModel
    }).pipe(
      Effect.provide(VercelAiGatewayClassifierLayer),
      Effect.provide(ConfigProvider.layer(ConfigProvider.fromEnvRecord(env)))
    )

  it.effect('reads AI_GATEWAY_API_KEY, falling back to VERCEL_OIDC_TOKEN', () =>
    Effect.gen(function* () {
      const model = yield* resolve({ VERCEL_OIDC_TOKEN: 'synthetic-oidc-token' })

      expect(model.classify).toBeTypeOf('function')

      const error = yield* Effect.flip(resolve({}))

      expect(error).toMatchObject({
        _tag: 'ClassificationProviderError',
        message: 'Vercel AI Gateway environment configuration missing',
        retryable: false,
        provider: { kind: 'auth' }
      })
    })
  )
})

describe('Vercel AI Gateway classifier fixtures', () => {
  it.effect('decode, carry no secrets, and stay synthetic and unverified', () =>
    Effect.gen(function* () {
      expect(vercelAiGatewayClassifierConformanceFixtures.map(fixture => fixture.id)).toEqual([
        vercelAiGatewayClassifierBooleanFixture.id,
        vercelAiGatewayClassifierChoiceFixture.id,
        vercelAiGatewayClassifierScoreFixture.id,
        'vercel-ai-gateway.classify.error-envelope.synthetic'
      ])

      for (const fixture of vercelAiGatewayClassifierConformanceFixtures) {
        expect(yield* decodeWireFixture(fixture)).toEqual(fixture)
        expect(scanFixtureForSecrets(fixture)).toEqual([])
        expect(fixture).toMatchObject({
          evidence: 'unverified',
          account: 'synthetic',
          endpoint: vercelAiGatewayEvaluateUrl
        })
      }
    })
  )
})
