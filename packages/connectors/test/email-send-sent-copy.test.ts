import { Effect, Layer, Result } from 'effect'
import { describe, expect, it } from '@effect/vitest'
import * as Schema from 'effect/Schema'
import { resolveTools } from '@yolk-sdk/agent/tools'
import { makeConnectorToolModule } from '@yolk-sdk/connectors/agent'
import {
  ActionResult,
  type ActionResultType,
  CredentialResolver,
  UsernamePasswordCredential,
  makeCredentialBinding,
  makeIntegration
} from '@yolk-sdk/connectors'
import {
  EmailClient,
  EmailConnector,
  EmailFolderName,
  EmailIncomingCredentialSlot,
  EmailSendMessageInput,
  EmailSendMessageOutput,
  EmailSendMessageRequest,
  EmailSentCopyOutput,
  EmailSentCopyRequest,
  EmailSmtpCredentialSlot,
  emailSendMessageAction
} from '@yolk-sdk/connectors/email'

const incomingCredential = UsernamePasswordCredential.make({
  username: 'alice@example.com',
  password: 'incoming-secret'
})

const smtpCredential = UsernamePasswordCredential.make({
  username: 'alice@example.com',
  password: 'smtp-secret'
})

const incomingBinding = makeCredentialBinding({
  slotId: EmailIncomingCredentialSlot.id,
  credentialRef: 'incoming-credential'
})

const smtpBinding = makeCredentialBinding({
  slotId: EmailSmtpCredentialSlot.id,
  credentialRef: 'smtp-credential'
})

const composeMessage = {
  to: [{ address: 'bob@example.com' }],
  subject: 'Hello',
  body: { text: 'Portable email' }
}

type SendRequests = Array<EmailSendMessageRequest>

const makeSendHost = (input: {
  readonly requests: SendRequests
  readonly refs: Array<string>
  readonly sendResult?: ActionResultType<EmailSendMessageOutput>
  readonly sendValue?: EmailSendMessageOutput
}) => {
  const credentials = Layer.succeed(
    CredentialResolver,
    CredentialResolver.of({
      resolve: request =>
        Effect.sync(() => {
          input.refs.push(request.binding.credentialRef)

          return request.binding.credentialRef === 'incoming-credential'
            ? incomingCredential
            : smtpCredential
        })
    })
  )

  const client = Layer.succeed(
    EmailClient,
    EmailClient.of({
      listMessages: () => Effect.succeed(ActionResult.success({ messages: [] })),
      getMessage: () =>
        Effect.succeed(
          ActionResult.success({
            message: {
              id: 'message-1',
              from: [{ address: 'sender@example.com' }],
              to: [{ address: 'alice@example.com' }],
              cc: [],
              bcc: [],
              replyTo: [],
              body: { text: 'Hello' },
              attachments: [],
              headers: []
            }
          })
        ),
      createDraft: request =>
        Effect.succeed(
          ActionResult.success({
            saved: true,
            folder: request.folder ?? EmailFolderName.make('Drafts')
          })
        ),
      sendMessage: request =>
        Effect.sync(() => {
          input.requests.push(request)

          if (input.sendResult !== undefined) return input.sendResult

          return ActionResult.success(
            input.sendValue ?? { accepted: true, submissionId: 'submission-1' }
          )
        })
    })
  )

  return Layer.merge(credentials, client)
}

const imapSmtpIntegration = makeIntegration({
  connectorId: 'email',
  config: { incomingHost: 'imap.example.com', smtpHost: 'smtp.example.com' },
  credentialBindings: [incomingBinding, smtpBinding]
})

describe('email.send_message Sent-copy contract', () => {
  it.effect('carries separate incoming credentials with the IMAP Sent copy by default', () =>
    Effect.gen(function* () {
      const requests: SendRequests = []
      const refs: Array<string> = []

      const result = yield* emailSendMessageAction
        .execute({
          integration: imapSmtpIntegration,
          input: { message: composeMessage }
        })
        .pipe(Effect.provide(makeSendHost({ requests, refs })))

      expect(refs).toEqual(['incoming-credential', 'smtp-credential'])
      expect(requests).toHaveLength(1)
      expect(requests[0]).toMatchObject({
        connection: { protocol: 'smtp', host: 'smtp.example.com' },
        message: { subject: 'Hello' }
      })
      expect(requests[0]?.credential).toEqual(smtpCredential)
      expect(requests[0]?.sentCopy).toMatchObject({
        connection: {
          protocol: 'imap',
          host: 'imap.example.com',
          port: 993,
          security: 'tls'
        }
      })
      expect(requests[0]?.sentCopy).not.toHaveProperty('folder')
      expect(requests[0]?.sentCopy?.credential).toEqual(incomingCredential)
      // Legacy host omits sentCopy: saving was requested, so synthesize unsupported.
      expect(result).toEqual(
        ActionResult.success({
          accepted: true,
          submissionId: 'submission-1',
          sentCopy: { status: 'unsupported' }
        })
      )
    })
  )

  it.effect('passes an explicit sentFolder and retains host saved output', () =>
    Effect.gen(function* () {
      const requests: SendRequests = []
      const refs: Array<string> = []

      const result = yield* emailSendMessageAction
        .execute({
          integration: imapSmtpIntegration,
          input: { message: composeMessage, sentFolder: EmailFolderName.make('Sent Items') }
        })
        .pipe(
          Effect.provide(
            makeSendHost({
              requests,
              refs,
              sendValue: EmailSendMessageOutput.make({
                accepted: true,
                submissionId: 'submission-2',
                sentCopy: EmailSentCopyOutput.make({
                  status: 'saved',
                  folder: EmailFolderName.make('Sent Items')
                })
              })
            })
          )
        )

      expect(requests[0]?.sentCopy?.folder).toBe('Sent Items')
      expect(result).toEqual(
        ActionResult.success({
          accepted: true,
          submissionId: 'submission-2',
          sentCopy: { status: 'saved', folder: 'Sent Items' }
        })
      )
    })
  )

  it.effect('opt-out skips incoming credential access and reports skipped', () =>
    Effect.gen(function* () {
      const requests: SendRequests = []
      const refs: Array<string> = []

      const result = yield* emailSendMessageAction
        .execute({
          integration: imapSmtpIntegration,
          input: { message: composeMessage, saveToSentItems: false }
        })
        .pipe(Effect.provide(makeSendHost({ requests, refs })))

      expect(refs).toEqual(['smtp-credential'])
      expect(requests).toHaveLength(1)
      expect(requests[0]?.sentCopy).toBeUndefined()
      expect(result).toEqual(
        ActionResult.success({
          accepted: true,
          submissionId: 'submission-1',
          sentCopy: { status: 'skipped' }
        })
      )
    })
  )

  it.effect('POP3 still sends and reports unsupported without incoming credentials', () =>
    Effect.gen(function* () {
      const requests: SendRequests = []
      const refs: Array<string> = []

      const integration = makeIntegration({
        connectorId: 'email',
        config: {
          incomingProtocol: 'pop3',
          incomingHost: 'pop.example.com',
          smtpHost: 'smtp.example.com'
        },
        credentialBindings: [incomingBinding, smtpBinding]
      })

      const result = yield* emailSendMessageAction
        .execute({
          integration,
          input: { message: composeMessage }
        })
        .pipe(Effect.provide(makeSendHost({ requests, refs })))

      expect(refs).toEqual(['smtp-credential'])
      expect(requests).toHaveLength(1)
      expect(requests[0]?.connection).toMatchObject({ protocol: 'smtp' })
      expect(requests[0]?.sentCopy).toBeUndefined()
      expect(result).toEqual(
        ActionResult.success({
          accepted: true,
          submissionId: 'submission-1',
          sentCopy: { status: 'unsupported' }
        })
      )
    })
  )

  it.effect('SMTP-only integrations still send with unsupported Sent status', () =>
    Effect.gen(function* () {
      const requests: SendRequests = []
      const refs: Array<string> = []

      const integration = makeIntegration({
        connectorId: 'email',
        config: { smtpHost: 'smtp.example.com' },
        credentialBindings: [smtpBinding]
      })

      const result = yield* emailSendMessageAction
        .execute({
          integration,
          input: { message: composeMessage }
        })
        .pipe(Effect.provide(makeSendHost({ requests, refs })))

      expect(refs).toEqual(['smtp-credential'])
      expect(requests).toHaveLength(1)
      expect(requests[0]?.sentCopy).toBeUndefined()
      expect(result).toEqual(
        ActionResult.success({
          accepted: true,
          submissionId: 'submission-1',
          sentCopy: { status: 'unsupported' }
        })
      )
    })
  )

  it.effect('passes host failed Sent output through without implying resend', () =>
    Effect.gen(function* () {
      const requests: SendRequests = []
      const refs: Array<string> = []

      const result = yield* emailSendMessageAction
        .execute({
          integration: imapSmtpIntegration,
          input: { message: composeMessage }
        })
        .pipe(
          Effect.provide(
            makeSendHost({
              requests,
              refs,
              sendValue: EmailSendMessageOutput.make({
                accepted: true,
                submissionId: 'submission-3',
                sentCopy: EmailSentCopyOutput.make({ status: 'failed' })
              })
            })
          )
        )

      expect(result).toEqual(
        ActionResult.success({
          accepted: true,
          submissionId: 'submission-3',
          sentCopy: { status: 'failed' }
        })
      )
      expect(requests[0]?.sentCopy).not.toBeUndefined()
    })
  )

  it.effect('preserves acceptance at the agent boundary when Sent metadata is malformed', () =>
    Effect.gen(function* () {
      const requests: SendRequests = []
      const refs: Array<string> = []

      const sendValue = EmailSendMessageOutput.make({
        accepted: true,
        submissionId: 'confirmed-submission'
      })

      // Simulate a host violating its typed output contract, without weakening the port type.
      Object.defineProperty(sendValue, 'sentCopy', {
        value: { status: 'failed', folder: '', providerDetail: 'secret-marker' },
        enumerable: true
      })

      const tools = yield* resolveTools(
        [
          makeConnectorToolModule(EmailConnector, {
            integration: imapSmtpIntegration,
            layer: makeSendHost({ requests, refs, sendValue })
          })
        ],
        {}
      )

      const result = yield* tools.execute({
        id: 'send-call',
        name: 'email.send_message',
        params: { message: composeMessage }
      })

      expect(requests).toHaveLength(1)
      expect(result.isError).not.toBe(true)
      expect(result.structuredContent).toMatchObject({
        accepted: true,
        submissionId: 'confirmed-submission',
        sentCopy: { status: 'failed' }
      })
      expect(JSON.stringify(result)).toContain('Do not resend.')
      expect(JSON.stringify(result)).not.toContain('secret-marker')
    })
  )

  it.effect('preserves host ActionResult failures untouched', () =>
    Effect.gen(function* () {
      const requests: SendRequests = []
      const refs: Array<string> = []

      const failure = ActionResult.failure({
        code: 'authentication_rejected',
        message: 'SMTP authentication rejected'
      })

      const result = yield* emailSendMessageAction
        .execute({
          integration: imapSmtpIntegration,
          input: { message: composeMessage }
        })
        .pipe(Effect.provide(makeSendHost({ requests, refs, sendResult: failure })))

      expect(result).toEqual(failure)
      expect(requests).toHaveLength(1)
    })
  )

  it.effect('keeps the additive contract optional for old inputs and host outputs', () =>
    Effect.gen(function* () {
      const legacyInput = yield* Schema.decodeUnknownEffect(EmailSendMessageInput)({
        message: { to: [{ address: 'bob@example.com' }], body: { text: 'Hi' } }
      })

      const legacyRequest = yield* Schema.decodeUnknownEffect(EmailSendMessageRequest)({
        connection: { protocol: 'smtp', host: 'smtp.example.com', port: 587, security: 'starttls' },
        credential: {
          _tag: 'UsernamePasswordCredential',
          username: 'alice@example.com',
          password: 'smtp-secret'
        },
        message: { to: [{ address: 'bob@example.com' }], body: { text: 'Hi' } }
      })

      const legacyOutput = yield* Schema.decodeUnknownEffect(EmailSendMessageOutput)({
        accepted: true
      })

      const sentCopyRequest = EmailSentCopyRequest.make({
        connection: { protocol: 'imap', host: 'imap.example.com', port: 993, security: 'tls' },
        credential: incomingCredential
      })

      const sentCopyOutput = EmailSentCopyOutput.make({ status: 'saved' })

      expect(legacyInput.saveToSentItems).toBeUndefined()
      expect(legacyInput.sentFolder).toBeUndefined()
      expect(legacyRequest.sentCopy).toBeUndefined()
      expect(legacyOutput.sentCopy).toBeUndefined()
      expect(sentCopyRequest.folder).toBeUndefined()
      expect(sentCopyOutput).toEqual(EmailSentCopyOutput.make({ status: 'saved' }))

      const invalidStatus = yield* Schema.decodeUnknownEffect(EmailSendMessageOutput)({
        accepted: true,
        sentCopy: { status: 'stored' }
      }).pipe(Effect.result)

      expect(Result.isFailure(invalidStatus)).toBe(true)
    })
  )
})
