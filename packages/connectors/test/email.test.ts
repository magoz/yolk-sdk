import { Effect, Layer } from 'effect'
import { describe, expect, it } from '@effect/vitest'
import {
  ActionResult,
  type ActionResultType,
  ApiKeyCredential,
  ConnectorError,
  CredentialResolver,
  UsernamePasswordCredential,
  makeCredentialBinding,
  makeIntegration
} from '@yolk-sdk/connectors'
import {
  EmailClient,
  EmailConnector,
  EmailIncomingCredentialSlot,
  EmailSendMessageOutput,
  EmailSmtpCredentialSlot,
  emailGetMessageAction,
  emailListMessagesAction,
  emailSendMessageAction,
  type EmailGetMessageRequest,
  type EmailListMessagesOutput,
  type EmailListMessagesRequest,
  type EmailSendMessageRequest
} from '@yolk-sdk/connectors/email'

const usernamePassword = UsernamePasswordCredential.make({
  _tag: 'UsernamePasswordCredential',
  username: 'alice@example.com',
  password: 'secret'
})

const message = {
  id: 'message-1',
  from: [{ address: 'sender@example.com' }],
  to: [{ address: 'alice@example.com' }],
  cc: [],
  bcc: [],
  replyTo: [],
  body: { text: 'Hello' },
  attachments: []
}

type EmailRequests = {
  readonly list: Array<EmailListMessagesRequest>
  readonly get: Array<EmailGetMessageRequest>
  readonly send: Array<EmailSendMessageRequest>
}

const makeRequests = (): EmailRequests => ({ list: [], get: [], send: [] })

const makeEmailClientLayer = (input?: {
  readonly requests?: EmailRequests
  readonly listResult?: ActionResultType<EmailListMessagesOutput>
}) => {
  const requests = input?.requests ?? makeRequests()
  return Layer.succeed(
    EmailClient,
    EmailClient.of({
      listMessages: request =>
        Effect.sync(() => {
          requests.list.push(request)
          return (
            input?.listResult ??
            ActionResult.success<EmailListMessagesOutput>({
              messages: [
                {
                  id: 'message-1',
                  from: [{ address: 'sender@example.com' }],
                  to: [{ address: 'alice@example.com' }],
                  hasAttachments: false
                }
              ]
            })
          )
        }),
      getMessage: request =>
        Effect.sync(() => {
          requests.get.push(request)
          return ActionResult.success({ message })
        }),
      sendMessage: request =>
        Effect.sync(() => {
          requests.send.push(request)
          return ActionResult.success(
            EmailSendMessageOutput.make({ accepted: true, submissionId: 'submission-1' })
          )
        })
    })
  )
}

const makeHostLayer = (input?: {
  readonly requests?: EmailRequests
  readonly refs?: Array<string>
  readonly listResult?: ActionResultType<EmailListMessagesOutput>
}) => {
  const refs = input?.refs ?? []
  const credentials = Layer.succeed(
    CredentialResolver,
    CredentialResolver.of({
      resolve: request =>
        Effect.sync(() => {
          refs.push(request.binding.credentialRef)
          return usernamePassword
        })
    })
  )
  return Layer.merge(credentials, makeEmailClientLayer(input))
}

const incomingBinding = makeCredentialBinding({
  slotId: EmailIncomingCredentialSlot.id,
  credentialRef: 'incoming-credential'
})
const smtpBinding = makeCredentialBinding({
  slotId: EmailSmtpCredentialSlot.id,
  credentialRef: 'smtp-credential'
})

describe('generic email connector', () => {
  it('exports the email connector and explicit action access metadata', () => {
    expect(EmailConnector.id).toBe('email')
    expect(EmailConnector.actions.map(action => action.id)).toEqual([
      'email.list_messages',
      'email.get_message',
      'email.send_message'
    ])
    expect(emailListMessagesAction.access).toBe('read')
    expect(emailGetMessageAction.access).toBe('read')
    expect(emailSendMessageAction.access).toBe('destructive')
  })

  it.effect('applies incoming defaults and dispatches normalized list input', () => {
    const requests = makeRequests()
    const integration = makeIntegration({
      connectorId: 'email',
      config: { incomingHost: 'imap.example.com' },
      credentialBindings: [incomingBinding]
    })

    return Effect.gen(function* () {
      const result = yield* EmailConnector.invoke({
        integration,
        action: 'email.list_messages',
        input: { cursor: 'opaque-cursor' }
      })

      expect(result._tag).toBe('Success')
      expect(requests.list).toHaveLength(1)
      expect(requests.list[0]).toMatchObject({
        connection: {
          protocol: 'imap',
          host: 'imap.example.com',
          port: 993,
          security: 'tls'
        },
        cursor: 'opaque-cursor',
        limit: 50,
        credential: { _tag: 'UsernamePasswordCredential', username: 'alice@example.com' }
      })
    }).pipe(Effect.provide(makeHostLayer({ requests })))
  })

  it.effect('applies SMTP defaults and reports accepted submission without delivery claims', () => {
    const requests = makeRequests()
    const integration = makeIntegration({
      connectorId: 'email',
      config: { smtpHost: 'smtp.example.com' },
      credentialBindings: [smtpBinding]
    })

    return Effect.gen(function* () {
      const result = yield* EmailConnector.invoke({
        integration,
        action: 'email.send_message',
        input: {
          message: {
            to: [{ address: 'bob@example.com', name: 'Bob' }],
            subject: 'Hello',
            body: { text: 'Portable email' }
          }
        }
      })

      expect(result).toEqual({
        _tag: 'Success',
        value: { accepted: true, submissionId: 'submission-1' }
      })
      expect(requests.send[0]).toMatchObject({
        connection: {
          protocol: 'smtp',
          host: 'smtp.example.com',
          port: 587,
          security: 'starttls'
        },
        message: { subject: 'Hello', body: { text: 'Portable email' } }
      })
    }).pipe(Effect.provide(makeHostLayer({ requests })))
  })

  it.effect('honors POP3 and SMTP connection overrides and separate credential bindings', () => {
    const requests = makeRequests()
    const refs: Array<string> = []
    const integration = makeIntegration({
      connectorId: 'email',
      config: {
        incomingProtocol: 'pop3',
        incomingHost: 'pop.example.com',
        incomingPort: '1110',
        incomingSecurity: 'none',
        smtpProtocol: 'smtp',
        smtpHost: 'mail.example.com',
        smtpPort: 2465,
        smtpSecurity: 'tls'
      },
      credentialBindings: [incomingBinding, smtpBinding]
    })

    return Effect.gen(function* () {
      yield* EmailConnector.invoke({
        integration,
        action: 'email.get_message',
        input: { messageId: 'message-1' }
      })
      yield* EmailConnector.invoke({
        integration,
        action: 'email.send_message',
        input: { message: { to: [{ address: 'bob@example.com' }], body: { html: '<p>Hi</p>' } } }
      })

      expect(refs).toEqual(['incoming-credential', 'smtp-credential'])
      expect(requests.get[0]?.connection).toMatchObject({
        protocol: 'pop3',
        port: 1110,
        security: 'none'
      })
      expect(requests.send[0]?.connection).toMatchObject({
        protocol: 'smtp',
        port: 2465,
        security: 'tls'
      })
    }).pipe(Effect.provide(makeHostLayer({ requests, refs })))
  })

  it.effect('allows incoming-only and SMTP-only integrations', () => {
    const incoming = makeIntegration({
      connectorId: 'email',
      config: { incomingHost: 'imap.example.com' },
      credentialBindings: [incomingBinding]
    })
    const smtp = makeIntegration({
      connectorId: 'email',
      config: { smtpHost: 'smtp.example.com' },
      credentialBindings: [smtpBinding]
    })

    return Effect.gen(function* () {
      const listed = yield* EmailConnector.invoke({
        integration: incoming,
        action: 'email.list_messages',
        input: {}
      })
      const sent = yield* EmailConnector.invoke({
        integration: smtp,
        action: 'email.send_message',
        input: { message: { to: [{ address: 'bob@example.com' }], body: { text: 'Hi' } } }
      })
      expect(listed._tag).toBe('Success')
      expect(sent._tag).toBe('Success')
    }).pipe(Effect.provide(makeHostLayer()))
  })

  it.effect('rejects a folder for POP3 list and get actions before dispatch', () => {
    const requests = makeRequests()
    const integration = makeIntegration({
      connectorId: 'email',
      config: { incomingProtocol: 'pop3', incomingHost: 'pop.example.com' },
      credentialBindings: [incomingBinding]
    })

    return Effect.gen(function* () {
      const listed = yield* EmailConnector.invoke({
        integration,
        action: 'email.list_messages',
        input: { folder: 'Archive' }
      }).pipe(Effect.result)
      const fetched = yield* EmailConnector.invoke({
        integration,
        action: 'email.get_message',
        input: { messageId: 'message-1', folder: 'Archive' }
      }).pipe(Effect.result)

      expect(listed).toMatchObject({
        _tag: 'Failure',
        failure: { _tag: 'ConnectorError', cause: 'validation_failed' }
      })
      expect(fetched).toMatchObject({
        _tag: 'Failure',
        failure: { _tag: 'ConnectorError', cause: 'validation_failed' }
      })
      expect(requests.list).toHaveLength(0)
      expect(requests.get).toHaveLength(0)
    }).pipe(Effect.provide(makeHostLayer({ requests })))
  })

  it.effect('rejects recipient-less SMTP messages but permits BCC-only submission', () => {
    const requests = makeRequests()
    const integration = makeIntegration({
      connectorId: 'email',
      config: { smtpHost: 'smtp.example.com' },
      credentialBindings: [smtpBinding]
    })

    return Effect.gen(function* () {
      const rejected = yield* EmailConnector.invoke({
        integration,
        action: 'email.send_message',
        input: { message: { to: [], body: {} } }
      }).pipe(Effect.result)
      const accepted = yield* EmailConnector.invoke({
        integration,
        action: 'email.send_message',
        input: {
          message: { to: [], bcc: [{ address: 'hidden@example.com' }], body: { text: 'Hi' } }
        }
      })

      expect(rejected).toMatchObject({
        _tag: 'Failure',
        failure: { _tag: 'ConnectorError', cause: 'validation_failed' }
      })
      expect(accepted._tag).toBe('Success')
      expect(requests.send).toHaveLength(1)
    }).pipe(Effect.provide(makeHostLayer({ requests })))
  })

  it.effect('fails with typed errors for missing action config and credential binding', () =>
    Effect.gen(function* () {
      const missingConfig = yield* EmailConnector.invoke({
        integration: makeIntegration({
          connectorId: 'email',
          credentialBindings: [incomingBinding]
        }),
        action: 'email.list_messages',
        input: {}
      }).pipe(Effect.result)
      const missingCredential = yield* EmailConnector.invoke({
        integration: makeIntegration({
          connectorId: 'email',
          config: { smtpHost: 'smtp.example.com' }
        }),
        action: 'email.send_message',
        input: { message: { to: [{ address: 'bob@example.com' }], body: { text: 'Hi' } } }
      }).pipe(Effect.result)

      expect(missingConfig).toMatchObject({
        _tag: 'Failure',
        failure: { _tag: 'ConnectorError', cause: 'validation_failed' }
      })
      expect(missingCredential).toMatchObject({
        _tag: 'Failure',
        failure: { _tag: 'ConnectorError', cause: 'credential_binding_missing' }
      })
    }).pipe(Effect.provide(makeHostLayer()))
  )

  it.effect('rejects invalid config and API-key credentials as typed errors', () => {
    const integration = makeIntegration({
      connectorId: 'email',
      config: { incomingHost: 'imap.example.com', incomingPort: 70_000 },
      credentialBindings: [incomingBinding]
    })
    const invalidCredentialLayer = Layer.succeed(
      CredentialResolver,
      CredentialResolver.of({
        resolve: () =>
          Effect.succeed(ApiKeyCredential.make({ _tag: 'ApiKeyCredential', key: 'not-email-auth' }))
      })
    )

    return Effect.gen(function* () {
      const invalidPort = yield* EmailConnector.invoke({
        integration,
        action: 'email.list_messages',
        input: {}
      }).pipe(Effect.result)
      expect(invalidPort).toMatchObject({
        _tag: 'Failure',
        failure: { _tag: 'ConnectorError', cause: 'validation_failed' }
      })

      const invalidCredential = yield* EmailConnector.invoke({
        integration: makeIntegration({
          connectorId: 'email',
          config: { incomingHost: 'imap.example.com' },
          credentialBindings: [incomingBinding]
        }),
        action: 'email.list_messages',
        input: {}
      }).pipe(Effect.result)
      expect(invalidCredential).toMatchObject({
        _tag: 'Failure',
        failure: { _tag: 'ConnectorError', cause: 'credential_invalid' }
      })
    }).pipe(Effect.provide(Layer.merge(invalidCredentialLayer, makeEmailClientLayer())))
  })

  it.effect('passes provider rejection through as ActionResult.failure', () => {
    const rejection = ActionResult.failure({
      code: 'authentication_rejected',
      message: 'The server rejected authentication'
    })
    const integration = makeIntegration({
      connectorId: 'email',
      config: { incomingHost: 'imap.example.com' },
      credentialBindings: [incomingBinding]
    })

    return Effect.gen(function* () {
      const result = yield* EmailConnector.invoke({
        integration,
        action: 'email.list_messages',
        input: {}
      })
      expect(result).toEqual(rejection)
    }).pipe(Effect.provide(makeHostLayer({ listResult: rejection })))
  })

  it.effect('keeps transport failures in the typed ConnectorError channel', () => {
    const integration = makeIntegration({
      connectorId: 'email',
      config: { incomingHost: 'imap.example.com' },
      credentialBindings: [incomingBinding]
    })
    const failingClient = Layer.succeed(
      EmailClient,
      EmailClient.of({
        listMessages: () =>
          Effect.fail(
            new ConnectorError({ cause: 'transport_failed', message: 'Transport unavailable' })
          ),
        getMessage: () =>
          Effect.fail(
            new ConnectorError({ cause: 'transport_failed', message: 'Transport unavailable' })
          ),
        sendMessage: () =>
          Effect.fail(
            new ConnectorError({ cause: 'transport_failed', message: 'Transport unavailable' })
          )
      })
    )

    return Effect.gen(function* () {
      const result = yield* EmailConnector.invoke({
        integration,
        action: 'email.list_messages',
        input: {}
      }).pipe(Effect.result)
      expect(result).toMatchObject({
        _tag: 'Failure',
        failure: { _tag: 'ConnectorError', message: 'Transport unavailable' }
      })
    }).pipe(
      Effect.provide(
        Layer.merge(
          Layer.succeed(
            CredentialResolver,
            CredentialResolver.of({ resolve: () => Effect.succeed(usernamePassword) })
          ),
          failingClient
        )
      )
    )
  })
})
