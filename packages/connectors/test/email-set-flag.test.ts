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
  EmailIncomingCredentialSlot,
  emailSetFlagAction,
  type EmailClientApi,
  type EmailSetFlagRequest
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

describe('generic email set flag', () => {
  it.effect('registers a provider-safe write tool', () =>
    Effect.gen(function* () {
      const host = makeHost()

      const tools = yield* resolveTools(
        [makeConnectorToolModule(EmailConnector, { integration, layer: host.layer })],
        {}
      )

      expect(emailSetFlagAction.access).toBe('write')
      expect(EmailConnector.actions).toContain(emailSetFlagAction)
      expect(tools.tools.find(tool => tool.name === 'email.set_flag')?.parameters).toMatchObject({
        type: 'object',
        required: expect.arrayContaining(['messageId', 'isFlagged'])
      })
    })
  )

  for (const isFlagged of [true, false]) {
    it.effect(`forwards isFlagged=${isFlagged} with an INBOX default`, () =>
      Effect.gen(function* () {
        const requests: Array<EmailSetFlagRequest> = []

        const host = makeHost({
          setFlag: request => {
            requests.push(request)

            return Effect.succeed(
              ActionResult.success({ messageId: request.messageId, isFlagged: request.isFlagged })
            )
          }
        })

        const result = yield* EmailConnector.invoke({
          integration,
          action: 'email.set_flag',
          input: { messageId: 'imap:123:1', isFlagged }
        }).pipe(Effect.provide(host.layer))

        expect(result).toEqual(ActionResult.success({ messageId: 'imap:123:1', isFlagged }))
        expect(requests).toMatchObject([
          {
            connection: { protocol: 'imap', host: 'imap.example.com', port: 993, security: 'tls' },
            credential,
            messageId: 'imap:123:1',
            folder: 'INBOX',
            isFlagged
          }
        ])
        expect(host.refs).toEqual(['incoming'])
      })
    )
  }

  it.effect('respects an explicit folder', () =>
    Effect.gen(function* () {
      const requests: Array<EmailSetFlagRequest> = []

      const host = makeHost({
        setFlag: request => {
          requests.push(request)

          return Effect.succeed(
            ActionResult.success({ messageId: request.messageId, isFlagged: true })
          )
        }
      })

      const result = yield* emailSetFlagAction
        .execute({ integration, input: { messageId: 'id', folder: 'Archive', isFlagged: true } })
        .pipe(Effect.provide(host.layer))

      expect(result._tag).toBe('Success')
      expect(requests).toMatchObject([{ folder: 'Archive', isFlagged: true }])
    })
  )

  it.effect('fails clearly for old adapters without setFlag', () =>
    Effect.gen(function* () {
      const host = makeHost()

      const result = yield* emailSetFlagAction
        .execute({ integration, input: { messageId: 'id', isFlagged: true } })
        .pipe(Effect.provide(host.layer), Effect.result)

      expect(result._tag).toBe('Failure')
      expect(result).toMatchObject({
        failure: { cause: 'validation_failed', message: 'EmailClient does not support setFlag' }
      })
    })
  )

  it.effect('rejects POP3 before credential resolution or adapter calls', () =>
    Effect.gen(function* () {
      const host = makeHost({ setFlag: unused })

      const result = yield* emailSetFlagAction
        .execute({
          integration: makeIntegration({
            connectorId: 'email',
            config: { incomingProtocol: 'pop3', incomingHost: 'pop.example.com' },
            credentialBindings: integration.credentialBindings
          }),
          input: { messageId: 'id', isFlagged: true }
        })
        .pipe(Effect.provide(host.layer), Effect.result)

      expect(result._tag).toBe('Failure')
      expect(result).toMatchObject({
        failure: { cause: 'validation_failed', message: expect.stringContaining('requires IMAP') }
      })
      expect(host.refs).toEqual([])
    })
  )

  it.effect('rejects missing identifiers and folders before IO', () =>
    Effect.gen(function* () {
      const host = makeHost({ setFlag: unused })

      const inputs = [
        { messageId: 'id' },
        { messageId: '', isFlagged: true },
        { messageId: 'id', folder: '', isFlagged: true }
      ]

      for (const input of inputs) {
        const result = yield* emailSetFlagAction
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
        code: 'unsupported_flag',
        message: 'Server does not accept the flag'
      })

      const host = makeHost({ setFlag: () => Effect.succeed(failure) })

      const result = yield* emailSetFlagAction
        .execute({ integration, input: { messageId: 'id', isFlagged: true } })
        .pipe(Effect.provide(host.layer))

      expect(result).toEqual(failure)
    })
  )

  it.effect('preserves transport errors', () =>
    Effect.gen(function* () {
      const error = new ConnectorError({ cause: 'transport_failed', message: 'Disconnected' })
      const host = makeHost({ setFlag: () => Effect.fail(error) })

      const result = yield* emailSetFlagAction
        .execute({ integration, input: { messageId: 'id', isFlagged: true } })
        .pipe(Effect.provide(host.layer), Effect.result)

      expect(result._tag).toBe('Failure')
      expect(result).toMatchObject({ failure: error })
    })
  )

  it.effect('validates host success output', () =>
    Effect.gen(function* () {
      const cases = [
        { messageId: '', isFlagged: true },
        // Wrong-typed flag from an untyped host payload.
        JSON.parse('{"messageId":"id","isFlagged":"yes"}')
      ]

      for (const output of cases) {
        const host = makeHost({
          setFlag: () => Effect.succeed(ActionResult.success(output))
        })

        const result = yield* emailSetFlagAction
          .execute({ integration, input: { messageId: 'id', isFlagged: true } })
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

  it.effect('roundtrips flag state through a host that preserves other flags', () =>
    Effect.gen(function* () {
      // Model the documented host STORE contract, not an actual IMAP server.
      const flags = new Set(['\\Seen', 'Keep'])

      const host = makeHost({
        setFlag: request =>
          Effect.sync(() => {
            if (request.isFlagged) flags.add('\\Flagged')
            else flags.delete('\\Flagged')

            return ActionResult.success({
              messageId: request.messageId,
              isFlagged: request.isFlagged
            })
          })
      })

      const flagged = yield* emailSetFlagAction
        .execute({ integration, input: { messageId: 'imap:123:1', isFlagged: true } })
        .pipe(Effect.provide(host.layer))

      expect([...flags]).toEqual(['\\Seen', 'Keep', '\\Flagged'])
      expect(flagged).toEqual(ActionResult.success({ messageId: 'imap:123:1', isFlagged: true }))

      const unflagged = yield* emailSetFlagAction
        .execute({ integration, input: { messageId: 'imap:123:1', isFlagged: false } })
        .pipe(Effect.provide(host.layer))

      expect([...flags]).toEqual(['\\Seen', 'Keep'])
      expect(unflagged).toEqual(ActionResult.success({ messageId: 'imap:123:1', isFlagged: false }))
    })
  )
})
