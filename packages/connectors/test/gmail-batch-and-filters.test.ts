import { describe, expect, it } from '@effect/vitest'
import { Effect, Layer, Predicate } from 'effect'
import { resolveTools } from '@yolk-sdk/agent/tools'
import {
  ConnectorError,
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
  gmailBatchModifyLabelsAction,
  gmailBatchSetReadAction,
  gmailBatchSetStarredAction,
  gmailBatchTrashAction,
  gmailBatchUntrashAction,
  gmailDeletePermanentlyAction,
  gmailSetReadAction,
  GoogleConnector,
  googleGmailFullMailScope,
  googleGmailModifyScope,
  googleOAuthSlotId
} from '@yolk-sdk/connectors/google'

const integration = makeIntegration({
  connectorId: 'google',
  credentialBindings: [
    makeCredentialBinding({ slotId: googleOAuthSlotId, credentialRef: 'google-account' })
  ]
})

const makeHost = (responses: ReadonlyArray<{ status: number; body: string }>) => {
  const requests: Array<ConnectorHttpRequest> = []
  const scopes: Array<ReadonlyArray<string> | undefined> = []
  let index = 0

  const layer = Layer.mergeAll(
    Layer.succeed(CredentialResolver, {
      resolve: request => {
        scopes.push(request.slot.requiredScopes)

        return Effect.succeed(
          OAuthCredential.make({
            provider: 'google',
            accessToken: 'token',
            expiresAt: 4_000_000_000_000
          })
        )
      }
    }),
    Layer.succeed(ConnectorHttpClient, {
      request: request => {
        requests.push(request)

        const response = responses[Math.min(index, responses.length - 1)] ?? {
          status: 200,
          body: '{}'
        }

        index += 1

        return Effect.succeed(
          ConnectorHttpResponse.make({
            status: response.status,
            headers: {},
            body: response.body
          })
        )
      }
    })
  )

  return { layer, requests, scopes }
}

const batchActions = [
  gmailBatchSetReadAction,
  gmailBatchSetStarredAction,
  gmailBatchModifyLabelsAction,
  gmailBatchTrashAction,
  gmailBatchUntrashAction,
  gmailDeletePermanentlyAction
]

describe('Gmail read/flag discovery and filters', () => {
  it.effect('normalizes isRead/isFlagged from labelIds on get_message', () =>
    Effect.gen(function* () {
      const cases: ReadonlyArray<{ labels: string | undefined; read: unknown; flagged: unknown }> =
        [
          { labels: undefined, read: undefined, flagged: undefined },
          { labels: '[]', read: true, flagged: false },
          { labels: '["INBOX"]', read: true, flagged: false },
          { labels: '["INBOX","UNREAD"]', read: false, flagged: false },
          { labels: '["INBOX","STARRED"]', read: true, flagged: true },
          { labels: '["UNREAD","STARRED"]', read: false, flagged: true }
        ]

      for (const testCase of cases) {
        const labelField = testCase.labels === undefined ? '' : `"labelIds":${testCase.labels},`

        const host = makeHost([{ status: 200, body: `{"id":"m1",${labelField}"snippet":"hi"}` }])

        const result = yield* gmailSetReadAction
          .executeTyped({ integration, input: { messageId: 'm1', isRead: true } })
          .pipe(Effect.provide(host.layer))

        expect(result._tag).toBe('Success')

        if (Predicate.isTagged(result, 'Success')) {
          expect(result.value).toMatchObject({ id: 'm1' })
          expect(result.value.isRead).toBe(testCase.read)
          expect(result.value.isFlagged).toBe(testCase.flagged)
        }
      }
    })
  )

  it.effect('normalizes direct get_message output from provider labels', () =>
    Effect.gen(function* () {
      const host = makeHost([{ status: 200, body: '{"id":"m1","labelIds":["UNREAD","STARRED"]}' }])

      const result = yield* GoogleConnector.invoke({
        integration,
        action: 'gmail.get_message',
        input: { id: 'm1' }
      }).pipe(Effect.provide(host.layer))

      expect(result).toMatchObject({ value: { id: 'm1', isRead: false, isFlagged: true } })
      expect(host.requests.at(0)?.method).toBe('GET')
    })
  )

  it.effect('ignores malformed provider lookalikes before normalizing get and set_read', () =>
    Effect.gen(function* () {
      const cases: ReadonlyArray<{
        readonly body: unknown
        readonly isRead: boolean | undefined
        readonly isFlagged: boolean | undefined
      }> = [
        {
          body: { id: 'm1', labelIds: ['UNREAD'], isRead: null, isFlagged: 'yes' },
          isRead: false,
          isFlagged: false
        },
        {
          body: { id: 'm1', labelIds: [], isRead: { wrong: true }, isFlagged: [] },
          isRead: true,
          isFlagged: false
        },
        {
          body: { id: 'm1', isRead: null, isFlagged: { wrong: true } },
          isRead: undefined,
          isFlagged: undefined
        }
      ]

      for (const testCase of cases) {
        const body = JSON.stringify(testCase.body)

        const host = makeHost([
          { status: 200, body },
          { status: 200, body }
        ])

        const fetched = yield* GoogleConnector.invoke({
          integration,
          action: 'gmail.get_message',
          input: { id: 'm1' }
        }).pipe(Effect.provide(host.layer))

        const updated = yield* gmailSetReadAction
          .execute({ integration, input: { messageId: 'm1', isRead: false } })
          .pipe(Effect.provide(host.layer))

        for (const result of [fetched, updated]) {
          if (testCase.isRead === undefined) {
            expect(result).not.toMatchObject({ value: { isRead: true } })
            expect(result).not.toMatchObject({ value: { isRead: false } })
            expect(result).not.toMatchObject({ value: { isFlagged: true } })
            expect(result).not.toMatchObject({ value: { isFlagged: false } })
          } else {
            expect(result).toMatchObject({
              value: { isRead: testCase.isRead, isFlagged: testCase.isFlagged }
            })
          }
        }
      }
    })
  )

  it.effect('composes typed filters with raw queries on search and list', () =>
    Effect.gen(function* () {
      const host = makeHost([
        { status: 200, body: '{"messages":[],"resultSizeEstimate":0}' },
        { status: 200, body: '{}' }
      ])

      yield* GoogleConnector.invoke({
        integration,
        action: 'gmail.search',
        input: { query: 'from:alice OR from:bob', isRead: false, isFlagged: true }
      }).pipe(Effect.provide(host.layer))

      yield* GoogleConnector.invoke({
        integration,
        action: 'gmail.list',
        input: { query: 'has:attachment', labelId: 'INBOX', isRead: true, isFlagged: false }
      }).pipe(Effect.provide(host.layer))

      expect(host.requests.at(0)?.url).toBe(
        'https://gmail.googleapis.com/gmail/v1/users/me/messages?q=%28from%3Aalice+OR+from%3Abob%29+is%3Aunread+is%3Astarred'
      )
      expect(host.requests.at(1)?.url).toBe(
        'https://gmail.googleapis.com/gmail/v1/users/me/messages?q=%28has%3Aattachment%29+is%3Aread+-is%3Astarred&labelIds=INBOX'
      )
    })
  )

  it.effect('leaves legacy queries unchanged without typed filters', () =>
    Effect.gen(function* () {
      const host = makeHost([{ status: 200, body: '{}' }])

      yield* GoogleConnector.invoke({
        integration,
        action: 'gmail.list',
        input: { query: 'newer_than:2d' }
      }).pipe(Effect.provide(host.layer))

      expect(host.requests.at(0)?.url).toBe(
        'https://gmail.googleapis.com/gmail/v1/users/me/messages?q=newer_than%3A2d'
      )
    })
  )
})

describe('Gmail set_read and batch actions', () => {
  it.effect('registers every action with root-object schemas and access metadata', () =>
    Effect.gen(function* () {
      const host = makeHost([])

      const tools = yield* resolveTools(
        [makeConnectorToolModule(GoogleConnector, { integration, layer: host.layer })],
        {}
      )

      expect(gmailSetReadAction.access).toBe('write')
      expect(batchActions.map(action => action.access)).toEqual([
        'write',
        'write',
        'write',
        'destructive',
        'write',
        'destructive'
      ])

      for (const action of [gmailSetReadAction, ...batchActions]) {
        expect(GoogleConnector.actions).toContain(action)
        expect(tools.tools.find(tool => tool.name === action.id)?.parameters).toMatchObject({
          type: 'object'
        })
      }

      expect(
        tools.tools.find(tool => tool.name === 'gmail.batch_set_read')?.parameters
      ).toMatchObject({ required: expect.arrayContaining(['messageIds', 'isRead']) })
    })
  )

  it.effect('rejects empty, duplicate, oversized, and path-unsafe IDs before IO', () =>
    Effect.gen(function* () {
      const host = makeHost([])

      const invalidInputs: ReadonlyArray<{
        readonly messageIds: ReadonlyArray<string>
        readonly isRead: boolean
      }> = [
        { messageIds: [], isRead: true },
        { messageIds: [''], isRead: true },
        { messageIds: ['a', 'a'], isRead: true },
        { messageIds: Array.from({ length: 101 }, (_, index) => `id-${index}`), isRead: true },
        { messageIds: ['...'], isRead: true },
        { messageIds: ['a b'], isRead: true },
        { messageIds: ['a\nb'], isRead: true },
        { messageIds: ['\u00a0bad'], isRead: true },
        { messageIds: ['bad\u00a0'], isRead: true },
        { messageIds: ['\ud800'], isRead: true }
      ]

      for (const input of invalidInputs) {
        const result = yield* gmailBatchSetReadAction
          .execute({ integration, input })
          .pipe(Effect.provide(host.layer), Effect.result)

        expect(result._tag).toBe('Failure')
      }

      const mutated = yield* gmailBatchSetReadAction
        .executeTyped({ integration, input: { messageIds: ['\u00a0bad'], isRead: true } })
        .pipe(Effect.provide(host.layer), Effect.result)

      expect(mutated._tag).toBe('Failure')
      expect(host.requests).toEqual([])
      expect(host.scopes).toEqual([])
    })
  )

  it.effect('sets read state with the modify scope and normalized output', () =>
    Effect.gen(function* () {
      const host = makeHost([
        { status: 200, body: '{"id":"m1","labelIds":["INBOX"]}' },
        { status: 200, body: '{"id":"m1","labelIds":["INBOX","UNREAD"]}' }
      ])

      const read = yield* gmailSetReadAction
        .execute({ integration, input: { messageId: 'm1', isRead: true } })
        .pipe(Effect.provide(host.layer))

      expect(read).toMatchObject({ value: { id: 'm1', isRead: true, isFlagged: false } })

      const unread = yield* gmailSetReadAction
        .execute({ integration, input: { messageId: 'm1', isRead: false } })
        .pipe(Effect.provide(host.layer))

      expect(unread).toMatchObject({ value: { isRead: false } })
      expect(host.requests).toMatchObject([
        {
          method: 'POST',
          url: 'https://gmail.googleapis.com/gmail/v1/users/me/messages/m1/modify',
          body: JSON.stringify({ removeLabelIds: ['UNREAD'] })
        },
        {
          method: 'POST',
          url: 'https://gmail.googleapis.com/gmail/v1/users/me/messages/m1/modify',
          body: JSON.stringify({ addLabelIds: ['UNREAD'] })
        }
      ])
      expect(host.scopes).toEqual([[googleGmailModifyScope], [googleGmailModifyScope]])
    })
  )

  it.effect('sanitizes set_read failures without provider bodies', () =>
    Effect.gen(function* () {
      const secret = 's3cret-token-value'

      const host = makeHost([{ status: 404, body: JSON.stringify({ error: { message: secret } }) }])

      const result = yield* gmailSetReadAction
        .execute({ integration, input: { messageId: 'm1', isRead: true } })
        .pipe(Effect.provide(host.layer))

      expect(result._tag).toBe('Failure')
      expect(result).toMatchObject({ error: { code: 'gmail_set_read_failed', status: 404 } })
      expect(JSON.stringify(result)).not.toContain(secret)
    })
  )

  it.effect('sanitizes set_read transport and malformed-success decoding errors', () =>
    Effect.gen(function* () {
      const secret = 'private-transport-or-body-sentinel'

      const transportLayer = Layer.mergeAll(
        Layer.succeed(CredentialResolver, {
          resolve: () =>
            Effect.succeed(
              OAuthCredential.make({
                provider: 'google',
                accessToken: 'token',
                expiresAt: 4_000_000_000_000
              })
            )
        }),
        Layer.succeed(ConnectorHttpClient, {
          request: () =>
            Effect.fail(
              new ConnectorError({
                cause: 'transport_failed',
                message: secret,
                underlying: { secret }
              })
            )
        })
      )

      const transport = yield* gmailSetReadAction
        .execute({ integration, input: { messageId: 'm1', isRead: true } })
        .pipe(Effect.provide(transportLayer), Effect.result)

      expect(transport).toMatchObject({
        _tag: 'Failure',
        failure: {
          cause: 'transport_failed',
          actionId: 'gmail.set_read',
          message: 'Gmail read-state mutation failed without a confirmed outcome'
        }
      })
      expect(JSON.stringify(transport)).not.toContain(secret)

      const malformedHost = makeHost([{ status: 200, body: secret }])

      const malformed = yield* gmailSetReadAction
        .execute({ integration, input: { messageId: 'm1', isRead: false } })
        .pipe(Effect.provide(malformedHost.layer), Effect.result)

      expect(malformed).toMatchObject({
        _tag: 'Failure',
        failure: {
          cause: 'validation_failed',
          actionId: 'gmail.set_read',
          message: 'Gmail read-state mutation failed without a confirmed outcome'
        }
      })
      expect(JSON.stringify(malformed)).not.toContain(secret)
    })
  )

  it.effect('batch set read succeeds per ID with exact counts', () =>
    Effect.gen(function* () {
      const host = makeHost([
        { status: 200, body: '{"id":"a","labelIds":[]}' },
        { status: 200, body: '{"id":"b","labelIds":[]}' }
      ])

      const result = yield* gmailBatchSetReadAction
        .execute({ integration, input: { messageIds: ['a', 'b'], isRead: true } })
        .pipe(Effect.provide(host.layer))

      expect(result).toMatchObject({
        value: {
          results: [
            { messageId: 'a', status: 'succeeded' },
            { messageId: 'b', status: 'succeeded' }
          ],
          summary: { requested: 2, succeeded: 2, failed: 0, unknown: 0, notAttempted: 0 }
        }
      })
      expect(host.requests).toHaveLength(2)
      expect(host.requests.at(0)).toMatchObject({
        method: 'POST',
        url: 'https://gmail.googleapis.com/gmail/v1/users/me/messages/a/modify'
      })
      expect(host.scopes).toEqual([[googleGmailModifyScope]])
    })
  )

  it.effect('records mixed outcomes and stops after auth rejection', () =>
    Effect.gen(function* () {
      const secret = 'auth-secret-body'

      const host = makeHost([
        { status: 404, body: `{"error":{"message":"${secret}"}}` },
        { status: 401, body: '{}' },
        { status: 200, body: '{"id":"c"}' }
      ])

      const result = yield* gmailBatchSetReadAction
        .execute({ integration, input: { messageIds: ['a', 'b', 'c'], isRead: false } })
        .pipe(Effect.provide(host.layer))

      expect(result).toMatchObject({
        value: {
          results: [
            { messageId: 'a', status: 'failed', code: 'not_found' },
            { messageId: 'b', status: 'failed', code: 'unauthorized' },
            { messageId: 'c', status: 'not_attempted', code: 'batch_stopped' }
          ],
          summary: { requested: 3, succeeded: 0, failed: 2, unknown: 0, notAttempted: 1 }
        }
      })
      expect(host.requests).toHaveLength(2)
      expect(JSON.stringify(result)).not.toContain(secret)
    })
  )

  it.effect('marks transport failures unknown and skips the rest', () =>
    Effect.gen(function* () {
      const layer = Layer.mergeAll(
        Layer.succeed(CredentialResolver, {
          resolve: () =>
            Effect.succeed(
              OAuthCredential.make({
                provider: 'google',
                accessToken: 'token',
                expiresAt: 4_000_000_000_000
              })
            )
        }),
        Layer.succeed(ConnectorHttpClient, {
          request: () =>
            Effect.fail(
              new ConnectorError({
                cause: 'transport_failed',
                message: 'boom',
                connectorId: 'google'
              })
            )
        })
      )

      const result = yield* gmailBatchTrashAction
        .execute({ integration, input: { messageIds: ['a', 'b'] } })
        .pipe(Effect.provide(layer))

      expect(result).toMatchObject({
        value: {
          results: [
            { messageId: 'a', status: 'unknown', code: 'outcome_ambiguous' },
            { messageId: 'b', status: 'not_attempted', code: 'batch_stopped' }
          ],
          summary: { requested: 2, succeeded: 0, failed: 0, unknown: 1, notAttempted: 1 }
        }
      })
    })
  )

  it.effect('treats empty, malformed, and mismatched mutation bodies as unknown', () =>
    Effect.gen(function* () {
      const host = makeHost([
        { status: 200, body: '{}' },
        { status: 200, body: 'not json' },
        { status: 200, body: '{"id":"someone-else"}' }
      ])

      const result = yield* gmailBatchSetStarredAction
        .execute({ integration, input: { messageIds: ['a', 'b', 'c'], isStarred: true } })
        .pipe(Effect.provide(host.layer))

      expect(result).toMatchObject({
        value: {
          results: [
            { messageId: 'a', status: 'unknown', code: 'invalid_response' },
            { messageId: 'b', status: 'unknown', code: 'invalid_response' },
            { messageId: 'c', status: 'unknown', code: 'invalid_response' }
          ],
          summary: { requested: 3, succeeded: 0, failed: 0, unknown: 3, notAttempted: 0 }
        }
      })
      expect(host.requests).toHaveLength(3)
      expect(host.requests.at(0)).toMatchObject({
        body: JSON.stringify({ addLabelIds: ['STARRED'] })
      })
    })
  )

  it.effect('rejects undocumented JSON mutation success statuses as unknown', () =>
    Effect.gen(function* () {
      const host = makeHost([
        { status: 201, body: '{"id":"a"}' },
        { status: 202, body: '{"id":"b"}' },
        { status: 204, body: '' }
      ])

      const result = yield* gmailBatchSetStarredAction
        .execute({ integration, input: { messageIds: ['a', 'b', 'c'], isStarred: true } })
        .pipe(Effect.provide(host.layer))

      expect(result).toMatchObject({
        value: {
          results: [
            { messageId: 'a', status: 'unknown', code: 'invalid_response' },
            { messageId: 'b', status: 'unknown', code: 'invalid_response' },
            { messageId: 'c', status: 'unknown', code: 'invalid_response' }
          ],
          summary: { requested: 3, succeeded: 0, failed: 0, unknown: 3, notAttempted: 0 }
        }
      })

      for (const status of [201, 202, 204]) {
        const single = makeHost([{ status, body: status === 204 ? '' : '{"id":"m1"}' }])

        const failure = yield* gmailSetReadAction
          .execute({ integration, input: { messageId: 'm1', isRead: true } })
          .pipe(Effect.provide(single.layer))

        expect(failure).toMatchObject({
          _tag: 'Failure',
          error: { code: 'gmail_set_read_failed', status }
        })
      }

      const mismatched = makeHost([{ status: 200, body: '{"id":"someone-else"}' }])

      const mismatch = yield* gmailSetReadAction
        .execute({ integration, input: { messageId: 'm1', isRead: true } })
        .pipe(Effect.provide(mismatched.layer))

      expect(mismatch).toMatchObject({
        _tag: 'Failure',
        error: { code: 'gmail_set_read_failed', status: 200 }
      })
    })
  )

  it.effect('merges label deltas with removal winning and caps of 100', () =>
    Effect.gen(function* () {
      const host = makeHost([{ status: 200, body: '{"id":"a"}' }])

      const result = yield* gmailBatchModifyLabelsAction
        .execute({
          integration,
          input: {
            messageIds: ['a'],
            addLabelIds: ['X', 'Y', 'X'],
            removeLabels: undefined,
            removeLabelIds: ['Y']
          }
        })
        .pipe(Effect.provide(host.layer))

      expect(result._tag).toBe('Success')
      expect(host.requests.at(0)).toMatchObject({
        body: JSON.stringify({ addLabelIds: ['X'], removeLabelIds: ['Y'] })
      })

      const tooMany = Array.from({ length: 101 }, (_, index) => `Label_${index}`)

      const rejected = yield* gmailBatchModifyLabelsAction
        .execute({ integration, input: { messageIds: ['a'], addLabelIds: tooMany } })
        .pipe(Effect.provide(host.layer), Effect.result)

      expect(rejected._tag).toBe('Failure')

      const missing = yield* gmailBatchModifyLabelsAction
        .execute({ integration, input: { messageIds: ['a'] } })
        .pipe(Effect.provide(host.layer), Effect.result)

      expect(missing._tag).toBe('Failure')
      expect(host.requests).toHaveLength(1)
    })
  )

  it.effect('trashes and untrashes with individual requests and no bulk endpoints', () =>
    Effect.gen(function* () {
      const host = makeHost([
        { status: 200, body: '{"id":"a","labelIds":["TRASH"]}' },
        { status: 200, body: '{"id":"b","labelIds":[]}' }
      ])

      const trashed = yield* gmailBatchTrashAction
        .execute({ integration, input: { messageIds: ['a'] } })
        .pipe(Effect.provide(host.layer))

      expect(trashed).toMatchObject({
        value: { results: [{ messageId: 'a', status: 'succeeded' }] }
      })

      const untrashed = yield* gmailBatchUntrashAction
        .execute({ integration, input: { messageIds: ['b'] } })
        .pipe(Effect.provide(host.layer))

      expect(untrashed).toMatchObject({
        value: { results: [{ messageId: 'b', status: 'succeeded' }] }
      })
      expect(host.requests).toMatchObject([
        { method: 'POST', url: expect.stringContaining('/messages/a/trash') },
        { method: 'POST', url: expect.stringContaining('/messages/b/untrash') }
      ])
      expect(JSON.stringify(host.requests)).not.toContain('batchModify')
      expect(JSON.stringify(host.requests)).not.toContain('batchDelete')
    })
  )

  it.effect('deletes permanently with 204, full-mail scope, and honest 404s', () =>
    Effect.gen(function* () {
      const host = makeHost([
        { status: 204, body: '' },
        { status: 404, body: '{"error":{"message":"not found"}}' }
      ])

      const result = yield* gmailDeletePermanentlyAction
        .execute({ integration, input: { messageIds: ['a', 'b'] } })
        .pipe(Effect.provide(host.layer))

      expect(result).toMatchObject({
        value: {
          results: [
            { messageId: 'a', status: 'succeeded' },
            { messageId: 'b', status: 'failed', code: 'not_found' }
          ],
          summary: { requested: 2, succeeded: 1, failed: 1, unknown: 0, notAttempted: 0 }
        }
      })
      expect(host.requests).toMatchObject([
        { method: 'DELETE', url: expect.stringContaining('/messages/a') },
        { method: 'DELETE', url: expect.stringContaining('/messages/b') }
      ])
      expect(host.scopes).toEqual([[googleGmailFullMailScope]])
    })
  )

  it.effect('maps quota reasons to rate_limited without leaking provider text', () =>
    Effect.gen(function* () {
      const secret = 'quota-secret-detail'

      const host = makeHost([
        {
          status: 403,
          body: JSON.stringify({
            error: { message: secret, errors: [{ reason: 'rateLimitExceeded' }] }
          })
        },
        { status: 200, body: '{"id":"b"}' }
      ])

      const result = yield* gmailBatchSetReadAction
        .execute({ integration, input: { messageIds: ['a', 'b'], isRead: true } })
        .pipe(Effect.provide(host.layer))

      expect(result).toMatchObject({
        value: {
          results: [
            { messageId: 'a', status: 'failed', code: 'rate_limited' },
            { messageId: 'b', status: 'not_attempted', code: 'batch_stopped' }
          ]
        }
      })
      expect(JSON.stringify(result)).not.toContain(secret)
    })
  )
})
