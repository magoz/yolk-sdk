# @yolk-sdk/connectors

Effect-native connector, integration, credential, and action primitives for hosts that bring their own auth, storage, and policy.

## Install

```bash
pnpm add @yolk-sdk/connectors@canary @yolk-sdk/agent@canary effect
```

Canary APIs are unstable. Keep all `@yolk-sdk/*` packages on the same version.

## Subpaths

| Subpath                                | Purpose                                                                                  |
| -------------------------------------- | ---------------------------------------------------------------------------------------- |
| `@yolk-sdk/connectors`                 | Core connector/action/integration/credential primitives                                  |
| `@yolk-sdk/connectors/agent`           | Adapter from connector actions to `@yolk-sdk/agent/tools` modules                        |
| `@yolk-sdk/connectors/figma`           | Figma remote MCP auth action and OAuth constants                                         |
| `@yolk-sdk/connectors/google`          | Gmail/Calendar actions and Google OAuth slot constants                                   |
| `@yolk-sdk/connectors/linkedin-search` | Exa people search and Enrich Layer profile/email actions                                 |
| `@yolk-sdk/connectors/notion`          | Notion page/block/database/data-source/comment/user actions and API token slot constants |
| `@yolk-sdk/connectors/r2-storage`      | Cloudflare R2 upload URL action with host-provided presigner                             |
| `@yolk-sdk/connectors/telegram`        | Telegram bot send/validate actions                                                       |
| `@yolk-sdk/connectors/todoist`         | Todoist project/task/label actions and API token slot constants                          |

## Imports

```ts
import { defineConnector, makeIntegration } from '@yolk-sdk/connectors'
import { makeConnectorToolModule } from '@yolk-sdk/connectors/agent'
import { GoogleConnector } from '@yolk-sdk/connectors/google'
```

## Model

- **Connector**: reusable provider logic.
- **Integration**: host-owned config that makes a connector invokable.
- **Action**: typed operation exposed by a connector.
- **CredentialSlot**: credential requirement declared by connector code.
- **CredentialBinding**: integration slot-to-host-credential-ref mapping.
- **CredentialResolver**: host Effect service that resolves refs at runtime.
- **ConnectorHttpClient**: host-provided HTTP port used by provider actions.

## HTTP port

The root export includes connector HTTP infrastructure, not a connector. It defines the typed HTTP request/response model, the `ConnectorHttpClient` Effect service, and JSON response decoding helpers.

Provider connectors build `ConnectorHttpRequest` values; hosts execute them by providing a `ConnectorHttpClient` layer. This keeps connector packages portable and avoids bundling `fetch`, Node HTTP clients, or app-specific networking policy.

Host adapters must preserve connector headers and body content type. Several provider actions send JSON and rely on `content-type: application/json` reaching the upstream API unchanged.

## Example

```ts
import { Effect, Layer, Schema } from 'effect'
import {
  ActionResult,
  ApiKeyCredential,
  CredentialResolver,
  CredentialSlot,
  defineAction,
  defineConnector,
  makeCredentialBinding,
  makeIntegration,
  resolveCredential
} from '@yolk-sdk/connectors'

const ApiToken = CredentialSlot.make({
  id: 'todoist.api_token',
  kind: 'api_key'
})

const ListTasksInput = Schema.Struct({ projectId: Schema.optional(Schema.String) })
const ListTasksOutput = Schema.Struct({ tasks: Schema.Array(Schema.String) })

const listTasks = defineAction({
  id: 'todoist.list_tasks',
  description: 'List Todoist tasks',
  inputSchema: ListTasksInput,
  outputSchema: ListTasksOutput,
  execute: input =>
    Effect.gen(function* () {
      const credential = yield* resolveCredential(input.integration, ApiToken)

      if (credential._tag !== 'ApiKeyCredential') {
        return ActionResult.failure({ code: 'invalid_credential', message: 'Expected API key' })
      }

      return ActionResult.success({ tasks: [] })
    })
})

const Todoist = defineConnector({
  id: 'todoist',
  actions: [listTasks]
})

const integration = makeIntegration({
  connectorId: 'todoist',
  credentialBindings: [
    makeCredentialBinding({ slotId: ApiToken.id, credentialRef: 'host-credential-id' })
  ]
})

const CredentialResolverLive = Layer.succeed(
  CredentialResolver,
  CredentialResolver.of({
    resolve: () =>
      Effect.succeed(
        ApiKeyCredential.make({
          _tag: 'ApiKeyCredential',
          key: 'runtime-secret-from-host'
        })
      )
  })
)

const program = Todoist.invoke({
  integration,
  action: 'todoist.list_tasks',
  input: {}
}).pipe(Effect.provide(CredentialResolverLive))
```

## Google connector

```ts
import { Effect } from 'effect'
import { makeCredentialBinding, makeIntegration } from '@yolk-sdk/connectors'
import { GoogleConnector, GoogleOAuthCredentialSlot } from '@yolk-sdk/connectors/google'

const integration = makeIntegration({
  connectorId: 'google',
  credentialBindings: [
    makeCredentialBinding({
      slotId: GoogleOAuthCredentialSlot.id,
      credentialRef: 'google-oauth-credential'
    })
  ]
})

const result = GoogleConnector.invoke({
  integration,
  action: 'gmail.search',
  input: { query: 'from:alice@example.com', maxResults: 10 }
})
```

Provide `CredentialResolver` and `ConnectorHttpClient` layers from host code. Hosts own OAuth refresh before returning `OAuthCredential`. If using Effect HTTP, adapt `effect/unstable/http` in host code rather than importing a Yolk wrapper. Preserve connector request headers and body content type when adapting HTTP; provider connectors may rely on `content-type: application/json` for request parsing.

Gmail draft compose, update, and reply inputs accept optional `from` values for Gmail send-as aliases. Explicit `from` values are validated through `users.settings.sendAs`; reply drafts can infer a matching alias from recipient headers. Google exports action-scoped OAuth slots such as `GoogleGmailComposeOAuthCredentialSlot`, `GoogleGmailDraftReplyOAuthCredentialSlot`, and `GoogleCalendarEventsOAuthCredentialSlot`; hosts should request the selected slot's `requiredScopes`. `GoogleOAuthCredentialSlot` keeps the generic `google.oauth` binding id for existing integrations, while `GoogleCombinedOAuthCredentialSlot` contains all Google connector scopes for broad-consent hosts.

`gmail.get_thread` requires `threadId` and `format: 'full' | 'metadata' | 'minimal'`. It returns `GmailThreadOutput` with normalized messages, selected headers, decoded text bodies when the provider includes them, and attachment metadata. Plain text is preferred over HTML. Raw MIME payloads and attachment bytes are omitted; fetch attachment content explicitly with `gmail.get_attachment`. Use `full` when decoded bodies are required.

Notion and Todoist actions decode provider wire pagination and expose SDK outputs with camelCase fields such as `nextCursor`. Inputs accept documented camelCase fields and common provider-native snake_case aliases where useful, such as Notion `data_source_id` / `rich_text` and Todoist `project_id` / `task_id` / `filter_lang`.

LinkedIn email lookup may return `{ status: 'queued', email: null }` when Enrich Layer accepts the lookup asynchronously.

## Provider actions

| Subpath                                | Actions                                                                                                     |
| -------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| `@yolk-sdk/connectors/figma`           | `figma.mcp_auth`                                                                                            |
| `@yolk-sdk/connectors/google`          | Gmail search/list/message/thread/draft/send-as/label/trash actions; Calendar calendar/event/account actions |
| `@yolk-sdk/connectors/linkedin-search` | `linkedin_search.search`, `linkedin_search.profile`, `linkedin_search.email`                                |
| `@yolk-sdk/connectors/notion`          | Notion search, page, block, database, data source, user, and comment actions                                |
| `@yolk-sdk/connectors/r2-storage`      | `r2_storage.upload_url`                                                                                     |
| `@yolk-sdk/connectors/telegram`        | `telegram.send_message`, `telegram.validate`                                                                |
| `@yolk-sdk/connectors/todoist`         | Todoist project, task, and label actions                                                                    |

R2 presigning is host-provided through `R2Presigner`; no AWS SDK dependency is bundled. `r2_storage.upload_url` includes `publicUrl` only when integration config provides `publicUrl`.

## Agent adapter

```ts
import { makeConnectorToolModule } from '@yolk-sdk/connectors/agent'
import { GoogleConnector } from '@yolk-sdk/connectors/google'

const toolModule = makeConnectorToolModule(GoogleConnector, {
  integration,
  layer: HostConnectorLayer,
  access: action => (action.includes('create') ? 'write' : 'read')
})
```

`HostConnectorLayer` should provide `CredentialResolver`, `ConnectorHttpClient`, and any other connector dependencies.

## Host responsibilities

- Store, encrypt, refresh, revoke, and audit credentials.
- Own OAuth routes, callbacks, state, token persistence, and required-scope consent.
- Map integrations to users, workspaces, agents, or projects outside this package.
- Authorize action execution before invoking connectors.

## Boundaries

- No DB, framework, UI, app auth, or product lifecycle code.
- No Promise facade; use Effect directly.
- Integrations contain credential refs only, never raw secrets.
