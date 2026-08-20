import { Effect, Layer } from 'effect'
import * as Schema from 'effect/Schema'
import { describe, expect, it } from '@effect/vitest'
import { resolveTools } from '@yolk-sdk/agent/tools'
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
import { makeConnectorToolModule } from '@yolk-sdk/connectors/agent'
import {
  EmailAttachmentContent,
  EmailClient,
  EmailConnector,
  EmailCreateDraftOutput,
  EmailDraftId,
  EmailFolderName,
  EmailIncomingCredentialSlot,
  EmailSendMessageOutput,
  EmailSmtpCredentialSlot,
  emailCreateDraftAction,
  emailGetAttachmentAction,
  emailGetMessageAction,
  emailListMessagesAction,
  emailSendMessageAction,
  type EmailCreateDraftRequest,
  type EmailGetAttachmentOutput,
  type EmailGetAttachmentRequest,
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
  readonly attachment: Array<EmailGetAttachmentRequest>
  readonly draft: Array<EmailCreateDraftRequest>
  readonly send: Array<EmailSendMessageRequest>
}

const makeRequests = (): EmailRequests => ({
  list: [],
  get: [],
  attachment: [],
  draft: [],
  send: []
})

const makeEmailClientLayer = (input?: {
  readonly requests?: EmailRequests
  readonly listResult?: ActionResultType<EmailListMessagesOutput>
  readonly attachmentResult?: ActionResultType<EmailGetAttachmentOutput>
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
      getAttachment: request =>
        Effect.sync(() => {
          requests.attachment.push(request)
          return (
            input?.attachmentResult ??
            ActionResult.success({
              attachment: {
                id: request.attachmentId,
                filename: 'invoice.pdf',
                contentType: 'application/pdf',
                size: 4,
                inline: false,
                contentBase64: 'JVBERg=='
              }
            })
          )
        }),
      createDraft: request =>
        Effect.sync(() => {
          requests.draft.push(request)
          return ActionResult.success(
            EmailCreateDraftOutput.make({
              saved: true,
              folder: request.folder ?? EmailFolderName.make('Drafts'),
              draftId: EmailDraftId.make('imap:uid-validity-123:uid-456')
            })
          )
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
  readonly attachmentResult?: ActionResultType<EmailGetAttachmentOutput>
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
      'email.get_attachment',
      'email.create_draft',
      'email.send_message'
    ])
    expect(emailListMessagesAction.access).toBe('read')
    expect(emailGetMessageAction.access).toBe('read')
    expect(emailGetAttachmentAction.access).toBe('read')
    expect(emailCreateDraftAction.access).toBe('write')
    expect(emailSendMessageAction.access).toBe('destructive')
  })

  it.effect('exposes a provider-safe attachment tool schema', () => {
    const integration = makeIntegration({
      connectorId: 'email',
      config: { incomingHost: 'imap.example.com' },
      credentialBindings: [incomingBinding]
    })

    return Effect.gen(function* () {
      const toolSet = yield* resolveTools(
        [makeConnectorToolModule(EmailConnector, { integration, layer: makeHostLayer() })],
        {}
      )
      const tool = toolSet.tools.find(candidate => candidate.name === 'email.get_attachment')
      const schema = JSON.stringify(tool?.parameters)

      expect(tool?.parameters).toMatchObject({ type: 'object' })
      expect(schema).not.toContain('"type":"null"')
    })
  })

  it.effect('rejects malformed base64 and invalid decoded-byte sizes', () =>
    Effect.gen(function* () {
      const malformedBase64 = yield* Schema.decodeUnknownEffect(EmailAttachmentContent)({
        id: 'mime-part-2',
        size: 4,
        contentBase64: 'not-base64'
      }).pipe(Effect.result)
      const invalidSize = yield* Schema.decodeUnknownEffect(EmailAttachmentContent)({
        id: 'mime-part-2',
        size: -1,
        contentBase64: 'JVBERg=='
      }).pipe(Effect.result)

      expect(malformedBase64._tag).toBe('Failure')
      expect(invalidSize._tag).toBe('Failure')
    })
  )

  it.effect('allows existing EmailClient hosts to omit attachment retrieval', () => {
    const integration = makeIntegration({
      connectorId: 'email',
      config: { incomingHost: 'imap.example.com' },
      credentialBindings: [incomingBinding]
    })
    const legacyClient = Layer.succeed(
      EmailClient,
      EmailClient.of({
        listMessages: () => Effect.succeed(ActionResult.success({ messages: [] })),
        getMessage: () => Effect.succeed(ActionResult.success({ message })),
        createDraft: request =>
          Effect.succeed(
            ActionResult.success(
              EmailCreateDraftOutput.make({
                saved: true,
                folder: request.folder ?? EmailFolderName.make('Drafts')
              })
            )
          ),
        sendMessage: () =>
          Effect.succeed(ActionResult.success(EmailSendMessageOutput.make({ accepted: true })))
      })
    )
    const credentials = Layer.succeed(
      CredentialResolver,
      CredentialResolver.of({ resolve: () => Effect.succeed(usernamePassword) })
    )

    return Effect.gen(function* () {
      const result = yield* EmailConnector.invoke({
        integration,
        action: 'email.get_attachment',
        input: { messageId: 'message-1', attachmentId: 'mime-part-2' }
      }).pipe(Effect.provide(Layer.merge(credentials, legacyClient)), Effect.result)

      expect(result).toMatchObject({
        _tag: 'Failure',
        failure: {
          _tag: 'ConnectorError',
          cause: 'validation_failed',
          message: 'EmailClient does not support attachment retrieval'
        }
      })
    })
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

  it.effect('retrieves decoded IMAP attachment content as base64', () => {
    const requests = makeRequests()
    const integration = makeIntegration({
      connectorId: 'email',
      config: { incomingHost: 'imap.example.com' },
      credentialBindings: [incomingBinding]
    })

    return Effect.gen(function* () {
      const result = yield* emailGetAttachmentAction.execute({
        integration,
        input: {
          messageId: 'message-1',
          attachmentId: 'mime-part-2',
          folder: 'Archive'
        }
      })

      expect(result).toEqual({
        _tag: 'Success',
        value: {
          attachment: {
            id: 'mime-part-2',
            filename: 'invoice.pdf',
            contentType: 'application/pdf',
            size: 4,
            inline: false,
            contentBase64: 'JVBERg=='
          }
        }
      })
      expect(requests.attachment[0]).toMatchObject({
        connection: {
          protocol: 'imap',
          host: 'imap.example.com',
          port: 993,
          security: 'tls'
        },
        messageId: 'message-1',
        attachmentId: 'mime-part-2',
        folder: 'Archive',
        credential: { _tag: 'UsernamePasswordCredential', username: 'alice@example.com' }
      })
    }).pipe(Effect.provide(makeHostLayer({ requests })))
  })

  it.effect('saves recipient-less drafts through IMAP and allows an explicit folder', () => {
    const requests = makeRequests()
    const integration = makeIntegration({
      connectorId: 'email',
      config: { incomingHost: 'imap.example.com' },
      credentialBindings: [incomingBinding]
    })

    return Effect.gen(function* () {
      const result = yield* EmailConnector.invoke({
        integration,
        action: 'email.create_draft',
        input: {
          folder: 'Saved Drafts',
          message: { to: [], subject: 'Work in progress', body: {} }
        }
      })

      expect(result).toEqual({
        _tag: 'Success',
        value: {
          saved: true,
          folder: 'Saved Drafts',
          draftId: 'imap:uid-validity-123:uid-456'
        }
      })
      expect(requests.draft[0]).toMatchObject({
        connection: {
          protocol: 'imap',
          host: 'imap.example.com',
          port: 993,
          security: 'tls'
        },
        folder: 'Saved Drafts',
        message: { subject: 'Work in progress', to: [], body: {} }
      })
    }).pipe(Effect.provide(makeHostLayer({ requests })))
  })

  it.effect('leaves an omitted draft folder for host mailbox discovery', () => {
    const requests = makeRequests()
    const integration = makeIntegration({
      connectorId: 'email',
      config: { incomingHost: 'imap.example.com' },
      credentialBindings: [incomingBinding]
    })

    return Effect.gen(function* () {
      const result = yield* EmailConnector.invoke({
        integration,
        action: 'email.create_draft',
        input: { message: { to: [], body: { text: 'Unfiled draft' } } }
      })

      expect(result).toMatchObject({
        _tag: 'Success',
        value: { saved: true, folder: 'Drafts' }
      })
      expect(requests.draft[0]?.folder).toBeUndefined()
    }).pipe(Effect.provide(makeHostLayer({ requests })))
  })

  it.effect('rejects empty explicit draft folders before dispatch', () => {
    const requests = makeRequests()
    const integration = makeIntegration({
      connectorId: 'email',
      config: { incomingHost: 'imap.example.com' },
      credentialBindings: [incomingBinding]
    })

    return Effect.gen(function* () {
      const result = yield* EmailConnector.invoke({
        integration,
        action: 'email.create_draft',
        input: { folder: '   ', message: { to: [], body: {} } }
      }).pipe(Effect.result)

      expect(result).toMatchObject({
        _tag: 'Failure',
        failure: { _tag: 'ConnectorError', cause: 'validation_failed' }
      })
      expect(requests.draft).toHaveLength(0)
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
        action: 'email.get_attachment',
        input: { messageId: 'message-1', attachmentId: 'mime-part-2' }
      })
      yield* EmailConnector.invoke({
        integration,
        action: 'email.send_message',
        input: { message: { to: [{ address: 'bob@example.com' }], body: { html: '<p>Hi</p>' } } }
      })

      expect(refs).toEqual(['incoming-credential', 'incoming-credential', 'smtp-credential'])
      expect(requests.get[0]?.connection).toMatchObject({
        protocol: 'pop3',
        port: 1110,
        security: 'none'
      })
      expect(requests.attachment[0]?.connection).toMatchObject({
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

  it.effect('rejects a folder for POP3 list, get, and attachment actions before dispatch', () => {
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
      const attachment = yield* EmailConnector.invoke({
        integration,
        action: 'email.get_attachment',
        input: { messageId: 'message-1', attachmentId: 'mime-part-2', folder: 'Archive' }
      }).pipe(Effect.result)

      expect(listed).toMatchObject({
        _tag: 'Failure',
        failure: { _tag: 'ConnectorError', cause: 'validation_failed' }
      })
      expect(fetched).toMatchObject({
        _tag: 'Failure',
        failure: { _tag: 'ConnectorError', cause: 'validation_failed' }
      })
      expect(attachment).toMatchObject({
        _tag: 'Failure',
        failure: { _tag: 'ConnectorError', cause: 'validation_failed' }
      })
      expect(requests.list).toHaveLength(0)
      expect(requests.get).toHaveLength(0)
      expect(requests.attachment).toHaveLength(0)
    }).pipe(Effect.provide(makeHostLayer({ requests })))
  })

  it.effect('rejects draft creation through POP3 before resolving credentials or dispatching', () => {
    const requests = makeRequests()
    const refs: Array<string> = []
    const integration = makeIntegration({
      connectorId: 'email',
      config: { incomingProtocol: 'pop3', incomingHost: 'pop.example.com' },
      credentialBindings: [incomingBinding]
    })

    return Effect.gen(function* () {
      const result = yield* EmailConnector.invoke({
        integration,
        action: 'email.create_draft',
        input: { message: { to: [], body: { text: 'Not supported' } } }
      }).pipe(Effect.result)

      expect(result).toMatchObject({
        _tag: 'Failure',
        failure: { _tag: 'ConnectorError', cause: 'validation_failed' }
      })
      expect(refs).toHaveLength(0)
      expect(requests.draft).toHaveLength(0)
    }).pipe(Effect.provide(makeHostLayer({ requests, refs })))
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

  it.effect('passes provider rejections through as ActionResult.failure', () => {
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
      const listResult = yield* EmailConnector.invoke({
        integration,
        action: 'email.list_messages',
        input: {}
      })
      const attachmentResult = yield* EmailConnector.invoke({
        integration,
        action: 'email.get_attachment',
        input: { messageId: 'message-1', attachmentId: 'mime-part-2' }
      })
      expect(listResult).toEqual(rejection)
      expect(attachmentResult).toEqual(rejection)
    }).pipe(Effect.provide(makeHostLayer({ listResult: rejection, attachmentResult: rejection })))
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
        getAttachment: () =>
          Effect.fail(
            new ConnectorError({ cause: 'transport_failed', message: 'Transport unavailable' })
          ),
        createDraft: () =>
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
      const listResult = yield* EmailConnector.invoke({
        integration,
        action: 'email.list_messages',
        input: {}
      }).pipe(Effect.result)
      const attachmentResult = yield* EmailConnector.invoke({
        integration,
        action: 'email.get_attachment',
        input: { messageId: 'message-1', attachmentId: 'mime-part-2' }
      }).pipe(Effect.result)
      expect(listResult).toMatchObject({
        _tag: 'Failure',
        failure: { _tag: 'ConnectorError', message: 'Transport unavailable' }
      })
      expect(attachmentResult).toMatchObject({
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
