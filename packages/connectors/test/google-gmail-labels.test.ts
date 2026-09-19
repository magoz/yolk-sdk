import { describe, expect, it } from '@effect/vitest'
import { Effect, Layer, Match, Predicate, Result } from 'effect'
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
  gmailCreateLabelAction,
  gmailDeleteLabelAction,
  gmailGetLabelAction,
  gmailListLabelsAction,
  gmailModifyLabelsAction,
  gmailUpdateLabelAction,
  GoogleConnector,
  googleGmailModifyScope,
  googleGmailReadonlyScope,
  googleOAuthSlotId
} from '@yolk-sdk/connectors/google'

const integration = makeIntegration({
  connectorId: 'google',
  credentialBindings: [
    makeCredentialBinding({ slotId: googleOAuthSlotId, credentialRef: 'google-account' })
  ]
})

const makeHost = (body = '{}', status = 200) => {
  const requests: Array<ConnectorHttpRequest> = []
  const scopes: Array<ReadonlyArray<string> | undefined> = []

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

        return Effect.succeed(ConnectorHttpResponse.make({ status, headers: {}, body }))
      }
    })
  )

  return { layer, requests, scopes }
}

const labelBody = JSON.stringify({
  id: 'Label_123',
  name: 'Receipts',
  type: 'user',
  messageListVisibility: 'show',
  labelListVisibility: 'labelShow'
})

describe('Gmail label actions', () => {
  it.effect('registers label actions with explicit access metadata', () =>
    Effect.gen(function* () {
      const actions = [
        gmailCreateLabelAction,
        gmailGetLabelAction,
        gmailUpdateLabelAction,
        gmailDeleteLabelAction
      ]

      expect(actions.map(action => action.id)).toEqual([
        'gmail.create_label',
        'gmail.get_label',
        'gmail.update_label',
        'gmail.delete_label'
      ])
      expect(actions.map(action => action.access)).toEqual([
        'write',
        'read',
        'write',
        'destructive'
      ])

      for (const action of actions) {
        expect(GoogleConnector.actions).toContain(action)
      }

      expect(gmailModifyLabelsAction.access).toBe('write')
      expect(GoogleConnector.actions).toContain(gmailModifyLabelsAction)
    })
  )

  it.effect('creates a label with the modify scope and a typed output', () =>
    Effect.gen(function* () {
      const host = makeHost(labelBody)

      const result = yield* gmailCreateLabelAction
        .execute({
          integration,
          input: {
            name: 'Receipts',
            messageListVisibility: 'show',
            labelListVisibility: 'labelShow'
          }
        })
        .pipe(Effect.provide(host.layer))

      expect(result._tag).toBe('Success')
      expect(result).toMatchObject({
        value: {
          id: 'Label_123',
          name: 'Receipts',
          type: 'user',
          messageListVisibility: 'show',
          labelListVisibility: 'labelShow'
        }
      })
      expect(host.requests).toMatchObject([
        {
          method: 'POST',
          url: 'https://gmail.googleapis.com/gmail/v1/users/me/labels',
          body: JSON.stringify({
            name: 'Receipts',
            messageListVisibility: 'show',
            labelListVisibility: 'labelShow'
          }),
          headers: {
            authorization: 'Bearer token',
            'content-type': 'application/json'
          }
        }
      ])
      expect(host.scopes).toEqual([[googleGmailModifyScope]])
    })
  )

  it.effect('gets a label with the readonly scope', () =>
    Effect.gen(function* () {
      const host = makeHost(labelBody)

      const result = yield* gmailGetLabelAction
        .execute({ integration, input: { id: 'Label_123' } })
        .pipe(Effect.provide(host.layer))

      expect(result._tag).toBe('Success')
      expect(result).toMatchObject({ value: { id: 'Label_123', name: 'Receipts' } })
      expect(host.requests).toMatchObject([
        {
          method: 'GET',
          url: 'https://gmail.googleapis.com/gmail/v1/users/me/labels/Label_123'
        }
      ])
      expect(host.scopes).toEqual([[googleGmailReadonlyScope]])
    })
  )

  it.effect('encodes complete label path ids', () =>
    Effect.gen(function* () {
      const host = makeHost(labelBody)

      yield* gmailGetLabelAction
        .execute({ integration, input: { id: 'Label/1' } })
        .pipe(Effect.provide(host.layer))

      expect(host.requests.at(0)?.url).toBe(
        'https://gmail.googleapis.com/gmail/v1/users/me/labels/Label%2F1'
      )
    })
  )

  it.effect('renames a label with PATCH and the modify scope', () =>
    Effect.gen(function* () {
      const host = makeHost(JSON.stringify({ id: 'Label_123', name: 'Invoices', type: 'user' }))

      const result = yield* gmailUpdateLabelAction
        .execute({ integration, input: { id: 'Label_123', name: 'Invoices' } })
        .pipe(Effect.provide(host.layer))

      expect(result._tag).toBe('Success')
      expect(result).toMatchObject({ value: { id: 'Label_123', name: 'Invoices' } })
      expect(host.requests).toMatchObject([
        {
          method: 'PATCH',
          url: 'https://gmail.googleapis.com/gmail/v1/users/me/labels/Label_123',
          body: JSON.stringify({ name: 'Invoices' }),
          headers: {
            authorization: 'Bearer token',
            'content-type': 'application/json'
          }
        }
      ])
      expect(host.scopes).toEqual([[googleGmailModifyScope]])
    })
  )

  it.effect('deletes a label without decoding the empty 204 body', () =>
    Effect.gen(function* () {
      const host = makeHost('', 204)

      const result = yield* gmailDeleteLabelAction
        .execute({ integration, input: { id: 'Label_123' } })
        .pipe(Effect.provide(host.layer))

      expect(result._tag).toBe('Success')
      expect(result).toMatchObject({ value: { id: 'Label_123', deleted: true } })
      expect(host.requests).toMatchObject([
        {
          method: 'DELETE',
          url: 'https://gmail.googleapis.com/gmail/v1/users/me/labels/Label_123'
        }
      ])
      expect(host.scopes).toEqual([[googleGmailModifyScope]])
    })
  )

  it.effect('modifies message labels with add and remove ids', () =>
    Effect.gen(function* () {
      const host = makeHost('{"id":"message_1","labelIds":["Label_123"]}')

      const result = yield* gmailModifyLabelsAction
        .execute({
          integration,
          input: {
            messageId: 'message_1',
            addLabelIds: ['Label_123'],
            removeLabelIds: ['INBOX']
          }
        })
        .pipe(Effect.provide(host.layer))

      expect(result._tag).toBe('Success')
      expect(host.requests).toMatchObject([
        {
          method: 'POST',
          url: 'https://gmail.googleapis.com/gmail/v1/users/me/messages/message_1/modify',
          body: JSON.stringify({
            addLabelIds: ['Label_123'],
            removeLabelIds: ['INBOX']
          })
        }
      ])
      expect(host.scopes).toEqual([[googleGmailModifyScope]])
    })
  )

  it.effect('lists labels with the readonly scope', () =>
    Effect.gen(function* () {
      const host = makeHost('{"labels":[]}')

      const result = yield* gmailListLabelsAction
        .execute({ integration, input: {} })
        .pipe(Effect.provide(host.layer))

      expect(result._tag).toBe('Success')
      expect(host.requests).toMatchObject([
        {
          method: 'GET',
          url: 'https://gmail.googleapis.com/gmail/v1/users/me/labels'
        }
      ])
      expect(host.scopes).toEqual([[googleGmailReadonlyScope]])
    })
  )

  it.effect('rejects invalid label inputs', () =>
    Effect.gen(function* () {
      const cases: ReadonlyArray<{
        readonly action: 'create' | 'id' | 'update'
        readonly input: unknown
      }> = [
        { action: 'create', input: { name: '' } },
        { action: 'create', input: { name: '   ' } },
        { action: 'create', input: { name: 'Receipts', messageListVisibility: 'everywhere' } },
        { action: 'id', input: { id: '' } },
        { action: 'id', input: { id: '.' } },
        { action: 'id', input: { id: '..' } },
        { action: 'id', input: { id: 'has space' } },
        { action: 'update', input: { id: 'Label_123' } },
        { action: 'update', input: { id: '.', name: 'Invoices' } },
        { action: 'update', input: { id: 'Label_123', name: '' } }
      ]

      for (const testCase of cases) {
        const effect = Match.value(testCase.action).pipe(
          Match.when('create', () =>
            gmailCreateLabelAction.execute({ integration, input: testCase.input })
          ),
          Match.when('update', () =>
            gmailUpdateLabelAction.execute({ integration, input: testCase.input })
          ),
          Match.when('id', () =>
            gmailDeleteLabelAction.execute({ integration, input: testCase.input })
          ),
          Match.exhaustive
        )

        const result = yield* effect.pipe(Effect.provide(makeHost().layer), Effect.result)

        expect(Result.isFailure(result)).toBe(true)

        if (Result.isFailure(result)) {
          expect(Predicate.isTagged(result.failure, 'ConnectorError')).toBe(true)
          expect(result.failure).toMatchObject({ cause: 'validation_failed' })
        }
      }
    })
  )

  it.effect('fails malformed label outputs as validation errors', () =>
    Effect.gen(function* () {
      const host = makeHost('{"name":"Receipts"}')

      const result = yield* gmailGetLabelAction
        .execute({ integration, input: { id: 'Label_123' } })
        .pipe(Effect.provide(host.layer), Effect.result)

      expect(Result.isFailure(result)).toBe(true)

      if (Result.isFailure(result)) {
        expect(Predicate.isTagged(result.failure, 'ConnectorError')).toBe(true)
        expect(result.failure).toMatchObject({ cause: 'validation_failed' })
      }
    })
  )

  it.effect('returns provider failures for label errors', () =>
    Effect.gen(function* () {
      const host = makeHost(
        '{"error":{"message":"Not found","errors":[{"reason":"notFound"}]}}',
        404
      )

      const result = yield* gmailGetLabelAction
        .execute({ integration, input: { id: 'Label_123' } })
        .pipe(Effect.provide(host.layer))

      expect(result._tag).toBe('Failure')
      expect(result).toMatchObject({
        error: { code: 'google_not_found', status: 404 }
      })
    })
  )
})
