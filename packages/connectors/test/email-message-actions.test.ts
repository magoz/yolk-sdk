import { describe, expect, it } from '@effect/vitest'
import { Effect, Layer, Predicate } from 'effect'
import { resolveTools } from '@yolk-sdk/agent/tools'
import {
  ActionResult,
  ConnectorError,
  CredentialResolver,
  makeCredentialBinding,
  makeIntegration,
  UsernamePasswordCredential
} from '@yolk-sdk/connectors'
import { makeConnectorToolModule } from '@yolk-sdk/connectors/agent'
import {
  EmailClient,
  EmailConnector,
  EmailFolderName,
  EmailIncomingCredentialSlot,
  emailSetReadAction,
  emailTrashAction,
  emailUntrashAction,
  type EmailClientApi,
  type EmailSetReadRequest,
  type EmailTrashRequest,
  type EmailUntrashRequest
} from '@yolk-sdk/connectors/email'

const integration = makeIntegration({
  connectorId: 'email',
  config: { incomingHost: 'imap.example.com' },
  credentialBindings: [
    makeCredentialBinding({ slotId: EmailIncomingCredentialSlot.id, credentialRef: 'incoming' })
  ]
})

const credential = UsernamePasswordCredential.make({
  _tag: 'UsernamePasswordCredential',
  username: 'alice@example.com',
  password: 'password'
})

const unused = () => Effect.die(new Error('Unexpected legacy email operation'))

const legacyClient: EmailClientApi = {
  listMessages: unused,
  getMessage: unused,
  createDraft: unused,
  sendMessage: unused
}

const makeHost = (methods: Partial<EmailClientApi> = {}) => {
  const refs: Array<string> = []

  const layer = Layer.mergeAll(
    Layer.succeed(EmailClient, { ...legacyClient, ...methods }),
    Layer.succeed(CredentialResolver, {
      resolve: request => {
        refs.push(request.binding.credentialRef)

        return Effect.succeed(credential)
      }
    })
  )

  return { refs, layer }
}

const actions = [emailSetReadAction, emailTrashAction, emailUntrashAction]

describe('generic email message actions', () => {
  it.effect('registers provider-safe tools with write/destructive access', () =>
    Effect.gen(function* () {
      const host = makeHost()

      const tools = yield* resolveTools(
        [makeConnectorToolModule(EmailConnector, { integration, layer: host.layer })],
        {}
      )

      expect(actions.map(action => action.access)).toEqual(['write', 'destructive', 'write'])

      for (const action of actions) {
        expect(EmailConnector.actions).toContain(action)
        expect(tools.tools.find(tool => tool.name === action.id)?.parameters).toMatchObject({
          type: 'object'
        })
      }
    })
  )

  for (const isRead of [true, false]) {
    for (const folder of [undefined, 'Archive']) {
      it.effect(`sets read=${isRead} in ${folder ?? 'INBOX'} using incoming credentials`, () =>
        Effect.gen(function* () {
          const requests: Array<EmailSetReadRequest> = []

          const host = makeHost({
            setRead: request => {
              requests.push(request)

              return Effect.succeed(
                ActionResult.success({
                  messageId: request.messageId,
                  isRead: request.isRead
                })
              )
            }
          })

          const result = yield* EmailConnector.invoke({
            integration,
            action: 'email.set_read',
            input: { messageId: 'uid-1', folder, isRead }
          }).pipe(Effect.provide(host.layer))

          const expectedResultFields = { value: { messageId: 'uid-1', isRead } }
          expect(result._tag).toBe('Success')
          expect(result).toMatchObject(expectedResultFields)
          expect(requests).toMatchObject([
            {
              connection: {
                protocol: 'imap',
                host: 'imap.example.com',
                port: 993,
                security: 'tls'
              },
              credential,
              messageId: 'uid-1',
              folder: folder ?? 'INBOX',
              isRead
            }
          ])
          expect(host.refs).toEqual(['incoming'])
        })
      )
    }
  }

  for (const explicitFolders of [false, true]) {
    it.effect(`trashes with ${explicitFolders ? 'explicit folders' : 'host trash discovery'}`, () =>
      Effect.gen(function* () {
        const requests: Array<EmailTrashRequest> = []

        const host = makeHost({
          trash: request => {
            requests.push(request)

            return Effect.succeed(
              ActionResult.success({
                moved: true,
                folder: EmailFolderName.make('Deleted'),
                messageId: 'imap:456:789'
              })
            )
          }
        })

        const result = yield* emailTrashAction
          .execute({
            integration,
            input: {
              messageId: 'imap:123:1',
              ...(explicitFolders ? { folder: 'Archive', trashFolder: 'Deleted' } : {})
            }
          })
          .pipe(Effect.provide(host.layer))

        expect(result._tag).toBe('Success')
        expect(result).toMatchObject({
          value: { moved: true, folder: 'Deleted', messageId: 'imap:456:789' }
        })
        expect(requests).toMatchObject([
          {
            connection: { protocol: 'imap' },
            credential,
            messageId: 'imap:123:1',
            folder: explicitFolders ? 'Archive' : 'INBOX'
          }
        ])
        expect(requests[0]?.trashFolder).toBe(explicitFolders ? 'Deleted' : undefined)
        expect(host.refs).toEqual(['incoming'])
      })
    )

    it.effect(
      `restores with ${explicitFolders ? 'explicit folders' : 'trash discovery and INBOX default'}`,
      () =>
        Effect.gen(function* () {
          const requests: Array<EmailUntrashRequest> = []

          const host = makeHost({
            untrash: request => {
              requests.push(request)

              return Effect.succeed(
                ActionResult.success({ moved: true, folder: request.destinationFolder })
              )
            }
          })

          const result = yield* emailUntrashAction
            .execute({
              integration,
              input: {
                messageId: 'trash-uid',
                ...(explicitFolders ? { folder: 'Deleted', destinationFolder: 'Archive' } : {})
              }
            })
            .pipe(Effect.provide(host.layer))

          const expectedResultFields = {
            value: { moved: true, folder: explicitFolders ? 'Archive' : 'INBOX' }
          }

          expect(result._tag).toBe('Success')
          expect(result).toMatchObject(expectedResultFields)

          if (Predicate.isTagged(result, 'Success'))
            expect(result.value).not.toHaveProperty('messageId')
          expect(requests).toMatchObject([
            {
              connection: { protocol: 'imap' },
              credential,
              messageId: 'trash-uid',
              destinationFolder: explicitFolders ? 'Archive' : 'INBOX'
            }
          ])
          expect(requests[0]?.folder).toBe(explicitFolders ? 'Deleted' : undefined)
          expect(host.refs).toEqual(['incoming'])
        })
    )
  }

  for (const action of actions) {
    it.effect(`${action.id} fails clearly for old adapters without mutation methods`, () =>
      Effect.gen(function* () {
        const host = makeHost()

        const result = yield* action
          .execute({
            integration,
            input: { messageId: 'id', isRead: true }
          })
          .pipe(Effect.provide(host.layer), Effect.result)

        const expectedResultFields = {
          failure: {
            cause: 'validation_failed',
            message: expect.stringContaining('EmailClient does not support')
          }
        }

        expect(result._tag).toBe('Failure')
        expect(result).toMatchObject(expectedResultFields)
      })
    )

    it.effect(`${action.id} rejects POP3 before credential resolution or adapter calls`, () =>
      Effect.gen(function* () {
        const host = makeHost({ setRead: unused, trash: unused, untrash: unused })

        const result = yield* action
          .execute({
            integration: makeIntegration({
              connectorId: 'email',
              config: { incomingProtocol: 'pop3', incomingHost: 'pop.example.com' },
              credentialBindings: integration.credentialBindings
            }),
            input: { messageId: 'id', isRead: true }
          })
          .pipe(Effect.provide(host.layer), Effect.result)

        const expectedResultFields = {
          failure: {
            cause: 'validation_failed',
            message: expect.stringContaining('requires IMAP')
          }
        }

        expect(result._tag).toBe('Failure')
        expect(result).toMatchObject(expectedResultFields)
        expect(host.refs).toEqual([])
      })
    )

    it.effect(`${action.id} preserves expected host failures`, () =>
      Effect.gen(function* () {
        const failure = ActionResult.failure({ code: 'not_found', message: 'Missing UID' })

        const host = makeHost({
          setRead: () => Effect.succeed(failure),
          trash: () => Effect.succeed(failure),
          untrash: () => Effect.succeed(failure)
        })

        const result = yield* action
          .execute({
            integration,
            input: { messageId: 'id', isRead: true }
          })
          .pipe(Effect.provide(host.layer))

        expect(result).toEqual(failure)
      })
    )

    it.effect(`${action.id} preserves transport errors`, () =>
      Effect.gen(function* () {
        const error = new ConnectorError({ cause: 'transport_failed', message: 'Disconnected' })
        const fail = () => Effect.fail(error)
        const host = makeHost({ setRead: fail, trash: fail, untrash: fail })

        const result = yield* action
          .execute({
            integration,
            input: { messageId: 'id', isRead: true }
          })
          .pipe(Effect.provide(host.layer), Effect.result)

        const expectedResultFields = { failure: error }
        expect(result._tag).toBe('Failure')
        expect(result).toMatchObject(expectedResultFields)
      })
    )

    it.effect(`${action.id} validates host success output`, () =>
      Effect.gen(function* () {
        const invalidMove = () =>
          Effect.succeed(
            ActionResult.success({
              moved: true as const,
              folder: EmailFolderName.make('Trash'),
              messageId: ''
            })
          )

        const host = makeHost({
          setRead: () => Effect.succeed(ActionResult.success({ messageId: '', isRead: true })),
          trash: invalidMove,
          untrash: invalidMove
        })

        const result = yield* action
          .execute({
            integration,
            input: { messageId: 'id', isRead: true }
          })
          .pipe(Effect.provide(host.layer), Effect.result)

        expect(result._tag).toBe('Failure')
        expect(result).toMatchObject({ failure: { cause: 'validation_failed' } })
      })
    )

    it.effect(`${action.id} rejects empty identifiers and folders before IO`, () =>
      Effect.gen(function* () {
        const host = makeHost({ setRead: unused, trash: unused, untrash: unused })

        for (const input of [
          { messageId: '', isRead: true },
          { messageId: 'id', folder: '', isRead: true }
        ]) {
          const result = yield* action
            .execute({ integration, input })
            .pipe(Effect.provide(host.layer), Effect.result)

          expect(result._tag).toBe('Failure')
          expect(result).toMatchObject({ failure: { cause: 'validation_failed' } })
        }

        expect(host.refs).toEqual([])
      })
    )
  }

  it.effect('rejects invalid read state and destination folders', () =>
    Effect.gen(function* () {
      const host = makeHost({ setRead: unused, trash: unused, untrash: unused })

      for (const [action, input] of [
        [emailSetReadAction, { messageId: 'id' }],
        [emailSetReadAction, { messageId: 'id', isRead: 'false' }],
        [emailTrashAction, { messageId: 'id', trashFolder: '' }],
        [emailUntrashAction, { messageId: 'id', destinationFolder: '' }]
      ] as const) {
        const result = yield* action
          .execute({ integration, input })
          .pipe(Effect.provide(host.layer), Effect.result)

        expect(result._tag).toBe('Failure')
      }

      expect(host.refs).toEqual([])
    })
  )
})
