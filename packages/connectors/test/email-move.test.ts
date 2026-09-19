import { describe, expect, it } from '@effect/vitest'
import { Effect, Layer, Predicate } from 'effect'
import * as Schema from 'effect/Schema'
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
  emailMoveAction,
  type EmailClientApi,
  type EmailMoveMessageOutput,
  type EmailMoveRequest
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

describe('generic email move', () => {
  it.effect('registers a provider-safe write tool', () =>
    Effect.gen(function* () {
      const host = makeHost()

      const tools = yield* resolveTools(
        [makeConnectorToolModule(EmailConnector, { integration, layer: host.layer })],
        {}
      )

      expect(emailMoveAction.access).toBe('write')
      expect(EmailConnector.actions).toContain(emailMoveAction)
      expect(tools.tools.find(tool => tool.name === 'email.move')?.parameters).toMatchObject({
        type: 'object',
        required: expect.arrayContaining(['messageId', 'destinationFolder'])
      })
    })
  )

  it.effect('forwards source and destination folders with an INBOX default', () =>
    Effect.gen(function* () {
      const requests: Array<EmailMoveRequest> = []

      const host = makeHost({
        move: request => {
          requests.push(request)

          return Effect.succeed(
            ActionResult.success({
              moved: true as const,
              folder: request.destinationFolder,
              messageId: 'imap:456:7'
            })
          )
        }
      })

      const result = yield* EmailConnector.invoke({
        integration,
        action: 'email.move',
        input: { messageId: 'imap:123:1', destinationFolder: 'Archive' }
      }).pipe(Effect.provide(host.layer))

      expect(result).toEqual(
        ActionResult.success({
          moved: true as const,
          folder: EmailFolderName.make('Archive'),
          messageId: 'imap:456:7'
        })
      )

      expect(requests).toMatchObject([
        {
          connection: {
            protocol: 'imap',
            host: 'imap.example.com',
            port: 993,
            security: 'tls'
          },
          credential,
          messageId: 'imap:123:1',
          folder: 'INBOX',
          destinationFolder: 'Archive'
        }
      ])
      expect(host.refs).toEqual(['incoming'])
    })
  )

  it.effect('respects an explicit source folder', () =>
    Effect.gen(function* () {
      const requests: Array<EmailMoveRequest> = []

      const host = makeHost({
        move: request => {
          requests.push(request)

          return Effect.succeed(
            ActionResult.success({ moved: true as const, folder: request.destinationFolder })
          )
        }
      })

      const result = yield* emailMoveAction
        .execute({
          integration,
          input: { messageId: 'imap:123:1', folder: 'Receipts', destinationFolder: 'Archive' }
        })
        .pipe(Effect.provide(host.layer))

      expect(result._tag).toBe('Success')
      expect(requests).toMatchObject([
        { folder: 'Receipts', destinationFolder: 'Archive', messageId: 'imap:123:1' }
      ])
    })
  )

  it.effect('fails clearly for old adapters without move', () =>
    Effect.gen(function* () {
      const host = makeHost()

      const result = yield* emailMoveAction
        .execute({ integration, input: { messageId: 'id', destinationFolder: 'Archive' } })
        .pipe(Effect.provide(host.layer), Effect.result)

      expect(result._tag).toBe('Failure')
      expect(result).toMatchObject({
        failure: {
          cause: 'validation_failed',
          message: 'EmailClient does not support move'
        }
      })
    })
  )

  it.effect('rejects POP3 before credential resolution or adapter calls', () =>
    Effect.gen(function* () {
      const host = makeHost({ move: unused })

      const result = yield* emailMoveAction
        .execute({
          integration: makeIntegration({
            connectorId: 'email',
            config: { incomingProtocol: 'pop3', incomingHost: 'pop.example.com' },
            credentialBindings: integration.credentialBindings
          }),
          input: { messageId: 'id', destinationFolder: 'Archive' }
        })
        .pipe(Effect.provide(host.layer), Effect.result)

      expect(result._tag).toBe('Failure')
      expect(result).toMatchObject({
        failure: {
          cause: 'validation_failed',
          message: expect.stringContaining('requires IMAP')
        }
      })
      expect(host.refs).toEqual([])
    })
  )

  it.effect('rejects missing identifiers and folders before IO', () =>
    Effect.gen(function* () {
      const host = makeHost({ move: unused })

      const inputs = [
        { messageId: 'id' },
        { messageId: '', destinationFolder: 'Archive' },
        { messageId: 'id', folder: '', destinationFolder: 'Archive' },
        { messageId: 'id', destinationFolder: '' },
        { messageId: 'id', destinationFolder: 'INBOX' },
        { messageId: 'id', folder: 'Archive', destinationFolder: 'Archive' }
      ]

      for (const input of inputs) {
        const result = yield* emailMoveAction
          .execute({ integration, input })
          .pipe(Effect.provide(host.layer), Effect.result)

        expect(result._tag).toBe('Failure')
        expect(result).toMatchObject({ failure: { cause: 'validation_failed' } })
      }

      expect(host.refs).toEqual([])
    })
  )

  it.effect('preserves expected host failures', () =>
    Effect.gen(function* () {
      const failure = ActionResult.failure({
        code: 'destination_not_found',
        message: 'No such mailbox'
      })

      const host = makeHost({ move: () => Effect.succeed(failure) })

      const result = yield* emailMoveAction
        .execute({ integration, input: { messageId: 'id', destinationFolder: 'Archive' } })
        .pipe(Effect.provide(host.layer))

      expect(result).toEqual(failure)
    })
  )

  it.effect('preserves transport errors', () =>
    Effect.gen(function* () {
      const error = new ConnectorError({ cause: 'transport_failed', message: 'Disconnected' })

      const host = makeHost({ move: () => Effect.fail(error) })

      const result = yield* emailMoveAction
        .execute({ integration, input: { messageId: 'id', destinationFolder: 'Archive' } })
        .pipe(Effect.provide(host.layer), Effect.result)

      expect(result._tag).toBe('Failure')
      expect(result).toMatchObject({ failure: error })
    })
  )

  it.effect('validates host success output', () =>
    Effect.gen(function* () {
      const cases = [
        { moved: true as const, folder: EmailFolderName.make('Archive'), messageId: '' },
        // Missing destination folder from an untyped host payload.
        JSON.parse('{"moved":true}')
      ]

      for (const output of cases) {
        const host = makeHost({
          move: () => Effect.succeed(ActionResult.success(output))
        })

        const result = yield* emailMoveAction
          .execute({ integration, input: { messageId: 'id', destinationFolder: 'Archive' } })
          .pipe(Effect.provide(host.layer), Effect.result)

        expect(result._tag).toBe('Failure')
        expect(result).toMatchObject({ failure: { cause: 'validation_failed' } })

        if (Predicate.isTagged(result, 'Failure')) {
          expect(result.failure.underlying).toBeInstanceOf(Error)
          expect(Schema.isSchemaError(result.failure.underlying)).toBe(true)
        }
      }
    })
  )

  it.effect('accepts a host omitting the new message ID', () =>
    Effect.gen(function* () {
      const host = makeHost({
        move: (request): Effect.Effect<ActionResult<EmailMoveMessageOutput>, ConnectorError> =>
          Effect.succeed(
            ActionResult.success({ moved: true as const, folder: request.destinationFolder })
          )
      })

      const result = yield* emailMoveAction
        .execute({ integration, input: { messageId: 'id', destinationFolder: 'Archive' } })
        .pipe(Effect.provide(host.layer))

      expect(result).toEqual(
        ActionResult.success({ moved: true as const, folder: EmailFolderName.make('Archive') })
      )
    })
  )

  it.effect('roundtrips a move through a host that reassigns UIDs', () =>
    Effect.gen(function* () {
      // Model the documented host MOVE contract, not an actual IMAP server:
      // the destination mailbox assigns a fresh UIDVALIDITY/UID.
      const mailboxes = new Map([
        ['INBOX', new Set(['imap:123:1'])],
        ['Archive', new Set<string>()]
      ])

      const host = makeHost({
        move: request =>
          Effect.sync(() => {
            mailboxes.get(request.folder)?.delete(request.messageId)
            const relocated = 'imap:456:7'
            mailboxes.get(request.destinationFolder)?.add(relocated)

            return ActionResult.success({
              moved: true as const,
              folder: request.destinationFolder,
              messageId: relocated
            })
          })
      })

      const result = yield* emailMoveAction
        .execute({ integration, input: { messageId: 'imap:123:1', destinationFolder: 'Archive' } })
        .pipe(Effect.provide(host.layer))

      expect(mailboxes.get('INBOX')).toEqual(new Set())
      expect(mailboxes.get('Archive')).toEqual(new Set(['imap:456:7']))
      expect(result).toEqual(
        ActionResult.success({
          moved: true as const,
          folder: EmailFolderName.make('Archive'),
          messageId: 'imap:456:7'
        })
      )
    })
  )
})
