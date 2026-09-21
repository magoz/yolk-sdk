import { describe, expect, it } from '@effect/vitest'
import { Effect, Layer, Predicate } from 'effect'
import * as Schema from 'effect/Schema'
import { resolveTools } from '@yolk-sdk/agent/tools'
import {
  ConnectorHttpClient,
  ConnectorHttpResponse,
  CredentialResolver,
  makeCredentialBinding,
  makeIntegration,
  OAuthCredential,
  type ConnectorHttpRequest
} from '@yolk-sdk/connectors'
import { makeConnectorToolModule } from '@yolk-sdk/connectors/agent'
import {
  MicrosoftConnector,
  microsoftOAuthSlotId,
  outlookBatchModifyCategoriesAction,
  outlookBatchMoveAction,
  outlookBatchSetFlagAction,
  outlookBatchSetReadAction,
  outlookBatchTrashAction,
  outlookBatchUntrashAction,
  outlookDeletePermanentlyAction
} from '@yolk-sdk/connectors/microsoft'

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

const messageIdFromUrl = (url: string) => {
  const path = url.split('?')[0] ?? ''
  const segments = path.split('/').filter(segment => segment !== '')

  if (segments.at(-1) === 'move' || segments.at(-1) === 'permanentDelete') {
    return decodeURIComponent(segments.at(-2) ?? '')
  }

  return decodeURIComponent(segments.at(-1) ?? '')
}

const defaultEnvelope = (subs: ReadonlyArray<Subrequest>) => ({
  status: 200,
  envelope: {
    responses: subs.map(sub => {
      const messageId = messageIdFromUrl(sub.url)

      if (sub.method === 'GET') {
        return { id: sub.id, status: 200, body: { id: messageId, categories: ['Existing'] } }
      }

      if (sub.url.endsWith('/move')) {
        return { id: sub.id, status: 201, body: { id: messageId, parentFolderId: 'folder-123' } }
      }

      if (sub.url.endsWith('/permanentDelete')) {
        return { id: sub.id, status: 204 }
      }

      return { id: sub.id, status: 200, body: { id: messageId, isRead: true } }
    })
  }
})

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

const makeBatchHost = (
  handler: (subs: ReadonlyArray<Subrequest>) => {
    status: number
    envelope: unknown
  } = defaultEnvelope,
  accountId?: string
) => {
  const requests: Array<ConnectorHttpRequest> = []
  const scopes: Array<ReadonlyArray<string> | undefined> = []
  const seen: Array<Subrequest> = []

  const layer = Layer.mergeAll(
    Layer.succeed(CredentialResolver, {
      resolve: request => {
        scopes.push(request.slot.requiredScopes)

        const credential =
          accountId === undefined
            ? OAuthCredential.make({
                provider: 'microsoft',
                accessToken: 'token',
                expiresAt: 4_000_000_000_000
              })
            : OAuthCredential.make({
                provider: 'microsoft',
                accessToken: 'token',
                expiresAt: 4_000_000_000_000,
                accountId
              })

        return Effect.succeed(credential)
      }
    }),
    Layer.succeed(ConnectorHttpClient, {
      request: (request: ConnectorHttpRequest) =>
        Effect.gen(function* () {
          requests.push(request)

          // Direct read endpoints (list/get) carry no batch envelope.
          if (!request.url.endsWith('/$batch')) {
            return ConnectorHttpResponse.make({
              status: 200,
              headers: {},
              body: '{"value":[]}'
            })
          }

          const parsed = yield* Schema.decodeUnknownEffect(BatchEnvelopeWire)(
            JSON.parse(request.body ?? '{}')
          ).pipe(Effect.orElseSucceed(() => ({ requests: [] })))

          seen.push(...parsed.requests)
          const { status, envelope } = handler(parsed.requests)

          return ConnectorHttpResponse.make({
            status,
            headers: {},
            body: JSON.stringify(envelope)
          })
        })
    })
  )

  const subrequests = () => seen

  return { layer, requests, scopes, subrequests }
}

const batchActions = [
  outlookBatchSetReadAction,
  outlookBatchSetFlagAction,
  outlookBatchMoveAction,
  outlookBatchTrashAction,
  outlookBatchUntrashAction,
  outlookBatchModifyCategoriesAction,
  outlookDeletePermanentlyAction
]

describe('Outlook flag discovery and list filters', () => {
  it.effect('normalizes every follow-up flag state on list and get', () =>
    Effect.gen(function* () {
      const cases: ReadonlyArray<{ flag: string; flagged: boolean | undefined }> = [
        { flag: '"flag":{"flagStatus":"flagged"},', flagged: true },
        { flag: '"flag":{"flagStatus":"notFlagged"},', flagged: false },
        { flag: '"flag":{"flagStatus":"complete"},', flagged: false },
        { flag: '"flag":{"flagStatus":"weird"},', flagged: undefined },
        { flag: '"flag":null,', flagged: undefined },
        { flag: '', flagged: undefined }
      ]

      for (const testCase of cases) {
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
              Effect.succeed(
                ConnectorHttpResponse.make({
                  status: 200,
                  headers: {},
                  body: request.url.includes('/messages/m1?')
                    ? `{"id":"m1",${testCase.flag}"isRead":true,"internetMessageHeaders":[]}`
                    : `{"value":[{"id":"m1",${testCase.flag}"isRead":false}]}`
                })
              )
          })
        )

        const listed = yield* MicrosoftConnector.invoke({
          integration,
          action: 'outlook.list_messages',
          input: {}
        }).pipe(Effect.provide(layer))

        const fetched = yield* MicrosoftConnector.invoke({
          integration,
          action: 'outlook.get_message',
          input: { messageId: 'm1' }
        }).pipe(Effect.provide(layer))

        expect(listed).toMatchObject({ value: { messages: [{ isRead: false }] } })
        expect(fetched).toMatchObject({ value: { isRead: true } })

        if (testCase.flagged === undefined) {
          expect(listed).not.toMatchObject({ value: { messages: [{ isFlagged: true }] } })
          expect(listed).not.toMatchObject({ value: { messages: [{ isFlagged: false }] } })
        } else {
          expect(listed).toMatchObject({ value: { messages: [{ isFlagged: testCase.flagged }] } })
          expect(fetched).toMatchObject({ value: { isFlagged: testCase.flagged } })
        }

        // Omitted fields remain unknown rather than defaulting.
        const omitted = yield* MicrosoftConnector.invoke({
          integration,
          action: 'outlook.list_messages',
          input: {}
        }).pipe(Effect.provide(layer))

        expect(omitted._tag).toBe('Success')
      }
    })
  )

  it.effect('ignores provider-supplied isFlagged lookalikes and derives only from flagStatus', () =>
    Effect.gen(function* () {
      for (const body of [
        '{"value":[{"id":"m1","isFlagged":true}]}',
        '{"value":[{"id":"m1","isFlagged":true,"flag":{"flagStatus":"weird"}}]}',
        '{"value":[{"id":"m1","isFlagged":false,"flag":{"flagStatus":"flagged"}}]}'
      ]) {
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
            request: () =>
              Effect.succeed(ConnectorHttpResponse.make({ status: 200, headers: {}, body }))
          })
        )

        const listed = yield* MicrosoftConnector.invoke({
          integration,
          action: 'outlook.list_messages',
          input: {}
        }).pipe(Effect.provide(layer))

        if (body.includes('"flagStatus":"flagged"')) {
          expect(listed).toMatchObject({ value: { messages: [{ isFlagged: true }] } })
        } else {
          expect(listed).not.toMatchObject({ value: { messages: [{ isFlagged: true }] } })
          expect(listed).not.toMatchObject({ value: { messages: [{ isFlagged: false }] } })
        }
      }
    })
  )

  it.effect('composes typed read/flag filters with raw filters', () =>
    Effect.gen(function* () {
      const host = makeBatchHost()

      yield* MicrosoftConnector.invoke({
        integration,
        action: 'outlook.list_messages',
        input: {
          filter: "contains(subject,'plan') or contains(subject,'roadmap')",
          isRead: true,
          isFlagged: false
        }
      }).pipe(Effect.provide(host.layer))

      const url = new URL(host.requests.at(0)?.url ?? '')
      expect(url.searchParams.get('$filter')).toBe(
        "(contains(subject,'plan') or contains(subject,'roadmap')) and isRead eq true and flag/flagStatus ne 'flagged'"
      )
      expect(url.searchParams.get('$select')).toContain('flag')
      expect(url.searchParams.get('$select')).toContain('isRead')

      const flaggedOnly = makeBatchHost()

      yield* MicrosoftConnector.invoke({
        integration,
        action: 'outlook.list_messages',
        input: { isFlagged: true }
      }).pipe(Effect.provide(flaggedOnly.layer))

      expect(new URL(flaggedOnly.requests.at(0)?.url ?? '').searchParams.get('$filter')).toBe(
        "flag/flagStatus eq 'flagged'"
      )

      const unreadOnly = makeBatchHost()

      yield* MicrosoftConnector.invoke({
        integration,
        action: 'outlook.list_messages',
        input: { isRead: false }
      }).pipe(Effect.provide(unreadOnly.layer))

      expect(new URL(unreadOnly.requests.at(0)?.url ?? '').searchParams.get('$filter')).toBe(
        'isRead eq false'
      )
    })
  )

  it.effect('rejects typed filters combined with nextLink before credentials', () =>
    Effect.gen(function* () {
      const host = makeBatchHost()

      const nextLink =
        'https://graph.microsoft.com/v1.0/me/messages?%24select=id&%24skip=3&%24top=5'

      const rejected = yield* MicrosoftConnector.invoke({
        integration,
        action: 'outlook.list_messages',
        input: { nextLink, isRead: true }
      }).pipe(Effect.provide(host.layer), Effect.result)

      expect(rejected).toMatchObject({ failure: { cause: 'validation_failed' } })
      expect(host.requests).toEqual([])
      expect(host.scopes).toEqual([])
    })
  )

  it.effect('registers every batch action with root-object schemas and access metadata', () =>
    Effect.gen(function* () {
      const host = makeBatchHost()

      const tools = yield* resolveTools(
        [makeConnectorToolModule(MicrosoftConnector, { integration, layer: host.layer })],
        {}
      )

      expect(batchActions.map(action => action.access)).toEqual([
        'write',
        'write',
        'write',
        'destructive',
        'write',
        'write',
        'destructive'
      ])

      for (const action of batchActions) {
        expect(MicrosoftConnector.actions).toContain(action)
        expect(tools.tools.find(tool => tool.name === action.id)?.parameters).toMatchObject({
          type: 'object',
          required: expect.arrayContaining(['messageIds'])
        })
      }
    })
  )

  it.effect('rejects empty, duplicate, oversized, and path-unsafe IDs before IO', () =>
    Effect.gen(function* () {
      const host = makeBatchHost()

      const invalidInputs: ReadonlyArray<{
        readonly messageIds: ReadonlyArray<string>
        readonly mailbox?: string
        readonly isRead: boolean
      }> = [
        { messageIds: [], isRead: true },
        { messageIds: [''], isRead: true },
        { messageIds: ['a', 'a'], isRead: true },
        { messageIds: Array.from({ length: 101 }, (_, index) => `id-${index}`), isRead: true },
        { messageIds: ['...'], isRead: true },
        { messageIds: ['a b'], isRead: true },
        { messageIds: ['\u00a0bad'], isRead: true },
        { messageIds: ['bad\u00a0'], isRead: true },
        { messageIds: ['\ud800'], isRead: true },
        { messageIds: ['a'], mailbox: '  ', isRead: true }
      ]

      for (const input of invalidInputs) {
        const result = yield* outlookBatchSetReadAction
          .execute({ integration, input })
          .pipe(Effect.provide(host.layer), Effect.result)

        expect(result._tag).toBe('Failure')
      }

      const typedHost = makeBatchHost()

      const mutated = yield* outlookBatchSetReadAction
        .executeTyped({ integration, input: { messageIds: ['\u00a0bad'], isRead: true } })
        .pipe(Effect.provide(typedHost.layer), Effect.result)

      expect(mutated._tag).toBe('Failure')
      expect(typedHost.requests).toEqual([])
      expect(typedHost.scopes).toEqual([])

      // Slash-containing Graph IDs are valid and preserved through encoding.
      const slash = yield* outlookBatchSetReadAction
        .execute({ integration, input: { messageIds: ['AAMkAG//x'], isRead: true } })
        .pipe(Effect.provide(host.layer))

      expect(slash._tag).toBe('Success')
      expect(host.subrequests().at(0)?.url).toBe('/me/messages/AAMkAG%2F%2Fx')
    })
  )

  it.effect('PATCHes isRead with the write slot and immutable-ID preference', () =>
    Effect.gen(function* () {
      const host = makeBatchHost()

      const result = yield* outlookBatchSetReadAction
        .execute({ integration, input: { messageIds: ['m/1'], isRead: false } })
        .pipe(Effect.provide(host.layer))

      expect(result).toMatchObject({
        value: {
          results: [{ messageId: 'm/1', status: 'succeeded' }],
          summary: { requested: 1, succeeded: 1, failed: 0, unknown: 0, notAttempted: 0 }
        }
      })
      expect(host.requests).toHaveLength(1)
      expect(host.requests.at(0)).toMatchObject({
        method: 'POST',
        url: 'https://graph.microsoft.com/v1.0/$batch',
        headers: expect.objectContaining({ authorization: 'Bearer token' })
      })

      const subs = host.subrequests()
      expect(subs).toHaveLength(1)
      expect(subs.at(0)).toMatchObject({
        method: 'PATCH',
        url: '/me/messages/m%2F1',
        body: { isRead: false },
        headers: { Prefer: 'IdType="ImmutableId"', 'Content-Type': 'application/json' }
      })
      expect(subs.at(0)?.headers).not.toHaveProperty('authorization')
      expect(host.scopes).toEqual([['https://graph.microsoft.com/Mail.ReadWrite']])
    })
  )

  it.effect('PATCHes both flag values without duplicating credentials', () =>
    Effect.gen(function* () {
      for (const [isFlagged, flagStatus] of [
        [true, 'flagged'],
        [false, 'notFlagged']
      ] as const) {
        const host = makeBatchHost()

        const result = yield* outlookBatchSetFlagAction
          .execute({ integration, input: { messageIds: ['m1'], isFlagged } })
          .pipe(Effect.provide(host.layer))

        expect(result._tag).toBe('Success')
        expect(host.subrequests().at(0)).toMatchObject({
          method: 'PATCH',
          body: { flag: { flagStatus } }
        })
      }
    })
  )

  it.effect('moves with provider-returned identity and never fabricates folders', () =>
    Effect.gen(function* () {
      const host = makeBatchHost()

      const result = yield* outlookBatchMoveAction
        .execute({
          integration,
          input: { messageIds: ['m1'], destinationFolderId: 'archive-folder' }
        })
        .pipe(Effect.provide(host.layer))

      expect(result).toMatchObject({
        value: {
          results: [
            {
              messageId: 'm1',
              status: 'succeeded',
              movedMessageId: 'm1',
              destinationFolderId: 'folder-123'
            }
          ],
          summary: { requested: 1, succeeded: 1, failed: 0, unknown: 0, notAttempted: 0 }
        }
      })
      expect(host.subrequests().at(0)).toMatchObject({
        method: 'POST',
        url: '/me/messages/m1/move',
        body: { destinationId: 'archive-folder' }
      })

      const missingFolder = makeBatchHost(subs => ({
        status: 200,
        envelope: {
          responses: subs.map(sub => ({ id: sub.id, status: 201, body: { id: 'm1' } }))
        }
      }))

      const unknown = yield* outlookBatchMoveAction
        .execute({
          integration,
          input: { messageIds: ['m1'], destinationFolderId: 'archive-folder' }
        })
        .pipe(Effect.provide(missingFolder.layer))

      expect(unknown).toMatchObject({
        value: {
          results: [{ messageId: 'm1', status: 'unknown', code: 'invalid_response' }]
        }
      })
    })
  )

  it.effect('accepts changed move identities and isolates malformed sibling metadata', () =>
    Effect.gen(function* () {
      const host = makeBatchHost(subs => ({
        status: 200,
        envelope: {
          responses: subs.map((sub, index) => ({
            id: sub.id,
            status: 201,
            body:
              index === 0
                ? { id: 'moved-m1', parentFolderId: 'actual-folder' }
                : { id: 'moved-m2', parentFolderId: '' }
          }))
        }
      }))

      const result = yield* outlookBatchMoveAction
        .execute({
          integration,
          input: { messageIds: ['m1', 'm2'], destinationFolderId: 'requested-folder' }
        })
        .pipe(Effect.provide(host.layer))

      expect(result).toMatchObject({
        value: {
          results: [
            {
              messageId: 'm1',
              status: 'succeeded',
              movedMessageId: 'moved-m1',
              destinationFolderId: 'actual-folder'
            },
            { messageId: 'm2', status: 'unknown', code: 'invalid_response' }
          ],
          summary: { requested: 2, succeeded: 1, failed: 0, unknown: 1, notAttempted: 0 }
        }
      })
    })
  )

  it.effect('trashes to Deleted Items and untrashes from it with honest defaults', () =>
    Effect.gen(function* () {
      const host = makeBatchHost()

      yield* outlookBatchTrashAction
        .execute({ integration, input: { messageIds: ['m1'] } })
        .pipe(Effect.provide(host.layer))

      yield* outlookBatchUntrashAction
        .execute({ integration, input: { messageIds: ['m2'] } })
        .pipe(Effect.provide(host.layer))

      yield* outlookBatchUntrashAction
        .execute({
          integration,
          input: { messageIds: ['m3'], destinationFolderId: 'archive-folder' }
        })
        .pipe(Effect.provide(host.layer))

      expect(host.subrequests()).toMatchObject([
        { method: 'POST', url: '/me/messages/m1/move', body: { destinationId: 'deleteditems' } },
        {
          method: 'POST',
          url: '/me/mailFolders/deleteditems/messages/m2/move',
          body: { destinationId: 'inbox' }
        },
        {
          method: 'POST',
          url: '/me/mailFolders/deleteditems/messages/m3/move',
          body: { destinationId: 'archive-folder' }
        }
      ])
    })
  )

  it.effect('merges categories with removal winning and failed reads not attempted', () =>
    Effect.gen(function* () {
      const host = makeBatchHost(subs => ({
        status: 200,
        envelope: {
          responses: subs.map(sub => {
            const messageId = messageIdFromUrl(sub.url)

            if (sub.method === 'GET') {
              if (messageId === 'missing') {
                return { id: sub.id, status: 404, body: { error: { message: 'nope' } } }
              }

              return {
                id: sub.id,
                status: 200,
                body: { id: messageId, categories: ['Existing', 'Stale', 'Keep'] }
              }
            }

            return { id: sub.id, status: 200, body: { id: messageId } }
          })
        }
      }))

      const result = yield* outlookBatchModifyCategoriesAction
        .execute({
          integration,
          input: {
            messageIds: ['m1', 'missing'],
            addCategories: ['New', 'Keep'],
            removeCategories: ['Stale', 'New']
          }
        })
        .pipe(Effect.provide(host.layer))

      expect(result).toMatchObject({
        value: {
          results: [
            { messageId: 'm1', status: 'succeeded' },
            { messageId: 'missing', status: 'not_attempted', code: 'prerequisite_failed' }
          ],
          summary: { requested: 2, succeeded: 1, failed: 0, unknown: 0, notAttempted: 1 }
        }
      })

      const patch = host.subrequests().find(sub => sub.method === 'PATCH' && sub.url.includes('m1'))

      // Removal wins over addition; unrelated categories are preserved.
      expect(patch?.body).toEqual({ categories: ['Existing', 'Keep'] })

      const invalid = yield* outlookBatchModifyCategoriesAction
        .execute({ integration, input: { messageIds: ['m1'] } })
        .pipe(Effect.provide(host.layer), Effect.result)

      expect(invalid._tag).toBe('Failure')
    })
  )

  it.effect('deletes permanently without a body and reports honest 404s', () =>
    Effect.gen(function* () {
      const host = makeBatchHost(subs => ({
        status: 200,
        envelope: {
          responses: subs.map(sub =>
            messageIdFromUrl(sub.url) === 'gone'
              ? { id: sub.id, status: 404, body: { error: { code: 'ErrorItemNotFound' } } }
              : { id: sub.id, status: 204 }
          )
        }
      }))

      const result = yield* outlookDeletePermanentlyAction
        .execute({ integration, input: { messageIds: ['m1', 'gone'] } })
        .pipe(Effect.provide(host.layer))

      expect(result).toMatchObject({
        value: {
          results: [
            { messageId: 'm1', status: 'succeeded' },
            { messageId: 'gone', status: 'failed', code: 'not_found' }
          ],
          summary: { requested: 2, succeeded: 1, failed: 1, unknown: 0, notAttempted: 0 }
        }
      })

      const subs = host.subrequests()
      expect(subs).toMatchObject([
        { method: 'POST', url: '/me/messages/m1/permanentDelete' },
        { method: 'POST', url: '/me/messages/gone/permanentDelete' }
      ])
      expect(subs.at(0)).not.toHaveProperty('body')
    })
  )

  it.effect('preserves shared, own-explicit, and application mailbox rules', () =>
    Effect.gen(function* () {
      const shared = makeBatchHost(defaultEnvelope)

      yield* outlookBatchSetReadAction
        .execute({
          integration,
          input: { mailbox: 'shared@example.com', messageIds: ['m1'], isRead: true }
        })
        .pipe(Effect.provide(shared.layer))

      expect(shared.subrequests().at(0)?.url).toBe('/users/shared%40example.com/messages/m1')
      expect(shared.scopes).toEqual([
        undefined,
        ['https://graph.microsoft.com/Mail.ReadWrite.Shared']
      ])

      const own = makeBatchHost(defaultEnvelope, 'own@example.com')

      yield* outlookBatchSetReadAction
        .execute({
          integration,
          input: { mailbox: 'OWN@example.com', messageIds: ['m1'], isRead: true }
        })
        .pipe(Effect.provide(own.layer))

      expect(own.subrequests().at(0)?.url).toBe('/users/OWN%40example.com/messages/m1')
      expect(own.scopes).toEqual([undefined, ['https://graph.microsoft.com/Mail.ReadWrite']])

      const application = makeIntegration({
        connectorId: 'microsoft',
        config: { mailboxAccessMode: 'application' },
        credentialBindings: integration.credentialBindings
      })

      const appHost = makeBatchHost()

      const rejected = yield* outlookBatchMoveAction
        .execute({
          integration: application,
          input: { messageIds: ['m1'], destinationFolderId: 'archive' }
        })
        .pipe(Effect.provide(appHost.layer), Effect.result)

      expect(rejected._tag).toBe('Failure')
      expect(appHost.requests).toEqual([])
    })
  )

  it.effect('keeps provider error text out of batch results', () =>
    Effect.gen(function* () {
      const secret = 'graph-secret-diagnostic'

      const host = makeBatchHost(subs => ({
        status: 200,
        envelope: {
          responses: subs.map(sub => ({
            id: sub.id,
            status: 500,
            body: { error: { message: secret } }
          }))
        }
      }))

      const ids = ['a', 'b', ...Array.from({ length: 19 }, (_, index) => `id-${index}`)]

      const result = yield* outlookBatchSetReadAction
        .executeTyped({ integration, input: { messageIds: ids, isRead: true } })
        .pipe(Effect.provide(host.layer))

      // Submitted siblings stay independently unknown; the later chunk stops.
      expect(result).toMatchObject({
        value: {
          summary: { requested: 21, succeeded: 0, failed: 0, unknown: 20, notAttempted: 1 }
        }
      })

      if (Predicate.isTagged(result, 'Success')) {
        expect(result.value.results.slice(0, 2)).toMatchObject([
          { messageId: 'a', status: 'unknown', code: 'outcome_ambiguous' },
          { messageId: 'b', status: 'unknown', code: 'outcome_ambiguous' }
        ])
        expect(result.value.results.at(-1)).toMatchObject({
          messageId: 'id-18',
          status: 'not_attempted',
          code: 'batch_stopped'
        })
        expect(result.value.results.map(item => item.messageId)).toEqual(ids)
      }

      expect(host.requests).toHaveLength(1)
      expect(JSON.stringify(result)).not.toContain(secret)
    })
  )
})
