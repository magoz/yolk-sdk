# @yolk-sdk/connectors

Effect-native connector, integration, credential, and action primitives for hosts that bring their own auth, storage, and policy.

## Install

```bash
pnpm add @yolk-sdk/connectors@canary @yolk-sdk/agent@canary effect
```

Canary APIs are unstable. Keep all `@yolk-sdk/*` packages on the same version.
Published package metadata requires Node.js 22+.

## Subpaths

| Subpath                                | Purpose                                                                               |
| -------------------------------------- | ------------------------------------------------------------------------------------- |
| `@yolk-sdk/connectors`                 | Core connector/action/integration/credential primitives                               |
| `@yolk-sdk/connectors/agent`           | Adapter from connector actions to `@yolk-sdk/agent/tools` modules                     |
| `@yolk-sdk/connectors/afloat`          | Afloat remote MCP auth action, API-key slot, endpoint, and protocol version           |
| `@yolk-sdk/connectors/dropbox`         | Dropbox metadata, search, and file-management actions plus OAuth slot constants       |
| `@yolk-sdk/connectors/email`           | Portable IMAP reads/drafts, POP3 reads, and SMTP submission through a host email port |
| `@yolk-sdk/connectors/figma`           | Figma remote MCP auth action and OAuth constants                                      |
| `@yolk-sdk/connectors/google`          | Gmail/Calendar actions and Google OAuth slot constants                                |
| `@yolk-sdk/connectors/linkedin-search` | Exa people search and Enrich Layer profile/email actions                              |
| `@yolk-sdk/connectors/microsoft`       | Microsoft Outlook/OneDrive actions through Graph and shared OAuth slot constants      |
| `@yolk-sdk/connectors/notion`          | Notion search/page/block/database/data-source/comment/user actions and API token slot |
| `@yolk-sdk/connectors/r2-storage`      | Cloudflare R2 upload URL action with host-provided presigner                          |
| `@yolk-sdk/connectors/telegram`        | Telegram bot send/validate actions                                                    |
| `@yolk-sdk/connectors/todoist`         | Todoist project/task/label actions and API token slot constants                       |

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
- **EmailClient**: host-provided IMAP, POP3, and SMTP transport port used by generic email actions.

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

## Generic email connector

```ts
import { makeCredentialBinding, makeIntegration } from '@yolk-sdk/connectors'
import {
  EmailConnector,
  EmailIncomingCredentialSlot,
  EmailSmtpCredentialSlot
} from '@yolk-sdk/connectors/email'

const integration = makeIntegration({
  connectorId: 'email',
  config: {
    incomingProtocol: 'imap',
    incomingHost: 'imap.example.com',
    smtpHost: 'smtp.example.com'
  },
  credentialBindings: [
    makeCredentialBinding({
      slotId: EmailIncomingCredentialSlot.id,
      credentialRef: 'incoming-email-credential'
    }),
    makeCredentialBinding({
      slotId: EmailSmtpCredentialSlot.id,
      credentialRef: 'smtp-email-credential'
    })
  ]
})

const program = EmailConnector.invoke({
  integration,
  action: 'email.list_messages',
  input: { limit: 25 }
})
```

Provide `CredentialResolver` and `EmailClient` layers. The package never imports socket, TLS, MIME,
IMAP, POP3, or SMTP libraries. Incoming config defaults to IMAP with TLS (`993`); POP3 with TLS
defaults to `995`. SMTP defaults to STARTTLS on `587`, while explicit SMTP TLS defaults to `465`.
Ports accept integers or numeric strings. A POP3 action rejects `folder`; use IMAP for folder-aware
reads. Incoming and SMTP bindings are separate, but both may point to the same host credential ref.
Both slots require `UsernamePasswordCredential`; provider-specific OAuth remains available through
the Google and Microsoft connectors.

The common action set is `email.list_messages`, `email.get_message`, `email.create_draft`, and
`email.send_message`. Draft creation requires IMAP and uses the incoming credential. An optional
`folder` selects the target mailbox; when omitted, the host adapter resolves the mailbox marked with
IMAP's `\Drafts` special-use attribute and may fall back to `Drafts`. Drafts may omit recipients.
The result reports `{ saved: true, folder, draftId? }` because IMAP servers without UIDPLUS may not
return an `APPENDUID`. `draftId`, when present, is an opaque adapter identifier; UIDPLUS adapters
must encode both UIDVALIDITY and UID rather than exposing a bare UID. The host adapter generates MIME
and performs `APPEND` with the `\Draft` flag.

Messages expose normalized addresses, text/HTML bodies, and attachment metadata only—never raw MIME
or attachment bytes. List `id` values are opaque adapter identifiers that callers pass unchanged to
`email.get_message`; POP3 adapters must use UIDL or another stable mapping, never transient message
sequence numbers. When IMAP `folder` is omitted, adapters use `INBOX`; POP3 uses its single mailbox.
Adapters return deterministic newest-first pages. Cursors are opaque, scoped to the integration,
protocol, folder, and ordering, and may fail after mailbox changes. Send success returns
`{ accepted: true }`, which means the SMTP server accepted submission, not that the message was
delivered.

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

const program = GoogleConnector.invoke({
  integration,
  action: 'gmail.search',
  input: { query: 'from:alice@example.com', maxResults: 10 }
})
```

Provide `CredentialResolver` and `ConnectorHttpClient` layers from host code. Hosts own OAuth refresh before returning `OAuthCredential`. If using Effect HTTP, adapt `effect/unstable/http` in host code rather than importing a Yolk wrapper. Preserve connector request headers and body content type when adapting HTTP; provider connectors may rely on `content-type: application/json` for request parsing.

Gmail draft compose, update, and reply inputs accept optional `from` values for Gmail send-as aliases. Explicit `from` values are validated through `users.settings.sendAs`; reply drafts can infer a matching alias from recipient headers. Google exports action-scoped OAuth slots such as `GoogleGmailComposeOAuthCredentialSlot`, `GoogleGmailDraftReplyOAuthCredentialSlot`, and `GoogleCalendarEventsOAuthCredentialSlot`; hosts should request the selected slot's `requiredScopes`. `GoogleOAuthCredentialSlot` keeps the generic `google.oauth` binding id for existing integrations, while `GoogleCombinedOAuthCredentialSlot` contains all Google connector scopes for broad-consent hosts.

`gmail.get_thread` requires `threadId` and `format: 'full' | 'metadata' | 'minimal'`. It returns `GmailThreadOutput` with normalized messages, selected headers, decoded message text when the provider includes it, and attachment metadata. Plain text is preferred over HTML; text attachments never become message bodies. Raw MIME and attachment content are omitted. When an attachment has `attachmentId`, fetch it with `gmail.get_attachment`; Gmail inline attachments may omit that id and cannot be retrieved through that action. Use `full` when decoded bodies are required.

## Dropbox connector

Minimal wiring fragment (host layer and Effect execution omitted):

```ts
import { makeCredentialBinding, makeIntegration } from '@yolk-sdk/connectors'
import { DropboxConnector, DropboxCombinedOAuthCredentialSlot } from '@yolk-sdk/connectors/dropbox'

const integration = makeIntegration({
  connectorId: 'dropbox',
  credentialBindings: [
    makeCredentialBinding({
      slotId: DropboxCombinedOAuthCredentialSlot.id,
      credentialRef: 'dropbox-oauth-credential'
    })
  ]
})

const program = DropboxConnector.invoke({
  integration,
  action: 'dropbox.list_folder',
  input: { path: '', limit: 100 }
})
```

Provide host-owned `CredentialResolver` and `ConnectorHttpClient` layers. Dropbox action-scoped slots share the `dropbox.oauth` binding id: metadata reads request `files.metadata.read`, while create/move/copy/delete actions request `files.content.write`. The host owns OAuth code exchange, refresh, storage, consent, and App Folder versus Full Dropbox configuration.

Use `path: ''` or omit `path` to list the Dropbox API root. Continue folder listings with `dropbox.list_folder_continue` while `hasMore` is true, and continue searches with `dropbox.search_continue`. Outputs normalize Dropbox `.tag` metadata into `type: 'file' | 'folder' | 'deleted'` and camelCase fields.

Upload and download actions are intentionally not included: Dropbox content routes are binary, while the portable connector HTTP port currently carries string bodies. Hosts can implement binary transfer outside this connector without lossy encoding.

## Microsoft connector

```ts
import { makeCredentialBinding, makeIntegration } from '@yolk-sdk/connectors'
import { MicrosoftConnector, MicrosoftOAuthCredentialSlot } from '@yolk-sdk/connectors/microsoft'

const integration = makeIntegration({
  connectorId: 'microsoft',
  credentialBindings: [
    makeCredentialBinding({
      slotId: MicrosoftOAuthCredentialSlot.id,
      credentialRef: 'microsoft-oauth-credential'
    })
  ]
})

const mailProgram = MicrosoftConnector.invoke({
  integration,
  action: 'outlook.search_messages',
  input: {
    query: 'from:alice@example.com',
    mailbox: 'shared@example.com',
    top: 10
  }
})

const filesProgram = MicrosoftConnector.invoke({
  integration,
  action: 'onedrive.search_items',
  input: { query: 'quarterly plan', top: 10 }
})
```

This integration targets **Microsoft Outlook and OneDrive through Microsoft Graph v1.0**. It does
not use the retired Outlook REST endpoint, direct Exchange Online APIs, or legacy OneDrive APIs.
Microsoft Graph is the shared API and OAuth resource boundary.

All action-scoped slots share the `microsoft.oauth` binding id, so one host credential can serve
Outlook and OneDrive when its consent includes the selected actions' `Mail.*` and `Files.*`
permissions. Use `MicrosoftCombinedOAuthCredentialSlot` only when broad consent is appropriate.

Outlook inputs default to the signed-in mailbox (`/me`). Set `mailbox` to a user ID or user principal
name to target an Exchange Online shared/delegated mailbox through `/users/{mailbox}`. Signed-in
mailbox actions request `Mail.Read`, `Mail.ReadWrite`, or `Mail.Send`; explicit mailbox targets
request the corresponding `Mail.Read.Shared`, `Mail.ReadWrite.Shared`, or `Mail.Send.Shared`
delegated permission.

The signed-in user still needs the relevant Exchange folder/full-access grant. Sending from another
mailbox also requires Exchange **Send As** or **Send on Behalf** rights; targeting that mailbox's
`/users/{mailbox}` endpoint requires Full Access. For application tokens, set integration config to
`{ mailboxAccessMode: 'application' }` and always provide `mailbox`. The connector then uses the non-Shared `Mail.Read`, `Mail.ReadWrite`, and
`Mail.Send` application-permission hints. Scope application access to approved mailboxes with host
or admin policy, such as Exchange Online RBAC for Applications. Hosts own Entra app registration,
tenant/authority selection, OAuth callbacks, refresh, credential storage, and consent.

Pass Outlook Graph `@odata.nextLink` values back through `nextLink` unchanged. Repeat `mailbox` for
an explicit mailbox continuation and `folderId` for a folder continuation. The connector only
accepts global Graph v1.0 links for the selected mailbox and folder collection. `outlook.get_message` requests a text body; read and
draft-returning actions request immutable IDs. Sending returns `{ accepted: true }` for Graph's
`202 Accepted`; that confirms submission, not processing or delivery.

OneDrive actions default to the signed-in user's `/me/drive`; set `driveId` to target
`/drives/{driveId}`. Delegated mode uses least-privilege `Files.Read` or `Files.ReadWrite`. Set
`oneDriveAccessMode` to `delegated_all` when the host has consented `Files.Read.All` or
`Files.ReadWrite.All` for broader delegated access. For application tokens, set it to `application`
and always provide `driveId`; application mode also uses the `Files.*.All` slots. List and search
continuations must repeat the same drive target; list continuations must also repeat `parentItemId`.

The OneDrive action set lists, searches, and gets file/folder metadata, creates folders, and moves
items to the recycle bin. Binary content download/upload and resumable upload sessions are not part
of the connector's current string/JSON HTTP boundary; hosts own file-content transfer. The built-in
Microsoft endpoint targets the global cloud; national-cloud hosts need a cloud-specific connector
until the API base is configurable.

See Microsoft's [Outlook mail API overview](https://learn.microsoft.com/en-us/graph/outlook-mail-concept-overview), [shared/delegated folder guide](https://learn.microsoft.com/en-us/graph/outlook-share-messages-folders), [OneDrive DriveItem overview](https://learn.microsoft.com/en-us/graph/onedrive-concept-overview), and [DriveItem addressing guide](https://learn.microsoft.com/en-us/graph/onedrive-addressing-driveitems).

Notion and Todoist actions decode provider wire pagination and expose SDK outputs with camelCase fields such as `nextCursor`. Inputs accept documented camelCase fields and common provider-native snake_case aliases where useful, such as Notion `data_source_id` / `rich_text` and Todoist `project_id` / `task_id` / `filter_lang`.

LinkedIn email lookup may return `{ status: 'queued', email: null }` when Enrich Layer accepts the lookup asynchronously.

## Provider actions

| Subpath                                | Actions                                                                                                     |
| -------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| `@yolk-sdk/connectors/afloat`          | `afloat.mcp_auth`                                                                                           |
| `@yolk-sdk/connectors/dropbox`         | list/continue, search/continue, metadata, create folder, move, copy, delete                                 |
| `@yolk-sdk/connectors/email`           | `email.list_messages`, `email.get_message`, `email.create_draft`, `email.send_message`                      |
| `@yolk-sdk/connectors/figma`           | `figma.mcp_auth`                                                                                            |
| `@yolk-sdk/connectors/google`          | Gmail search/list/message/thread/draft/send-as/label/trash actions; Calendar calendar/event/account actions |
| `@yolk-sdk/connectors/linkedin-search` | `linkedin_search.search`, `linkedin_search.profile`, `linkedin_search.email`                                |
| `@yolk-sdk/connectors/microsoft`       | Outlook mail plus OneDrive metadata, search, folder-create, and recycle-bin actions                         |
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

Connector actions can declare default `read`, `write`, or `destructive` access metadata. The agent
adapter uses that declaration unless the host supplies `access`; host access resolvers always win.
Microsoft draft/folder-create actions declare `write`; message sends and OneDrive deletion declare
`destructive`. Legacy actions without metadata default to `read`, so hosts should continue assigning
explicit access when adapting other write-capable connectors.

Afloat MCP auth reads an `afloat_` API key from the host runtime credential and returns the
canonical MCP endpoint and required `2026-07-28` protocol version. Keep the API key server-side;
never expose the auth action through a model-callable connector module.

Figma MCP auth reads `accessToken` plus optional `refreshToken`, `clientId`, and `clientSecret`
from the runtime `OAuthCredential`. Keep these values in the host credential store.

## Host responsibilities

- Store, encrypt, refresh, revoke, and audit credentials.
- Own OAuth routes, callbacks, state, token persistence, and required-scope consent.
- Provide the `ConnectorHttpClient` implementation and Effect layers required by enabled connectors.
- Preserve connector request headers and body content types while applying host networking policy.
- Map integrations to users, workspaces, agents, or projects outside this package.
- Authorize action execution before invoking connectors.

## Boundaries

- No DB, framework, UI, app auth, or product lifecycle code.
- No Promise facade; use Effect directly.
- Integrations contain credential refs only, never raw secrets.
