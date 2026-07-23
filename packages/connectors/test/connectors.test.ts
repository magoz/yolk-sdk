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
  gmailGetThreadAction,
  gmailListDraftsAction,
  gmailListSendAsAction,
  GoogleConnector,
  googleCalendarEventsScope,
  GoogleOAuthCredentialSlot,
  googleGmailComposeScope,
  googleGmailReadonlyScope,
  googleCalendarCreateEventAction
} from '@yolk-sdk/connectors/google'
import {
  EnrichLayerApiKeySlot,
  ExaApiKeySlot,
  LinkedInSearchConnector,
  linkedInEmailAction,
  linkedInSearchAction
} from '@yolk-sdk/connectors/linkedin-search'
import {
  NotionApiTokenSlot,
  NotionConnector,
  notionCreateCommentAction,
  notionCreatePageAction,
  notionGetDataSourceAction,
  notionGetPagePropertyAction,
  notionSearchAction
} from '@yolk-sdk/connectors/notion'
import {
  R2AccessKeyIdSlot,
  R2PresignOutput,
  R2Presigner,
  R2SecretAccessKeySlot,
  R2StorageConnector,
  r2StorageUploadUrlAction
} from '@yolk-sdk/connectors/r2-storage'
import {
  TelegramConnector,
  telegramBotTokenSlotId,
  telegramSendMessageAction
} from '@yolk-sdk/connectors/telegram'
import {
  TodoistApiTokenSlot,
  TodoistConnector,
  todoistCreateTaskAction,
  todoistListLabelsAction,
  todoistListProjectsAction,
  todoistListTasksAction
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

const jsonStatusHttpResponse = (status: number, body: string) =>
  ConnectorHttpResponse.make({
    status,
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
      return '{"results":[],"has_more":false,"next_cursor":null}'
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

  it.effect('normalizes Notion search pagination', () =>
    Effect.gen(function* () {
      const ConnectorHttpClientTest = makeConnectorHttpClientTest(
        [],
        [jsonHttpResponse('{"results":[{"id":"page_1"}],"has_more":true,"next_cursor":"cursor_1"}')]
      )
      const CredentialResolverTest = Layer.succeed(
        CredentialResolver,
        CredentialResolver.of({
          resolve: () =>
            Effect.succeed(ApiKeyCredential.make({ _tag: 'ApiKeyCredential', key: 'api_token' }))
        })
      )
      const notionIntegration = makeIntegration({
        connectorId: 'notion',
        credentialBindings: [
          makeCredentialBinding({ slotId: NotionApiTokenSlot.id, credentialRef: 'api-token' })
        ]
      })

      const result = yield* notionSearchAction
        .execute({ integration: notionIntegration, input: {} })
        .pipe(Effect.provide(Layer.mergeAll(CredentialResolverTest, ConnectorHttpClientTest)))

      expect(result).toMatchObject({
        _tag: 'Success',
        value: { results: [{ id: 'page_1' }], hasMore: true, nextCursor: 'cursor_1' }
      })
    })
  )

  it.effect('normalizes Todoist task pagination', () =>
    Effect.gen(function* () {
      const requests: Array<ConnectorHttpRequest> = []
      const ConnectorHttpClientTest = makeConnectorHttpClientTest(requests, [
        jsonHttpResponse(
          '{"results":[{"id":"task_1","content":"Buy milk","section_id":null,"parent_id":null}],"next_cursor":"cursor_1"}'
        )
      ])
      const CredentialResolverTest = Layer.succeed(
        CredentialResolver,
        CredentialResolver.of({
          resolve: () =>
            Effect.succeed(ApiKeyCredential.make({ _tag: 'ApiKeyCredential', key: 'api_token' }))
        })
      )
      const todoistIntegration = makeIntegration({
        connectorId: 'todoist',
        credentialBindings: [
          makeCredentialBinding({ slotId: TodoistApiTokenSlot.id, credentialRef: 'api-token' })
        ]
      })

      const result = yield* todoistListTasksAction
        .execute({ integration: todoistIntegration, input: {} })
        .pipe(Effect.provide(Layer.mergeAll(CredentialResolverTest, ConnectorHttpClientTest)))
      const request = requests.at(0)
      if (request === undefined) throw new Error('Expected Todoist request')

      expect(result).toMatchObject({
        _tag: 'Success',
        value: { tasks: [{ id: 'task_1', content: 'Buy milk' }], nextCursor: 'cursor_1' }
      })
      expect(request).toMatchObject({
        method: 'GET',
        url: 'https://api.todoist.com/api/v1/tasks'
      })
      expect(request.body).toBeUndefined()
    })
  )

  it.effect('normalizes Notion terminal pagination', () =>
    Effect.gen(function* () {
      const ConnectorHttpClientTest = makeConnectorHttpClientTest(
        [],
        [jsonHttpResponse('{"results":[],"has_more":false,"next_cursor":null}')]
      )
      const CredentialResolverTest = Layer.succeed(
        CredentialResolver,
        CredentialResolver.of({
          resolve: () =>
            Effect.succeed(ApiKeyCredential.make({ _tag: 'ApiKeyCredential', key: 'api_token' }))
        })
      )
      const notionIntegration = makeIntegration({
        connectorId: 'notion',
        credentialBindings: [
          makeCredentialBinding({ slotId: NotionApiTokenSlot.id, credentialRef: 'api-token' })
        ]
      })

      const result = yield* notionSearchAction
        .execute({ integration: notionIntegration, input: {} })
        .pipe(Effect.provide(Layer.mergeAll(CredentialResolverTest, ConnectorHttpClientTest)))

      expect(result).toMatchObject({
        _tag: 'Success',
        value: { results: [], hasMore: false, nextCursor: null }
      })
    })
  )

  it.effect('accepts Notion data source snake-case ids', () =>
    Effect.gen(function* () {
      const requests: Array<ConnectorHttpRequest> = []
      const ConnectorHttpClientTest = makeConnectorHttpClientTest(requests, [
        jsonHttpResponse('{"id":"ds_1"}')
      ])
      const CredentialResolverTest = Layer.succeed(
        CredentialResolver,
        CredentialResolver.of({
          resolve: () =>
            Effect.succeed(ApiKeyCredential.make({ _tag: 'ApiKeyCredential', key: 'api_token' }))
        })
      )
      const notionIntegration = makeIntegration({
        connectorId: 'notion',
        credentialBindings: [
          makeCredentialBinding({ slotId: NotionApiTokenSlot.id, credentialRef: 'api-token' })
        ]
      })

      yield* notionGetDataSourceAction
        .execute({ integration: notionIntegration, input: { data_source_id: 'ds_1' } })
        .pipe(Effect.provide(Layer.mergeAll(CredentialResolverTest, ConnectorHttpClientTest)))

      expect(requests.at(0)).toMatchObject({
        method: 'GET',
        url: 'https://api.notion.com/v1/data_sources/ds_1'
      })
    })
  )

  it.effect('sends Notion comment rich_text snake-case input', () =>
    Effect.gen(function* () {
      const requests: Array<ConnectorHttpRequest> = []
      const ConnectorHttpClientTest = makeConnectorHttpClientTest(requests, [
        jsonHttpResponse('{"id":"comment_1"}')
      ])
      const CredentialResolverTest = Layer.succeed(
        CredentialResolver,
        CredentialResolver.of({
          resolve: () =>
            Effect.succeed(ApiKeyCredential.make({ _tag: 'ApiKeyCredential', key: 'api_token' }))
        })
      )
      const notionIntegration = makeIntegration({
        connectorId: 'notion',
        credentialBindings: [
          makeCredentialBinding({ slotId: NotionApiTokenSlot.id, credentialRef: 'api-token' })
        ]
      })

      yield* notionCreateCommentAction
        .execute({
          integration: notionIntegration,
          input: { discussion_id: 'disc_1', rich_text: [{ text: { content: 'Hi' } }] }
        })
        .pipe(Effect.provide(Layer.mergeAll(CredentialResolverTest, ConnectorHttpClientTest)))

      expect(requests.at(0)).toMatchObject({
        method: 'POST',
        url: 'https://api.notion.com/v1/comments',
        body: JSON.stringify({
          discussion_id: 'disc_1',
          rich_text: [{ text: { content: 'Hi' } }]
        })
      })
    })
  )

  it.effect('paginates Notion page property requests', () =>
    Effect.gen(function* () {
      const requests: Array<ConnectorHttpRequest> = []
      const ConnectorHttpClientTest = makeConnectorHttpClientTest(requests, [
        jsonHttpResponse('{"object":"list","results":[]}')
      ])
      const CredentialResolverTest = Layer.succeed(
        CredentialResolver,
        CredentialResolver.of({
          resolve: () =>
            Effect.succeed(ApiKeyCredential.make({ _tag: 'ApiKeyCredential', key: 'api_token' }))
        })
      )
      const notionIntegration = makeIntegration({
        connectorId: 'notion',
        credentialBindings: [
          makeCredentialBinding({ slotId: NotionApiTokenSlot.id, credentialRef: 'api-token' })
        ]
      })

      yield* notionGetPagePropertyAction
        .execute({
          integration: notionIntegration,
          input: { pageId: 'page_1', propertyId: 'title', pageSize: 10, startCursor: 'cursor_1' }
        })
        .pipe(Effect.provide(Layer.mergeAll(CredentialResolverTest, ConnectorHttpClientTest)))

      expect(requests.at(0)).toMatchObject({
        method: 'GET',
        url: 'https://api.notion.com/v1/pages/page_1/properties/title?page_size=10&start_cursor=cursor_1'
      })
    })
  )

  it.effect('normalizes Todoist project and label pagination', () =>
    Effect.gen(function* () {
      const requests: Array<ConnectorHttpRequest> = []
      const ConnectorHttpClientTest = makeConnectorHttpClientTest(requests, [
        jsonHttpResponse('{"results":[{"id":"project_1","name":"Inbox"}],"next_cursor":null}'),
        jsonHttpResponse('{"results":[{"id":"label_1","name":"Urgent"}],"next_cursor":"cursor_2"}')
      ])
      const CredentialResolverTest = Layer.succeed(
        CredentialResolver,
        CredentialResolver.of({
          resolve: () =>
            Effect.succeed(ApiKeyCredential.make({ _tag: 'ApiKeyCredential', key: 'api_token' }))
        })
      )
      const todoistIntegration = makeIntegration({
        connectorId: 'todoist',
        credentialBindings: [
          makeCredentialBinding({ slotId: TodoistApiTokenSlot.id, credentialRef: 'api-token' })
        ]
      })

      const projects = yield* todoistListProjectsAction
        .execute({ integration: todoistIntegration, input: { cursor: 'cursor_1', limit: 5 } })
        .pipe(Effect.provide(Layer.mergeAll(CredentialResolverTest, ConnectorHttpClientTest)))
      const labels = yield* todoistListLabelsAction
        .execute({ integration: todoistIntegration, input: { limit: 3 } })
        .pipe(Effect.provide(Layer.mergeAll(CredentialResolverTest, ConnectorHttpClientTest)))

      expect(projects).toMatchObject({
        _tag: 'Success',
        value: { projects: [{ id: 'project_1', name: 'Inbox' }], nextCursor: null }
      })
      expect(labels).toMatchObject({
        _tag: 'Success',
        value: { labels: [{ id: 'label_1', name: 'Urgent' }], nextCursor: 'cursor_2' }
      })
      expect(requests.at(0)).toMatchObject({
        method: 'GET',
        url: 'https://api.todoist.com/api/v1/projects?cursor=cursor_1&limit=5'
      })
      expect(requests.at(1)).toMatchObject({
        method: 'GET',
        url: 'https://api.todoist.com/api/v1/labels?limit=3'
      })
    })
  )

  it.effect('uses Todoist filter endpoint for filtered tasks', () =>
    Effect.gen(function* () {
      const requests: Array<ConnectorHttpRequest> = []
      const ConnectorHttpClientTest = makeConnectorHttpClientTest(requests, [
        jsonHttpResponse('{"results":[],"next_cursor":null}')
      ])
      const CredentialResolverTest = Layer.succeed(
        CredentialResolver,
        CredentialResolver.of({
          resolve: () =>
            Effect.succeed(ApiKeyCredential.make({ _tag: 'ApiKeyCredential', key: 'api_token' }))
        })
      )
      const todoistIntegration = makeIntegration({
        connectorId: 'todoist',
        credentialBindings: [
          makeCredentialBinding({ slotId: TodoistApiTokenSlot.id, credentialRef: 'api-token' })
        ]
      })

      yield* todoistListTasksAction
        .execute({
          integration: todoistIntegration,
          input: { filter: 'today', filterLang: 'en', projectId: 'ignored', cursor: 'c', limit: 5 }
        })
        .pipe(Effect.provide(Layer.mergeAll(CredentialResolverTest, ConnectorHttpClientTest)))

      expect(requests.at(0)).toMatchObject({
        method: 'GET',
        url: 'https://api.todoist.com/api/v1/tasks/filter?query=today&lang=en&cursor=c&limit=5'
      })
    })
  )

  it.effect('maps provider status and body details into failures', () =>
    Effect.gen(function* () {
      const ConnectorHttpClientTest = makeConnectorHttpClientTest(
        [],
        [jsonStatusHttpResponse(429, '{"error":"Rate limit exceeded"}')]
      )
      const CredentialResolverTest = Layer.succeed(
        CredentialResolver,
        CredentialResolver.of({
          resolve: () =>
            Effect.succeed(ApiKeyCredential.make({ _tag: 'ApiKeyCredential', key: 'api_token' }))
        })
      )
      const todoistIntegration = makeIntegration({
        connectorId: 'todoist',
        credentialBindings: [
          makeCredentialBinding({ slotId: TodoistApiTokenSlot.id, credentialRef: 'api-token' })
        ]
      })

      const result = yield* todoistListTasksAction
        .execute({ integration: todoistIntegration, input: {} })
        .pipe(Effect.provide(Layer.mergeAll(CredentialResolverTest, ConnectorHttpClientTest)))

      expect(result).toMatchObject({
        _tag: 'Failure',
        error: {
          code: 'todoist_rate_limited',
          message: 'Todoist list tasks failed: Rate limit exceeded',
          status: 429
        }
      })
    })
  )

  it.effect('uses scoped Google OAuth slots and draft query params', () =>
    Effect.gen(function* () {
      const requests: Array<ConnectorHttpRequest> = []
      const requestedScopes: Array<ReadonlyArray<string> | undefined> = []
      const ConnectorHttpClientTest = makeConnectorHttpClientTest(requests, [
        jsonHttpResponse('{"drafts":[]}'),
        jsonHttpResponse('{"id":"event_1","summary":"Planning"}')
      ])
      const CredentialResolverTest = Layer.succeed(
        CredentialResolver,
        CredentialResolver.of({
          resolve: request => {
            requestedScopes.push(request.slot.requiredScopes)
            return Effect.succeed(
              OAuthCredential.make({
                _tag: 'OAuthCredential',
                provider: 'google',
                accessToken: 'google_token',
                expiresAt: Date.now() + 60_000
              })
            )
          }
        })
      )

      yield* gmailListDraftsAction
        .execute({
          integration: googleIntegration,
          input: { query: 'subject:draft', maxResults: 3, pageToken: 'page_1' }
        })
        .pipe(Effect.provide(Layer.mergeAll(CredentialResolverTest, ConnectorHttpClientTest)))
      yield* googleCalendarCreateEventAction
        .execute({
          integration: googleIntegration,
          input: {
            summary: 'Planning',
            start: { dateTime: '2026-05-21T10:00:00Z' },
            end: { dateTime: '2026-05-21T10:30:00Z' }
          }
        })
        .pipe(Effect.provide(Layer.mergeAll(CredentialResolverTest, ConnectorHttpClientTest)))

      const gmailScopes = requestedScopes.at(0)
      const calendarScopes = requestedScopes.at(1)
      if (gmailScopes === undefined || calendarScopes === undefined) {
        throw new Error('Expected requested Google scopes')
      }

      expect(requests.at(0)).toMatchObject({
        method: 'GET',
        url: 'https://gmail.googleapis.com/gmail/v1/users/me/drafts?q=subject%3Adraft&maxResults=3&pageToken=page_1'
      })
      expect(gmailScopes).toContain(googleGmailComposeScope)
      expect(gmailScopes).not.toContain(googleCalendarEventsScope)
      expect(calendarScopes).toContain(googleCalendarEventsScope)
      expect(calendarScopes).not.toContain(googleGmailReadonlyScope)
    })
  )

  it.effect('normalizes Gmail threads without MIME or attachment content', () =>
    Effect.gen(function* () {
      const requests: Array<ConnectorHttpRequest> = []
      const quotedPrintableData = encodeBase64Url('Hej=20Elina=0AAndra=20raden')
      const htmlData = encodeBase64Url('<p>HTML fallback</p>')
      const attachmentData = encodeBase64Url('SECRET_ATTACHMENT_BYTES')
      const textAttachmentData = encodeBase64Url('SECRET_TEXT_ATTACHMENT')
      const inlineAttachmentData = encodeBase64Url('SECRET_INLINE_ATTACHMENT')
      const dispositionAttachmentData = encodeBase64Url('SECRET_DISPOSITION_ATTACHMENT')
      const nestedAttachmentData = encodeBase64Url('SECRET_NESTED_ATTACHMENT')
      const ConnectorHttpClientTest = makeConnectorHttpClientTest(requests, [
        jsonHttpResponse(
          JSON.stringify({
            id: 'thread_1',
            historyId: 'history_1',
            messages: [
              {
                id: 'message_1',
                threadId: 'thread_1',
                labelIds: ['INBOX'],
                snippet: 'Hej Elina',
                internalDate: '1780000000000',
                payload: {
                  mimeType: 'multipart/mixed',
                  headers: [
                    { name: 'From', value: 'Lead <lead@example.com>' },
                    { name: 'Subject', value: 'Avtal' },
                    { name: 'X-Provider-Internal', value: 'omit' }
                  ],
                  parts: [
                    {
                      partId: '0',
                      mimeType: 'text/plain',
                      headers: [
                        { name: 'Content-Transfer-Encoding', value: 'quoted-printable' }
                      ],
                      body: { size: 31, data: quotedPrintableData }
                    },
                    {
                      partId: '1',
                      mimeType: 'application/pdf',
                      filename: 'agreement.pdf',
                      body: {
                        size: 1024,
                        attachmentId: 'attachment_1',
                        data: attachmentData
                      }
                    },
                    {
                      partId: '2',
                      mimeType: 'text/plain',
                      filename: 'notes.txt',
                      body: {
                        size: 22,
                        attachmentId: 'attachment_2',
                        data: textAttachmentData
                      }
                    },
                    {
                      partId: '3',
                      mimeType: 'application/octet-stream',
                      filename: 'inline.bin',
                      body: { size: 24, data: inlineAttachmentData }
                    },
                    {
                      partId: '4',
                      mimeType: 'text/plain',
                      headers: [{ name: 'Content-Disposition', value: 'attachment' }],
                      body: { size: 29, data: dispositionAttachmentData }
                    },
                    {
                      partId: '5',
                      mimeType: 'message/rfc822',
                      body: { size: 128 },
                      parts: [
                        {
                          partId: '5.1',
                          mimeType: 'text/plain',
                          body: { size: 24, data: nestedAttachmentData }
                        }
                      ]
                    }
                  ]
                }
              },
              {
                id: 'message_2',
                threadId: 'thread_1',
                payload: {
                  mimeType: 'text/html',
                  headers: [{ name: 'Date', value: 'Thu, 23 Jul 2026 10:00:00 +0200' }],
                  body: { size: 20, data: htmlData }
                }
              },
              {
                id: 'message_3',
                threadId: 'thread_1',
                snippet: 'Malformed body remains readable through snippet',
                payload: {
                  mimeType: 'text/plain',
                  body: { size: 3, data: '%%%' }
                }
              },
              {
                id: 'message_4',
                threadId: 'thread_1',
                snippet: 'Malformed padding remains readable through snippet',
                payload: {
                  mimeType: 'text/plain',
                  body: { size: 2, data: 'A=' }
                }
              }
            ]
          })
        )
      ])

      const result = yield* gmailGetThreadAction
        .execute({
          integration: googleIntegration,
          input: { threadId: 'thread_1', format: 'full' }
        })
        .pipe(Effect.provide(Layer.mergeAll(GoogleCredentialResolverTest, ConnectorHttpClientTest)))

      expect(requests.at(0)).toMatchObject({
        method: 'GET',
        url: 'https://gmail.googleapis.com/gmail/v1/users/me/threads/thread_1?format=full'
      })
      expect(result).toMatchObject({
        _tag: 'Success',
        value: {
          id: 'thread_1',
          historyId: 'history_1',
          messages: [
            {
              id: 'message_1',
              headers: [
                { name: 'From', value: 'Lead <lead@example.com>' },
                { name: 'Subject', value: 'Avtal' }
              ],
              body: 'Hej Elina\nAndra raden',
              bodyMimeType: 'text/plain',
              attachments: [
                {
                  partId: '1',
                  filename: 'agreement.pdf',
                  mimeType: 'application/pdf',
                  size: 1024,
                  attachmentId: 'attachment_1'
                },
                {
                  partId: '2',
                  filename: 'notes.txt',
                  mimeType: 'text/plain',
                  size: 22,
                  attachmentId: 'attachment_2'
                },
                {
                  partId: '3',
                  filename: 'inline.bin',
                  mimeType: 'application/octet-stream',
                  size: 24
                },
                {
                  partId: '4',
                  mimeType: 'text/plain',
                  size: 29
                },
                {
                  partId: '5',
                  mimeType: 'message/rfc822',
                  size: 128
                }
              ]
            },
            {
              id: 'message_2',
              body: '<p>HTML fallback</p>',
              bodyMimeType: 'text/html',
              attachments: []
            },
            {
              id: 'message_3',
              snippet: 'Malformed body remains readable through snippet',
              attachments: []
            },
            {
              id: 'message_4',
              snippet: 'Malformed padding remains readable through snippet',
              attachments: []
            }
          ]
        }
      })
      const serialized = JSON.stringify(result)
      expect(serialized).not.toContain(quotedPrintableData)
      expect(serialized).not.toContain(htmlData)
      expect(serialized).not.toContain(attachmentData)
      expect(serialized).not.toContain(textAttachmentData)
      expect(serialized).not.toContain(inlineAttachmentData)
      expect(serialized).not.toContain(dispositionAttachmentData)
      expect(serialized).not.toContain(nestedAttachmentData)
      expect(serialized).not.toContain('SECRET_TEXT_ATTACHMENT')
      expect(serialized).not.toContain('SECRET_INLINE_ATTACHMENT')
      expect(serialized).not.toContain('SECRET_DISPOSITION_ATTACHMENT')
      expect(serialized).not.toContain('SECRET_NESTED_ATTACHMENT')
      expect(serialized).not.toContain('X-Provider-Internal')
    })
  )

  it.effect('returns queued LinkedIn email lookups', () =>
    Effect.gen(function* () {
      const ConnectorHttpClientTest = makeConnectorHttpClientTest(
        [],
        [jsonHttpResponse('{"email_queue_count":2}')]
      )
      const CredentialResolverTest = Layer.succeed(
        CredentialResolver,
        CredentialResolver.of({
          resolve: () =>
            Effect.succeed(ApiKeyCredential.make({ _tag: 'ApiKeyCredential', key: 'api_token' }))
        })
      )
      const linkedInIntegration = makeIntegration({
        connectorId: 'linkedin-search',
        credentialBindings: [
          makeCredentialBinding({ slotId: EnrichLayerApiKeySlot.id, credentialRef: 'api-token' })
        ]
      })

      const result = yield* linkedInEmailAction
        .execute({
          integration: linkedInIntegration,
          input: { linkedinUrl: 'https://linkedin.com/in/a' }
        })
        .pipe(Effect.provide(Layer.mergeAll(CredentialResolverTest, ConnectorHttpClientTest)))

      expect(result).toMatchObject({
        _tag: 'Success',
        value: { email: null, status: 'queued' }
      })
    })
  )

  it.effect('omits R2 public URL when integration has no publicUrl config', () =>
    Effect.gen(function* () {
      const CredentialResolverTest = Layer.succeed(
        CredentialResolver,
        CredentialResolver.of({
          resolve: request =>
            Effect.succeed(
              ApiKeyCredential.make({
                _tag: 'ApiKeyCredential',
                key: request.slot.id === R2SecretAccessKeySlot.id ? 'secret' : 'access'
              })
            )
        })
      )
      const R2PresignerTest = Layer.succeed(
        R2Presigner,
        R2Presigner.of({
          presignPutObject: () =>
            Effect.succeed(R2PresignOutput.make({ uploadUrl: 'https://upload.example.com' }))
        })
      )
      const r2Integration = makeIntegration({
        connectorId: 'r2-storage',
        config: { endpoint: 'https://r2.example.com', bucket: 'bucket' },
        credentialBindings: [
          makeCredentialBinding({ slotId: R2AccessKeyIdSlot.id, credentialRef: 'access' }),
          makeCredentialBinding({ slotId: R2SecretAccessKeySlot.id, credentialRef: 'secret' })
        ]
      })

      const result = yield* r2StorageUploadUrlAction
        .execute({
          integration: r2Integration,
          input: { filename: '/file.png', contentType: 'image/png' }
        })
        .pipe(Effect.provide(Layer.mergeAll(CredentialResolverTest, R2PresignerTest)))

      if (result._tag !== 'Success' || typeof result.value !== 'object' || result.value === null) {
        throw new Error('Expected R2 success')
      }

      expect(result.value).toMatchObject({
        uploadUrl: 'https://upload.example.com',
        key: 'file.png'
      })
      expect(Object.getOwnPropertyDescriptor(result.value, 'publicUrl')?.value).toBeUndefined()
    })
  )

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
          sendAs: [{ sendAsEmail: 'elina@speldosa.app', displayName: 'Elina', isDefault: true }]
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
