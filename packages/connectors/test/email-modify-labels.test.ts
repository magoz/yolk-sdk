import { describe, expect, it } from '@effect/vitest'
import { Chunk, Effect, Layer, Predicate } from 'effect'
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
  EmailImapKeyword,
  EmailIncomingCredentialSlot,
  EmailMessage,
  EmailMessageSummary,
  emailModifyLabelsAction,
  type EmailClientApi,
  type EmailModifyLabelsRequest
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

describe('generic email modify labels', () => {
  it.effect('registers a provider-safe write tool', () =>
    Effect.gen(function* () {
      const host = makeHost()

      const tools = yield* resolveTools(
        [makeConnectorToolModule(EmailConnector, { integration, layer: host.layer })],
        {}
      )

      expect(emailModifyLabelsAction.access).toBe('write')
      expect(EmailConnector.actions).toContain(emailModifyLabelsAction)
      expect(
        tools.tools.find(tool => tool.name === 'email.modify_labels')?.parameters
      ).toMatchObject({ type: 'object' })
    })
  )

  it.effect('accepts IMAP keyword labels', () =>
    Effect.gen(function* () {
      for (const keyword of ['Work', 'Receipts', '$Forwarded', '$NotJunk', 'todo-1_x.y']) {
        const decoded = yield* Schema.decodeUnknownEffect(EmailImapKeyword)(keyword)

        expect(decoded).toBe(keyword)
      }
    })
  )

  it.effect('rejects system flags and non-atom keywords', () =>
    Effect.gen(function* () {
      const invalid = [
        '',
        '   ',
        '\\Seen',
        '\\Draft',
        '\\Flagged',
        'has space',
        ' leading',
        'trailing ',
        'with(parens)',
        'with)paren',
        'with{brace}',
        'with]bracket',
        'with%percent',
        'with*star',
        'with"quote',
        'with\\backslash',
        'tab\there',
        'newline\nhere',
        'control\x01here',
        'del\x7fhere',
        'ünïcode'
      ]

      for (const keyword of invalid) {
        const decoded = yield* Schema.decodeUnknownEffect(EmailImapKeyword)(keyword).pipe(
          Effect.result
        )

        expect(decoded._tag).toBe('Failure')
      }
    })
  )

  it.effect('forwards add/remove keywords with an INBOX default using incoming credentials', () =>
    Effect.gen(function* () {
      const requests: Array<EmailModifyLabelsRequest> = []

      const host = makeHost({
        modifyLabels: request => {
          requests.push(request)

          return Effect.succeed(
            ActionResult.success({
              messageId: request.messageId,
              labels: Chunk.fromIterable(['Work', '$Forwarded'])
            })
          )
        }
      })

      const result = yield* EmailConnector.invoke({
        integration,
        action: 'email.modify_labels',
        input: {
          messageId: 'imap:123:1',
          addLabels: ['Work', '$Forwarded'],
          removeLabels: ['Receipts']
        }
      }).pipe(Effect.provide(host.layer))

      expect(result).toEqual(
        ActionResult.success({
          messageId: 'imap:123:1',
          labels: Chunk.fromIterable(['Work', '$Forwarded'])
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
          addLabels: ['Work', '$Forwarded'],
          removeLabels: ['Receipts']
        }
      ])
      expect(host.refs).toEqual(['incoming'])
    })
  )

  it.effect('respects an explicit folder and add-only input', () =>
    Effect.gen(function* () {
      const requests: Array<EmailModifyLabelsRequest> = []

      const host = makeHost({
        modifyLabels: request => {
          requests.push(request)

          return Effect.succeed(
            ActionResult.success({
              messageId: request.messageId,
              labels: Chunk.fromIterable(['Work'])
            })
          )
        }
      })

      const result = yield* emailModifyLabelsAction
        .execute({
          integration,
          input: { messageId: 'imap:123:1', folder: 'Archive', addLabels: ['Work'] }
        })
        .pipe(Effect.provide(host.layer))

      expect(result._tag).toBe('Success')
      expect(requests).toMatchObject([
        {
          connection: { protocol: 'imap' },
          credential,
          messageId: 'imap:123:1',
          folder: 'Archive',
          addLabels: ['Work']
        }
      ])
      expect(requests[0]?.removeLabels).toBeUndefined()
      expect(host.refs).toEqual(['incoming'])
    })
  )

  it.effect('supports remove-only input', () =>
    Effect.gen(function* () {
      const requests: Array<EmailModifyLabelsRequest> = []

      const host = makeHost({
        modifyLabels: request => {
          requests.push(request)

          return Effect.succeed(
            ActionResult.success({
              messageId: request.messageId,
              labels: Chunk.empty<string>()
            })
          )
        }
      })

      const result = yield* emailModifyLabelsAction
        .execute({ integration, input: { messageId: 'imap:123:1', removeLabels: ['Receipts'] } })
        .pipe(Effect.provide(host.layer))

      expect(result).toEqual(
        ActionResult.success({ messageId: 'imap:123:1', labels: Chunk.empty<string>() })
      )

      expect(requests[0]?.addLabels).toBeUndefined()
      expect(requests[0]?.removeLabels).toEqual(['Receipts'])
    })
  )

  it.effect('fails clearly for old adapters without modifyLabels', () =>
    Effect.gen(function* () {
      const host = makeHost()

      const result = yield* emailModifyLabelsAction
        .execute({ integration, input: { messageId: 'id', addLabels: ['Work'] } })
        .pipe(Effect.provide(host.layer), Effect.result)

      expect(result._tag).toBe('Failure')
      expect(result).toMatchObject({
        failure: {
          cause: 'validation_failed',
          message: 'EmailClient does not support modifyLabels'
        }
      })
    })
  )

  it.effect('rejects POP3 before credential resolution or adapter calls', () =>
    Effect.gen(function* () {
      const host = makeHost({ modifyLabels: unused })

      const result = yield* emailModifyLabelsAction
        .execute({
          integration: makeIntegration({
            connectorId: 'email',
            config: { incomingProtocol: 'pop3', incomingHost: 'pop.example.com' },
            credentialBindings: integration.credentialBindings
          }),
          input: { messageId: 'id', addLabels: ['Work'] }
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

  it.effect('rejects missing label changes and malformed keywords before IO', () =>
    Effect.gen(function* () {
      const host = makeHost({ modifyLabels: unused })

      const inputs = [
        { messageId: 'id' },
        { messageId: '', addLabels: ['Work'] },
        { messageId: 'id', folder: '', addLabels: ['Work'] },
        { messageId: 'id', addLabels: ['\\Seen'] },
        { messageId: 'id', removeLabels: ['has space'] },
        { messageId: 'id', addLabels: ['ok', 'bad(label'] },
        { messageId: 'id', addLabels: [''] },
        { messageId: 'id', addLabels: ['Work'], removeLabels: ['a%b'] }
      ]

      for (const input of inputs) {
        const result = yield* emailModifyLabelsAction
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
        code: 'unsupported_keyword',
        message: 'Server does not accept the keyword'
      })

      const host = makeHost({ modifyLabels: () => Effect.succeed(failure) })

      const result = yield* emailModifyLabelsAction
        .execute({ integration, input: { messageId: 'id', addLabels: ['Work'] } })
        .pipe(Effect.provide(host.layer))

      expect(result).toEqual(failure)
    })
  )

  it.effect('preserves transport errors', () =>
    Effect.gen(function* () {
      const error = new ConnectorError({ cause: 'transport_failed', message: 'Disconnected' })
      const host = makeHost({ modifyLabels: () => Effect.fail(error) })

      const result = yield* emailModifyLabelsAction
        .execute({ integration, input: { messageId: 'id', addLabels: ['Work'] } })
        .pipe(Effect.provide(host.layer), Effect.result)

      expect(result._tag).toBe('Failure')
      expect(result).toMatchObject({ failure: error })
    })
  )

  it.effect('validates host success output, including returned labels', () =>
    Effect.gen(function* () {
      const cases = [
        { messageId: '', labels: Chunk.fromIterable(['Work']) },
        { messageId: 'id', labels: Chunk.fromIterable(['\\Seen']) },
        { messageId: 'id', labels: Chunk.fromIterable(['has space']) }
      ]

      for (const output of cases) {
        const host = makeHost({
          modifyLabels: () => Effect.succeed(ActionResult.success(output))
        })

        const result = yield* emailModifyLabelsAction
          .execute({ integration, input: { messageId: 'id', addLabels: ['Work'] } })
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

  it.effect('rejects an untyped host returning a string instead of a keyword collection', () =>
    Effect.gen(function* () {
      const host = makeHost({
        // @ts-expect-error Deliberately violate the host port to exercise runtime validation.
        modifyLabels: () =>
          Effect.succeed(ActionResult.success({ messageId: 'id', labels: 'Work' }))
      })

      const result = yield* emailModifyLabelsAction
        .execute({
          integration,
          input: { messageId: 'id', addLabels: ['Work'] }
        })
        .pipe(Effect.provide(host.layer), Effect.result)

      expect(result).toMatchObject({ failure: { cause: 'validation_failed' } })
    })
  )

  it.effect('roundtrips keyword changes through a host that preserves unrelated flags', () =>
    Effect.gen(function* () {
      // Model the documented host STORE contract, not an actual IMAP server.
      const flags = new Set(['\\Seen', '\\Flagged', 'Keep', 'Old'])

      const host = makeHost({
        modifyLabels: request =>
          Effect.sync(() => {
            for (const label of request.addLabels ?? []) flags.add(label)

            for (const label of request.removeLabels ?? []) flags.delete(label)

            return ActionResult.success({
              messageId: request.messageId,
              labels: Chunk.fromIterable([...flags].filter(flag => !flag.startsWith('\\')))
            })
          })
      })

      const result = yield* emailModifyLabelsAction
        .execute({
          integration,
          input: { messageId: 'imap:123:1', addLabels: ['New', 'Old'], removeLabels: ['Old'] }
        })
        .pipe(Effect.provide(host.layer))

      expect([...flags]).toEqual(['\\Seen', '\\Flagged', 'Keep', 'New'])
      expect(result).toEqual(
        ActionResult.success({
          messageId: 'imap:123:1',
          labels: Chunk.fromIterable(['Keep', 'New'])
        })
      )
    })
  )

  it.effect('exposes optional labels on messages and summaries without breaking old hosts', () =>
    Effect.gen(function* () {
      const summaryWithLabels = yield* Schema.decodeUnknownEffect(EmailMessageSummary)({
        id: 'message-1',
        from: [{ address: 'sender@example.com' }],
        to: [{ address: 'alice@example.com' }],
        hasAttachments: false,
        labels: ['Work', '$Forwarded']
      })

      const summaryWithoutLabels = yield* Schema.decodeUnknownEffect(EmailMessageSummary)({
        id: 'message-1',
        from: [{ address: 'sender@example.com' }],
        to: [{ address: 'alice@example.com' }],
        hasAttachments: false
      })

      const messageWithoutLabels = yield* Schema.decodeUnknownEffect(EmailMessage)({
        id: 'message-1',
        from: [{ address: 'sender@example.com' }],
        to: [{ address: 'alice@example.com' }],
        cc: [],
        bcc: [],
        replyTo: [],
        body: { text: 'Hello' },
        attachments: []
      })

      expect(summaryWithLabels.labels).toEqual(['Work', '$Forwarded'])
      expect(summaryWithoutLabels.labels).toBeUndefined()
      expect(messageWithoutLabels.labels).toBeUndefined()

      const invalidLabels = yield* Schema.decodeUnknownEffect(EmailMessageSummary)({
        id: 'message-1',
        from: [{ address: 'sender@example.com' }],
        to: [{ address: 'alice@example.com' }],
        hasAttachments: false,
        labels: ['\\Seen']
      }).pipe(Effect.result)

      expect(invalidLabels._tag).toBe('Failure')
    })
  )
})
