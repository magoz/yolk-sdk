import { describe, expect, it } from '@effect/vitest'
import { Chunk, Effect, Layer } from 'effect'
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
  outlookCreateDraftAction,
  outlookGetAttachmentAction,
  outlookListAttachmentsAction,
  outlookListMessagesAction,
  outlookSendMailAction,
  outlookSetReadAction,
  outlookTrashAction,
  outlookUntrashAction
} from '@yolk-sdk/connectors/microsoft'

const integration = makeIntegration({
  connectorId: 'microsoft',
  credentialBindings: [
    makeCredentialBinding({ slotId: microsoftOAuthSlotId, credentialRef: 'microsoft-account' })
  ]
})

const makeHost = (body = '{"id":"updated-id","isRead":true}', status = 200) => {
  const requests: Array<ConnectorHttpRequest> = []
  const scopes: Array<ReadonlyArray<string> | undefined> = []

  const layer = Layer.mergeAll(
    Layer.succeed(CredentialResolver, {
      resolve: request => {
        scopes.push(request.slot.requiredScopes)

        return Effect.succeed(
          OAuthCredential.make({
            _tag: 'OAuthCredential',
            provider: 'microsoft',
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

const actions = [outlookSetReadAction, outlookTrashAction, outlookUntrashAction]

describe('Outlook message actions', () => {
  it.effect('registers mutation actions with provider-safe tool schemas and access metadata', () =>
    Effect.gen(function* () {
      const host = makeHost()

      const tools = yield* resolveTools(
        [makeConnectorToolModule(MicrosoftConnector, { integration, layer: host.layer })],
        {}
      )

      expect(actions.map(action => action.access)).toEqual(['write', 'destructive', 'write'])

      for (const action of actions) {
        expect(MicrosoftConnector.actions).toContain(action)
        expect(tools.tools.find(tool => tool.name === action.id)?.parameters).toMatchObject({
          type: 'object'
        })
      }
    })
  )

  for (const isRead of [true, false]) {
    it.effect(`sets isRead=${isRead} using PATCH and Mail.ReadWrite`, () =>
      Effect.gen(function* () {
        const host = makeHost(JSON.stringify({ id: 'message/id', isRead }))

        const result = yield* MicrosoftConnector.invoke({
          integration,
          action: 'outlook.set_read',
          input: { messageId: 'message/id', isRead }
        }).pipe(Effect.provide(host.layer))

        const expectedResultFields = { value: { id: 'message/id', isRead } }
        expect(result._tag).toBe('Success')
        expect(result).toMatchObject(expectedResultFields)
        expect(host.requests).toMatchObject([
          {
            method: 'PATCH',
            url: 'https://graph.microsoft.com/v1.0/me/messages/message%2Fid',
            body: JSON.stringify({ isRead }),
            headers: {
              authorization: 'Bearer token',
              'content-type': 'application/json',
              prefer: 'IdType="ImmutableId"'
            }
          }
        ])
        expect(host.scopes).toEqual([['https://graph.microsoft.com/Mail.ReadWrite']])
      })
    )
  }

  it.effect('trashes by moving to Deleted Items and returns the provider message ID', () =>
    Effect.gen(function* () {
      const host = makeHost('{"id":"moved-id","parentFolderId":"trash-id"}', 201)

      const result = yield* outlookTrashAction
        .execute({
          integration,
          input: { messageId: 'old-id' }
        })
        .pipe(Effect.provide(host.layer))

      expect(result._tag).toBe('Success')
      expect(result).toMatchObject({ value: { id: 'moved-id', parentFolderId: 'trash-id' } })
      expect(host.requests).toMatchObject([
        {
          method: 'POST',
          url: 'https://graph.microsoft.com/v1.0/me/messages/old-id/move',
          body: JSON.stringify({ destinationId: 'deleteditems' }),
          headers: { prefer: 'IdType="ImmutableId"' }
        }
      ])
    })
  )

  for (const destinationFolderId of [undefined, 'folder/id']) {
    it.effect(`restores from Deleted Items to ${destinationFolderId ?? 'inbox'}`, () =>
      Effect.gen(function* () {
        const host = makeHost('{"id":"restored-id"}', 201)

        const result = yield* outlookUntrashAction
          .execute({
            integration,
            input: { messageId: 'trash/id', destinationFolderId }
          })
          .pipe(Effect.provide(host.layer))

        expect(result._tag).toBe('Success')
        expect(result).toMatchObject({ value: { id: 'restored-id' } })
        expect(host.requests).toMatchObject([
          {
            method: 'POST',
            url: 'https://graph.microsoft.com/v1.0/me/mailFolders/deleteditems/messages/trash%2Fid/move',
            body: JSON.stringify({ destinationId: destinationFolderId ?? 'inbox' })
          }
        ])
      })
    )
  }

  for (const action of actions) {
    for (const mode of ['delegated', 'application']) {
      it.effect(`${action.id} honors ${mode} mailbox permissions and encodes mailbox paths`, () =>
        Effect.gen(function* () {
          const host = makeHost()

          const configured = makeIntegration({
            connectorId: 'microsoft',
            credentialBindings: integration.credentialBindings,
            config: { mailboxAccessMode: mode }
          })

          const result = yield* action
            .execute({
              integration: configured,
              input: { mailbox: 'shared@example.com', messageId: 'a/b', isRead: false }
            })
            .pipe(Effect.provide(host.layer))

          expect(result._tag).toBe('Success')
          expect(host.requests[0]?.url).toContain('/users/shared%40example.com/')
          expect(host.requests[0]?.url).toContain('/messages/a%2Fb')
          expect(host.scopes).toEqual([
            [
              mode === 'delegated'
                ? 'https://graph.microsoft.com/Mail.ReadWrite.Shared'
                : 'https://graph.microsoft.com/Mail.ReadWrite'
            ]
          ])
        })
      )
    }

    it.effect(`${action.id} rejects application access without a mailbox before IO`, () =>
      Effect.gen(function* () {
        const host = makeHost()

        const result = yield* action
          .execute({
            integration: makeIntegration({
              connectorId: 'microsoft',
              config: { mailboxAccessMode: 'application' },
              credentialBindings: integration.credentialBindings
            }),
            input: { messageId: 'id', isRead: true }
          })
          .pipe(Effect.provide(host.layer), Effect.result)

        expect(result._tag).toBe('Failure')
        expect(result).toMatchObject({ failure: { cause: 'validation_failed' } })
        expect(host.requests).toEqual([])
        expect(host.scopes).toEqual([])
      })
    )

    for (const [status, code] of [
      [401, 'microsoft_unauthorized'],
      [403, 'microsoft_unauthorized'],
      [404, 'microsoft_not_found'],
      [429, 'microsoft_rate_limited'],
      [500, `${action.id.replace('.', '_')}_failed`]
    ] as const) {
      it.effect(`${action.id} preserves provider failure at HTTP ${status}`, () =>
        Effect.gen(function* () {
          const host = makeHost('{"error":{"code":"ErrorAccessDenied","message":"Denied"}}', status)

          const result = yield* action
            .execute({
              integration,
              input: { messageId: 'id', isRead: true }
            })
            .pipe(Effect.provide(host.layer))

          const expectedResultFields = { error: { code, status } }
          expect(result._tag).toBe('Failure')
          expect(result).toMatchObject(expectedResultFields)
        })
      )
    }

    it.effect(`${action.id} rejects malformed successful provider output`, () =>
      Effect.gen(function* () {
        const host = makeHost('{}')

        const result = yield* action
          .execute({
            integration,
            input: { messageId: 'id', isRead: true }
          })
          .pipe(Effect.provide(host.layer), Effect.result)

        expect(result._tag).toBe('Failure')
      })
    )

    it.effect(`${action.id} rejects empty identifiers before credentials or HTTP`, () =>
      Effect.gen(function* () {
        const host = makeHost()

        for (const input of [
          { messageId: '', isRead: true },
          { messageId: 'id', mailbox: '', isRead: true }
        ]) {
          const result = yield* action
            .execute({ integration, input })
            .pipe(Effect.provide(host.layer), Effect.result)

          expect(result._tag).toBe('Failure')
          expect(result).toMatchObject({ failure: { cause: 'validation_failed' } })
        }

        expect(host.requests).toEqual([])
        expect(host.scopes).toEqual([])
      })
    )
  }

  it.effect('requires a boolean read state and nonempty restore destination', () =>
    Effect.gen(function* () {
      const host = makeHost()

      for (const input of [{ messageId: 'id' }, { messageId: 'id', isRead: 'false' }]) {
        const result = yield* outlookSetReadAction
          .execute({ integration, input })
          .pipe(Effect.provide(host.layer), Effect.result)

        expect(result._tag).toBe('Failure')
      }

      const result = yield* outlookUntrashAction
        .execute({
          integration,
          input: { messageId: 'id', destinationFolderId: '' }
        })
        .pipe(Effect.provide(host.layer), Effect.result)

      expect(result._tag).toBe('Failure')
      expect(host.requests).toEqual([])
    })
  )

  it.effect('omits Outlook sendMail optionals and preserves JSON key order', () =>
    Effect.gen(function* () {
      const host = makeHost('', 202)

      yield* outlookSendMailAction
        .execute({
          integration,
          input: {
            to: ['lead@example.com'],
            subject: 'Hello',
            body: 'Welcome'
          }
        })
        .pipe(Effect.provide(host.layer))

      expect(host.requests.at(0)?.body).toBe(
        '{"message":{"subject":"Hello","body":{"contentType":"Text","content":"Welcome"},"toRecipients":[{"emailAddress":{"address":"lead@example.com"}}]}}'
      )
    })
  )

  it.effect('keeps Outlook false saveToSentItems and empty cc/bcc arrays on the wire', () =>
    Effect.gen(function* () {
      const host = makeHost('', 202)

      yield* outlookSendMailAction
        .execute({
          integration,
          input: {
            mailbox: 'shared@example.com',
            to: ['lead@example.com'],
            subject: 'Hello',
            body: 'Welcome',
            cc: [],
            bcc: [],
            saveToSentItems: false
          }
        })
        .pipe(Effect.provide(host.layer))

      expect(host.requests.at(0)?.body).toBe(
        '{"message":{"subject":"Hello","body":{"contentType":"Text","content":"Welcome"},"toRecipients":[{"emailAddress":{"address":"lead@example.com"}}],"from":{"emailAddress":{"address":"shared@example.com"}},"ccRecipients":[],"bccRecipients":[]},"saveToSentItems":false}'
      )
    })
  )

  it.effect(
    'reads Outlook sendMail input getters once in schema field order before the wire body',
    () =>
      Effect.gen(function* () {
        const accesses: Array<string> = []
        const host = makeHost('', 202)

        const input = {
          get mailbox() {
            accesses.push('mailbox')

            return 'shared@example.com'
          },
          get to() {
            accesses.push('to')

            return ['lead@example.com']
          },
          get subject() {
            accesses.push('subject')

            return 'Hello'
          },
          get body() {
            accesses.push('body')

            return 'Welcome'
          },
          get contentType(): 'html' {
            accesses.push('contentType')

            return 'html'
          },
          get cc() {
            accesses.push('cc')

            return ['team@example.com']
          },
          get bcc() {
            accesses.push('bcc')

            return ['hidden@example.com']
          },
          get saveToSentItems() {
            accesses.push('saveToSentItems')

            return false
          }
        }

        yield* outlookSendMailAction
          .execute({ integration, input })
          .pipe(Effect.provide(host.layer))

        expect(accesses).toEqual([
          'mailbox',
          'to',
          'subject',
          'body',
          'contentType',
          'cc',
          'bcc',
          'saveToSentItems'
        ])
        expect(host.requests.at(0)?.body).toBe(
          '{"message":{"subject":"Hello","body":{"contentType":"HTML","content":"Welcome"},"toRecipients":[{"emailAddress":{"address":"lead@example.com"}}],"from":{"emailAddress":{"address":"shared@example.com"}},"ccRecipients":[{"emailAddress":{"address":"team@example.com"}}],"bccRecipients":[{"emailAddress":{"address":"hidden@example.com"}}]},"saveToSentItems":false}'
        )
      })
  )

  it.effect('omits Outlook draft from/cc/bcc when absent and preserves create-draft JSON', () =>
    Effect.gen(function* () {
      const host = makeHost('{"id":"draft_1","isDraft":true}')

      yield* outlookCreateDraftAction
        .execute({
          integration,
          input: {
            to: ['lead@example.com'],
            subject: 'Draft',
            body: 'Body'
          }
        })
        .pipe(Effect.provide(host.layer))

      expect(host.requests.at(0)?.body).toBe(
        '{"subject":"Draft","body":{"contentType":"Text","content":"Body"},"toRecipients":[{"emailAddress":{"address":"lead@example.com"}}]}'
      )
    })
  )

  it.effect('omits Outlook list nextLink and includes false/0/null attachment fields', () =>
    Effect.gen(function* () {
      const listHost = makeHost('{"value":[{"id":"message_1"}]}')

      const attachmentHost = makeHost(
        JSON.stringify({
          value: [
            {
              '@odata.type': '#microsoft.graph.fileAttachment',
              id: 'attachment_1',
              name: null,
              size: 0,
              isInline: false
            }
          ]
        })
      )

      const listResult = yield* outlookListMessagesAction
        .execute({
          integration,
          input: {}
        })
        .pipe(Effect.provide(listHost.layer))

      const attachmentResult = yield* outlookListAttachmentsAction
        .execute({
          integration,
          input: { messageId: 'message_1' }
        })
        .pipe(Effect.provide(attachmentHost.layer))

      expect(listResult._tag).toBe('Success')
      expect(listResult).toMatchObject({
        value: { messages: [{ id: 'message_1' }] }
      })
      expect(JSON.stringify(listResult)).toBe(
        '{"_tag":"Success","value":{"messages":[{"id":"message_1"}]}}'
      )

      expect(attachmentResult._tag).toBe('Success')
      expect(attachmentResult).toMatchObject({
        value: {
          attachments: Chunk.fromIterable([
            {
              id: 'attachment_1',
              kind: 'file',
              name: null,
              size: 0,
              isInline: false
            }
          ])
        }
      })

      expect(JSON.stringify(attachmentResult)).toContain(
        '"id":"attachment_1","kind":"file","name":null,"size":0,"isInline":false'
      )
      expect(JSON.stringify(attachmentResult)).not.toContain('contentType')
      expect(JSON.stringify(attachmentResult)).not.toContain('contentId')
      expect(JSON.stringify(attachmentResult)).not.toContain('lastModifiedDateTime')
    })
  )

  it.effect('preserves Outlook attachment contentBase64 last and zero-byte file payloads', () =>
    Effect.gen(function* () {
      const host = makeHost(
        JSON.stringify({
          '@odata.type': '#microsoft.graph.fileAttachment',
          id: 'attachment_1',
          contentBytes: ''
        })
      )

      const result = yield* outlookGetAttachmentAction
        .execute({
          integration,
          input: { messageId: 'message_1', attachmentId: 'attachment_1' }
        })
        .pipe(Effect.provide(host.layer))

      expect(result._tag).toBe('Success')
      expect(result).toMatchObject({
        value: {
          attachment: {
            id: 'attachment_1',
            kind: 'file',
            contentBase64: ''
          }
        }
      })

      expect(JSON.stringify(result)).toBe(
        '{"_tag":"Success","value":{"attachment":{"id":"attachment_1","kind":"file","contentBase64":""}}}'
      )
    })
  )

  it.effect('keeps Outlook nextLink error fields without sending HTTP', () =>
    Effect.gen(function* () {
      const host = makeHost()

      const result = yield* outlookListMessagesAction
        .execute({
          integration,
          input: { nextLink: 'https://example.com/v1.0/me/messages' }
        })
        .pipe(Effect.provide(host.layer), Effect.result)

      expect(host.requests).toHaveLength(0)
      expect(result._tag).toBe('Failure')
      expect(result).toMatchObject({
        failure: {
          cause: 'validation_failed',
          message:
            'Microsoft Graph nextLink must target the selected v1.0 mailbox folder collection',
          connectorId: 'microsoft',
          actionId: 'outlook.list_messages'
        }
      })
    })
  )
})
