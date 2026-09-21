import { describe, expect, it } from '@effect/vitest'
import { Effect, Layer, Predicate } from 'effect'
import * as Schema from 'effect/Schema'
import { resolveTools } from '@yolk-sdk/agent/tools'
import {
  ActionResult,
  CredentialResolver,
  makeCredentialBinding,
  makeIntegration,
  UsernamePasswordCredential
} from '@yolk-sdk/connectors'
import { makeConnectorToolModule } from '@yolk-sdk/connectors/agent'
import {
  EmailBatchModifyLabelsInput,
  EmailBatchMoveInput,
  EmailBatchMoveOutput,
  EmailBatchSetFlagInput,
  EmailBatchSetReadInput,
  EmailBatchTrashInput,
  EmailBatchUntrashInput,
  EmailClient,
  EmailConnector,
  EmailDeletePermanentlyInput,
  EmailFolderName,
  EmailIncomingCredentialSlot,
  EmailMessage,
  EmailMessageSummary,
  emailBatchModifyLabelsAction,
  emailBatchMoveAction,
  emailBatchSetFlagAction,
  emailBatchSetReadAction,
  emailBatchTrashAction,
  emailBatchUntrashAction,
  emailDeletePermanentlyAction,
  type EmailClientApi,
  type EmailListMessagesRequest
} from '@yolk-sdk/connectors/email'

const integration = makeIntegration({
  connectorId: 'email',
  config: { incomingHost: 'imap.example.com' },
  credentialBindings: [
    makeCredentialBinding({ slotId: EmailIncomingCredentialSlot.id, credentialRef: 'incoming' })
  ]
})

const credential = UsernamePasswordCredential.make({
  username: 'alice@example.com',
  password: 'password'
})

const message = {
  id: 'message-1',
  from: [{ address: 'sender@example.com' }],
  to: [{ address: 'alice@example.com' }],
  cc: [],
  bcc: [],
  replyTo: [],
  body: { text: 'Hello' },
  attachments: [],
  headers: [{ name: 'Subject', value: 'Hello' }]
}

const unused = () => Effect.die(new Error('Unexpected email operation'))

const legacyClient: EmailClientApi = {
  listMessages: () => Effect.succeed(ActionResult.success({ messages: [] })),
  getMessage: () => Effect.succeed(ActionResult.success({ message })),
  createDraft: unused,
  sendMessage: unused
}

const makeClientHost = (client: EmailClientApi) => {
  const refs: Array<string> = []

  const layer = Layer.mergeAll(
    Layer.succeed(EmailClient, client),
    Layer.succeed(CredentialResolver, {
      resolve: request => {
        refs.push(request.binding.credentialRef)

        return Effect.succeed(credential)
      }
    })
  )

  return { refs, layer }
}

const makeHost = (methods: Partial<EmailClientApi> = {}) =>
  makeClientHost({ ...legacyClient, ...methods })

const successfulBatch = (messageIds: ReadonlyArray<string>) =>
  ActionResult.success({
    results: messageIds.map(messageId => ({ messageId, status: 'succeeded' as const })),
    summary: {
      requested: messageIds.length,
      succeeded: messageIds.length,
      failed: 0,
      unknown: 0,
      notAttempted: 0
    }
  })

const successfulMoveBatch = (messageIds: ReadonlyArray<string>, folder: string) =>
  ActionResult.success(
    EmailBatchMoveOutput.make({
      results: messageIds.map(messageId => ({
        messageId,
        status: 'succeeded' as const,
        folder: EmailFolderName.make(folder)
      })),
      summary: {
        requested: messageIds.length,
        succeeded: messageIds.length,
        failed: 0,
        unknown: 0,
        notAttempted: 0
      }
    })
  )

const batchActions = [
  emailBatchSetReadAction,
  emailBatchSetFlagAction,
  emailBatchMoveAction,
  emailBatchTrashAction,
  emailBatchUntrashAction,
  emailBatchModifyLabelsAction,
  emailDeletePermanentlyAction
]

describe('generic email filters and batch actions', () => {
  it.effect(
    'keeps legacy list routing and preserves optional read/flag state on list and get',
    () =>
      Effect.gen(function* () {
        const legacyRequests: Array<EmailListMessagesRequest> = []

        const host = makeHost({
          listMessages: request => {
            legacyRequests.push(request)

            return Effect.succeed(
              ActionResult.success({
                messages: [
                  {
                    id: 'message-1',
                    from: [{ address: 'sender@example.com' }],
                    to: [{ address: 'alice@example.com' }],
                    hasAttachments: false,
                    isRead: false,
                    isFlagged: true
                  }
                ]
              })
            )
          },
          getMessage: () =>
            Effect.succeed(
              ActionResult.success({ message: { ...message, isRead: true, isFlagged: false } })
            )
        })

        const listed = yield* EmailConnector.invoke({
          integration,
          action: 'email.list_messages',
          input: {}
        }).pipe(Effect.provide(host.layer))

        const fetched = yield* EmailConnector.invoke({
          integration,
          action: 'email.get_message',
          input: { messageId: 'message-1' }
        }).pipe(Effect.provide(host.layer))

        expect(listed).toMatchObject({
          value: { messages: [{ isRead: false, isFlagged: true }] }
        })
        expect(fetched).toMatchObject({ value: { message: { isRead: true, isFlagged: false } } })
        expect(legacyRequests).toHaveLength(1)
        expect(legacyRequests[0]?.isRead).toBeUndefined()
        expect(legacyRequests[0]?.isFlagged).toBeUndefined()

        const oldSummary = yield* Schema.decodeUnknownEffect(EmailMessageSummary)({
          id: 'old',
          from: [],
          to: [],
          hasAttachments: false
        })

        const oldMessage = yield* Schema.decodeUnknownEffect(EmailMessage)(message)

        const stateSummary = yield* Schema.decodeUnknownEffect(EmailMessageSummary)({
          id: 'stateful',
          from: [],
          to: [],
          hasAttachments: false,
          isRead: true,
          isFlagged: false
        })

        expect(oldSummary.isRead).toBeUndefined()
        expect(oldMessage.isFlagged).toBeUndefined()
        expect(yield* Schema.encodeEffect(EmailMessageSummary)(stateSummary)).toMatchObject({
          isRead: true,
          isFlagged: false
        })
      })
  )

  it.effect('routes filtered lists only through listMessagesFiltered', () =>
    Effect.gen(function* () {
      const filteredRequests: Array<EmailListMessagesRequest> = []

      const host = makeHost({
        listMessages: unused,
        listMessagesFiltered: request => {
          filteredRequests.push(request)

          return Effect.succeed(ActionResult.success({ messages: [] }))
        }
      })

      const result = yield* EmailConnector.invoke({
        integration,
        action: 'email.list_messages',
        input: { folder: 'Archive', isRead: true, isFlagged: false }
      }).pipe(Effect.provide(host.layer))

      expect(result).toEqual(ActionResult.success({ messages: [] }))
      expect(filteredRequests).toMatchObject([
        { folder: 'Archive', isRead: true, isFlagged: false, limit: 50 }
      ])
    })
  )

  it.effect('preserves the EmailClient receiver for legacy, filtered, and batch dispatch', () =>
    Effect.gen(function* () {
      const calls: Array<string> = []

      const receiverClient = {
        ...legacyClient,
        calls,
        listMessages() {
          this.calls.push('list')

          return Effect.succeed(ActionResult.success({ messages: [] }))
        },
        listMessagesFiltered() {
          this.calls.push('filtered')

          return Effect.succeed(ActionResult.success({ messages: [] }))
        },
        batchSetRead(request: Parameters<NonNullable<EmailClientApi['batchSetRead']>>[0]) {
          this.calls.push('batch')

          return Effect.succeed(successfulBatch(request.messageIds))
        }
      }

      const host = makeClientHost(receiverClient)

      yield* EmailConnector.invoke({
        integration,
        action: 'email.list_messages',
        input: {}
      }).pipe(Effect.provide(host.layer))

      yield* EmailConnector.invoke({
        integration,
        action: 'email.list_messages',
        input: { isRead: false }
      }).pipe(Effect.provide(host.layer))

      yield* emailBatchSetReadAction
        .execute({ integration, input: { messageIds: ['message-1'], isRead: true } })
        .pipe(Effect.provide(host.layer))

      expect(receiverClient.calls).toEqual(['list', 'filtered', 'batch'])
    })
  )

  it.effect(
    'fails clearly when filtered listing is unsupported and rejects POP3 filters before credentials',
    () =>
      Effect.gen(function* () {
        const unsupported = makeHost()

        const missing = yield* EmailConnector.invoke({
          integration,
          action: 'email.list_messages',
          input: { isRead: true }
        }).pipe(Effect.provide(unsupported.layer), Effect.result)

        expect(missing).toMatchObject({
          failure: {
            cause: 'validation_failed',
            message: 'EmailClient does not support filtered message listing'
          }
        })
        expect(unsupported.refs).toEqual([])

        const pop3 = makeHost({ listMessages: unused, listMessagesFiltered: unused })

        const rejected = yield* EmailConnector.invoke({
          integration: makeIntegration({
            connectorId: 'email',
            config: { incomingProtocol: 'pop3', incomingHost: 'pop.example.com' },
            credentialBindings: integration.credentialBindings
          }),
          action: 'email.list_messages',
          input: { isFlagged: true }
        }).pipe(Effect.provide(pop3.layer), Effect.result)

        expect(rejected).toMatchObject({
          failure: { cause: 'validation_failed', message: expect.stringContaining('POP3') }
        })
        expect(pop3.refs).toEqual([])
      })
  )

  it.effect('schema-validates legacy and filtered list success output', () =>
    Effect.gen(function* () {
      const cases: ReadonlyArray<{
        readonly filtered: boolean
        readonly methods: Partial<EmailClientApi>
      }> = [
        {
          filtered: false,
          methods: {
            listMessages: () =>
              Effect.succeed(ActionResult.success(JSON.parse('{"messages":[{"id":1}]}')))
          }
        },
        {
          filtered: true,
          methods: {
            listMessagesFiltered: () =>
              Effect.succeed(
                ActionResult.success(JSON.parse('{"messages":[{"id":"id","isRead":"yes"}]}'))
              )
          }
        }
      ]

      for (const testCase of cases) {
        const host = makeHost(testCase.methods)

        const result = yield* EmailConnector.invoke({
          integration,
          action: 'email.list_messages',
          input: testCase.filtered ? { isRead: true } : {}
        }).pipe(Effect.provide(host.layer), Effect.result)

        expect(result).toMatchObject({ failure: { cause: 'validation_failed' } })
      }
    })
  )

  it.effect(
    'registers every batch/delete action with root-object schemas and access metadata',
    () =>
      Effect.gen(function* () {
        const host = makeHost()

        const tools = yield* resolveTools(
          [makeConnectorToolModule(EmailConnector, { integration, layer: host.layer })],
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
          expect(EmailConnector.actions).toContain(action)
          expect(tools.tools.find(tool => tool.name === action.id)?.parameters).toMatchObject({
            type: 'object',
            required: expect.arrayContaining(['messageIds'])
          })
        }
      })
  )

  it.effect('validates message ID size, emptiness, and uniqueness before host IO', () =>
    Effect.gen(function* () {
      const host = makeHost({ batchSetRead: unused })
      const invalidIds = [[], [''], ['id', 'id'], Array.from({ length: 101 }, (_, i) => `id-${i}`)]

      for (const messageIds of invalidIds) {
        const result = yield* emailBatchSetReadAction
          .execute({ integration, input: { messageIds, isRead: true } })
          .pipe(Effect.provide(host.layer), Effect.result)

        expect(result).toMatchObject({ failure: { cause: 'validation_failed' } })
      }

      expect(host.refs).toEqual([])
    })
  )

  it.effect('revalidates mutated typed batch inputs before credential resolution', () =>
    Effect.gen(function* () {
      const host = makeHost()

      const setRead = EmailBatchSetReadInput.make({ messageIds: ['id'], isRead: true })
      const setFlag = EmailBatchSetFlagInput.make({ messageIds: ['id'], isFlagged: true })

      const move = EmailBatchMoveInput.make({
        messageIds: ['id'],
        destinationFolder: EmailFolderName.make('Archive')
      })

      const trash = EmailBatchTrashInput.make({ messageIds: ['id'] })
      const untrash = EmailBatchUntrashInput.make({ messageIds: ['id'] })

      const modifyLabels = EmailBatchModifyLabelsInput.make({
        messageIds: ['id'],
        addLabels: ['Work']
      })

      const deletePermanently = EmailDeletePermanentlyInput.make({ messageIds: ['id'] })

      for (const input of [
        setRead,
        setFlag,
        move,
        trash,
        untrash,
        modifyLabels,
        deletePermanently
      ]) {
        Object.assign(input, { messageIds: [] })
      }

      const results = [
        yield* emailBatchSetReadAction
          .executeTyped({ integration, input: setRead })
          .pipe(Effect.provide(host.layer), Effect.result),
        yield* emailBatchSetFlagAction
          .executeTyped({ integration, input: setFlag })
          .pipe(Effect.provide(host.layer), Effect.result),
        yield* emailBatchMoveAction
          .executeTyped({ integration, input: move })
          .pipe(Effect.provide(host.layer), Effect.result),
        yield* emailBatchTrashAction
          .executeTyped({ integration, input: trash })
          .pipe(Effect.provide(host.layer), Effect.result),
        yield* emailBatchUntrashAction
          .executeTyped({ integration, input: untrash })
          .pipe(Effect.provide(host.layer), Effect.result),
        yield* emailBatchModifyLabelsAction
          .executeTyped({ integration, input: modifyLabels })
          .pipe(Effect.provide(host.layer), Effect.result),
        yield* emailDeletePermanentlyAction
          .executeTyped({ integration, input: deletePermanently })
          .pipe(Effect.provide(host.layer), Effect.result)
      ]

      for (const result of results) {
        expect(result).toMatchObject({ failure: { cause: 'validation_failed' } })
      }

      expect(host.refs).toEqual([])
    })
  )

  it.effect('rejects batch mutations on POP3 before credential resolution', () =>
    Effect.gen(function* () {
      const host = makeHost({ batchSetRead: unused })

      const result = yield* emailBatchSetReadAction
        .execute({
          integration: makeIntegration({
            connectorId: 'email',
            config: { incomingProtocol: 'pop3', incomingHost: 'pop.example.com' },
            credentialBindings: integration.credentialBindings
          }),
          input: { messageIds: ['id'], isRead: true }
        })
        .pipe(Effect.provide(host.layer), Effect.result)

      expect(result).toMatchObject({
        failure: { cause: 'validation_failed', message: expect.stringContaining('requires IMAP') }
      })
      expect(host.refs).toEqual([])
    })
  )

  it.effect('forwards a batch request with defaults and validates complete per-ID output', () =>
    Effect.gen(function* () {
      const requests: Array<ReadonlyArray<string>> = []

      const host = makeHost({
        batchSetRead: request => {
          requests.push(request.messageIds)
          expect(request.folder).toBe('INBOX')
          expect(request.isRead).toBe(false)

          return Effect.succeed(successfulBatch(request.messageIds))
        }
      })

      const result = yield* emailBatchSetReadAction
        .execute({ integration, input: { messageIds: ['a', 'b'], isRead: false } })
        .pipe(Effect.provide(host.layer))

      expect(result).toEqual(successfulBatch(['a', 'b']))
      expect(requests).toEqual([['a', 'b']])
    })
  )

  it.effect('forwards permanent deletion and validates a mixed per-ID outcome', () =>
    Effect.gen(function* () {
      const requests: Array<ReadonlyArray<string>> = []

      const mixed = ActionResult.success({
        results: [
          { messageId: 'a', status: 'succeeded' as const },
          { messageId: 'b', status: 'failed' as const, code: 'provider_rejected' },
          { messageId: 'c', status: 'unknown' as const, code: 'outcome_ambiguous' },
          { messageId: 'd', status: 'not_attempted' as const }
        ],
        summary: { requested: 4, succeeded: 1, failed: 1, unknown: 1, notAttempted: 1 }
      })

      const host = makeHost({
        deletePermanently: request => {
          requests.push(request.messageIds)
          expect(request.folder).toBe('INBOX')

          return Effect.succeed(mixed)
        }
      })

      const result = yield* emailDeletePermanentlyAction
        .execute({ integration, input: { messageIds: ['a', 'b', 'c', 'd'] } })
        .pipe(Effect.provide(host.layer))

      expect(result).toEqual(mixed)
      expect(requests).toEqual([['a', 'b', 'c', 'd']])
    })
  )

  it.effect('fails clearly for legacy adapters missing each optional batch/delete method', () =>
    Effect.gen(function* () {
      const cases = [
        [emailBatchSetReadAction, { messageIds: ['id'], isRead: true }],
        [emailBatchSetFlagAction, { messageIds: ['id'], isFlagged: true }],
        [emailBatchMoveAction, { messageIds: ['id'], destinationFolder: 'Archive' }],
        [emailBatchTrashAction, { messageIds: ['id'] }],
        [emailBatchUntrashAction, { messageIds: ['id'] }],
        [emailBatchModifyLabelsAction, { messageIds: ['id'], addLabels: ['Work'] }],
        [emailDeletePermanentlyAction, { messageIds: ['id'] }]
      ] as const

      for (const [action, input] of cases) {
        const result = yield* action
          .execute({ integration, input })
          .pipe(Effect.provide(makeHost().layer), Effect.result)

        expect(result).toMatchObject({
          failure: {
            cause: 'validation_failed',
            message: expect.stringContaining('EmailClient does not support')
          }
        })
      }
    })
  )

  it.effect('requires a destination folder for every successful move result', () =>
    Effect.gen(function* () {
      const host = makeHost({
        batchMove: () =>
          Effect.succeed(
            ActionResult.success({
              results: [{ messageId: 'a', status: 'succeeded' }],
              summary: { requested: 1, succeeded: 1, failed: 0, unknown: 0, notAttempted: 0 }
            })
          )
      })

      const result = yield* emailBatchMoveAction
        .execute({ integration, input: { messageIds: ['a'], destinationFolder: 'Archive' } })
        .pipe(Effect.provide(host.layer), Effect.result)

      expect(result).toMatchObject({ failure: { cause: 'validation_failed' } })
    })
  )

  it.effect('rejects inconsistent or unsafe batch host output', () =>
    Effect.gen(function* () {
      const outputs = [
        JSON.parse(
          '{"results":[{"messageId":"a","status":"succeeded"}],"summary":{"requested":2,"succeeded":1,"failed":0,"unknown":0,"notAttempted":0}}'
        ),
        {
          results: [
            { messageId: 'a', status: 'succeeded' },
            { messageId: 'a', status: 'failed', code: 'provider_rejected' }
          ],
          summary: { requested: 2, succeeded: 1, failed: 1, unknown: 0, notAttempted: 0 }
        },
        {
          results: [
            { messageId: 'a', status: 'succeeded' },
            { messageId: 'foreign', status: 'failed', code: 'provider_rejected' }
          ],
          summary: { requested: 2, succeeded: 1, failed: 1, unknown: 0, notAttempted: 0 }
        },
        {
          results: [
            { messageId: 'b', status: 'failed', code: 'provider_rejected' },
            { messageId: 'a', status: 'succeeded' }
          ],
          summary: { requested: 2, succeeded: 1, failed: 1, unknown: 0, notAttempted: 0 }
        },
        {
          results: [
            { messageId: 'a', status: 'succeeded' },
            { messageId: 'b', status: 'failed', code: 'provider_rejected' }
          ],
          summary: { requested: 2, succeeded: 2, failed: 0, unknown: 0, notAttempted: 0 }
        },
        JSON.parse(
          '{"results":[{"messageId":"a","status":"succeeded"},{"messageId":"b","status":"failed","code":"Raw provider error: token=secret"}],"summary":{"requested":2,"succeeded":1,"failed":1,"unknown":0,"notAttempted":0}}'
        )
      ]

      for (const output of outputs) {
        const host = makeHost({
          batchSetRead: () => Effect.succeed(ActionResult.success(output))
        })

        const result = yield* emailBatchSetReadAction
          .execute({ integration, input: { messageIds: ['a', 'b'], isRead: true } })
          .pipe(Effect.provide(host.layer), Effect.result)

        expect(result).toMatchObject({ failure: { cause: 'validation_failed' } })

        if (Predicate.isTagged(result, 'Failure') && result.failure.underlying !== undefined) {
          expect(Schema.isSchemaError(result.failure.underlying)).toBe(true)
        }
      }
    })
  )
})

describe('generic email batch forwarding per operation', () => {
  it.effect('forwards batchSetRead with connection, credential, IDs, folder, and both values', () =>
    Effect.gen(function* () {
      const seen: Array<{ folder: string; isRead: boolean; ids: ReadonlyArray<string> }> = []

      for (const isRead of [true, false]) {
        const host = makeHost({
          batchSetRead: request => {
            expect(request.connection.protocol).toBe('imap')
            expect(request.credential.username).toBe('alice@example.com')
            seen.push({
              folder: request.folder,
              isRead: request.isRead,
              ids: request.messageIds
            })

            return Effect.succeed(successfulBatch(request.messageIds))
          }
        })

        const result = yield* emailBatchSetReadAction
          .execute({ integration, input: { messageIds: ['a'], isRead } })
          .pipe(Effect.provide(host.layer))

        expect(result).toEqual(successfulBatch(['a']))
      }

      expect(seen).toMatchObject([
        { folder: 'INBOX', isRead: true, ids: ['a'] },
        { folder: 'INBOX', isRead: false, ids: ['a'] }
      ])

      const explicit = makeHost({
        batchSetRead: request => {
          expect(request.folder).toBe('Archive')

          return Effect.succeed(successfulBatch(request.messageIds))
        }
      })

      yield* emailBatchSetReadAction
        .execute({ integration, input: { messageIds: ['a'], folder: 'Archive', isRead: true } })
        .pipe(Effect.provide(explicit.layer))
    })
  )

  it.effect('forwards batchSetFlag with both values and default or explicit source folder', () =>
    Effect.gen(function* () {
      const seen: Array<{ folder: string; isFlagged: boolean }> = []

      for (const [isFlagged, folder] of [
        [true, undefined],
        [false, 'Archive']
      ] as const) {
        const host = makeHost({
          batchSetFlag: request => {
            seen.push({ folder: request.folder, isFlagged: request.isFlagged })
            expect(request.messageIds).toEqual(['a', 'b'])

            return Effect.succeed(successfulBatch(request.messageIds))
          }
        })

        const result = yield* emailBatchSetFlagAction
          .execute({ integration, input: { messageIds: ['a', 'b'], folder, isFlagged } })
          .pipe(Effect.provide(host.layer))

        expect(result).toEqual(successfulBatch(['a', 'b']))
      }

      expect(seen).toEqual([
        { folder: 'INBOX', isFlagged: true },
        { folder: 'Archive', isFlagged: false }
      ])
    })
  )

  it.effect('forwards batchMove with a required distinct destination and both sources', () =>
    Effect.gen(function* () {
      const folders: Array<string> = []

      const host = makeHost({
        batchMove: request => {
          folders.push(request.folder)
          expect(request.destinationFolder).toBe('Archive')

          return Effect.succeed(successfulMoveBatch(request.messageIds, request.destinationFolder))
        }
      })

      yield* emailBatchMoveAction
        .execute({ integration, input: { messageIds: ['a'], destinationFolder: 'Archive' } })
        .pipe(Effect.provide(host.layer))

      yield* emailBatchMoveAction
        .execute({
          integration,
          input: { messageIds: ['a'], folder: 'Drafts', destinationFolder: 'Archive' }
        })
        .pipe(Effect.provide(host.layer))

      expect(folders).toEqual(['INBOX', 'Drafts'])

      const sameFolder = yield* emailBatchMoveAction
        .execute({
          integration,
          input: { messageIds: ['a'], folder: 'Archive', destinationFolder: 'Archive' }
        })
        .pipe(Effect.provide(host.layer), Effect.result)

      expect(sameFolder).toMatchObject({ failure: { cause: 'validation_failed' } })
    })
  )

  it.effect('forwards batchTrash with default source and an optional trash folder', () =>
    Effect.gen(function* () {
      const host = makeHost({
        batchTrash: request => {
          expect(request.folder).toBe('INBOX')
          expect(request.trashFolder).toBe('Trash')

          return Effect.succeed(successfulMoveBatch(request.messageIds, 'Trash'))
        }
      })

      const result = yield* emailBatchTrashAction
        .execute({ integration, input: { messageIds: ['a'], trashFolder: 'Trash' } })
        .pipe(Effect.provide(host.layer))

      expect(result._tag).toBe('Success')
    })
  )

  it.effect('forwards batchUntrash with omitted source and default destination', () =>
    Effect.gen(function* () {
      const host = makeHost({
        batchUntrash: request => {
          expect(request.folder).toBeUndefined()
          expect(request.destinationFolder).toBe('INBOX')

          return Effect.succeed(successfulMoveBatch(request.messageIds, 'INBOX'))
        }
      })

      const result = yield* emailBatchUntrashAction
        .execute({ integration, input: { messageIds: ['a'] } })
        .pipe(Effect.provide(host.layer))

      expect(result._tag).toBe('Success')
    })
  )

  it.effect('forwards batchModifyLabels values unchanged and keeps keyword validation', () =>
    Effect.gen(function* () {
      const host = makeHost({
        batchModifyLabels: request => {
          expect(request.folder).toBe('INBOX')
          expect(request.addLabels).toEqual(['Work'])
          expect(request.removeLabels).toEqual(['Later'])

          return Effect.succeed(successfulBatch(request.messageIds))
        }
      })

      const result = yield* emailBatchModifyLabelsAction
        .execute({
          integration,
          input: { messageIds: ['a'], addLabels: ['Work'], removeLabels: ['Later'] }
        })
        .pipe(Effect.provide(host.layer))

      expect(result).toEqual(successfulBatch(['a']))

      // System flags are never valid IMAP keyword labels.
      const rejected = yield* emailBatchModifyLabelsAction
        .execute({ integration, input: { messageIds: ['a'], addLabels: ['\\Seen'] } })
        .pipe(Effect.provide(host.layer), Effect.result)

      expect(rejected).toMatchObject({ failure: { cause: 'validation_failed' } })

      const missing = yield* emailBatchModifyLabelsAction
        .execute({ integration, input: { messageIds: ['a'] } })
        .pipe(Effect.provide(host.layer), Effect.result)

      expect(missing).toMatchObject({ failure: { cause: 'validation_failed' } })
    })
  )

  it.effect('forwards deletePermanently through the exact host method with folder defaults', () =>
    Effect.gen(function* () {
      const methods: Array<string> = []
      const folders: Array<string> = []

      const receiver = {
        ...legacyClient,
        deletePermanently(
          request: Parameters<NonNullable<EmailClientApi['deletePermanently']>>[0]
        ) {
          methods.push('deletePermanently')
          folders.push(request.folder)

          return Effect.succeed(successfulBatch(request.messageIds))
        }
      }

      const host = makeClientHost(receiver)

      yield* emailDeletePermanentlyAction
        .execute({ integration, input: { messageIds: ['a'] } })
        .pipe(Effect.provide(host.layer))

      yield* emailDeletePermanentlyAction
        .execute({ integration, input: { messageIds: ['a'], folder: 'Archive' } })
        .pipe(Effect.provide(host.layer))

      expect(methods).toEqual(['deletePermanently', 'deletePermanently'])
      expect(folders).toEqual(['INBOX', 'Archive'])
    })
  )

  it.effect('accepts folder-only move results for every move-shaped action', () =>
    Effect.gen(function* () {
      const folderOnly = ActionResult.success({
        results: [{ messageId: 'a', status: 'succeeded' as const, folder: 'Archive' }],
        summary: { requested: 1, succeeded: 1, failed: 0, unknown: 0, notAttempted: 0 }
      })

      for (const [action, input] of [
        [emailBatchMoveAction, { messageIds: ['a'], destinationFolder: 'Archive' }],
        [emailBatchTrashAction, { messageIds: ['a'] }],
        [emailBatchUntrashAction, { messageIds: ['a'] }]
      ] as const) {
        const host = makeHost({
          [action === emailBatchMoveAction
            ? 'batchMove'
            : action === emailBatchTrashAction
              ? 'batchTrash'
              : 'batchUntrash']: () => Effect.succeed(folderOnly)
        })

        const result = yield* action
          .execute({ integration, input })
          .pipe(Effect.provide(host.layer))

        expect(result).toEqual(folderOnly)
      }
    })
  )
})
