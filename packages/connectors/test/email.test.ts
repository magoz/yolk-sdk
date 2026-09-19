import { Effect, Layer, Predicate, Result } from 'effect'
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
  type EmailSecurity,
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
      'email.send_message',
      'email.set_read',
      'email.set_flag',
      'email.trash',
      'email.untrash',
      'email.modify_labels',
      'email.move'
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

  it.effect('rejects malformed host attachment output through the public action', () => {
    const integration = makeIntegration({
      connectorId: 'email',
      config: { incomingHost: 'imap.example.com' },
      credentialBindings: [incomingBinding]
    })

    const attachmentResult = ActionResult.success<EmailGetAttachmentOutput>({
      attachment: {
        id: 'mime-part-2',
        size: -1,
        contentBase64: 'not-base64'
      }
    })

    return Effect.gen(function* () {
      const result = yield* EmailConnector.invoke({
        integration,
        action: 'email.get_attachment',
        input: { messageId: 'message-1', attachmentId: 'mime-part-2' }
      }).pipe(Effect.provide(makeHostLayer({ attachmentResult })), Effect.result)

      expect(Result.isFailure(result)).toBe(true)

      if (Result.isFailure(result)) {
        expect(Predicate.isTagged(result.failure, 'ConnectorError')).toBe(true)
        expect(result.failure).toMatchObject({ cause: 'validation_failed' })
        expect(result.failure.underlying).toBeInstanceOf(Error)
        expect(Schema.isSchemaError(result.failure.underlying)).toBe(true)
      }
    })
  })

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

      expect(Result.isFailure(result)).toBe(true)

      if (Result.isFailure(result)) {
        expect(Predicate.isTagged(result.failure, 'ConnectorError')).toBe(true)
        expect(result.failure).toMatchObject({
          cause: 'validation_failed',
          message: 'EmailClient does not support attachment retrieval'
        })
      }
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
        credential: usernamePassword
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

      expect(result).toEqual(
        ActionResult.success({
          attachment: {
            id: 'mime-part-2',
            filename: 'invoice.pdf',
            contentType: 'application/pdf',
            size: 4,
            inline: false,
            contentBase64: 'JVBERg=='
          }
        })
      )
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
        credential: usernamePassword
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

      expect(result).toEqual(
        ActionResult.success({
          saved: true,
          folder: 'Saved Drafts',
          draftId: 'imap:uid-validity-123:uid-456'
        })
      )
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

      expect(result._tag).toBe('Success')
      expect(result).toMatchObject({ value: { saved: true, folder: 'Drafts' } })
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

      expect(Result.isFailure(result)).toBe(true)

      if (Result.isFailure(result)) {
        expect(Predicate.isTagged(result.failure, 'ConnectorError')).toBe(true)
        expect(result.failure).toMatchObject({ cause: 'validation_failed' })
      }

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

      expect(result).toEqual(ActionResult.success({ accepted: true, submissionId: 'submission-1' }))
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

  it.effect('selects SMTP and IMAP default ports from EmailSecurity owners', () =>
    Effect.gen(function* () {
      const smtpCases: ReadonlyArray<readonly [EmailSecurity, number]> = [
        ['tls', 465],
        ['starttls', 587],
        ['none', 25]
      ]

      for (const [security, port] of smtpCases) {
        const requests = makeRequests()

        const result = yield* EmailConnector.invoke({
          integration: makeIntegration({
            connectorId: 'email',
            config: { smtpHost: 'smtp.example.com', smtpSecurity: security },
            credentialBindings: [smtpBinding]
          }),
          action: 'email.send_message',
          input: {
            message: { to: [{ address: 'bob@example.com' }], body: { text: 'Hello' } }
          }
        }).pipe(Effect.provide(makeHostLayer({ requests })))

        expect(result).toEqual(
          ActionResult.success({ accepted: true, submissionId: 'submission-1' })
        )
        expect(requests.send[0]?.connection).toMatchObject({
          protocol: 'smtp',
          port,
          security
        })
      }

      const incomingCases: ReadonlyArray<readonly [EmailSecurity, number]> = [
        ['tls', 993],
        ['starttls', 143],
        ['none', 143]
      ]

      for (const [security, port] of incomingCases) {
        const requests = makeRequests()

        const result = yield* EmailConnector.invoke({
          integration: makeIntegration({
            connectorId: 'email',
            config: { incomingHost: 'imap.example.com', incomingSecurity: security },
            credentialBindings: [incomingBinding]
          }),
          action: 'email.get_attachment',
          input: { messageId: 'message-1', attachmentId: 'mime-part-2' }
        }).pipe(Effect.provide(makeHostLayer({ requests })))

        expect(result).toEqual(
          ActionResult.success({
            attachment: {
              id: 'mime-part-2',
              filename: 'invoice.pdf',
              contentType: 'application/pdf',
              size: 4,
              inline: false,
              contentBase64: 'JVBERg=='
            }
          })
        )
        expect(requests.attachment[0]?.connection).toMatchObject({
          protocol: 'imap',
          port,
          security
        })
        expect(requests.attachment[0]?.attachmentId).toBe('mime-part-2')
      }
    })
  )

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

      expect(Result.isFailure(listed)).toBe(true)

      if (Result.isFailure(listed)) {
        expect(Predicate.isTagged(listed.failure, 'ConnectorError')).toBe(true)
        expect(listed.failure).toMatchObject({ cause: 'validation_failed' })
      }

      expect(Result.isFailure(fetched)).toBe(true)

      if (Result.isFailure(fetched)) {
        expect(Predicate.isTagged(fetched.failure, 'ConnectorError')).toBe(true)
        expect(fetched.failure).toMatchObject({ cause: 'validation_failed' })
      }

      expect(Result.isFailure(attachment)).toBe(true)

      if (Result.isFailure(attachment)) {
        expect(Predicate.isTagged(attachment.failure, 'ConnectorError')).toBe(true)
        expect(attachment.failure).toMatchObject({ cause: 'validation_failed' })
      }

      expect(requests.list).toHaveLength(0)
      expect(requests.get).toHaveLength(0)
      expect(requests.attachment).toHaveLength(0)
    }).pipe(Effect.provide(makeHostLayer({ requests })))
  })

  it.effect(
    'rejects draft creation through POP3 before resolving credentials or dispatching',
    () => {
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

        expect(Result.isFailure(result)).toBe(true)

        if (Result.isFailure(result)) {
          expect(Predicate.isTagged(result.failure, 'ConnectorError')).toBe(true)
          expect(result.failure).toMatchObject({ cause: 'validation_failed' })
        }

        expect(refs).toHaveLength(0)
        expect(requests.draft).toHaveLength(0)
      }).pipe(Effect.provide(makeHostLayer({ requests, refs })))
    }
  )

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

      expect(Result.isFailure(rejected)).toBe(true)

      if (Result.isFailure(rejected)) {
        expect(Predicate.isTagged(rejected.failure, 'ConnectorError')).toBe(true)
        expect(rejected.failure).toMatchObject({ cause: 'validation_failed' })
      }

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

      expect(Result.isFailure(missingConfig)).toBe(true)

      if (Result.isFailure(missingConfig)) {
        expect(Predicate.isTagged(missingConfig.failure, 'ConnectorError')).toBe(true)
        expect(missingConfig.failure).toMatchObject({ cause: 'validation_failed' })
      }

      expect(Result.isFailure(missingCredential)).toBe(true)

      if (Result.isFailure(missingCredential)) {
        expect(Predicate.isTagged(missingCredential.failure, 'ConnectorError')).toBe(true)
        expect(missingCredential.failure).toMatchObject({ cause: 'credential_binding_missing' })
      }
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
        resolve: () => Effect.succeed(ApiKeyCredential.make({ key: 'not-email-auth' }))
      })
    )

    return Effect.gen(function* () {
      const invalidPort = yield* EmailConnector.invoke({
        integration,
        action: 'email.list_messages',
        input: {}
      }).pipe(Effect.result)

      expect(Result.isFailure(invalidPort)).toBe(true)

      if (Result.isFailure(invalidPort)) {
        expect(Predicate.isTagged(invalidPort.failure, 'ConnectorError')).toBe(true)
        expect(invalidPort.failure).toMatchObject({ cause: 'validation_failed' })
      }

      const invalidCredential = yield* EmailConnector.invoke({
        integration: makeIntegration({
          connectorId: 'email',
          config: { incomingHost: 'imap.example.com' },
          credentialBindings: [incomingBinding]
        }),
        action: 'email.list_messages',
        input: {}
      }).pipe(Effect.result)

      expect(Result.isFailure(invalidCredential)).toBe(true)

      if (Result.isFailure(invalidCredential)) {
        expect(Predicate.isTagged(invalidCredential.failure, 'ConnectorError')).toBe(true)
        expect(invalidCredential.failure).toMatchObject({ cause: 'credential_invalid' })
      }
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

      expect(Result.isFailure(listResult)).toBe(true)

      if (Result.isFailure(listResult)) {
        expect(Predicate.isTagged(listResult.failure, 'ConnectorError')).toBe(true)
        expect(listResult.failure).toMatchObject({ message: 'Transport unavailable' })
      }

      expect(Result.isFailure(attachmentResult)).toBe(true)

      if (Result.isFailure(attachmentResult)) {
        expect(Predicate.isTagged(attachmentResult.failure, 'ConnectorError')).toBe(true)
        expect(attachmentResult.failure).toMatchObject({ message: 'Transport unavailable' })
      }
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

  it.effect('trims own incoming and SMTP host config values', () => {
    const requests = makeRequests()

    return Effect.gen(function* () {
      const listed = yield* EmailConnector.invoke({
        integration: makeIntegration({
          connectorId: 'email',
          config: { incomingHost: ' imap.example.com ' },
          credentialBindings: [incomingBinding]
        }),
        action: 'email.list_messages',
        input: {}
      })

      const sent = yield* EmailConnector.invoke({
        integration: makeIntegration({
          connectorId: 'email',
          config: { smtpHost: ' smtp.example.com ' },
          credentialBindings: [smtpBinding]
        }),
        action: 'email.send_message',
        input: { message: { to: [{ address: 'bob@example.com' }], body: { text: 'Hi' } } }
      })

      expect(listed._tag).toBe('Success')
      expect(sent._tag).toBe('Success')
      expect(requests.list[0]?.connection.host).toBe('imap.example.com')
      expect(requests.send[0]?.connection.host).toBe('smtp.example.com')
    }).pipe(Effect.provide(makeHostLayer({ requests })))
  })

  it.effect('rejects inherited and getter email config without evaluating accessors', () => {
    const requests = makeRequests()
    let incomingHostReads = 0
    let incomingProtocolReads = 0
    let incomingPortReads = 0

    const inherited = makeIntegration({
      connectorId: 'email',
      config: {},
      credentialBindings: [incomingBinding]
    })

    Object.setPrototypeOf(inherited.config, { incomingHost: 'imap.example.com' })

    const accessors = makeIntegration({
      connectorId: 'email',
      config: {},
      credentialBindings: [incomingBinding]
    })

    Object.defineProperty(accessors.config, 'incomingHost', {
      configurable: true,
      enumerable: true,
      get: () => {
        incomingHostReads += 1

        return 'imap.example.com'
      }
    })
    Object.defineProperty(accessors.config, 'incomingProtocol', {
      configurable: true,
      enumerable: true,
      get: () => {
        incomingProtocolReads += 1

        return 'pop3'
      }
    })
    Object.defineProperty(accessors.config, 'incomingPort', {
      configurable: true,
      enumerable: true,
      get: () => {
        incomingPortReads += 1

        return 1110
      }
    })

    return Effect.gen(function* () {
      const inheritedResult = yield* EmailConnector.invoke({
        integration: inherited,
        action: 'email.list_messages',
        input: {}
      }).pipe(Effect.result)

      const accessorResult = yield* EmailConnector.invoke({
        integration: accessors,
        action: 'email.list_messages',
        input: {}
      }).pipe(Effect.result)

      expect(Result.isFailure(inheritedResult)).toBe(true)

      if (Result.isFailure(inheritedResult)) {
        expect(Predicate.isTagged(inheritedResult.failure, 'ConnectorError')).toBe(true)
        expect(inheritedResult.failure).toMatchObject({
          cause: 'validation_failed',
          message: 'Missing integration config: incomingHost',
          connectorId: 'email'
        })
      }

      expect(Result.isFailure(accessorResult)).toBe(true)

      if (Result.isFailure(accessorResult)) {
        expect(Predicate.isTagged(accessorResult.failure, 'ConnectorError')).toBe(true)
        expect(accessorResult.failure).toMatchObject({
          cause: 'validation_failed',
          message: 'Missing integration config: incomingHost',
          connectorId: 'email'
        })
      }

      expect(incomingHostReads).toBe(0)
      expect(incomingProtocolReads).toBe(0)
      expect(incomingPortReads).toBe(0)
      expect(requests.list).toHaveLength(0)
    }).pipe(Effect.provide(makeHostLayer({ requests })))
  })

  it.effect(
    'keeps enum fallback distinct from invalid values and preserves underlying config',
    () => {
      const protocol = { kind: 'imap' }
      const requests = makeRequests()

      return Effect.gen(function* () {
        const fallback = yield* EmailConnector.invoke({
          integration: makeIntegration({
            connectorId: 'email',
            config: { incomingHost: 'imap.example.com' },
            credentialBindings: [incomingBinding]
          }),
          action: 'email.list_messages',
          input: {}
        })

        const invalidString = yield* EmailConnector.invoke({
          integration: makeIntegration({
            connectorId: 'email',
            config: { incomingHost: 'imap.example.com', incomingProtocol: 'smtp' },
            credentialBindings: [incomingBinding]
          }),
          action: 'email.list_messages',
          input: {}
        }).pipe(Effect.result)

        const invalidObject = yield* EmailConnector.invoke({
          integration: makeIntegration({
            connectorId: 'email',
            config: { incomingHost: 'imap.example.com', incomingProtocol: protocol },
            credentialBindings: [incomingBinding]
          }),
          action: 'email.list_messages',
          input: {}
        }).pipe(Effect.result)

        expect(fallback._tag).toBe('Success')
        expect(requests.list[0]?.connection.protocol).toBe('imap')

        expect(Result.isFailure(invalidString)).toBe(true)

        if (Result.isFailure(invalidString)) {
          expect(Predicate.isTagged(invalidString.failure, 'ConnectorError')).toBe(true)
          expect(invalidString.failure).toMatchObject({
            cause: 'validation_failed',
            message: 'Invalid integration config incomingProtocol; expected imap | pop3',
            connectorId: 'email',
            underlying: 'smtp'
          })
        }

        expect(Result.isFailure(invalidObject)).toBe(true)

        if (Result.isFailure(invalidObject)) {
          expect(Predicate.isTagged(invalidObject.failure, 'ConnectorError')).toBe(true)
          expect(invalidObject.failure.underlying).toBe(protocol)
        }
      }).pipe(Effect.provide(makeHostLayer({ requests })))
    }
  )

  it.effect(
    'accepts integer and digit-string ports in 1-65535 and rejects out-of-range values',
    () => {
      const requests = makeRequests()

      return Effect.gen(function* () {
        const listed = yield* EmailConnector.invoke({
          integration: makeIntegration({
            connectorId: 'email',
            config: { incomingHost: 'imap.example.com', incomingPort: '1' },
            credentialBindings: [incomingBinding]
          }),
          action: 'email.list_messages',
          input: {}
        })

        const sent = yield* EmailConnector.invoke({
          integration: makeIntegration({
            connectorId: 'email',
            config: { smtpHost: 'smtp.example.com', smtpPort: 65_535 },
            credentialBindings: [smtpBinding]
          }),
          action: 'email.send_message',
          input: { message: { to: [{ address: 'bob@example.com' }], body: { text: 'Hi' } } }
        })

        const zero = yield* EmailConnector.invoke({
          integration: makeIntegration({
            connectorId: 'email',
            config: { incomingHost: 'imap.example.com', incomingPort: 0 },
            credentialBindings: [incomingBinding]
          }),
          action: 'email.list_messages',
          input: {}
        }).pipe(Effect.result)

        const over = yield* EmailConnector.invoke({
          integration: makeIntegration({
            connectorId: 'email',
            config: { incomingHost: 'imap.example.com', incomingPort: '65536' },
            credentialBindings: [incomingBinding]
          }),
          action: 'email.list_messages',
          input: {}
        }).pipe(Effect.result)

        expect(listed._tag).toBe('Success')
        expect(sent._tag).toBe('Success')
        expect(requests.list[0]?.connection.port).toBe(1)
        expect(requests.send[0]?.connection.port).toBe(65_535)

        expect(Result.isFailure(zero)).toBe(true)

        if (Result.isFailure(zero)) {
          expect(Predicate.isTagged(zero.failure, 'ConnectorError')).toBe(true)
          expect(zero.failure).toMatchObject({
            cause: 'validation_failed',
            message: 'Invalid integration config incomingPort; expected port 1-65535',
            connectorId: 'email',
            underlying: 0
          })
        }

        expect(Result.isFailure(over)).toBe(true)

        if (Result.isFailure(over)) {
          expect(Predicate.isTagged(over.failure, 'ConnectorError')).toBe(true)
          expect(over.failure).toMatchObject({
            cause: 'validation_failed',
            message: 'Invalid integration config incomingPort; expected port 1-65535',
            connectorId: 'email',
            underlying: '65536'
          })
        }
      }).pipe(Effect.provide(makeHostLayer({ requests })))
    }
  )

  it.effect(
    'falls back through individual own protocol, security, and port accessors without evaluating them',
    () => {
      let incomingProtocolReads = 0
      let incomingSecurityReads = 0
      let incomingPortReads = 0
      let smtpProtocolReads = 0
      let smtpSecurityReads = 0
      let smtpPortReads = 0

      const incomingProtocol = makeIntegration({
        connectorId: 'email',
        config: { incomingHost: 'imap.example.com' },
        credentialBindings: [incomingBinding]
      })

      const incomingSecurity = makeIntegration({
        connectorId: 'email',
        config: { incomingHost: 'imap.example.com' },
        credentialBindings: [incomingBinding]
      })

      const incomingPort = makeIntegration({
        connectorId: 'email',
        config: { incomingHost: 'imap.example.com' },
        credentialBindings: [incomingBinding]
      })

      const smtpProtocol = makeIntegration({
        connectorId: 'email',
        config: { smtpHost: 'smtp.example.com' },
        credentialBindings: [smtpBinding]
      })

      const smtpSecurity = makeIntegration({
        connectorId: 'email',
        config: { smtpHost: 'smtp.example.com' },
        credentialBindings: [smtpBinding]
      })

      const smtpPort = makeIntegration({
        connectorId: 'email',
        config: { smtpHost: 'smtp.example.com' },
        credentialBindings: [smtpBinding]
      })

      Object.defineProperty(incomingProtocol.config, 'incomingProtocol', {
        configurable: true,
        enumerable: true,
        get: () => {
          incomingProtocolReads += 1

          return 'pop3'
        }
      })
      Object.defineProperty(incomingSecurity.config, 'incomingSecurity', {
        configurable: true,
        enumerable: true,
        get: () => {
          incomingSecurityReads += 1

          return 'none'
        }
      })
      Object.defineProperty(incomingPort.config, 'incomingPort', {
        configurable: true,
        enumerable: true,
        get: () => {
          incomingPortReads += 1

          return 1110
        }
      })
      Object.defineProperty(smtpProtocol.config, 'smtpProtocol', {
        configurable: true,
        enumerable: true,
        get: () => {
          smtpProtocolReads += 1

          return 'imap'
        }
      })
      Object.defineProperty(smtpSecurity.config, 'smtpSecurity', {
        configurable: true,
        enumerable: true,
        get: () => {
          smtpSecurityReads += 1

          return 'tls'
        }
      })
      Object.defineProperty(smtpPort.config, 'smtpPort', {
        configurable: true,
        enumerable: true,
        get: () => {
          smtpPortReads += 1

          return 25
        }
      })

      return Effect.gen(function* () {
        const incomingProtocolRequests = makeRequests()
        const incomingSecurityRequests = makeRequests()
        const incomingPortRequests = makeRequests()
        const smtpProtocolRequests = makeRequests()
        const smtpSecurityRequests = makeRequests()
        const smtpPortRequests = makeRequests()

        const incomingProtocolResult = yield* EmailConnector.invoke({
          integration: incomingProtocol,
          action: 'email.list_messages',
          input: {}
        }).pipe(Effect.provide(makeHostLayer({ requests: incomingProtocolRequests })))

        const incomingSecurityResult = yield* EmailConnector.invoke({
          integration: incomingSecurity,
          action: 'email.list_messages',
          input: {}
        }).pipe(Effect.provide(makeHostLayer({ requests: incomingSecurityRequests })))

        const incomingPortResult = yield* EmailConnector.invoke({
          integration: incomingPort,
          action: 'email.list_messages',
          input: {}
        }).pipe(Effect.provide(makeHostLayer({ requests: incomingPortRequests })))

        const smtpProtocolResult = yield* EmailConnector.invoke({
          integration: smtpProtocol,
          action: 'email.send_message',
          input: { message: { to: [{ address: 'bob@example.com' }], body: { text: 'Hi' } } }
        }).pipe(Effect.provide(makeHostLayer({ requests: smtpProtocolRequests })))

        const smtpSecurityResult = yield* EmailConnector.invoke({
          integration: smtpSecurity,
          action: 'email.send_message',
          input: { message: { to: [{ address: 'bob@example.com' }], body: { text: 'Hi' } } }
        }).pipe(Effect.provide(makeHostLayer({ requests: smtpSecurityRequests })))

        const smtpPortResult = yield* EmailConnector.invoke({
          integration: smtpPort,
          action: 'email.send_message',
          input: { message: { to: [{ address: 'bob@example.com' }], body: { text: 'Hi' } } }
        }).pipe(Effect.provide(makeHostLayer({ requests: smtpPortRequests })))

        expect(incomingProtocolResult._tag).toBe('Success')
        expect(incomingSecurityResult._tag).toBe('Success')
        expect(incomingPortResult._tag).toBe('Success')
        expect(smtpProtocolResult._tag).toBe('Success')
        expect(smtpSecurityResult._tag).toBe('Success')
        expect(smtpPortResult._tag).toBe('Success')

        expect(incomingProtocolRequests.list[0]?.connection).toMatchObject({
          protocol: 'imap',
          host: 'imap.example.com',
          port: 993,
          security: 'tls'
        })
        expect(incomingSecurityRequests.list[0]?.connection).toMatchObject({
          protocol: 'imap',
          port: 993,
          security: 'tls'
        })
        expect(incomingPortRequests.list[0]?.connection).toMatchObject({
          protocol: 'imap',
          port: 993,
          security: 'tls'
        })
        expect(smtpProtocolRequests.send[0]?.connection).toMatchObject({
          protocol: 'smtp',
          host: 'smtp.example.com',
          port: 587,
          security: 'starttls'
        })
        expect(smtpSecurityRequests.send[0]?.connection).toMatchObject({
          protocol: 'smtp',
          port: 587,
          security: 'starttls'
        })
        expect(smtpPortRequests.send[0]?.connection).toMatchObject({
          protocol: 'smtp',
          port: 587,
          security: 'starttls'
        })

        expect(incomingProtocolReads).toBe(0)
        expect(incomingSecurityReads).toBe(0)
        expect(incomingPortReads).toBe(0)
        expect(smtpProtocolReads).toBe(0)
        expect(smtpSecurityReads).toBe(0)
        expect(smtpPortReads).toBe(0)
      })
    }
  )

  it.effect(
    'rejects invalid own security and port without accessor execution or credential dispatch',
    () => {
      const requests = makeRequests()
      const refs: Array<string> = []
      let incomingProtocolReads = 0
      let incomingSecurityReads = 0
      let incomingPortReads = 0
      let smtpProtocolReads = 0
      let smtpPortReads = 0

      const invalidIncomingSecurity = makeIntegration({
        connectorId: 'email',
        config: { incomingHost: 'imap.example.com', incomingSecurity: 'ssl' },
        credentialBindings: [incomingBinding]
      })

      const invalidIncomingPort = makeIntegration({
        connectorId: 'email',
        config: { incomingHost: 'imap.example.com', incomingPort: 0 },
        credentialBindings: [incomingBinding]
      })

      const invalidSmtpSecurity = makeIntegration({
        connectorId: 'email',
        config: { smtpHost: 'smtp.example.com', smtpSecurity: 'ssl' },
        credentialBindings: [smtpBinding]
      })

      Object.defineProperty(invalidIncomingSecurity.config, 'incomingProtocol', {
        configurable: true,
        enumerable: true,
        get: () => {
          incomingProtocolReads += 1

          return 'pop3'
        }
      })
      Object.defineProperty(invalidIncomingSecurity.config, 'incomingPort', {
        configurable: true,
        enumerable: true,
        get: () => {
          incomingPortReads += 1

          return 1110
        }
      })
      Object.defineProperty(invalidIncomingPort.config, 'incomingSecurity', {
        configurable: true,
        enumerable: true,
        get: () => {
          incomingSecurityReads += 1

          return 'none'
        }
      })
      Object.defineProperty(invalidSmtpSecurity.config, 'smtpProtocol', {
        configurable: true,
        enumerable: true,
        get: () => {
          smtpProtocolReads += 1

          return 'imap'
        }
      })
      Object.defineProperty(invalidSmtpSecurity.config, 'smtpPort', {
        configurable: true,
        enumerable: true,
        get: () => {
          smtpPortReads += 1

          return 25
        }
      })

      return Effect.gen(function* () {
        const incomingSecurityResult = yield* EmailConnector.invoke({
          integration: invalidIncomingSecurity,
          action: 'email.list_messages',
          input: {}
        }).pipe(Effect.result)

        const incomingPortResult = yield* EmailConnector.invoke({
          integration: invalidIncomingPort,
          action: 'email.list_messages',
          input: {}
        }).pipe(Effect.result)

        const smtpSecurityResult = yield* EmailConnector.invoke({
          integration: invalidSmtpSecurity,
          action: 'email.send_message',
          input: { message: { to: [{ address: 'bob@example.com' }], body: { text: 'Hi' } } }
        }).pipe(Effect.result)

        expect(Result.isFailure(incomingSecurityResult)).toBe(true)

        if (Result.isFailure(incomingSecurityResult)) {
          expect(Predicate.isTagged(incomingSecurityResult.failure, 'ConnectorError')).toBe(true)
          expect(incomingSecurityResult.failure).toMatchObject({
            cause: 'validation_failed',
            message: 'Invalid integration config incomingSecurity; expected none | starttls | tls',
            connectorId: 'email',
            underlying: 'ssl'
          })
        }

        expect(Result.isFailure(incomingPortResult)).toBe(true)

        if (Result.isFailure(incomingPortResult)) {
          expect(Predicate.isTagged(incomingPortResult.failure, 'ConnectorError')).toBe(true)
          expect(incomingPortResult.failure).toMatchObject({
            cause: 'validation_failed',
            message: 'Invalid integration config incomingPort; expected port 1-65535',
            connectorId: 'email',
            underlying: 0
          })
        }

        expect(Result.isFailure(smtpSecurityResult)).toBe(true)

        if (Result.isFailure(smtpSecurityResult)) {
          expect(Predicate.isTagged(smtpSecurityResult.failure, 'ConnectorError')).toBe(true)
          expect(smtpSecurityResult.failure).toMatchObject({
            cause: 'validation_failed',
            message: 'Invalid integration config smtpSecurity; expected none | starttls | tls',
            connectorId: 'email',
            underlying: 'ssl'
          })
        }

        expect(incomingProtocolReads).toBe(0)
        expect(incomingSecurityReads).toBe(0)
        expect(incomingPortReads).toBe(0)
        expect(smtpProtocolReads).toBe(0)
        expect(smtpPortReads).toBe(0)
        expect(refs).toHaveLength(0)
        expect(requests.list).toHaveLength(0)
        expect(requests.send).toHaveLength(0)
      }).pipe(Effect.provide(makeHostLayer({ requests, refs })))
    }
  )
})
