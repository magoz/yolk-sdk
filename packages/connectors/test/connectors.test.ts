import { Effect, Layer } from 'effect'
import * as Schema from 'effect/Schema'
import { describe, expect, it } from '@effect/vitest'
import { resolveTools } from '@yolk-sdk/agent/tools'
import {
  ActionResult,
  ApiKeyCredential,
  type ConnectorAction,
  OAuthCredential,
  ConnectorError,
  ConnectorHttpClient,
  ConnectorHttpResponse,
  CredentialResolver,
  defineAction,
  defineConnector,
  makeCredentialBinding,
  makeIntegration
} from '@yolk-sdk/connectors'
import type { ConnectorHttpRequest } from '@yolk-sdk/connectors'
import { makeConnectorToolModule } from '@yolk-sdk/connectors/agent'
import { FigmaConnector } from '@yolk-sdk/connectors/figma'
import {
  gmailDraftComposeAction,
  gmailDraftReplyAction,
  gmailListSendAsAction,
  GoogleConnector,
  GoogleOAuthCredentialSlot,
  googleCalendarCreateEventAction
} from '@yolk-sdk/connectors/google'
import {
  ExaApiKeySlot,
  LinkedInSearchConnector,
  linkedInSearchAction
} from '@yolk-sdk/connectors/linkedin-search'
import {
  NotionApiTokenSlot,
  NotionConnector,
  notionCreatePageAction,
  notionSearchAction
} from '@yolk-sdk/connectors/notion'
import { R2StorageConnector } from '@yolk-sdk/connectors/r2-storage'
import {
  TelegramConnector,
  telegramBotTokenSlotId,
  telegramSendMessageAction
} from '@yolk-sdk/connectors/telegram'
import {
  TodoistApiTokenSlot,
  TodoistConnector,
  todoistCreateTaskAction
} from '@yolk-sdk/connectors/todoist'

const TestInput = Schema.Struct({ text: Schema.String })
const TestOutput = Schema.Struct({ value: Schema.String })

const encodeBase64Url = (value: string) => Buffer.from(value, 'utf8').toString('base64url')

const rawTextEmail = (input: {
  readonly to: ReadonlyArray<string>
  readonly subject: string
  readonly body: string
  readonly cc?: ReadonlyArray<string>
  readonly bcc?: ReadonlyArray<string>
  readonly from?: string
  readonly inReplyTo?: string
  readonly references?: string
}) => {
  const headers = [
    ...(input.from === undefined ? [] : [`From: ${input.from}`]),
    ...(input.to.length === 0 ? [] : [`To: ${input.to.join(', ')}`]),
    ...(input.cc === undefined ? [] : [`Cc: ${input.cc.join(', ')}`]),
    ...(input.bcc === undefined ? [] : [`Bcc: ${input.bcc.join(', ')}`]),
    `Subject: ${input.subject}`,
    ...(input.inReplyTo === undefined ? [] : [`In-Reply-To: ${input.inReplyTo}`]),
    ...(input.references === undefined ? [] : [`References: ${input.references}`]),
    'Content-Type: text/plain; charset=utf-8'
  ]

  return encodeBase64Url(`${headers.join('\r\n')}\r\n\r\n${input.body}`)
}

const testAction = defineAction({
  id: 'test.echo',
  description: 'Echo test action.',
  inputSchema: TestInput,
  outputSchema: TestOutput,
  execute: ({ input }) => Effect.succeed(ActionResult.success({ value: input.text }))
})

const failureAction = defineAction({
  id: 'test.fail',
  description: 'Return a provider failure.',
  inputSchema: Schema.Struct({}),
  outputSchema: TestOutput,
  execute: () => Effect.succeed(ActionResult.failure({ code: 'upstream_failed', message: 'Nope' }))
})

const TestConnector = defineConnector({
  id: 'test',
  actions: [testAction, failureAction]
})

const integration = makeIntegration({ connectorId: 'test' })

const googleIntegration = makeIntegration({
  connectorId: 'google',
  credentialBindings: [
    makeCredentialBinding({
      slotId: GoogleOAuthCredentialSlot.id,
      credentialRef: 'google-token'
    })
  ]
})

const GoogleCredentialResolverTest = Layer.succeed(
  CredentialResolver,
  CredentialResolver.of({
    resolve: () =>
      Effect.succeed(
        OAuthCredential.make({
          _tag: 'OAuthCredential',
          provider: 'google',
          accessToken: 'google_token',
          expiresAt: Date.now() + 60_000
        })
      )
  })
)

const jsonHttpResponse = (body: string) =>
  ConnectorHttpResponse.make({
    status: 200,
    headers: { 'content-type': 'application/json' },
    body
  })

const makeConnectorHttpClientTest = (
  requests: Array<ConnectorHttpRequest>,
  responses: ReadonlyArray<ConnectorHttpResponse>
) => {
  let index = 0

  return Layer.succeed(
    ConnectorHttpClient,
    ConnectorHttpClient.of({
      request: request => {
        requests.push(request)
        const response = responses.at(index)
        index += 1

        if (response === undefined) {
          return Effect.fail(
            new ConnectorError({
              cause: 'validation_failed',
              message: 'Unexpected test request'
            })
          )
        }

        return Effect.succeed(response)
      }
    })
  )
}

type JsonRequestCase = {
  readonly name: string
  readonly execute: ConnectorAction<
    ConnectorHttpClient | CredentialResolver,
    ConnectorError
  >['execute']
  readonly connectorId: string
  readonly slotId: string
  readonly credentialKind?: 'api_key' | 'oauth'
  readonly input: unknown
  readonly config?: Readonly<Record<string, unknown>>
  readonly expected: {
    readonly method: string
    readonly url: string
    readonly body: unknown
  }
}

const successBody = (name: string) => {
  switch (name) {
    case 'Calendar create event':
      return '{"id":"event_1","summary":"Planning"}'
    case 'Notion search':
      return '{"results":[],"hasMore":false}'
    case 'Notion create page':
      return '{"id":"page_1","object":"page"}'
    case 'Todoist create task':
      return '{"id":"task_1","content":"Buy milk"}'
    case 'LinkedIn search':
      return '{"results":[],"totalResults":0}'
    case 'Telegram send message':
      return '{"ok":true}'
    default:
      return '{}'
  }
}

const jsonRequestCases: ReadonlyArray<JsonRequestCase> = [
  {
    name: 'Calendar create event',
    execute: googleCalendarCreateEventAction.execute,
    connectorId: 'google',
    slotId: GoogleOAuthCredentialSlot.id,
    credentialKind: 'oauth',
    input: {
      summary: 'Planning',
      start: { dateTime: '2026-05-21T10:00:00Z' },
      end: { dateTime: '2026-05-21T10:30:00Z' }
    },
    expected: {
      method: 'POST',
      url: 'https://www.googleapis.com/calendar/v3/calendars/primary/events',
      body: {
        summary: 'Planning',
        start: { dateTime: '2026-05-21T10:00:00Z' },
        end: { dateTime: '2026-05-21T10:30:00Z' }
      }
    }
  },
  {
    name: 'Notion search',
    execute: notionSearchAction.execute,
    connectorId: 'notion',
    slotId: NotionApiTokenSlot.id,
    input: { query: 'roadmap', pageSize: 3 },
    expected: {
      method: 'POST',
      url: 'https://api.notion.com/v1/search',
      body: { query: 'roadmap', page_size: 3 }
    }
  },
  {
    name: 'Notion create page',
    execute: notionCreatePageAction.execute,
    connectorId: 'notion',
    slotId: NotionApiTokenSlot.id,
    input: { parentPageId: 'parent_1', title: 'New page' },
    expected: {
      method: 'POST',
      url: 'https://api.notion.com/v1/pages',
      body: {
        parent: { page_id: 'parent_1' },
        properties: { title: { title: [{ text: { content: 'New page' } }] } }
      }
    }
  },
  {
    name: 'Todoist create task',
    execute: todoistCreateTaskAction.execute,
    connectorId: 'todoist',
    slotId: TodoistApiTokenSlot.id,
    input: { content: 'Buy milk', dueString: 'tomorrow' },
    expected: {
      method: 'POST',
      url: 'https://api.todoist.com/api/v1/tasks',
      body: { content: 'Buy milk', due_string: 'tomorrow' }
    }
  },
  {
    name: 'LinkedIn search',
    execute: linkedInSearchAction.execute,
    connectorId: 'linkedin-search',
    slotId: ExaApiKeySlot.id,
    input: { query: 'founder', numResults: 2 },
    expected: {
      method: 'POST',
      url: 'https://api.exa.ai/search',
      body: {
        query: 'founder',
        category: 'people',
        numResults: 2,
        type: 'auto',
        contents: { text: true }
      }
    }
  },
  {
    name: 'Telegram send message',
    execute: telegramSendMessageAction.execute,
    connectorId: 'telegram',
    slotId: telegramBotTokenSlotId,
    input: { message: 'hello', disableWebPagePreview: true },
    config: { chatId: 'chat_1' },
    expected: {
      method: 'POST',
      url: 'https://api.telegram.org/botapi_token/sendMessage',
      body: { chat_id: 'chat_1', text: 'hello', disable_web_page_preview: true }
    }
  }
]

describe('@yolk-sdk/connectors', () => {
  it('imports public subpaths', async () => {
    const [root, agent, figma, google, linkedIn, notion, r2, telegram, todoist] = await Promise.all(
      [
        import('@yolk-sdk/connectors'),
        import('@yolk-sdk/connectors/agent'),
        import('@yolk-sdk/connectors/figma'),
        import('@yolk-sdk/connectors/google'),
        import('@yolk-sdk/connectors/linkedin-search'),
        import('@yolk-sdk/connectors/notion'),
        import('@yolk-sdk/connectors/r2-storage'),
        import('@yolk-sdk/connectors/telegram'),
        import('@yolk-sdk/connectors/todoist')
      ]
    )

    expect(root.defineConnector).toBeDefined()
    expect(agent.makeConnectorToolModule).toBeDefined()
    expect(figma.FigmaConnector).toBeDefined()
    expect(google.GoogleConnector).toBeDefined()
    expect(linkedIn.LinkedInSearchConnector).toBeDefined()
    expect(notion.NotionConnector).toBeDefined()
    expect(r2.R2StorageConnector).toBeDefined()
    expect(telegram.TelegramConnector).toBeDefined()
    expect(todoist.TodoistConnector).toBeDefined()
  })

  it('exposes provider action definitions', () => {
    expect(GoogleConnector.actions.map(action => action.id)).toEqual([
      'gmail.search',
      'gmail.list',
      'gmail.list_drafts',
      'gmail.get_message',
      'gmail.draft_reply',
      'gmail.get_attachment',
      'gmail.draft_compose',
      'gmail.draft_update',
      'gmail.get_thread',
      'gmail.list_labels',
      'gmail.modify_labels',
      'gmail.trash',
      'gmail.untrash',
      'gmail.draft_delete',
      'gmail.list_send_as',
      'gmail.list_accounts',
      'calendar.list_calendars',
      'calendar.list_events',
      'calendar.get_event',
      'calendar.create_event',
      'calendar.update_event',
      'calendar.delete_event',
      'calendar.list_accounts'
    ])
    expect(FigmaConnector.actions.map(action => action.id)).toEqual(['figma.mcp_auth'])
    expect(LinkedInSearchConnector.actions.map(action => action.id)).toEqual([
      'linkedin_search.search',
      'linkedin_search.profile',
      'linkedin_search.email'
    ])
    expect(NotionConnector.actions.map(action => action.id)).toEqual([
      'notion.search',
      'notion.get_page',
      'notion.get_page_content',
      'notion.create_page',
      'notion.update_page',
      'notion.get_database',
      'notion.query_database',
      'notion.create_database',
      'notion.append_blocks',
      'notion.update_block',
      'notion.delete_block',
      'notion.get_data_source',
      'notion.query_data_source',
      'notion.create_data_source',
      'notion.update_data_source',
      'notion.get_block',
      'notion.update_database',
      'notion.get_page_property',
      'notion.list_users',
      'notion.get_user',
      'notion.get_bot_user',
      'notion.create_comment',
      'notion.list_comments'
    ])
    expect(R2StorageConnector.actions.map(action => action.id)).toEqual(['r2_storage.upload_url'])
    expect(TelegramConnector.actions.map(action => action.id)).toEqual([
      'telegram.send_message',
      'telegram.validate'
    ])
    expect(TodoistConnector.actions.map(action => action.id)).toEqual([
      'todoist.list_projects',
      'todoist.create_project',
      'todoist.get_project',
      'todoist.update_project',
      'todoist.delete_project',
      'todoist.list_tasks',
      'todoist.create_task',
      'todoist.get_task',
      'todoist.update_task',
      'todoist.close_task',
      'todoist.delete_task',
      'todoist.list_labels'
    ])
  })

  it.effect('invokes a typed connector action', () =>
    Effect.gen(function* () {
      const result = yield* TestConnector.invoke({
        integration,
        action: 'test.echo',
        input: { text: 'hello' }
      })

      expect(result).toEqual({ _tag: 'Success', value: { value: 'hello' } })
    })
  )

  it.effect('rejects connector mismatch', () =>
    Effect.gen(function* () {
      const result = yield* TestConnector.invoke({
        integration: makeIntegration({ connectorId: 'other' }),
        action: 'test.echo',
        input: { text: 'hello' }
      }).pipe(Effect.result)

      expect(result).toMatchObject({
        _tag: 'Failure',
        failure: { _tag: 'ConnectorError', cause: 'connector_mismatch' }
      })
    })
  )

  it.effect('rejects invalid action input', () =>
    Effect.gen(function* () {
      const result = yield* TestConnector.invoke({
        integration,
        action: 'test.echo',
        input: { text: 123 }
      }).pipe(Effect.result)

      expect(result).toMatchObject({
        _tag: 'Failure',
        failure: { _tag: 'ConnectorError', cause: 'validation_failed' }
      })
    })
  )

  it.effect('adapts successful connector actions to agent tools', () =>
    Effect.gen(function* () {
      const toolModule = makeConnectorToolModule(TestConnector, {
        integration,
        layer: Layer.empty,
        access: action => (action.includes('fail') ? 'write' : 'read')
      })
      const toolSet = yield* resolveTools([toolModule], {})
      const result = yield* toolSet.execute({
        id: 'call_1',
        name: 'test.echo',
        params: { text: 'hi' }
      })

      expect(toolSet.metadata).toContainEqual({
        moduleId: 'test',
        name: 'test.fail',
        access: 'write'
      })
      expect(result).toMatchObject({
        toolCallId: 'call_1',
        content: JSON.stringify({ value: 'hi' }),
        structuredContent: { value: 'hi' }
      })
    })
  )

  it.effect('adapts provider failures to error tool results', () =>
    Effect.gen(function* () {
      const toolModule = makeConnectorToolModule(TestConnector, {
        integration,
        layer: Layer.empty
      })
      const toolSet = yield* resolveTools([toolModule], {})
      const result = yield* toolSet.execute({ id: 'call_1', name: 'test.fail', params: {} })

      expect(result).toMatchObject({
        toolCallId: 'call_1',
        content: 'upstream_failed: Nope',
        isError: true,
        structuredContent: { code: 'upstream_failed', message: 'Nope' }
      })
    })
  )

  for (const requestCase of jsonRequestCases) {
    it.effect(`${requestCase.name} sends a JSON request`, () =>
      Effect.gen(function* () {
        const requests: Array<ConnectorHttpRequest> = []
        const integration = makeIntegration({
          connectorId: requestCase.connectorId,
          config: requestCase.config,
          credentialBindings: [
            makeCredentialBinding({
              slotId: requestCase.slotId,
              credentialRef: 'api-token'
            })
          ]
        })
        const CredentialResolverTest = Layer.succeed(
          CredentialResolver,
          CredentialResolver.of({
            resolve: () =>
              Effect.succeed(
                requestCase.credentialKind === 'oauth'
                  ? OAuthCredential.make({
                      _tag: 'OAuthCredential',
                      provider: requestCase.connectorId,
                      accessToken: 'api_token',
                      expiresAt: Date.now() + 60_000
                    })
                  : ApiKeyCredential.make({ _tag: 'ApiKeyCredential', key: 'api_token' })
              )
          })
        )
        const ConnectorHttpClientTest = Layer.succeed(
          ConnectorHttpClient,
          ConnectorHttpClient.of({
            request: request => {
              requests.push(request)

              return Effect.succeed(
                ConnectorHttpResponse.make({
                  status: 200,
                  headers: { 'content-type': 'application/json' },
                  body: successBody(requestCase.name)
                })
              )
            }
          })
        )

        yield* requestCase
          .execute({
            integration,
            input: requestCase.input
          })
          .pipe(Effect.provide(Layer.mergeAll(CredentialResolverTest, ConnectorHttpClientTest)))

        expect(requests[0]).toMatchObject({
          method: requestCase.expected.method,
          url: requestCase.expected.url,
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(requestCase.expected.body)
        })
      })
    )
  }

  it.effect('validates Gmail draft compose send-as aliases', () =>
    Effect.gen(function* () {
      const requests: Array<ConnectorHttpRequest> = []
      const ConnectorHttpClientTest = makeConnectorHttpClientTest(requests, [
        jsonHttpResponse('{"sendAs":[{"sendAsEmail":"elina@speldosa.app"}]}'),
        jsonHttpResponse('{"id":"draft_1"}')
      ])

      const result = yield* gmailDraftComposeAction
        .execute({
          integration: googleIntegration,
          input: {
            to: ['lead@example.com'],
            subject: 'Hej',
            body: 'Välkommen',
            from: 'Elina <elina@speldosa.app>'
          }
        })
        .pipe(Effect.provide(Layer.mergeAll(GoogleCredentialResolverTest, ConnectorHttpClientTest)))

      const sendAsRequest = requests.at(0)
      const draftRequest = requests.at(1)
      if (sendAsRequest === undefined || draftRequest === undefined) {
        throw new Error('Expected Gmail requests')
      }

      expect(result).toMatchObject({ _tag: 'Success' })
      expect(sendAsRequest).toMatchObject({
        method: 'GET',
        url: 'https://gmail.googleapis.com/gmail/v1/users/me/settings/sendAs'
      })
      expect(draftRequest).toMatchObject({
        method: 'POST',
        url: 'https://gmail.googleapis.com/gmail/v1/users/me/drafts',
        body: JSON.stringify({
          message: {
            raw: rawTextEmail({
              to: ['lead@example.com'],
              subject: 'Hej',
              body: 'Välkommen',
              from: 'Elina <elina@speldosa.app>'
            })
          }
        })
      })
    })
  )

  it.effect('rejects unconfigured Gmail draft send-as aliases', () =>
    Effect.gen(function* () {
      const requests: Array<ConnectorHttpRequest> = []
      const ConnectorHttpClientTest = makeConnectorHttpClientTest(requests, [
        jsonHttpResponse('{"sendAs":[{"sendAsEmail":"elina@speldosa.app"}]}')
      ])

      const result = yield* gmailDraftComposeAction
        .execute({
          integration: googleIntegration,
          input: {
            to: ['lead@example.com'],
            subject: 'Hej',
            body: 'Välkommen',
            from: 'wrong@speldosa.app'
          }
        })
        .pipe(Effect.provide(Layer.mergeAll(GoogleCredentialResolverTest, ConnectorHttpClientTest)))

      expect(result).toMatchObject({
        _tag: 'Failure',
        error: { code: 'gmail_from_not_configured' }
      })
      expect(requests).toHaveLength(1)
    })
  )

  it.effect('lists Gmail send-as aliases', () =>
    Effect.gen(function* () {
      const requests: Array<ConnectorHttpRequest> = []
      const ConnectorHttpClientTest = makeConnectorHttpClientTest(requests, [
        jsonHttpResponse(
          '{"sendAs":[{"sendAsEmail":"elina@speldosa.app","displayName":"Elina","isDefault":true}]}'
        )
      ])

      const result = yield* gmailListSendAsAction
        .execute({ integration: googleIntegration, input: {} })
        .pipe(Effect.provide(Layer.mergeAll(GoogleCredentialResolverTest, ConnectorHttpClientTest)))

      expect(result).toMatchObject({
        _tag: 'Success',
        value: {
          sendAs: [
            { sendAsEmail: 'elina@speldosa.app', displayName: 'Elina', isDefault: true }
          ]
        }
      })
      expect(requests.at(0)).toMatchObject({
        method: 'GET',
        url: 'https://gmail.googleapis.com/gmail/v1/users/me/settings/sendAs'
      })
    })
  )

  it.effect('detects Gmail reply send-as aliases from recipient headers', () =>
    Effect.gen(function* () {
      const requests: Array<ConnectorHttpRequest> = []
      const ConnectorHttpClientTest = makeConnectorHttpClientTest(requests, [
        jsonHttpResponse(
          JSON.stringify({
            id: 'msg_1',
            threadId: 'thread_1',
            payload: {
              headers: [
                { name: 'From', value: 'Lead <lead@example.com>' },
                { name: 'To', value: 'Elina <elina@speldosa.app>' },
                { name: 'Cc', value: 'Other <other@example.com>' },
                { name: 'Message-ID', value: '<msg_1@example.com>' },
                { name: 'References', value: '<root@example.com>' },
                { name: 'Subject', value: 'Hej' }
              ]
            }
          })
        ),
        jsonHttpResponse('{"emailAddress":"primary@gmail.com"}'),
        jsonHttpResponse(
          '{"sendAs":[{"sendAsEmail":"primary@gmail.com"},{"sendAsEmail":"elina@speldosa.app"}]}'
        ),
        jsonHttpResponse('{"id":"draft_1"}')
      ])

      const result = yield* gmailDraftReplyAction
        .execute({
          integration: googleIntegration,
          input: { messageId: 'msg_1', body: 'Tack' }
        })
        .pipe(Effect.provide(Layer.mergeAll(GoogleCredentialResolverTest, ConnectorHttpClientTest)))

      const draftRequest = requests.at(3)
      if (draftRequest === undefined) throw new Error('Expected Gmail draft request')

      expect(result).toMatchObject({ _tag: 'Success' })
      expect(draftRequest).toMatchObject({
        method: 'POST',
        url: 'https://gmail.googleapis.com/gmail/v1/users/me/drafts',
        body: JSON.stringify({
          message: {
            threadId: 'thread_1',
            raw: rawTextEmail({
              to: ['Lead <lead@example.com>', 'Other <other@example.com>'],
              subject: 'Re: Hej',
              body: 'Tack',
              from: 'elina@speldosa.app',
              inReplyTo: '<msg_1@example.com>',
              references: '<root@example.com> <msg_1@example.com>'
            })
          }
        })
      })
    })
  )

  it.effect('adapts Telegram connector to an agent tool', () =>
    Effect.gen(function* () {
      const requests: Array<ConnectorHttpRequest> = []
      const telegramIntegration = makeIntegration({
        connectorId: 'telegram',
        config: { chatId: 'chat_1' },
        credentialBindings: [
          makeCredentialBinding({
            slotId: telegramBotTokenSlotId,
            credentialRef: 'telegram-token'
          })
        ]
      })
      const CredentialResolverTest = Layer.succeed(
        CredentialResolver,
        CredentialResolver.of({
          resolve: () =>
            Effect.succeed(ApiKeyCredential.make({ _tag: 'ApiKeyCredential', key: 'bot_token' }))
        })
      )
      const ConnectorHttpClientTest = Layer.succeed(
        ConnectorHttpClient,
        ConnectorHttpClient.of({
          request: request => {
            requests.push(request)

            return Effect.succeed(
              ConnectorHttpResponse.make({
                status: 200,
                headers: { 'content-type': 'application/json' },
                body: '{"ok":true}'
              })
            )
          }
        })
      )

      const result = yield* TelegramConnector.invoke({
        integration: telegramIntegration,
        action: 'telegram.send_message',
        input: { message: 'hello', disableWebPagePreview: true }
      }).pipe(Effect.provide(Layer.mergeAll(CredentialResolverTest, ConnectorHttpClientTest)))

      expect(result).toMatchObject({ _tag: 'Success', value: { sent: true, chatId: 'chat_1' } })
      expect(requests[0]).toMatchObject({
        method: 'POST',
        url: 'https://api.telegram.org/botbot_token/sendMessage',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          chat_id: 'chat_1',
          text: 'hello',
          disable_web_page_preview: true
        })
      })
    })
  )

  it('constructs typed errors', () => {
    expect(new ConnectorError({ cause: 'action_not_found', message: 'missing' })._tag).toBe(
      'ConnectorError'
    )
  })
})
