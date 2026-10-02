import { Effect, Layer, Predicate, Redacted, Ref } from 'effect'
import { HttpClient } from 'effect/unstable/http'
import { describe, expect, it } from '@effect/vitest'
import type { ConformanceCase } from '@yolk-sdk/conformance/case'
import type { WireFixture } from '@yolk-sdk/conformance/fixture'
import {
  makeReplayHttpClient,
  ReplayHttpClient,
  type ReplayLedgerApi
} from '@yolk-sdk/conformance/replay'
import {
  conformanceReportFailed,
  formatConformanceReport,
  runConformance
} from '@yolk-sdk/conformance/runner'
import { vercelAiGatewayEvaluateUrl } from '../../../src/providers/vercel/ai-gateway-classifier.ts'
import {
  VercelAiGatewayClassifierConformanceConfig,
  vercelAiGatewayClassifierBooleanCase,
  vercelAiGatewayClassifierBooleanFixture,
  vercelAiGatewayClassifierChoiceCase,
  vercelAiGatewayClassifierChoiceFixture,
  vercelAiGatewayClassifierConformanceCases,
  vercelAiGatewayClassifierConformanceDefaultModels,
  vercelAiGatewayClassifierConformanceFixtures,
  vercelAiGatewayClassifierErrorEnvelopeCase,
  vercelAiGatewayClassifierErrorEnvelopeFixture,
  vercelAiGatewayClassifierScoreCase,
  vercelAiGatewayClassifierScoreFixture,
  vercelAiGatewayConformanceCases,
  vercelAiGatewayConformanceFixtures,
  type VercelAiGatewayClassifierConformanceCase,
  type VercelAiGatewayClassifierConformanceSettings
} from '../../../src/providers/vercel/conformance/index.ts'

const now = new Date('2026-10-02T12:00:00.000Z')

// Mutable JSON, for editing parsed response bodies in drills.
type Json = null | boolean | number | string | Array<Json> | JsonRecord

type JsonRecord = { [key: string]: Json }

const isRecord = (value: unknown): value is JsonRecord =>
  Predicate.isObject(value) && !Array.isArray(value)

const parseRecord = (text: string): JsonRecord => {
  const parsed: unknown = JSON.parse(text)

  return isRecord(parsed) ? parsed : expect.fail('expected a JSON object')
}

const requestBody = (fixture: WireFixture): JsonRecord => {
  const body: unknown = fixture.exchanges[0].request.body

  return isRecord(body) ? body : expect.fail(`${fixture.id} has no JSON request body`)
}

const recordedModel = (fixture: WireFixture): string => {
  const model = requestBody(fixture).model

  return Predicate.isString(model) ? model : expect.fail(`${fixture.id} has no model`)
}

const settings: VercelAiGatewayClassifierConformanceSettings = {
  apiKey: Redacted.make('synthetic-gateway-key'),
  models: {
    classifier: recordedModel(vercelAiGatewayClassifierBooleanFixture),
    invalid: recordedModel(vercelAiGatewayClassifierErrorEnvelopeFixture)
  }
}

const configLayer = Layer.succeed(VercelAiGatewayClassifierConformanceConfig, settings)

const fixturesFor = (
  testCase: Pick<ConformanceCase<unknown, unknown>, 'fixtures'>,
  fixtures: ReadonlyArray<WireFixture> = vercelAiGatewayClassifierConformanceFixtures
) => fixtures.filter(fixture => testCase.fixtures.includes(fixture.id))

const replayCaseLayer = (testCase: VercelAiGatewayClassifierConformanceCase) =>
  Layer.mergeAll(ReplayHttpClient.layer(fixturesFor(testCase)), configLayer)

const expectedWarnings = (testCase: VercelAiGatewayClassifierConformanceCase) => [
  { kind: 'unverified-case' },
  ...fixturesFor(testCase).map(fixture => ({ kind: 'unverified-fixture', fixtureId: fixture.id }))
]

describe('Vercel AI Gateway classifier conformance cases', () => {
  it('are read-only, unobserved, and backed by one unverified synthetic fixture each', () => {
    expect(vercelAiGatewayClassifierConformanceCases.map(testCase => testCase.id)).toEqual([
      'vercel-ai-gateway.classify.boolean',
      'vercel-ai-gateway.classify.choice',
      'vercel-ai-gateway.classify.score',
      'vercel-ai-gateway.classify.error-envelope'
    ])
    expect(vercelAiGatewayClassifierConformanceCases.map(testCase => testCase.id)).toEqual(
      vercelAiGatewayClassifierConformanceFixtures.map(fixture => fixture.caseId)
    )

    for (const testCase of vercelAiGatewayClassifierConformanceCases) {
      expect(testCase.safety).toBe('read')
      expect(testCase.observed).toBeUndefined()
      expect(fixturesFor(testCase).map(fixture => fixture.evidence)).toEqual(['unverified'])
    }
  })

  it('stay apart from the chat cases and fixtures', () => {
    const chatIds = vercelAiGatewayConformanceCases.map(testCase => testCase.id)

    expect(chatIds).toHaveLength(4)
    expect(vercelAiGatewayConformanceFixtures).toHaveLength(4)
    expect(
      vercelAiGatewayClassifierConformanceCases.some(testCase => chatIds.includes(testCase.id))
    ).toBe(false)
  })

  it('default to the model ids the committed fixtures recorded', () => {
    expect(vercelAiGatewayClassifierConformanceDefaultModels).toEqual(settings.models)

    for (const fixture of [
      vercelAiGatewayClassifierChoiceFixture,
      vercelAiGatewayClassifierScoreFixture
    ]) {
      expect(recordedModel(fixture)).toBe(settings.models.classifier)
    }
  })

  it.effect('all pass against the replayed fixtures with unverified warnings', () =>
    Effect.gen(function* () {
      const report = yield* runConformance(vercelAiGatewayClassifierConformanceCases, {
        target: { kind: 'replay' },
        now,
        fixtures: vercelAiGatewayClassifierConformanceFixtures,
        layer: replayCaseLayer
      })

      expect(report.summary).toEqual({ passed: 4, failed: 0, skipped: 0 })
      expect(conformanceReportFailed(report)).toBe(false)
      expect(report.results.map(result => result.warnings)).toEqual(
        vercelAiGatewayClassifierConformanceCases.map(expectedWarnings)
      )
      expect(formatConformanceReport(report).split('\n').at(-1)).toBe(
        `4 passed, 0 failed, 0 skipped; target replay; started ${now.toISOString()}`
      )
    })
  )

  it.effect('run on read-safe live targets with case-level warnings only', () =>
    Effect.gen(function* () {
      const report = yield* runConformance(vercelAiGatewayClassifierConformanceCases, {
        target: { kind: 'live', account: 'synthetic' },
        now,
        fixtures: vercelAiGatewayClassifierConformanceFixtures,
        layer: replayCaseLayer
      })

      expect(report.summary).toEqual({ passed: 4, failed: 0, skipped: 0 })
      expect(report.results.map(result => result.warnings)).toEqual(
        vercelAiGatewayClassifierConformanceCases.map(() => [{ kind: 'unverified-case' }])
      )
    })
  )

  it.effect('send the recorded requests (asserted through the replay ledger)', () =>
    Effect.gen(function* () {
      const ledgers = yield* Ref.make(new Map<string, ReplayLedgerApi>())

      const report = yield* runConformance(vercelAiGatewayClassifierConformanceCases, {
        target: { kind: 'replay' },
        now,
        layer: testCase =>
          Layer.mergeAll(
            Layer.unwrap(
              makeReplayHttpClient(fixturesFor(testCase)).pipe(
                Effect.tap(({ ledger }) =>
                  Ref.update(ledgers, current => new Map(current).set(testCase.id, ledger))
                ),
                Effect.map(({ client }) => Layer.succeed(HttpClient.HttpClient, client))
              )
            ),
            configLayer
          )
      })

      expect(report.summary.passed).toBe(4)

      const byCase = yield* Ref.get(ledgers)

      for (const testCase of vercelAiGatewayClassifierConformanceCases) {
        const ledger = byCase.get(testCase.id) ?? expect.fail(`no ledger for ${testCase.id}`)
        const [fixture] = fixturesFor(testCase)

        expect(yield* ledger.remaining).toEqual([])

        const entries = yield* ledger.entries

        expect(entries).toHaveLength(1)
        expect(entries[0]).toMatchObject({
          method: 'POST',
          url: vercelAiGatewayEvaluateUrl,
          match: { outcome: 'matched' },
          headers: { authorization: '<redacted>', accept: 'application/json' }
        })
        expect(entries[0]?.bodyJson).toEqual(fixture?.exchanges[0].request.body)
        expect(JSON.stringify(entries)).not.toContain('synthetic-gateway-key')
      }
    })
  )
})

// Disagreement drills: replay a fixture whose response contradicts a claim and check the matching
// case fails. Bodies are edited structurally (parsed JSON), never by matching recorded text.

const responseText = (fixture: WireFixture): string => {
  const response = fixture.exchanges[0].response

  return 'body' in response && Predicate.isString(response.body)
    ? response.body
    : expect.fail(`${fixture.id} has no text body`)
}

const withResponse = (
  fixture: WireFixture,
  suffix: string,
  edit: (body: JsonRecord) => void,
  status = fixture.exchanges[0].response.status
): WireFixture => {
  const body = parseRecord(responseText(fixture))

  edit(body)

  return {
    ...fixture,
    id: `${fixture.id}.${suffix}`,
    exchanges: [
      {
        request: fixture.exchanges[0].request,
        response: {
          status,
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body)
        }
      }
    ]
  }
}

const answerOf = (body: JsonRecord, questionId: string): JsonRecord => {
  const answer = isRecord(body.answers) ? body.answers[questionId] : undefined

  return isRecord(answer) ? answer : expect.fail(`no answer ${questionId}`)
}

const recordOf = (value: Json | undefined): JsonRecord =>
  Predicate.isObject(value) && !Array.isArray(value) ? value : expect.fail('expected a JSON object')

const drill = (testCase: VercelAiGatewayClassifierConformanceCase, fixture: WireFixture) =>
  Effect.gen(function* () {
    const report = yield* runConformance([testCase], {
      target: { kind: 'replay' },
      now,
      layer: () => Layer.mergeAll(ReplayHttpClient.layer([fixture]), configLayer)
    })

    const [result] = report.results

    expect(result?.status).toBe('failed')

    return result?.failure
  })

const mismatch = (message: string) => ({ kind: 'failure', tag: 'ConformanceMismatch', message })

describe('Vercel AI Gateway classifier conformance disagreement drills', () => {
  it.effect('fails the boolean case without a Gateway cost or usage', () =>
    Effect.gen(function* () {
      expect(
        yield* drill(
          vercelAiGatewayClassifierBooleanCase,
          withResponse(vercelAiGatewayClassifierBooleanFixture, 'costless', body => {
            delete body.providerMetadata
          })
        )
      ).toEqual(mismatch('expected a non-negative cost in US dollars'))

      expect(
        yield* drill(
          vercelAiGatewayClassifierBooleanCase,
          withResponse(vercelAiGatewayClassifierBooleanFixture, 'unbilled', body => {
            delete body.usage
          })
        )
      ).toEqual(mismatch('expected token usage with input tokens'))
    })
  )

  // `1e999` cannot be produced by `JSON.stringify`, so this drill writes the raw body text.
  it.effect('fails the boolean case with the provider error for a non-finite probability', () =>
    Effect.gen(function* () {
      const body = parseRecord(responseText(vercelAiGatewayClassifierBooleanFixture))

      answerOf(body, 'approves').probability = 0.5

      const infinite: WireFixture = {
        ...vercelAiGatewayClassifierBooleanFixture,
        id: `${vercelAiGatewayClassifierBooleanFixture.id}.infinite`,
        exchanges: [
          {
            request: vercelAiGatewayClassifierBooleanFixture.exchanges[0].request,
            response: {
              status: 200,
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify(body).replace('"probability":0.5', '"probability":1e999')
            }
          }
        ]
      }

      expect(yield* drill(vercelAiGatewayClassifierBooleanCase, infinite)).toEqual({
        kind: 'failure',
        tag: 'ClassificationResponseInvalid',
        message:
          'Vercel AI Gateway classification answer for question "approves" is invalid: invalid_probability'
      })
    })
  )

  it.effect('fails the choice case for probabilities of unoffered options or no confidence', () =>
    Effect.gen(function* () {
      expect(
        yield* drill(
          vercelAiGatewayClassifierChoiceCase,
          withResponse(vercelAiGatewayClassifierChoiceFixture, 'unoffered', body => {
            recordOf(answerOf(body, 'route').probabilities).refunds = 0.01
          })
        )
      ).toEqual(mismatch('expected probabilities keyed by offered options'))

      expect(
        yield* drill(
          vercelAiGatewayClassifierChoiceCase,
          withResponse(vercelAiGatewayClassifierChoiceFixture, 'no-confidence', body => {
            delete recordOf(body.providerMetadata).typesafe
            delete answerOf(body, 'route').confidence
          })
        )
      ).toEqual(mismatch('expected a confidence in [0, 1]'))
    })
  )

  it.effect('passes the choice case with confidence on the answer instead of metadata', () =>
    Effect.gen(function* () {
      const moved = withResponse(
        vercelAiGatewayClassifierChoiceFixture,
        'answer-confidence',
        body => {
          delete recordOf(body.providerMetadata).typesafe
          answerOf(body, 'route').confidence = 0.88
        }
      )

      const report = yield* runConformance([vercelAiGatewayClassifierChoiceCase], {
        target: { kind: 'replay' },
        now,
        layer: () => Layer.mergeAll(ReplayHttpClient.layer([moved]), configLayer)
      })

      expect(report.results[0]?.status).toBe('passed')
    })
  )

  it.effect('passes the score case for a fractional, probability-weighted score', () =>
    Effect.gen(function* () {
      const report = yield* runConformance([vercelAiGatewayClassifierScoreCase], {
        target: { kind: 'replay' },
        now,
        layer: () =>
          Layer.mergeAll(
            ReplayHttpClient.layer([
              withResponse(vercelAiGatewayClassifierScoreFixture, 'fractional', body => {
                answerOf(body, 'urgency').score = 2.86
              })
            ]),
            configLayer
          )
      })

      expect(report.results[0]?.status).toBe('passed')
    })
  )

  it.effect(
    'fails the score case for an out-of-range level or more probabilities than levels',
    () =>
      Effect.gen(function* () {
        expect(
          yield* drill(
            vercelAiGatewayClassifierScoreCase,
            withResponse(vercelAiGatewayClassifierScoreFixture, 'out-of-range', body => {
              answerOf(body, 'urgency').score = 3.5
            })
          )
        ).toEqual(mismatch('expected a score within the zero-based level range'))

        expect(
          yield* drill(
            vercelAiGatewayClassifierScoreCase,
            withResponse(vercelAiGatewayClassifierScoreFixture, 'extra-level', body => {
              recordOf(answerOf(body, 'urgency').probabilities)['4'] = 0
            })
          )
        ).toEqual(mismatch('expected at most one probability in [0, 1] per level'))
      })
  )

  it.effect('fails the error case for an auth failure or a missing Gateway error type', () =>
    Effect.gen(function* () {
      expect(
        yield* drill(
          vercelAiGatewayClassifierErrorEnvelopeCase,
          withResponse(vercelAiGatewayClassifierErrorEnvelopeFixture, 'status-401', () => {}, 401)
        )
      ).toEqual(mismatch('expected a model rejection, not an authentication or permission failure'))

      expect(
        yield* drill(
          vercelAiGatewayClassifierErrorEnvelopeCase,
          withResponse(vercelAiGatewayClassifierErrorEnvelopeFixture, 'typeless', body => {
            delete body.error_type
          })
        )
      ).toEqual(mismatch('expected the Gateway error type to be preserved'))

      expect(
        yield* drill(
          vercelAiGatewayClassifierErrorEnvelopeCase,
          withResponse(vercelAiGatewayClassifierErrorEnvelopeFixture, 'status-402', () => {}, 402)
        )
      ).toEqual(mismatch('expected a 400, 404, or 422 model-rejection status'))
    })
  )

  it.effect('fails the error case when the unknown model is answered', () =>
    Effect.gen(function* () {
      const answered: WireFixture = {
        ...vercelAiGatewayClassifierErrorEnvelopeFixture,
        id: `${vercelAiGatewayClassifierErrorEnvelopeFixture.id}.answered`,
        exchanges: [
          {
            request: vercelAiGatewayClassifierErrorEnvelopeFixture.exchanges[0].request,
            response: vercelAiGatewayClassifierBooleanFixture.exchanges[0].response
          }
        ]
      }

      expect(yield* drill(vercelAiGatewayClassifierErrorEnvelopeCase, answered)).toEqual(
        mismatch('expected an error envelope, the request succeeded')
      )
    })
  )
})
