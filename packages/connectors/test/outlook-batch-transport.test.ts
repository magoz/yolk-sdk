import { describe, expect, it } from '@effect/vitest'
import { Effect, Layer, Predicate } from 'effect'
import * as Schema from 'effect/Schema'
import {
  ConnectorHttpClient,
  ConnectorHttpResponse,
  CredentialResolver,
  makeCredentialBinding,
  makeIntegration,
  OAuthCredential,
  type ConnectorHttpRequest
} from '@yolk-sdk/connectors'
import {
  MicrosoftConnector,
  outlookBatchModifyCategoriesAction,
  outlookBatchSetReadAction
} from '@yolk-sdk/connectors/microsoft'
import { microsoftOAuthSlotId } from '@yolk-sdk/connectors/microsoft'

const integration = makeIntegration({
  connectorId: 'microsoft',
  credentialBindings: [
    makeCredentialBinding({ slotId: microsoftOAuthSlotId, credentialRef: 'microsoft-account' })
  ]
})

type Subrequest = {
  readonly id: string
  readonly method: string
  readonly url: string
  readonly headers: Record<string, string>
  readonly body?: unknown
}

const BatchEnvelopeWire = Schema.Struct({
  requests: Schema.Array(
    Schema.Struct({
      id: Schema.String,
      method: Schema.String,
      url: Schema.String,
      headers: Schema.Record(Schema.String, Schema.String),
      body: Schema.optional(Schema.Unknown)
    })
  )
})

const makeTransportHost = (
  respond: (subs: ReadonlyArray<Subrequest>) => { status: number; body: string }
) => {
  const requests: Array<ConnectorHttpRequest> = []
  const seen: Array<typeof BatchEnvelopeWire.Type> = []

  const layer = Layer.mergeAll(
    Layer.succeed(CredentialResolver, {
      resolve: () =>
        Effect.succeed(
          OAuthCredential.make({
            provider: 'microsoft',
            accessToken: 'token',
            expiresAt: 4_000_000_000_000
          })
        )
    }),
    Layer.succeed(ConnectorHttpClient, {
      request: (request: ConnectorHttpRequest) =>
        Effect.gen(function* () {
          requests.push(request)

          const parsed = yield* Schema.decodeUnknownEffect(BatchEnvelopeWire)(
            JSON.parse(request.body ?? '{}')
          ).pipe(Effect.orElseSucceed(() => ({ requests: [] })))

          seen.push(parsed)
          const { status, body } = respond(parsed.requests)

          return ConnectorHttpResponse.make({ status, headers: {}, body })
        })
    })
  )

  const envelopes = () => seen

  return { layer, requests, envelopes }
}

const successEnvelope = (subs: ReadonlyArray<Subrequest>) => ({
  status: 200,
  body: JSON.stringify({
    responses: subs.map(sub => ({
      id: sub.id,
      status: 200,
      body: { id: decodeURIComponent(sub.url.split('/').pop() ?? '') }
    }))
  })
})

const ids = (count: number) => Array.from({ length: count }, (_, index) => `id-${index}`)

describe('Outlook Graph batch transport', () => {
  it.effect('chunks 20/21/100 IDs into sequential envelopes of at most 20', () =>
    Effect.gen(function* () {
      for (const [count, envelopes] of [
        [1, 1],
        [20, 1],
        [21, 2],
        [100, 5]
      ] as const) {
        const host = makeTransportHost(successEnvelope)

        const result = yield* outlookBatchSetReadAction
          .executeTyped({ integration, input: { messageIds: ids(count), isRead: true } })
          .pipe(Effect.provide(host.layer))

        expect(result).toMatchObject({
          value: {
            summary: {
              requested: count,
              succeeded: count,
              failed: 0,
              unknown: 0,
              notAttempted: 0
            }
          }
        })
        expect(host.requests).toHaveLength(envelopes)

        for (const envelope of host.envelopes()) {
          expect(envelope.requests.length).toBeLessThanOrEqual(20)
          expect(new Set(envelope.requests.map(sub => sub.id)).size).toBe(envelope.requests.length)
        }

        if (Predicate.isTagged(result, 'Success')) {
          expect(result.value.results.map(item => item.messageId)).toEqual(ids(count))
        }
      }
    })
  )

  it.effect('matches reversed responses by correlation ID and preserves input order', () =>
    Effect.gen(function* () {
      const host = makeTransportHost(subs => ({
        status: 200,
        body: JSON.stringify({
          responses: [...subs].reverse().map(sub => ({
            id: sub.id,
            status: 200,
            body: { id: decodeURIComponent(sub.url.split('/').pop() ?? '') }
          }))
        })
      }))

      const result = yield* outlookBatchSetReadAction
        .execute({ integration, input: { messageIds: ['a', 'b', 'c'], isRead: true } })
        .pipe(Effect.provide(host.layer))

      expect(result).toMatchObject({
        value: {
          results: [
            { messageId: 'a', status: 'succeeded' },
            { messageId: 'b', status: 'succeeded' },
            { messageId: 'c', status: 'succeeded' }
          ],
          summary: { requested: 3, succeeded: 3, failed: 0, unknown: 0, notAttempted: 0 }
        }
      })
    })
  )

  it.effect('marks missing responses unknown and stops later chunks', () =>
    Effect.gen(function* () {
      const host = makeTransportHost(subs => ({
        status: 200,
        body: JSON.stringify({
          responses: subs.slice(1).map(sub => ({
            id: sub.id,
            status: 200,
            body: { id: decodeURIComponent(sub.url.split('/').pop() ?? '') }
          }))
        })
      }))

      const result = yield* outlookBatchSetReadAction
        .executeTyped({ integration, input: { messageIds: [...ids(21)], isRead: true } })
        .pipe(Effect.provide(host.layer))

      expect(result).toMatchObject({
        value: {
          summary: { requested: 21, succeeded: 19, failed: 0, unknown: 1, notAttempted: 1 }
        }
      })

      if (Predicate.isTagged(result, 'Success')) {
        expect(result.value.results.at(0)).toMatchObject({
          status: 'unknown',
          code: 'invalid_batch_response'
        })
        expect(result.value.results.at(-1)).toMatchObject({
          status: 'not_attempted',
          code: 'batch_stopped'
        })
      }

      expect(host.requests).toHaveLength(1)
    })
  )

  it.effect('isolates malformed keyed subresponses and stops later chunks', () =>
    Effect.gen(function* () {
      const host = makeTransportHost(subs => ({
        status: 200,
        body: JSON.stringify({
          responses: subs.map((sub, index) =>
            index === 1
              ? { id: sub.id, status: '200', body: { id: 'invalid-status' } }
              : {
                  id: sub.id,
                  status: 200,
                  body: { id: decodeURIComponent(sub.url.split('/').pop() ?? '') }
                }
          )
        })
      }))

      const result = yield* outlookBatchSetReadAction
        .executeTyped({ integration, input: { messageIds: ids(21), isRead: true } })
        .pipe(Effect.provide(host.layer))

      expect(result).toMatchObject({
        value: {
          summary: { requested: 21, succeeded: 19, failed: 0, unknown: 1, notAttempted: 1 }
        }
      })

      if (Predicate.isTagged(result, 'Success')) {
        expect(result.value.results.at(0)).toMatchObject({
          messageId: 'id-0',
          status: 'succeeded'
        })
        expect(result.value.results.at(1)).toMatchObject({
          messageId: 'id-1',
          status: 'unknown',
          code: 'invalid_batch_response'
        })
        expect(result.value.results.at(-1)).toMatchObject({
          messageId: 'id-20',
          status: 'not_attempted',
          code: 'batch_stopped'
        })
      }

      expect(host.requests).toHaveLength(1)
    })
  )

  it.effect('marks duplicate correlation IDs ambiguous without inventing outcomes', () =>
    Effect.gen(function* () {
      const host = makeTransportHost(subs => ({
        status: 200,
        body: JSON.stringify({
          responses: subs.flatMap(sub => [
            {
              id: sub.id,
              status: 200,
              body: { id: decodeURIComponent(sub.url.split('/').pop() ?? '') }
            },
            { id: sub.id, status: 200, body: { id: 'other' } }
          ])
        })
      }))

      const result = yield* outlookBatchSetReadAction
        .execute({ integration, input: { messageIds: ['a', 'b'], isRead: true } })
        .pipe(Effect.provide(host.layer))

      // Both duplicates were submitted in one envelope, so both stay unknown.
      expect(result).toMatchObject({
        value: {
          results: [
            { messageId: 'a', status: 'unknown', code: 'invalid_batch_response' },
            { messageId: 'b', status: 'unknown', code: 'invalid_batch_response' }
          ],
          summary: { requested: 2, succeeded: 0, failed: 0, unknown: 2, notAttempted: 0 }
        }
      })
    })
  )

  it.effect('preserves valid siblings but stops later chunks on foreign response IDs', () =>
    Effect.gen(function* () {
      const host = makeTransportHost(subs => ({
        status: 200,
        body: JSON.stringify({
          responses: [
            ...subs.map(sub => ({
              id: sub.id,
              status: 200,
              body: { id: decodeURIComponent(sub.url.split('/').pop() ?? '') }
            })),
            { id: 'foreign', status: 200, body: { id: 'foreign-message' } }
          ]
        })
      }))

      const result = yield* outlookBatchSetReadAction
        .executeTyped({ integration, input: { messageIds: ids(21), isRead: true } })
        .pipe(Effect.provide(host.layer))

      expect(result).toMatchObject({
        value: {
          summary: { requested: 21, succeeded: 20, failed: 0, unknown: 0, notAttempted: 1 }
        }
      })

      if (Predicate.isTagged(result, 'Success')) {
        expect(result.value.results.at(0)).toMatchObject({
          messageId: 'id-0',
          status: 'succeeded'
        })
        expect(result.value.results.at(-1)).toMatchObject({
          messageId: 'id-20',
          status: 'not_attempted',
          code: 'batch_stopped'
        })
      }

      expect(host.requests).toHaveLength(1)
    })
  )

  it.effect('treats malformed envelopes as ambiguous for the submitted chunk', () =>
    Effect.gen(function* () {
      const host = makeTransportHost(() => ({ status: 200, body: 'not json' }))

      const result = yield* outlookBatchSetReadAction
        .execute({ integration, input: { messageIds: ['a', 'b'], isRead: true } })
        .pipe(Effect.provide(host.layer))

      expect(result).toMatchObject({
        value: {
          results: [
            { messageId: 'a', status: 'unknown', code: 'outcome_ambiguous' },
            { messageId: 'b', status: 'unknown', code: 'outcome_ambiguous' }
          ],
          summary: { requested: 2, succeeded: 0, failed: 0, unknown: 2, notAttempted: 0 }
        }
      })
    })
  )

  it.effect('marks definitively rejected envelopes not attempted', () =>
    Effect.gen(function* () {
      for (const status of [400, 401, 403, 404]) {
        const host = makeTransportHost(() => ({
          status,
          body: JSON.stringify({ error: { code: 'BadRequest', message: 'rejected' } })
        }))

        const result = yield* outlookBatchSetReadAction
          .execute({ integration, input: { messageIds: ['a', 'b'], isRead: true } })
          .pipe(Effect.provide(host.layer))

        expect(result).toMatchObject({
          value: {
            results: [
              { messageId: 'a', status: 'not_attempted', code: 'batch_stopped' },
              { messageId: 'b', status: 'not_attempted', code: 'batch_stopped' }
            ],
            summary: { requested: 2, succeeded: 0, failed: 0, unknown: 0, notAttempted: 2 }
          }
        })
        expect(host.requests).toHaveLength(1)
      }
    })
  )

  it.effect('treats timed out, throttled, and failed envelopes as ambiguous, never success', () =>
    Effect.gen(function* () {
      for (const status of [408, 429, 500, 503]) {
        const host = makeTransportHost(() => ({
          status,
          body: JSON.stringify({ error: { message: 'busy' } })
        }))

        const result = yield* outlookBatchSetReadAction
          .execute({ integration, input: { messageIds: ['a'], isRead: true } })
          .pipe(Effect.provide(host.layer))

        expect(result).toMatchObject({
          value: {
            results: [{ messageId: 'a', status: 'unknown', code: 'outcome_ambiguous' }]
          }
        })
      }
    })
  )

  it.effect('stops category PATCHes after mixed systemic prerequisite failures', () =>
    Effect.gen(function* () {
      for (const status of [401, 403, 408, 429, 500]) {
        const host = makeTransportHost(subs => ({
          status: 200,
          body: JSON.stringify({
            responses: subs.map((sub, index) => ({
              id: sub.id,
              status: index === 1 ? status : 200,
              body:
                index === 1
                  ? { error: { code: 'systemic' } }
                  : {
                      id: decodeURIComponent(sub.url.split('/').pop()?.split('?')[0] ?? ''),
                      categories: ['Existing']
                    }
            }))
          })
        }))

        const result = yield* outlookBatchModifyCategoriesAction
          .execute({
            integration,
            input: { messageIds: ['a', 'b', 'c'], addCategories: ['Added'] }
          })
          .pipe(Effect.provide(host.layer))

        expect(result).toMatchObject({
          value: {
            results: [
              { messageId: 'a', status: 'not_attempted', code: 'batch_stopped' },
              { messageId: 'b', status: 'not_attempted', code: 'prerequisite_failed' },
              { messageId: 'c', status: 'not_attempted', code: 'batch_stopped' }
            ],
            summary: { requested: 3, succeeded: 0, failed: 0, unknown: 0, notAttempted: 3 }
          }
        })
        expect(host.requests).toHaveLength(1)
        expect(
          host
            .envelopes()
            .at(0)
            ?.requests.every(sub => sub.method === 'GET')
        ).toBe(true)
      }
    })
  )

  it.effect(
    'reports ambiguous category read envelopes as failed prerequisites without PATCHing',
    () =>
      Effect.gen(function* () {
        for (const status of [408, 429, 503]) {
          const host = makeTransportHost(() => ({ status, body: '{}' }))

          const result = yield* outlookBatchModifyCategoriesAction
            .execute({
              integration,
              input: { messageIds: ['a', 'b'], removeCategories: ['Old'] }
            })
            .pipe(Effect.provide(host.layer))

          expect(result).toMatchObject({
            value: {
              results: [
                { messageId: 'a', status: 'not_attempted', code: 'prerequisite_failed' },
                { messageId: 'b', status: 'not_attempted', code: 'prerequisite_failed' }
              ],
              summary: { requested: 2, succeeded: 0, failed: 0, unknown: 0, notAttempted: 2 }
            }
          })
          expect(host.requests).toHaveLength(1)
        }
      })
  )

  it.effect(
    'stops category writes for missing, duplicate, malformed, and foreign read correlations',
    () =>
      Effect.gen(function* () {
        const variants = [
          (subs: ReadonlyArray<Subrequest>) => [
            {
              id: subs[0]?.id,
              status: 200,
              body: { id: 'a', categories: ['Existing'] }
            }
          ],
          (subs: ReadonlyArray<Subrequest>) => [
            {
              id: subs[0]?.id,
              status: 200,
              body: { id: 'a', categories: ['Existing'] }
            },
            {
              id: subs[0]?.id,
              status: 200,
              body: { id: 'a', categories: ['Duplicate'] }
            },
            {
              id: subs[1]?.id,
              status: 200,
              body: { id: 'b', categories: ['Existing'] }
            }
          ],
          (subs: ReadonlyArray<Subrequest>) => [
            {
              id: subs[0]?.id,
              status: '200',
              body: { id: 'a', categories: ['Existing'] }
            },
            {
              id: subs[1]?.id,
              status: 200,
              body: { id: 'b', categories: ['Existing'] }
            }
          ],
          (subs: ReadonlyArray<Subrequest>) => [
            {
              id: subs[0]?.id,
              status: 200,
              body: { id: 'a', categories: ['Existing'] }
            },
            {
              id: subs[1]?.id,
              status: 200,
              body: { id: 'b', categories: ['Existing'] }
            },
            {
              id: 'foreign',
              status: 200,
              body: { id: 'foreign-message', categories: [] }
            }
          ]
        ] as const

        for (const responses of variants) {
          const host = makeTransportHost(subs => ({
            status: 200,
            body: JSON.stringify({ responses: responses(subs) })
          }))

          const result = yield* outlookBatchModifyCategoriesAction
            .execute({
              integration,
              input: { messageIds: ['a', 'b'], addCategories: ['Added'] }
            })
            .pipe(Effect.provide(host.layer))

          expect(result).toMatchObject({
            value: {
              summary: { requested: 2, succeeded: 0, failed: 0, unknown: 0, notAttempted: 2 }
            }
          })
          expect(host.requests).toHaveLength(1)
        }
      })
  )

  it.effect('sends outer auth only with immutable-ID preference on each subrequest', () =>
    Effect.gen(function* () {
      const host = makeTransportHost(successEnvelope)

      yield* MicrosoftConnector.invoke({
        integration,
        action: 'outlook.batch_set_read',
        input: { messageIds: ['a'], isRead: true }
      }).pipe(Effect.provide(host.layer))

      const outer = host.requests.at(0)
      expect(outer?.url).toBe('https://graph.microsoft.com/v1.0/$batch')
      expect(outer?.headers).toMatchObject({ authorization: 'Bearer token' })

      const subs = host.envelopes().at(0)?.requests ?? []
      expect(subs).toHaveLength(1)
      expect(subs.at(0)?.headers).toMatchObject({
        Prefer: 'IdType="ImmutableId"',
        'Content-Type': 'application/json'
      })
      expect(subs.at(0)?.headers).not.toHaveProperty('authorization')
      expect(subs.at(0)?.url).not.toMatch(/^https?:\/\//)
    })
  )

  it.effect('classifies mixed item statuses with exact counts in input order', () =>
    Effect.gen(function* () {
      const host = makeTransportHost(subs => ({
        status: 200,
        body: JSON.stringify({
          responses: [
            { id: subs[0]?.id, status: 404, body: { error: { code: 'ErrorItemNotFound' } } },
            {
              id: subs[1]?.id,
              status: 200,
              body: { id: decodeURIComponent(subs[1]?.url.split('/').pop() ?? '') }
            },
            { id: subs[2]?.id, status: 409, body: { error: { code: 'ErrorIrresolvableConflict' } } }
          ]
        })
      }))

      const result = yield* outlookBatchSetReadAction
        .execute({ integration, input: { messageIds: ['a', 'b', 'c'], isRead: true } })
        .pipe(Effect.provide(host.layer))

      expect(result).toMatchObject({
        value: {
          results: [
            { messageId: 'a', status: 'failed', code: 'not_found' },
            { messageId: 'b', status: 'succeeded' },
            { messageId: 'c', status: 'failed', code: 'conflict' }
          ],
          summary: { requested: 3, succeeded: 1, failed: 2, unknown: 0, notAttempted: 0 }
        }
      })
    })
  )
})
