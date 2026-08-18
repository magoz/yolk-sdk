import { Effect, Layer } from 'effect'
import * as Schema from 'effect/Schema'
import { describe, expect, it } from '@effect/vitest'
import { resolveTools } from '@yolk-sdk/agent/tools'
import {
  ActionResult,
  ApiKeyCredential,
  BearerTokenCredential,
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
import {
  afloatMcpAuthAction,
  AfloatApiKeyCredentialSlot,
  AfloatConnector
} from '@yolk-sdk/connectors/afloat'
import {
  DropboxConnector,
  DropboxOAuthCredentialSlot,
  dropboxFilesContentWriteScope,
  dropboxFilesMetadataReadScope,
  dropboxCopyAction,
  dropboxCreateFolderAction,
  dropboxDeleteAction,
  dropboxGetMetadataAction,
  dropboxListFolderAction,
  dropboxListFolderContinueAction,
  dropboxMoveAction,
  dropboxSearchAction,
  dropboxSearchContinueAction
} from '@yolk-sdk/connectors/dropbox'
import {
  figmaMcpAuthAction,
  FigmaConnector,
  FigmaOAuthCredentialSlot
} from '@yolk-sdk/connectors/figma'
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
  MicrosoftConnector,
  MicrosoftOAuthCredentialSlot,
  microsoftGraphFilesReadAllScope,
  microsoftGraphFilesReadScope,
  microsoftGraphFilesReadWriteAllScope,
  microsoftGraphFilesReadWriteScope,
  microsoftGraphMailReadScope,
  microsoftGraphMailReadSharedScope,
  microsoftGraphMailReadWriteScope,
  microsoftGraphMailReadWriteSharedScope,
  microsoftGraphMailSendScope,
  microsoftGraphMailSendSharedScope,
  oneDriveCreateFolderAction,
  oneDriveDeleteItemAction,
  oneDriveGetItemAction,
  oneDriveListItemsAction,
  oneDriveSearchItemsAction,
  outlookCreateReplyDraftAction,
  outlookGetMessageAction,
  outlookListMessagesAction,
  outlookSearchMessagesAction,
  outlookSendDraftAction,
  outlookSendMailAction
} from '@yolk-sdk/connectors/microsoft'
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
  access: 'write',
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

const dropboxIntegration = makeIntegration({
  connectorId: 'dropbox',
  credentialBindings: [
    makeCredentialBinding({
      slotId: DropboxOAuthCredentialSlot.id,
      credentialRef: 'dropbox-token'
    })
  ]
})

const DropboxCredentialResolverTest = Layer.succeed(
  CredentialResolver,
  CredentialResolver.of({
    resolve: () =>
      Effect.succeed(
        OAuthCredential.make({
          _tag: 'OAuthCredential',
          provider: 'dropbox',
          accessToken: 'dropbox_token',
          expiresAt: Date.now() + 60_000
        })
      )
  })
)

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

const microsoftIntegration = makeIntegration({
  connectorId: 'microsoft',
  credentialBindings: [
    makeCredentialBinding({
      slotId: MicrosoftOAuthCredentialSlot.id,
      credentialRef: 'microsoft-token'
    })
  ]
})

const microsoftApplicationIntegration = makeIntegration({
  connectorId: 'microsoft',
  config: { mailboxAccessMode: 'application' },
  credentialBindings: [
    makeCredentialBinding({
      slotId: MicrosoftOAuthCredentialSlot.id,
      credentialRef: 'microsoft-application-token'
    })
  ]
})

const microsoftDriveDelegatedAllIntegration = makeIntegration({
  connectorId: 'microsoft',
  config: { oneDriveAccessMode: 'delegated_all' },
  credentialBindings: [
    makeCredentialBinding({
      slotId: MicrosoftOAuthCredentialSlot.id,
      credentialRef: 'microsoft-token'
    })
  ]
})

const microsoftDriveApplicationIntegration = makeIntegration({
  connectorId: 'microsoft',
  config: { oneDriveAccessMode: 'application' },
  credentialBindings: [
    makeCredentialBinding({
      slotId: MicrosoftOAuthCredentialSlot.id,
      credentialRef: 'microsoft-application-token'
    })
  ]
})

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
    case 'Dropbox create folder':
    case 'Dropbox move':
    case 'Dropbox copy':
    case 'Dropbox delete':
      return '{"metadata":{".tag":"folder","id":"id:folder_1","name":"Archive","path_lower":"/archive","path_display":"/Archive"}}'
    case 'Dropbox get metadata':
      return '{".tag":"file","id":"id:file_1","name":"notes.txt","path_lower":"/notes.txt","path_display":"/Notes.txt","client_modified":"2026-05-21T10:00:00Z","server_modified":"2026-05-21T10:00:01Z","rev":"abc123456","size":12}'
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
    name: 'Dropbox create folder',
    execute: dropboxCreateFolderAction.execute,
    connectorId: 'dropbox',
    slotId: DropboxOAuthCredentialSlot.id,
    credentialKind: 'oauth',
    input: { path: '/Archive', autorename: true },
    expected: {
      method: 'POST',
      url: 'https://api.dropboxapi.com/2/files/create_folder_v2',
      body: { path: '/Archive', autorename: true }
    }
  },
  {
    name: 'Dropbox get metadata',
    execute: dropboxGetMetadataAction.execute,
    connectorId: 'dropbox',
    slotId: DropboxOAuthCredentialSlot.id,
    credentialKind: 'oauth',
    input: { path: 'id:file_1', includeDeleted: true },
    expected: {
      method: 'POST',
      url: 'https://api.dropboxapi.com/2/files/get_metadata',
      body: { path: 'id:file_1', include_deleted: true }
    }
  },
  {
    name: 'Dropbox move',
    execute: dropboxMoveAction.execute,
    connectorId: 'dropbox',
    slotId: DropboxOAuthCredentialSlot.id,
    credentialKind: 'oauth',
    input: {
      fromPath: '/Drafts',
      toPath: '/Archive',
      autorename: true,
      allowOwnershipTransfer: false
    },
    expected: {
      method: 'POST',
      url: 'https://api.dropboxapi.com/2/files/move_v2',
      body: {
        from_path: '/Drafts',
        to_path: '/Archive',
        autorename: true,
        allow_ownership_transfer: false
      }
    }
  },
  {
    name: 'Dropbox copy',
    execute: dropboxCopyAction.execute,
    connectorId: 'dropbox',
    slotId: DropboxOAuthCredentialSlot.id,
    credentialKind: 'oauth',
    input: { fromPath: '/Template', toPath: '/Template copy', autorename: false },
    expected: {
      method: 'POST',
      url: 'https://api.dropboxapi.com/2/files/copy_v2',
      body: { from_path: '/Template', to_path: '/Template copy', autorename: false }
    }
  },
  {
    name: 'Dropbox delete',
    execute: dropboxDeleteAction.execute,
    connectorId: 'dropbox',
    slotId: DropboxOAuthCredentialSlot.id,
    credentialKind: 'oauth',
    input: { path: '/Archive', parentRev: 'abc123456' },
    expected: {
      method: 'POST',
      url: 'https://api.dropboxapi.com/2/files/delete_v2',
      body: { path: '/Archive', parent_rev: 'abc123456' }
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
    const [
      root,
      agent,
      afloat,
      dropbox,
      figma,
      google,
      linkedIn,
      microsoft,
      notion,
      r2,
      telegram,
      todoist
    ] = await Promise.all([
      import('@yolk-sdk/connectors'),
      import('@yolk-sdk/connectors/agent'),
      import('@yolk-sdk/connectors/afloat'),
      import('@yolk-sdk/connectors/dropbox'),
      import('@yolk-sdk/connectors/figma'),
      import('@yolk-sdk/connectors/google'),
      import('@yolk-sdk/connectors/linkedin-search'),
      import('@yolk-sdk/connectors/microsoft'),
      import('@yolk-sdk/connectors/notion'),
      import('@yolk-sdk/connectors/r2-storage'),
      import('@yolk-sdk/connectors/telegram'),
      import('@yolk-sdk/connectors/todoist')
    ])

    expect(root.defineConnector).toBeDefined()
    expect(agent.makeConnectorToolModule).toBeDefined()
    expect(afloat.AfloatConnector).toBeDefined()
    expect(dropbox.DropboxConnector).toBeDefined()
    expect(figma.FigmaConnector).toBeDefined()
    expect(google.GoogleConnector).toBeDefined()
    expect(linkedIn.LinkedInSearchConnector).toBeDefined()
    expect(microsoft.MicrosoftConnector).toBeDefined()
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
    expect(AfloatConnector.actions.map(action => action.id)).toEqual(['afloat.mcp_auth'])
    expect(DropboxConnector.actions.map(action => action.id)).toEqual([
      'dropbox.list_folder',
      'dropbox.list_folder_continue',
      'dropbox.search',
      'dropbox.search_continue',
      'dropbox.get_metadata',
      'dropbox.create_folder',
      'dropbox.move',
      'dropbox.copy',
      'dropbox.delete'
    ])
    expect(
      DropboxConnector.actions.filter(action => action.access === 'write').map(action => action.id)
    ).toEqual(['dropbox.create_folder', 'dropbox.move', 'dropbox.copy'])
    expect(
      DropboxConnector.actions
        .filter(action => action.access === 'destructive')
        .map(action => action.id)
    ).toEqual(['dropbox.delete'])
    expect(FigmaConnector.actions.map(action => action.id)).toEqual(['figma.mcp_auth'])
    expect(LinkedInSearchConnector.actions.map(action => action.id)).toEqual([
      'linkedin_search.search',
      'linkedin_search.profile',
      'linkedin_search.email'
    ])
    expect(MicrosoftConnector.actions.map(action => action.id)).toEqual([
      'outlook.list_messages',
      'outlook.search_messages',
      'outlook.get_message',
      'outlook.create_draft',
      'outlook.create_reply_draft',
      'outlook.send_mail',
      'outlook.send_draft',
      'onedrive.list_items',
      'onedrive.search_items',
      'onedrive.get_item',
      'onedrive.create_folder',
      'onedrive.delete_item'
    ])
    expect(
      MicrosoftConnector.actions
        .filter(action => action.access === 'write')
        .map(action => action.id)
    ).toEqual(['outlook.create_draft', 'outlook.create_reply_draft', 'onedrive.create_folder'])
    expect(
      MicrosoftConnector.actions
        .filter(action => action.access === 'destructive')
        .map(action => action.id)
    ).toEqual(['outlook.send_mail', 'outlook.send_draft', 'onedrive.delete_item'])
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

  it.effect('resolves Afloat MCP secrets through the runtime credential', () =>
    Effect.gen(function* () {
      const afloatIntegration = makeIntegration({
        connectorId: 'afloat',
        credentialBindings: [
          makeCredentialBinding({
            slotId: AfloatApiKeyCredentialSlot.id,
            credentialRef: 'afloat-api-key'
          })
        ]
      })
      const CredentialResolverTest = Layer.succeed(
        CredentialResolver,
        CredentialResolver.of({
          resolve: () =>
            Effect.succeed(
              ApiKeyCredential.make({
                _tag: 'ApiKeyCredential',
                key: 'afloat_test_key'
              })
            )
        })
      )

      const result = yield* afloatMcpAuthAction
        .execute({ integration: afloatIntegration, input: {} })
        .pipe(Effect.provide(CredentialResolverTest))

      expect(result).toMatchObject({
        _tag: 'Success',
        value: {
          provider: 'afloat',
          serverUrl: 'https://useafloat.com/mcp',
          protocolVersion: '2026-07-28',
          apiKey: 'afloat_test_key'
        }
      })
    })
  )

  it.effect('rejects invalid Afloat runtime credentials', () =>
    Effect.gen(function* () {
      const afloatIntegration = makeIntegration({
        connectorId: 'afloat',
        credentialBindings: [
          makeCredentialBinding({
            slotId: AfloatApiKeyCredentialSlot.id,
            credentialRef: 'afloat-api-key'
          })
        ]
      })
      const malformedKeyResolver = Layer.succeed(
        CredentialResolver,
        CredentialResolver.of({
          resolve: () =>
            Effect.succeed(
              ApiKeyCredential.make({
                _tag: 'ApiKeyCredential',
                key: 'invalid_key'
              })
            )
        })
      )
      const bearerResolver = Layer.succeed(
        CredentialResolver,
        CredentialResolver.of({
          resolve: () =>
            Effect.succeed(
              BearerTokenCredential.make({
                _tag: 'BearerTokenCredential',
                token: 'afloat_bearer'
              })
            )
        })
      )

      const [malformedKey, wrongKind] = yield* Effect.all([
        afloatMcpAuthAction
          .execute({ integration: afloatIntegration, input: {} })
          .pipe(Effect.provide(malformedKeyResolver), Effect.result),
        afloatMcpAuthAction
          .execute({ integration: afloatIntegration, input: {} })
          .pipe(Effect.provide(bearerResolver), Effect.result)
      ])

      expect(malformedKey).toMatchObject({
        _tag: 'Failure',
        failure: { _tag: 'ConnectorError', cause: 'credential_invalid' }
      })
      expect(wrongKind).toMatchObject({
        _tag: 'Failure',
        failure: { _tag: 'ConnectorError', cause: 'credential_invalid' }
      })
    })
  )

  it.effect('resolves Figma MCP secrets through the runtime credential', () =>
    Effect.gen(function* () {
      const figmaIntegration = makeIntegration({
        connectorId: 'figma',
        credentialBindings: [
          makeCredentialBinding({
            slotId: FigmaOAuthCredentialSlot.id,
            credentialRef: 'figma-oauth'
          })
        ]
      })
      const CredentialResolverTest = Layer.succeed(
        CredentialResolver,
        CredentialResolver.of({
          resolve: () =>
            Effect.succeed(
              OAuthCredential.make({
                _tag: 'OAuthCredential',
                provider: 'figma',
                accessToken: 'figma_access',
                refreshToken: 'figma_refresh',
                clientId: 'figma_client',
                clientSecret: 'figma_secret',
                expiresAt: 1_800_000_000_000
              })
            )
        })
      )

      const result = yield* figmaMcpAuthAction
        .execute({ integration: figmaIntegration, input: {} })
        .pipe(Effect.provide(CredentialResolverTest))

      expect(result).toMatchObject({
        _tag: 'Success',
        value: {
          provider: 'figma',
          tokens: {
            accessToken: 'figma_access',
            refreshToken: 'figma_refresh',
            expiresAt: 1_800_000_000_000
          },
          clientInfo: {
            clientId: 'figma_client',
            clientSecret: 'figma_secret'
          }
        }
      })
    })
  )

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
        layer: Layer.empty
      })
      const toolSet = yield* resolveTools([toolModule], {})
      const overriddenToolSet = yield* resolveTools(
        [
          makeConnectorToolModule(TestConnector, {
            integration,
            layer: Layer.empty,
            access: 'read'
          })
        ],
        {}
      )
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
      expect(overriddenToolSet.metadata).toContainEqual({
        moduleId: 'test',
        name: 'test.fail',
        access: 'read'
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

  it.effect('lists and continues Dropbox folders with normalized metadata', () =>
    Effect.gen(function* () {
      const requests: Array<ConnectorHttpRequest> = []
      const requestedScopes: Array<ReadonlyArray<string> | undefined> = []
      const ConnectorHttpClientTest = makeConnectorHttpClientTest(requests, [
        jsonHttpResponse(
          JSON.stringify({
            entries: [
              {
                '.tag': 'file',
                id: 'id:file_1',
                name: 'Notes.txt',
                path_lower: '/notes.txt',
                path_display: '/Notes.txt',
                client_modified: '2026-05-21T10:00:00Z',
                server_modified: '2026-05-21T10:00:01Z',
                rev: 'abc123456',
                size: 12,
                is_downloadable: true,
                content_hash: 'content_hash'
              },
              {
                '.tag': 'folder',
                id: 'id:folder_1',
                name: 'Projects',
                path_lower: '/projects',
                path_display: '/Projects'
              }
            ],
            cursor: 'cursor_1',
            has_more: true
          })
        ),
        jsonHttpResponse(
          JSON.stringify({
            entries: [
              {
                '.tag': 'deleted',
                name: 'Old.txt',
                path_lower: '/old.txt',
                path_display: '/Old.txt',
                is_restorable: true
              }
            ],
            cursor: 'cursor_2',
            has_more: false
          })
        )
      ])
      const CredentialResolverTest = Layer.succeed(
        CredentialResolver,
        CredentialResolver.of({
          resolve: request => {
            requestedScopes.push(request.slot.requiredScopes)
            return Effect.succeed(
              OAuthCredential.make({
                _tag: 'OAuthCredential',
                provider: 'dropbox',
                accessToken: 'dropbox_token',
                expiresAt: Date.now() + 60_000
              })
            )
          }
        })
      )
      const layer = Layer.mergeAll(CredentialResolverTest, ConnectorHttpClientTest)

      const first = yield* dropboxListFolderAction
        .execute({
          integration: dropboxIntegration,
          input: { recursive: true, includeDeleted: true, limit: 50 }
        })
        .pipe(Effect.provide(layer))
      const second = yield* dropboxListFolderContinueAction
        .execute({ integration: dropboxIntegration, input: { cursor: 'cursor_1' } })
        .pipe(Effect.provide(layer))

      expect(first).toMatchObject({
        _tag: 'Success',
        value: {
          entries: [
            {
              type: 'file',
              id: 'id:file_1',
              pathLower: '/notes.txt',
              clientModified: '2026-05-21T10:00:00Z',
              contentHash: 'content_hash'
            },
            { type: 'folder', id: 'id:folder_1', pathDisplay: '/Projects' }
          ],
          cursor: 'cursor_1',
          hasMore: true
        }
      })
      expect(second).toMatchObject({
        _tag: 'Success',
        value: {
          entries: [{ type: 'deleted', name: 'Old.txt', isRestorable: true }],
          cursor: 'cursor_2',
          hasMore: false
        }
      })
      expect(requests.at(0)).toMatchObject({
        method: 'POST',
        url: 'https://api.dropboxapi.com/2/files/list_folder',
        headers: {
          authorization: 'Bearer dropbox_token',
          'content-type': 'application/json'
        },
        body: JSON.stringify({
          path: '',
          recursive: true,
          include_deleted: true,
          limit: 50
        })
      })
      expect(requests.at(1)).toMatchObject({
        method: 'POST',
        url: 'https://api.dropboxapi.com/2/files/list_folder/continue',
        body: JSON.stringify({ cursor: 'cursor_1' })
      })
      expect(requestedScopes).toEqual([
        [dropboxFilesMetadataReadScope],
        [dropboxFilesMetadataReadScope]
      ])
    })
  )

  it.effect('normalizes Dropbox search pagination and highlights', () =>
    Effect.gen(function* () {
      const requests: Array<ConnectorHttpRequest> = []
      const match = {
        metadata: {
          '.tag': 'metadata',
          metadata: {
            '.tag': 'folder',
            id: 'id:folder_1',
            name: 'Roadmap',
            path_lower: '/roadmap',
            path_display: '/Roadmap'
          }
        },
        match_type: { '.tag': 'filename' },
        highlight_spans: [{ highlight_str: 'Road', is_highlighted: true }]
      }
      const ConnectorHttpClientTest = makeConnectorHttpClientTest(requests, [
        jsonHttpResponse(JSON.stringify({ matches: [match], has_more: true, cursor: 'search_1' })),
        jsonHttpResponse(JSON.stringify({ matches: [], has_more: false }))
      ])
      const layer = Layer.mergeAll(DropboxCredentialResolverTest, ConnectorHttpClientTest)

      const first = yield* dropboxSearchAction
        .execute({
          integration: dropboxIntegration,
          input: {
            query: 'roadmap',
            path: '/Projects',
            maxResults: 20,
            filenameOnly: true,
            fileExtensions: ['pdf']
          }
        })
        .pipe(Effect.provide(layer))
      const second = yield* dropboxSearchContinueAction
        .execute({ integration: dropboxIntegration, input: { cursor: 'search_1' } })
        .pipe(Effect.provide(layer))

      expect(first).toMatchObject({
        _tag: 'Success',
        value: {
          matches: [
            {
              metadata: { type: 'folder', id: 'id:folder_1' },
              matchType: 'filename',
              highlightSpans: [{ text: 'Road', isHighlighted: true }]
            }
          ],
          hasMore: true,
          cursor: 'search_1'
        }
      })
      expect(second).toMatchObject({
        _tag: 'Success',
        value: { matches: [], hasMore: false }
      })
      expect(requests.at(0)).toMatchObject({
        url: 'https://api.dropboxapi.com/2/files/search_v2',
        body: JSON.stringify({
          query: 'roadmap',
          options: {
            path: '/Projects',
            max_results: 20,
            filename_only: true,
            file_extensions: ['pdf']
          }
        })
      })
      expect(requests.at(1)).toMatchObject({
        url: 'https://api.dropboxapi.com/2/files/search/continue_v2',
        body: JSON.stringify({ cursor: 'search_1' })
      })
    })
  )

  it.effect('uses Dropbox write scopes for file-management actions', () =>
    Effect.gen(function* () {
      const requestedScopes: Array<ReadonlyArray<string> | undefined> = []
      const CredentialResolverTest = Layer.succeed(
        CredentialResolver,
        CredentialResolver.of({
          resolve: request => {
            requestedScopes.push(request.slot.requiredScopes)
            return Effect.succeed(
              OAuthCredential.make({
                _tag: 'OAuthCredential',
                provider: 'dropbox',
                accessToken: 'dropbox_token',
                expiresAt: Date.now() + 60_000
              })
            )
          }
        })
      )
      const ConnectorHttpClientTest = makeConnectorHttpClientTest(
        [],
        [
          jsonHttpResponse(
            '{"metadata":{".tag":"folder","id":"id:folder_1","name":"Archive","path_lower":"/archive","path_display":"/Archive"}}'
          )
        ]
      )

      yield* dropboxCreateFolderAction
        .execute({
          integration: dropboxIntegration,
          input: { path: '/Archive' }
        })
        .pipe(Effect.provide(Layer.mergeAll(CredentialResolverTest, ConnectorHttpClientTest)))

      expect(requestedScopes).toEqual([[dropboxFilesContentWriteScope]])
    })
  )

  it.effect('maps Dropbox error summaries and retry details into provider failures', () =>
    Effect.gen(function* () {
      const notFoundHttp = makeConnectorHttpClientTest(
        [],
        [jsonStatusHttpResponse(409, '{"error_summary":"path/not_found/..."}')]
      )
      const conflictHttp = makeConnectorHttpClientTest(
        [],
        [jsonStatusHttpResponse(409, '{"error_summary":"path/conflict/folder/..."}')]
      )
      const rateLimitHttp = Layer.succeed(
        ConnectorHttpClient,
        ConnectorHttpClient.of({
          request: () =>
            Effect.succeed(
              ConnectorHttpResponse.make({
                status: 429,
                headers: { 'Retry-After': '3' },
                body: '{"error_summary":"too_many_requests/..."}'
              })
            )
        })
      )

      const notFound = yield* dropboxGetMetadataAction
        .execute({ integration: dropboxIntegration, input: { path: '/missing' } })
        .pipe(Effect.provide(Layer.mergeAll(DropboxCredentialResolverTest, notFoundHttp)))
      const conflict = yield* dropboxCreateFolderAction
        .execute({ integration: dropboxIntegration, input: { path: '/existing' } })
        .pipe(Effect.provide(Layer.mergeAll(DropboxCredentialResolverTest, conflictHttp)))
      const rateLimited = yield* dropboxListFolderAction
        .execute({ integration: dropboxIntegration, input: {} })
        .pipe(Effect.provide(Layer.mergeAll(DropboxCredentialResolverTest, rateLimitHttp)))

      expect(notFound).toMatchObject({
        _tag: 'Failure',
        error: {
          code: 'dropbox_not_found',
          message: 'Dropbox get metadata failed: path/not_found/...',
          status: 409
        }
      })
      expect(conflict).toMatchObject({
        _tag: 'Failure',
        error: {
          code: 'dropbox_conflict',
          message: 'Dropbox create folder failed: path/conflict/folder/...',
          status: 409
        }
      })
      expect(rateLimited).toMatchObject({
        _tag: 'Failure',
        error: {
          code: 'dropbox_rate_limited',
          message: 'Dropbox list folder failed: too_many_requests/...',
          status: 429,
          retryAfterMs: 3000
        }
      })
    })
  )

  it.effect('rejects invalid Dropbox inputs and API-key credentials', () =>
    Effect.gen(function* () {
      const invalidInput = yield* dropboxSearchAction
        .execute({ integration: dropboxIntegration, input: { query: '', maxResults: 1001 } })
        .pipe(
          Effect.provide(
            Layer.mergeAll(DropboxCredentialResolverTest, makeConnectorHttpClientTest([], []))
          ),
          Effect.result
        )
      const ApiKeyCredentialResolverTest = Layer.succeed(
        CredentialResolver,
        CredentialResolver.of({
          resolve: () =>
            Effect.succeed(ApiKeyCredential.make({ _tag: 'ApiKeyCredential', key: 'api_key' }))
        })
      )
      const invalidCredential = yield* dropboxListFolderAction
        .execute({ integration: dropboxIntegration, input: {} })
        .pipe(
          Effect.provide(
            Layer.mergeAll(ApiKeyCredentialResolverTest, makeConnectorHttpClientTest([], []))
          ),
          Effect.result
        )

      expect(invalidInput).toMatchObject({
        _tag: 'Failure',
        failure: { _tag: 'ConnectorError', cause: 'validation_failed' }
      })
      expect(invalidCredential).toMatchObject({
        _tag: 'Failure',
        failure: { _tag: 'ConnectorError', cause: 'credential_invalid' }
      })
    })
  )

  it.effect('fails malformed Dropbox success responses as validation errors', () =>
    Effect.gen(function* () {
      const ConnectorHttpClientTest = makeConnectorHttpClientTest(
        [],
        [jsonHttpResponse('{"entries":[],"has_more":false}')]
      )

      const result = yield* dropboxListFolderAction
        .execute({ integration: dropboxIntegration, input: {} })
        .pipe(
          Effect.provide(Layer.mergeAll(DropboxCredentialResolverTest, ConnectorHttpClientTest)),
          Effect.result
        )

      expect(result).toMatchObject({
        _tag: 'Failure',
        failure: { _tag: 'ConnectorError', cause: 'validation_failed' }
      })
    })
  )

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

  it.effect('lists and searches Outlook mail with scoped Graph permissions and opaque paging', () =>
    Effect.gen(function* () {
      const requests: Array<ConnectorHttpRequest> = []
      const requestedScopes: Array<ReadonlyArray<string> | undefined> = []
      const nextLink =
        'https://graph.microsoft.com/v1.0/me/mailFolders/inbox/messages?%24select=id&%24skip=27&%24top=5'
      const sharedNextLink =
        'https://graph.microsoft.com/v1.0/users/shared%40example.com/messages?%24select=id&%24skip=27&%24top=3'
      const ConnectorHttpClientTest = makeConnectorHttpClientTest(requests, [
        jsonHttpResponse(
          JSON.stringify({
            value: [
              {
                id: 'message_1',
                subject: 'Planning',
                from: { emailAddress: { address: 'alice@example.com', name: 'Alice' } }
              }
            ],
            '@odata.nextLink': nextLink
          })
        ),
        jsonHttpResponse('{"value":[]}'),
        jsonHttpResponse('{"value":[]}'),
        jsonHttpResponse('{"value":[]}')
      ])
      const CredentialResolverTest = Layer.succeed(
        CredentialResolver,
        CredentialResolver.of({
          resolve: request => {
            requestedScopes.push(request.slot.requiredScopes)
            return Effect.succeed(
              OAuthCredential.make({
                _tag: 'OAuthCredential',
                provider: 'microsoft',
                accessToken: 'microsoft_token',
                expiresAt: Date.now() + 60_000
              })
            )
          }
        })
      )
      const TestLayer = Layer.mergeAll(CredentialResolverTest, ConnectorHttpClientTest)

      const listResult = yield* outlookListMessagesAction
        .execute({
          integration: microsoftIntegration,
          input: {
            folderId: 'inbox',
            top: 5,
            filter: 'isRead eq false',
            orderBy: 'receivedDateTime desc'
          }
        })
        .pipe(Effect.provide(TestLayer))
      yield* outlookSearchMessagesAction
        .execute({
          integration: microsoftIntegration,
          input: {
            query: 'from:alice@example.com',
            mailbox: 'shared@example.com',
            top: 3
          }
        })
        .pipe(Effect.provide(TestLayer))
      yield* outlookSearchMessagesAction
        .execute({
          integration: microsoftIntegration,
          input: {
            query: 'ignored for continuation',
            mailbox: 'shared@example.com',
            nextLink: sharedNextLink
          }
        })
        .pipe(Effect.provide(TestLayer))
      yield* outlookListMessagesAction
        .execute({
          integration: microsoftIntegration,
          input: { folderId: 'inbox', nextLink }
        })
        .pipe(Effect.provide(TestLayer))

      const listRequest = requests.at(0)
      const searchRequest = requests.at(1)
      if (listRequest === undefined || searchRequest === undefined) {
        throw new Error('Expected Microsoft Graph requests')
      }
      const listUrl = new URL(listRequest.url)
      const searchUrl = new URL(searchRequest.url)

      expect(listResult).toMatchObject({
        _tag: 'Success',
        value: {
          messages: [{ id: 'message_1', subject: 'Planning' }],
          nextLink
        }
      })
      expect(listUrl.pathname).toBe('/v1.0/me/mailFolders/inbox/messages')
      expect(listUrl.searchParams.get('$top')).toBe('5')
      expect(listUrl.searchParams.get('$filter')).toBe('isRead eq false')
      expect(listUrl.searchParams.get('$orderby')).toBe('receivedDateTime desc')
      expect(searchUrl.pathname).toBe('/v1.0/users/shared%40example.com/messages')
      expect(searchUrl.searchParams.get('$search')).toBe('"from:alice@example.com"')
      expect(requests.at(2)?.url).toBe(sharedNextLink)
      expect(requests.at(3)?.url).toBe(nextLink)
      expect(listRequest.headers?.prefer).toBe('IdType="ImmutableId"')
      expect(requestedScopes.at(0)).toContain(microsoftGraphMailReadScope)
      expect(requestedScopes.at(0)).not.toContain(microsoftGraphMailReadSharedScope)
      expect(requestedScopes.at(1)).toContain(microsoftGraphMailReadSharedScope)
      expect(requestedScopes.at(1)).not.toContain(microsoftGraphMailReadScope)
      expect(requestedScopes.at(2)).toContain(microsoftGraphMailReadSharedScope)
      expect(requestedScopes.at(2)).not.toContain(microsoftGraphMailReadScope)
      expect(requestedScopes.at(2)).not.toContain(microsoftGraphMailReadWriteScope)
      expect(requestedScopes.at(2)).not.toContain(microsoftGraphMailSendScope)
      expect(requestedScopes.at(3)).toContain(microsoftGraphMailReadScope)
    })
  )

  it.effect('uses application mail permissions for explicit Exchange Online mailboxes', () =>
    Effect.gen(function* () {
      const requests: Array<ConnectorHttpRequest> = []
      const requestedScopes: Array<ReadonlyArray<string> | undefined> = []
      const ConnectorHttpClientTest = makeConnectorHttpClientTest(requests, [
        jsonHttpResponse('{"value":[]}')
      ])
      const CredentialResolverTest = Layer.succeed(
        CredentialResolver,
        CredentialResolver.of({
          resolve: request => {
            requestedScopes.push(request.slot.requiredScopes)
            return Effect.succeed(
              OAuthCredential.make({
                _tag: 'OAuthCredential',
                provider: 'microsoft',
                accessToken: 'microsoft_application_token',
                expiresAt: Date.now() + 60_000
              })
            )
          }
        })
      )
      const TestLayer = Layer.mergeAll(CredentialResolverTest, ConnectorHttpClientTest)

      yield* outlookListMessagesAction
        .execute({
          integration: microsoftApplicationIntegration,
          input: { mailbox: 'finance@example.com' }
        })
        .pipe(Effect.provide(TestLayer))
      const missingMailboxResult = yield* outlookListMessagesAction
        .execute({ integration: microsoftApplicationIntegration, input: {} })
        .pipe(Effect.provide(TestLayer), Effect.result)

      expect(requests.at(0)?.url).toContain('/v1.0/users/finance%40example.com/messages')
      expect(requestedScopes.at(0)).toContain(microsoftGraphMailReadScope)
      expect(requestedScopes.at(0)).not.toContain(microsoftGraphMailReadSharedScope)
      expect(missingMailboxResult).toMatchObject({
        _tag: 'Failure',
        failure: { _tag: 'ConnectorError', cause: 'validation_failed' }
      })
      expect(requests).toHaveLength(1)
    })
  )

  it.effect('creates Outlook reply drafts and submits new and draft messages', () =>
    Effect.gen(function* () {
      const requests: Array<ConnectorHttpRequest> = []
      const requestedScopes: Array<ReadonlyArray<string> | undefined> = []
      const ConnectorHttpClientTest = makeConnectorHttpClientTest(requests, [
        ConnectorHttpResponse.make({
          status: 201,
          headers: { 'content-type': 'application/json' },
          body: '{"id":"reply_draft_1","isDraft":true}'
        }),
        ConnectorHttpResponse.make({ status: 202, headers: {}, body: '' }),
        ConnectorHttpResponse.make({ status: 202, headers: {}, body: '' })
      ])
      const CredentialResolverTest = Layer.succeed(
        CredentialResolver,
        CredentialResolver.of({
          resolve: request => {
            requestedScopes.push(request.slot.requiredScopes)
            return Effect.succeed(
              OAuthCredential.make({
                _tag: 'OAuthCredential',
                provider: 'microsoft',
                accessToken: 'microsoft_token',
                expiresAt: Date.now() + 60_000
              })
            )
          }
        })
      )
      const TestLayer = Layer.mergeAll(CredentialResolverTest, ConnectorHttpClientTest)

      const replyResult = yield* outlookCreateReplyDraftAction
        .execute({
          integration: microsoftIntegration,
          input: {
            messageId: 'source/message',
            mailbox: 'shared@example.com',
            body: '<p>Thanks</p>',
            contentType: 'html'
          }
        })
        .pipe(Effect.provide(TestLayer))
      const sendResult = yield* outlookSendMailAction
        .execute({
          integration: microsoftIntegration,
          input: {
            mailbox: 'shared@example.com',
            to: ['lead@example.com'],
            cc: ['team@example.com'],
            subject: 'Hello',
            body: 'Welcome',
            saveToSentItems: false
          }
        })
        .pipe(Effect.provide(TestLayer))
      const sendDraftResult = yield* outlookSendDraftAction
        .execute({
          integration: microsoftIntegration,
          input: { messageId: 'reply_draft_1', mailbox: 'shared@example.com' }
        })
        .pipe(Effect.provide(TestLayer))

      expect(replyResult).toMatchObject({
        _tag: 'Success',
        value: { id: 'reply_draft_1', isDraft: true }
      })
      expect(sendResult).toEqual({ _tag: 'Success', value: { accepted: true } })
      expect(sendDraftResult).toEqual({ _tag: 'Success', value: { accepted: true } })
      expect(requests.at(0)).toMatchObject({
        method: 'POST',
        url: 'https://graph.microsoft.com/v1.0/users/shared%40example.com/messages/source%2Fmessage/createReply',
        headers: { prefer: 'IdType="ImmutableId"' },
        body: JSON.stringify({
          message: { body: { contentType: 'HTML', content: '<p>Thanks</p>' } }
        })
      })
      expect(requests.at(1)).toMatchObject({
        method: 'POST',
        url: 'https://graph.microsoft.com/v1.0/users/shared%40example.com/sendMail',
        body: JSON.stringify({
          message: {
            subject: 'Hello',
            body: { contentType: 'Text', content: 'Welcome' },
            toRecipients: [{ emailAddress: { address: 'lead@example.com' } }],
            from: { emailAddress: { address: 'shared@example.com' } },
            ccRecipients: [{ emailAddress: { address: 'team@example.com' } }]
          },
          saveToSentItems: false
        })
      })
      expect(requests.at(2)?.url).toBe(
        'https://graph.microsoft.com/v1.0/users/shared%40example.com/messages/reply_draft_1/send'
      )
      expect(requestedScopes.at(0)).toContain(microsoftGraphMailReadWriteSharedScope)
      expect(requestedScopes.at(0)).not.toContain(microsoftGraphMailReadWriteScope)
      expect(requestedScopes.at(1)).toContain(microsoftGraphMailSendSharedScope)
      expect(requestedScopes.at(1)).not.toContain(microsoftGraphMailSendScope)
      expect(requestedScopes.at(2)).toContain(microsoftGraphMailSendSharedScope)
    })
  )

  it.effect('maps Microsoft Graph errors and rejects untrusted nextLink URLs', () =>
    Effect.gen(function* () {
      const requests: Array<ConnectorHttpRequest> = []
      const ConnectorHttpClientTest = makeConnectorHttpClientTest(requests, [
        ConnectorHttpResponse.make({
          status: 429,
          headers: { 'retry-after': '2' },
          body: '{"error":{"code":"TooManyRequests","message":"Slow down"}}'
        }),
        jsonHttpResponse('{"subject":"Missing required id"}')
      ])
      const CredentialResolverTest = Layer.succeed(
        CredentialResolver,
        CredentialResolver.of({
          resolve: () =>
            Effect.succeed(
              OAuthCredential.make({
                _tag: 'OAuthCredential',
                provider: 'microsoft',
                accessToken: 'microsoft_token',
                expiresAt: Date.now() + 60_000
              })
            )
        })
      )
      const TestLayer = Layer.mergeAll(CredentialResolverTest, ConnectorHttpClientTest)

      const providerResult = yield* outlookSearchMessagesAction
        .execute({ integration: microsoftIntegration, input: { query: 'invoice' } })
        .pipe(Effect.provide(TestLayer))
      const invalidNextLinkResult = yield* outlookListMessagesAction
        .execute({
          integration: microsoftIntegration,
          input: {
            nextLink: 'https://graph.microsoft.com/v1.0/users/other/messages?%24skip=10'
          }
        })
        .pipe(Effect.provide(TestLayer), Effect.result)
      const mismatchedFolderNextLinkResult = yield* outlookListMessagesAction
        .execute({
          integration: microsoftIntegration,
          input: {
            folderId: 'inbox',
            nextLink: 'https://graph.microsoft.com/v1.0/me/messages?%24skip=10'
          }
        })
        .pipe(Effect.provide(TestLayer), Effect.result)
      const invalidPageSizeResult = yield* outlookListMessagesAction
        .execute({ integration: microsoftIntegration, input: { top: 1_001 } })
        .pipe(Effect.provide(TestLayer), Effect.result)
      const malformedResponseResult = yield* outlookGetMessageAction
        .execute({ integration: microsoftIntegration, input: { messageId: 'message_1' } })
        .pipe(Effect.provide(TestLayer), Effect.result)

      expect(providerResult).toMatchObject({
        _tag: 'Failure',
        error: {
          code: 'microsoft_rate_limited',
          message: 'Microsoft Outlook search messages failed: Slow down',
          status: 429,
          retryAfterMs: 2_000
        }
      })
      expect(invalidNextLinkResult).toMatchObject({
        _tag: 'Failure',
        failure: { _tag: 'ConnectorError', cause: 'validation_failed' }
      })
      expect(mismatchedFolderNextLinkResult).toMatchObject({
        _tag: 'Failure',
        failure: { _tag: 'ConnectorError', cause: 'validation_failed' }
      })
      expect(invalidPageSizeResult).toMatchObject({
        _tag: 'Failure',
        failure: { _tag: 'ConnectorError', cause: 'validation_failed' }
      })
      expect(malformedResponseResult).toMatchObject({
        _tag: 'Failure',
        failure: { _tag: 'ConnectorError', cause: 'validation_failed' }
      })
      expect(requests.at(1)?.headers?.prefer).toBe(
        'IdType="ImmutableId", outlook.body-content-type="text"'
      )
      expect(requests).toHaveLength(2)
    })
  )

  it.effect('lists and searches OneDrive items with scoped Graph permissions and paging', () =>
    Effect.gen(function* () {
      const requests: Array<ConnectorHttpRequest> = []
      const requestedScopes: Array<ReadonlyArray<string> | undefined> = []
      const listNextLink =
        'https://graph.microsoft.com/v1.0/me/drive/root/children?%24skiptoken=list_page_2'
      const searchNextLink =
        "https://graph.microsoft.com/v1.0/drives/shared%2Fdrive/root/search(q='quarterly')?%24skiptoken=search_page_2"
      const ConnectorHttpClientTest = makeConnectorHttpClientTest(requests, [
        jsonHttpResponse(
          JSON.stringify({
            value: [
              {
                id: 'item_1',
                name: 'Plan.docx',
                size: 42,
                file: {
                  mimeType:
                    'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
                },
                parentReference: { driveId: 'personal_drive', id: 'root' }
              }
            ],
            '@odata.nextLink': listNextLink
          })
        ),
        jsonHttpResponse('{"value":[]}'),
        jsonHttpResponse('{"value":[]}')
      ])
      const CredentialResolverTest = Layer.succeed(
        CredentialResolver,
        CredentialResolver.of({
          resolve: request => {
            requestedScopes.push(request.slot.requiredScopes)
            return Effect.succeed(
              OAuthCredential.make({
                _tag: 'OAuthCredential',
                provider: 'microsoft',
                accessToken: 'microsoft_token',
                expiresAt: Date.now() + 60_000
              })
            )
          }
        })
      )
      const TestLayer = Layer.mergeAll(CredentialResolverTest, ConnectorHttpClientTest)

      const listResult = yield* oneDriveListItemsAction
        .execute({
          integration: microsoftIntegration,
          input: { parentItemId: 'folder/root', top: 25, orderBy: 'name asc' }
        })
        .pipe(Effect.provide(TestLayer))
      yield* oneDriveSearchItemsAction
        .execute({
          integration: microsoftDriveDelegatedAllIntegration,
          input: { query: "quarterly's report", driveId: 'shared/drive', top: 10 }
        })
        .pipe(Effect.provide(TestLayer))
      yield* oneDriveSearchItemsAction
        .execute({
          integration: microsoftDriveDelegatedAllIntegration,
          input: {
            query: 'ignored for continuation',
            driveId: 'shared/drive',
            nextLink: searchNextLink
          }
        })
        .pipe(Effect.provide(TestLayer))

      const listRequest = requests.at(0)
      const searchRequest = requests.at(1)
      if (listRequest === undefined || searchRequest === undefined) {
        throw new Error('Expected Microsoft OneDrive requests')
      }
      const listUrl = new URL(listRequest.url)
      const searchUrl = new URL(searchRequest.url)

      expect(listResult).toMatchObject({
        _tag: 'Success',
        value: {
          items: [{ id: 'item_1', name: 'Plan.docx', size: 42 }],
          nextLink: listNextLink
        }
      })
      expect(listUrl.pathname).toBe('/v1.0/me/drive/items/folder%2Froot/children')
      expect(listUrl.searchParams.get('$top')).toBe('25')
      expect(listUrl.searchParams.get('$orderby')).toBe('name asc')
      expect(searchUrl.pathname).toBe(
        "/v1.0/drives/shared%2Fdrive/root/search(q='quarterly%27%27s%20report')"
      )
      expect(searchUrl.searchParams.get('$top')).toBe('10')
      expect(requests.at(2)?.url).toBe(searchNextLink)
      expect(requestedScopes.at(0)).toContain(microsoftGraphFilesReadScope)
      expect(requestedScopes.at(0)).not.toContain(microsoftGraphFilesReadAllScope)
      expect(requestedScopes.at(1)).toContain(microsoftGraphFilesReadAllScope)
      expect(requestedScopes.at(1)).not.toContain(microsoftGraphFilesReadScope)
      expect(requestedScopes.at(2)).toContain(microsoftGraphFilesReadAllScope)
    })
  )

  it.effect('gets OneDrive metadata and creates and deletes folders with write scopes', () =>
    Effect.gen(function* () {
      const requests: Array<ConnectorHttpRequest> = []
      const requestedScopes: Array<ReadonlyArray<string> | undefined> = []
      const ConnectorHttpClientTest = makeConnectorHttpClientTest(requests, [
        jsonHttpResponse(
          '{"id":"item_1","name":"Budget.xlsx","file":{"mimeType":"application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"}}'
        ),
        ConnectorHttpResponse.make({
          status: 201,
          headers: { 'content-type': 'application/json' },
          body: '{"id":"folder_1","name":"Reports","folder":{"childCount":0}}'
        }),
        ConnectorHttpResponse.make({ status: 204, headers: {}, body: '' })
      ])
      const CredentialResolverTest = Layer.succeed(
        CredentialResolver,
        CredentialResolver.of({
          resolve: request => {
            requestedScopes.push(request.slot.requiredScopes)
            return Effect.succeed(
              OAuthCredential.make({
                _tag: 'OAuthCredential',
                provider: 'microsoft',
                accessToken: 'microsoft_token',
                expiresAt: Date.now() + 60_000
              })
            )
          }
        })
      )
      const TestLayer = Layer.mergeAll(CredentialResolverTest, ConnectorHttpClientTest)

      const itemResult = yield* oneDriveGetItemAction
        .execute({
          integration: microsoftIntegration,
          input: { driveId: 'shared/drive', itemId: 'item/1' }
        })
        .pipe(Effect.provide(TestLayer))
      const folderResult = yield* oneDriveCreateFolderAction
        .execute({
          integration: microsoftIntegration,
          input: { parentItemId: 'parent/1', name: 'Reports', conflictBehavior: 'rename' }
        })
        .pipe(Effect.provide(TestLayer))
      const deleteResult = yield* oneDriveDeleteItemAction
        .execute({
          integration: microsoftDriveDelegatedAllIntegration,
          input: { driveId: 'shared/drive', itemId: 'folder/1', ifMatch: 'etag_1' }
        })
        .pipe(Effect.provide(TestLayer))

      expect(itemResult).toMatchObject({
        _tag: 'Success',
        value: { id: 'item_1', name: 'Budget.xlsx' }
      })
      expect(folderResult).toMatchObject({
        _tag: 'Success',
        value: { id: 'folder_1', name: 'Reports', folder: { childCount: 0 } }
      })
      expect(deleteResult).toEqual({ _tag: 'Success', value: { deleted: true } })
      expect(requests.at(0)?.url).toContain(
        'https://graph.microsoft.com/v1.0/drives/shared%2Fdrive/items/item%2F1?'
      )
      expect(requests.at(1)).toMatchObject({
        method: 'POST',
        url: 'https://graph.microsoft.com/v1.0/me/drive/items/parent%2F1/children',
        body: JSON.stringify({
          name: 'Reports',
          folder: {},
          '@microsoft.graph.conflictBehavior': 'rename'
        })
      })
      expect(requests.at(2)).toMatchObject({
        method: 'DELETE',
        url: 'https://graph.microsoft.com/v1.0/drives/shared%2Fdrive/items/folder%2F1',
        headers: { 'if-match': 'etag_1' }
      })
      expect(requestedScopes.at(0)).toContain(microsoftGraphFilesReadScope)
      expect(requestedScopes.at(0)).not.toContain(microsoftGraphFilesReadAllScope)
      expect(requestedScopes.at(1)).toContain(microsoftGraphFilesReadWriteScope)
      expect(requestedScopes.at(1)).not.toContain(microsoftGraphFilesReadWriteAllScope)
      expect(requestedScopes.at(2)).toContain(microsoftGraphFilesReadWriteAllScope)
      expect(requestedScopes.at(2)).not.toContain(microsoftGraphFilesReadWriteScope)
    })
  )

  it.effect('guards application OneDrive access, pagination, page size, and provider errors', () =>
    Effect.gen(function* () {
      const requests: Array<ConnectorHttpRequest> = []
      const requestedScopes: Array<ReadonlyArray<string> | undefined> = []
      const ConnectorHttpClientTest = makeConnectorHttpClientTest(requests, [
        ConnectorHttpResponse.make({
          status: 423,
          headers: { 'retry-after': '3' },
          body: '{"error":{"code":"resourceLocked","message":"The item is locked"}}'
        })
      ])
      const CredentialResolverTest = Layer.succeed(
        CredentialResolver,
        CredentialResolver.of({
          resolve: request => {
            requestedScopes.push(request.slot.requiredScopes)
            return Effect.succeed(
              OAuthCredential.make({
                _tag: 'OAuthCredential',
                provider: 'microsoft',
                accessToken: 'microsoft_application_token',
                expiresAt: Date.now() + 60_000
              })
            )
          }
        })
      )
      const TestLayer = Layer.mergeAll(CredentialResolverTest, ConnectorHttpClientTest)

      const providerResult = yield* oneDriveListItemsAction
        .execute({
          integration: microsoftDriveApplicationIntegration,
          input: { driveId: 'finance_drive' }
        })
        .pipe(Effect.provide(TestLayer))
      const missingDriveResult = yield* oneDriveListItemsAction
        .execute({ integration: microsoftDriveApplicationIntegration, input: {} })
        .pipe(Effect.provide(TestLayer), Effect.result)
      const invalidNextLinkResult = yield* oneDriveListItemsAction
        .execute({
          integration: microsoftIntegration,
          input: {
            driveId: 'finance_drive',
            nextLink:
              'https://graph.microsoft.com/v1.0/drives/other_drive/root/children?%24skiptoken=page_2'
          }
        })
        .pipe(Effect.provide(TestLayer), Effect.result)
      const invalidPageSizeResult = yield* oneDriveSearchItemsAction
        .execute({ integration: microsoftIntegration, input: { query: 'invoice', top: 1_000 } })
        .pipe(Effect.provide(TestLayer), Effect.result)

      expect(providerResult).toMatchObject({
        _tag: 'Failure',
        error: {
          code: 'microsoft_locked',
          message: 'Microsoft OneDrive list items failed: The item is locked',
          status: 423,
          retryAfterMs: 3_000
        }
      })
      expect(missingDriveResult).toMatchObject({
        _tag: 'Failure',
        failure: { _tag: 'ConnectorError', cause: 'validation_failed' }
      })
      expect(invalidNextLinkResult).toMatchObject({
        _tag: 'Failure',
        failure: { _tag: 'ConnectorError', cause: 'validation_failed' }
      })
      expect(invalidPageSizeResult).toMatchObject({
        _tag: 'Failure',
        failure: { _tag: 'ConnectorError', cause: 'validation_failed' }
      })
      expect(requests.at(0)?.url).toContain('/v1.0/drives/finance_drive/root/children?')
      expect(requestedScopes.at(0)).toContain(microsoftGraphFilesReadAllScope)
      expect(requestedScopes.at(0)).not.toContain(microsoftGraphFilesReadScope)
      expect(requests).toHaveLength(1)
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
                      headers: [{ name: 'Content-Transfer-Encoding', value: 'quoted-printable' }],
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
