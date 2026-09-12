# @yolk-sdk/connectors

Effect-native connector primitives and reusable provider actions for hosts that bring their own auth, storage, and policy.

## Install

```bash
pnpm add @yolk-sdk/connectors@canary @yolk-sdk/agent@canary effect@4.0.0-beta.80
```

Canary APIs are unstable. Keep all `@yolk-sdk/*` packages on the same version.
Use the SDK's matching Effect version (`4.0.0-beta.80`) in host code.
Published package metadata requires Node.js 22+.

## Subpaths

| Subpath                                | Purpose                                                                                                   |
| -------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| `@yolk-sdk/connectors`                 | Core connector/action/integration/credential primitives plus binary HTTP ports and file-transfer types    |
| `@yolk-sdk/connectors/agent`           | Adapter from connector actions to `@yolk-sdk/agent/tools` modules                                         |
| `@yolk-sdk/connectors/afloat`          | Afloat remote MCP auth action, API-key slot, endpoint, and protocol version                               |
| `@yolk-sdk/connectors/dropbox`         | Dropbox metadata, search, file-management actions, OAuth slots, and host-only download plus create/update |
| `@yolk-sdk/connectors/email`           | Portable IMAP reads/drafts/message state, POP3 reads, and SMTP submission through a host email port       |
| `@yolk-sdk/connectors/figma`           | Figma remote MCP auth action and OAuth constants                                                          |
| `@yolk-sdk/connectors/fortnox`         | Read-only company, customer, invoice, supplier, and supplier-invoice file listing with OAuth              |
| `@yolk-sdk/connectors/google`          | Gmail, Calendar, and Drive actions plus Google OAuth slot constants                                       |
| `@yolk-sdk/connectors/linkedin-search` | Exa people search and Enrich Layer profile/email actions                                                  |
| `@yolk-sdk/connectors/microsoft`       | Microsoft Outlook/OneDrive actions through Graph and shared OAuth slot constants                          |
| `@yolk-sdk/connectors/notion`          | Notion search/page/block/database/data-source/comment/user actions and API token slot                     |
| `@yolk-sdk/connectors/r2-storage`      | Cloudflare R2 upload URL action plus host-only `R2ObjectClient` get/create/update                         |
| `@yolk-sdk/connectors/telegram`        | Telegram bot send/validate actions                                                                        |
| `@yolk-sdk/connectors/todoist`         | Todoist project/task/label/comment actions and API token slot constants                                   |

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
- **ConnectorBinaryHttpClient** / **ConnectorBinaryWriteHttpClient**: optional host-provided GET/write byte ports used by host-only file helpers.
- **R2ObjectClient**: host-provided conditional object port for R2 get/create/update.
- **ConnectorFileTransferBudget**: host-owned streamed byte/metadata/error limits for those helpers.
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

The common action set is `email.list_messages`, `email.get_message`, `email.get_attachment`,
`email.create_draft`, `email.send_message`, `email.set_read`, `email.trash`, and `email.untrash`.
Draft creation requires IMAP and uses the incoming
credential. An optional
`folder` selects the target mailbox; when omitted, the host adapter discovers a mailbox advertised
with `\Drafts` by the IMAP SPECIAL-USE extension and may fall back to `Drafts`. Drafts may omit
recipients.
The result reports `{ saved: true, folder, draftId? }` because IMAP servers without UIDPLUS may not
return an `APPENDUID`. `draftId`, when present, is an opaque adapter identifier; UIDPLUS adapters
must encode both UIDVALIDITY and UID rather than exposing a bare UID. The host adapter generates MIME
and performs `APPEND` with the `\Draft` flag.

Message list/get outputs expose normalized addresses, text/HTML bodies, and attachment metadata,
never raw MIME. When `EmailAttachmentMetadata.id` is present, pass it with the parent message ID to
`email.get_attachment`. The host returns decoded file bytes—not MIME transfer-encoded text—as
base64 in `contentBase64`; decoded `size` is a non-negative integer. Existing `EmailClient`
implementations may omit the optional `getAttachment` method; invoking the action then fails with a
typed validation error. Successful host output is schema-validated at the connector boundary before
it is returned. Hosts that implement it own MIME parsing, base64 encoding, size policy,
storage, and content scanning.
IMAP adapters should fetch parts without marking messages read when supported. POP3 has no standard
partial-part fetch, so adapters may retrieve the whole stable UIDL-addressed message before
extracting the part. POP3 rejects `folder` for attachment retrieval just as it does for list/get.
List `id` values are opaque adapter identifiers that callers pass unchanged to `email.get_message`;
POP3 adapters must use UIDL or another stable mapping, never transient message sequence numbers. When IMAP `folder` is omitted, adapters use `INBOX`; POP3 uses its single mailbox.
Adapters return deterministic newest-first pages. Cursors are opaque, scoped to the integration,
protocol, folder, and ordering, and may fail after mailbox changes. Send success returns
`{ accepted: true }`, which means the SMTP server accepted submission, not that the message was
delivered.

### Read state and trash (IMAP only)

| Action           | Input                                        | Host method           | Access        |
| ---------------- | -------------------------------------------- | --------------------- | ------------- |
| `email.set_read` | `{ messageId, isRead, folder? }`             | `EmailClient.setRead` | `write`       |
| `email.trash`    | `{ messageId, folder?, trashFolder? }`       | `EmailClient.trash`   | `destructive` |
| `email.untrash`  | `{ messageId, folder?, destinationFolder? }` | `EmailClient.untrash` | `write`       |

Set `isRead: true` to mark read, or `false` to mark unread. These actions use the incoming
credential and require IMAP; POP3 is rejected before credential resolution or adapter calls.
SMTP is submission-only. The three host methods are optional for compatibility: old adapters
continue working, but calling an unsupported action fails with a typed validation error.
Successful host output is schema-validated; provider failures pass through unchanged.

Hosts implement `setRead` using UID-addressed `STORE` to add/remove only `\Seen`, preserving
other flags. It returns `EmailSetReadOutput` (`{ messageId, isRead }`) after the server confirms
success. Set-read and trash source `folder` default to `INBOX`.

For trash, the adapter uses explicit `trashFolder` or discovers a `\Trash` SPECIAL-USE mailbox;
any fallback is host-configured, not a guessed folder or permanent deletion. For untrash, `folder`
selects the source trash mailbox; when omitted the adapter discovers it using the same policy.
The destination defaults to `INBOX`, or uses explicit `destinationFolder`. This does **not** restore
the original folder automatically. Hosts must reject missing/ambiguous trash discovery and unsafe
moves (including identical source/destination folders).

Use UID `MOVE` where supported, or a safe per-message copy/delete fallback. Never use a blanket
`EXPUNGE` that can delete unrelated messages, or treat setting `\Deleted` alone as a trash move.
If a safe move is unavailable, return a failure. Trash/untrash return `EmailMoveMessageOutput`
(`{ moved: true, folder, messageId? }`). `folder` is the destination; `messageId`, when known, is the
**new** opaque identifier there. UIDPLUS mappings must encode destination UIDVALIDITY and UID.
If no reliable mapping is available, omit `messageId` and re-list the destination; never reuse a
stale source UID. Hosts own safe retry/reconciliation after partially completed moves.

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

const gmailProgram = GoogleConnector.invoke({
  integration,
  action: 'gmail.search',
  input: { query: 'from:alice@example.com', maxResults: 10 }
})

const driveProgram = GoogleConnector.invoke({
  integration,
  action: 'drive.list_files',
  input: { parentId: 'folder-id', pageSize: 100 }
})
```

Provide `CredentialResolver` and `ConnectorHttpClient` layers from host code. Hosts own OAuth refresh before returning `OAuthCredential`. If using Effect HTTP, adapt `effect/unstable/http` in host code rather than importing a Yolk wrapper. Preserve connector request headers and body content type when adapting HTTP; provider connectors may rely on `content-type: application/json` for request parsing.

Gmail draft compose, update, and reply inputs accept optional `from` values for Gmail send-as aliases. Explicit `from` values are validated through `users.settings.sendAs`; reply drafts can infer a matching alias from recipient headers. Google exports action-scoped OAuth slots such as `GoogleGmailComposeOAuthCredentialSlot`, `GoogleGmailDraftReplyOAuthCredentialSlot`, `GoogleCalendarEventsOAuthCredentialSlot`, `GoogleDriveMetadataReadonlyOAuthCredentialSlot`, and `GoogleDriveFileOAuthCredentialSlot`; hosts should request the selected slot's `requiredScopes`. `GoogleOAuthCredentialSlot` keeps the generic `google.oauth` binding id for existing integrations, while `GoogleCombinedOAuthCredentialSlot` contains all Google connector scopes for broad-consent hosts.

`gmail.get_thread` requires `threadId` and `format: 'full' | 'metadata' | 'minimal'`. It returns `GmailThreadOutput` with normalized messages, selected headers, decoded message text when the provider includes it, and attachment metadata. Plain text is preferred over HTML; text attachments never become message bodies. Raw MIME and attachment content are omitted. Use `gmail.list_attachments` with one `messageId` for metadata-only discovery without fetching a whole thread; its `attachments` field is an Effect `Chunk`, and metadata includes inline/content-ID details when Gmail supplies them. When an attachment has `attachmentId`, fetch it with `gmail.get_attachment`; the typed output preserves Gmail's `size` and base64url `data` fields and adds standard-base64 `contentBase64` plus the input IDs. Gmail inline attachments may omit `attachmentId` and remain discoverable but cannot be retrieved through that action. Use `full` when decoded bodies are required.

Gmail discovery omits invalid optional attachment sizes; present sizes are nonnegative integers.
Provider size metadata is not a substitute for validating actual bytes. The host `ConnectorHttpClient`
adapter must cap streamed bytes before returning its string body. Keep ordinary/error limits separate
from successful attachment retrieval limits, allowing bounded base64 expansion and JSON overhead only
for trusted attachment routes. Hosts also validate encoded length and actual decoded per-file/aggregate
size, and own canonical encoding checks, MIME policy, storage, scanning, and extraction.

Calendar create/update boundaries use exactly one non-empty field: `{ date, timeZone? }` for an
all-day boundary or `{ dateTime, timeZone? }` for a date-time boundary. `start` and `end` reject
`null`, empty values, missing boundary fields, and objects that provide both `date` and `dateTime`.

Google Drive actions list, search, and get metadata; create folders; move items to trash; and permanently delete items. The action ids are `drive.list_files`, `drive.search_files`, `drive.get_file`, `drive.create_folder`, `drive.trash_file`, and `drive.delete_file`. Metadata reads request `drive.metadata.readonly`. Mutations request the least-privilege `drive.file` scope, which only covers files the app created or that a user explicitly opened/shared with the app. Hosts that need mutations across arbitrary existing files own broader restricted-scope consent, verification, and policy. All slots still bind through `google.oauth`.

`drive.list_files` and `drive.search_files` return `GoogleDriveListFilesOutput` with a `Chunk` of files and an opaque `nextPageToken`; pass the token back through `pageToken`. Repeated file metadata such as parents and owners also decodes to `Chunk`. Trashed items are excluded unless `includeTrashed` is true. Optional `driveId` targets one shared drive using `corpora=drive`; requests include current shared-drive support parameters. Pass a returned link-shared file `resourceKey` with get/trash/delete, or `parentResourceKey` with parent-scoped list/search/create, so the connector sends `X-Goog-Drive-Resource-Keys`; `parentResourceKey` requires `parentId`. `drive.trash_file` is reversible until Google removes the item, while `drive.delete_file` permanently deletes it without moving it to trash. Hosts should authorize both as destructive and may inspect returned `capabilities` first.

Binary Drive download/export uses the host-only helpers below; uploads remain outside this SDK surface. Hosts own file-content transfer, OAuth code exchange, refresh, storage, consent UX, Google Picker integration, and restricted-scope compliance.

## Fortnox connector

Wiring fragment (host layers and Effect execution omitted):

```ts
import { makeCredentialBinding, makeIntegration } from '@yolk-sdk/connectors'
import { FortnoxConnector, FortnoxOAuthCredentialSlot } from '@yolk-sdk/connectors/fortnox'

const integration = makeIntegration({
  connectorId: 'fortnox',
  credentialBindings: [
    makeCredentialBinding({
      slotId: FortnoxOAuthCredentialSlot.id,
      credentialRef: 'host-fortnox-credential'
    })
  ]
})

const program = FortnoxConnector.invoke({
  integration,
  action: 'fortnox.list_invoices',
  input: { filter: 'unpaid', limit: 25 }
})
```

Provide `CredentialResolver` and `ConnectorHttpClient`. The resolver returns a current
`OAuthCredential` with `provider: 'fortnox'`. No config keys are required. Hosts own OAuth code
exchange, state validation, serialized refresh-token rotation/persistence, revocation, consent,
license checks, throttling, and authorization. Exported `fortnoxOAuthAuthorizeUrl` and
`fortnoxOAuthTokenUrl` point to Fortnox's `apps.fortnox.se/oauth-v1/auth` and `/token` endpoints.
Use `access_type=offline` for refresh; token exchange uses HTTP Basic client authentication and a
form-urlencoded body. The connector never stores or refreshes tokens.

**Fortnox has no read-only OAuth scopes.** Action-scoped `FortnoxCompanyInformationOAuthCredentialSlot`,
`FortnoxCustomerOAuthCredentialSlot`, `FortnoxInvoiceOAuthCredentialSlot`,
`FortnoxSupplierOAuthCredentialSlot`, and `FortnoxSupplierInvoiceOAuthCredentialSlot` request
`companyinformation`, `customer`, `invoice`, `supplier`, and `supplierinvoice`, respectively.
All share `fortnox.oauth`; `FortnoxCombinedOAuthCredentialSlot` requests all five. These consent hints
do not restrict the underlying token to reads. This connector exposes only GET actions with `read`
metadata: `fortnox.get_company_information`, `fortnox.list_customers`, `fortnox.get_customer`,
`fortnox.list_invoices`, `fortnox.get_invoice`, `fortnox.list_suppliers`, `fortnox.get_supplier`,
`fortnox.list_supplier_invoices`, `fortnox.get_supplier_invoice`, and `fortnox.list_supplier_invoice_files` (described below).

List inputs support `page` (at least 1), `limit` (1–500; provider default 100), `lastModified`, and
one `search: { field, value }` pair with resource-specific fields. Customers accept active/inactive
`filter`; invoice lists accept status `filter` and `fromDate`/`toDate`. Each list returns one page:
`{ customers | invoices | suppliers | supplierInvoices, pagination }`. Collections are runtime
Effect Chunks. `pagination` contains `currentPage`, `totalPages`, `totalResources`, and optional
`nextPage`; repeat the same selection and limit with `page: nextPage` until it is absent.

Get inputs use string `customerNumber`, `documentNumber`, `supplierNumber`, or numeric-string
`givenNumber`. The latter is Fortnox's **GivenNumber**, not the supplier's InvoiceNumber. Get outputs
unwrap the resource. Resource fields retain Fortnox spelling and selected contact, status, reference,
amount, and row data; they are bounded read models, not lossless accounting exports. Unknown fields
and supplier bank details are omitted. Optional fields can be absent from list responses; use get
for available `InvoiceRows` / `SupplierInvoiceRows` Chunks. Customer-invoice `Total` / `Balance` remain
numbers, supplier-invoice equivalents remain strings. No monetary arithmetic or rounding occurs.

Non-2xx responses are value-level provider failures, with status-specific unauthorized, forbidden,
not-found, and rate-limit codes. Provider error messages and codes are retained without raw error
bodies. Valid delta-seconds `Retry-After` becomes `retryAfterMs`; there are no automatic retries.
Validation, credential, malformed success, and transport failures remain typed Effect errors.
The HTTP adapter must preserve Bearer authorization and JSON accept headers; hosts own redirect
safety, response-size limits, and sensitive-data handling. No financial mutations, app UI, or database integration are included. Host-only preview/archive downloads are described below.

See the [official API reference](https://apps.fortnox.se/apidocs),
[scopes](https://www.fortnox.se/developer/guides-and-good-to-know/scopes),
[OAuth lifecycle](https://www.fortnox.se/developer/authorization/), and
[pagination/search](https://www.fortnox.se/developer/guides-and-good-to-know/parameters/).

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

Provide host-owned `CredentialResolver` and `ConnectorHttpClient` layers. Dropbox action-scoped slots share the `dropbox.oauth` binding id: metadata reads request `files.metadata.read`, create/move/copy/delete actions request `files.content.write`, and the host-only download helper below requests `files.content.read` through `DropboxContentReadOAuthCredentialSlot`. `DropboxCombinedOAuthCredentialSlot` now hints all three. The host owns OAuth code exchange, refresh, storage, consent, and App Folder versus Full Dropbox configuration.

Use `path: ''` or omit `path` to list the Dropbox API root. Continue folder listings with `dropbox.list_folder_continue` while `hasMore` is true, and continue searches with `dropbox.search_continue`. Outputs normalize Dropbox `.tag` metadata into `type: 'file' | 'folder' | 'deleted'` and camelCase fields.

Upload and download **actions** are intentionally not included: Dropbox content routes are binary, while the portable connector HTTP port carries string bodies. Original-byte download and create/update are available only through separate host helpers below.

### Host integration: download Dropbox file bytes

`downloadDropboxFile` from `@yolk-sdk/connectors/dropbox` downloads **bytes only**, mirroring
`downloadOneDriveItem`. It is not a connector action and is never automatically serialized by
`makeConnectorToolModule`. A host must supply an **app-owned materialization/read tool** to
store/scan/extract the bytes and expose bounded, provenance-bearing reader output. A skill can help
select paths or IDs; it cannot itself download or read a file. Search highlights and
`get_metadata` output are not file contents.

```ts
import { downloadDropboxFile } from '@yolk-sdk/connectors/dropbox'

// Host code: provide existing CredentialResolver and a compliant ConnectorBinaryHttpClient layer.
// The path comes from discovery. This example assumes host-owned integration and selectedFile values.
const download = downloadDropboxFile(
  integration,
  { path: selectedFile.id },
  { maxBytes: 20 * 1024 * 1024, maxErrorBodyBytes: 16 * 1024 }
)
```

The third argument is trusted **host configuration**, separate from tool parameters. Both
nonnegative safe-integer budgets are required; `maxBytes: 0` permits valid empty files. The helper
needs the root `ConnectorBinaryHttpClient` port plus `CredentialResolver`; the existing
`ConnectorHttpClient` and default `DropboxConnector` dependencies are unchanged. File bytes are an
untouched `Uint8Array`, not text or base64 model content.

`path` accepts one Dropbox `/path`, bare `id:` file identifier, folder-ID-relative path
(`id:folder-id/child.txt`), `rev:` revision, or `ns:` namespace path; share links, unrooted
relative paths, blank values, and control characters are rejected before any
credential or network use. The value is sent as ASCII-escaped `Dropbox-API-Arg` JSON, so non-ASCII
names are preserved exactly. No `Dropbox-API-Path-Root` or `Dropbox-API-Select-User` header is sent.

The helper issues a single `GET` to `content.dropboxapi.com/2/files/download`. Dropbox serves
bytes directly; every 3xx fails with `unexpected_redirect` and is never followed. Metadata comes
from the `Dropbox-API-Result` header of that same response, so it describes the served revision,
but the helper does not verify `contentHash`. Exactly one result header is required; bare `id:`
and `rev:` requests must match the returned identity. Folder-ID-relative paths return the child's
own ID, not the folder address. Body length must equal metadata `size`; Paper
and other non-downloadable entries fail with `not_downloadable` (use Dropbox export flows instead).

Errors expose only the typed `DropboxDownloadError.code`: `invalid_input`, `credential_failed`,
`transport_failed`, `network_policy_rejected`, `response_too_large`, `unauthorized`, `forbidden`,
`not_found`, `rate_limited`, `upstream_failed`, `invalid_metadata`, `not_a_file`,
`not_downloadable`, `unexpected_redirect`, and `partial_content`. Dropbox 409 bodies are parsed
only to classify `error_summary`; bodies, URLs, headers, and wrapped causes are discarded.

The host adapter contract is identical to the Microsoft helper's (see below): no automatic
redirects, cookies, or ambient auth; connection-time public DNS/IP policy; TLS; timeouts and
cancellation; and actual streamed byte limits with `response_too_large` on overflow and
`bodyComplete: false` only for bounded non-200 bodies. Offline fake-port tests cover protocol flow,
byte identity, bounds, status handling, and redaction, not socket enforcement.

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

`outlook.search_messages` and `outlook.list_messages` accept omitted, `null`, or blank optional
string inputs (`mailbox`, `folderId`, `nextLink`, plus list `filter`/`orderBy`) as absent. `top`
accepts omission or `null` for the provider default; explicit values must be integers from 1 to 1000. Decoding normalizes these placeholders to `undefined`, while preserving non-blank values
unchanged. Search still requires a string `query`, and application access still requires an
explicit non-blank `mailbox`. This applies to direct connector calls and generated agent tools.

Pass Outlook Graph `@odata.nextLink` values back through `nextLink` unchanged. Repeat `mailbox` for
an explicit mailbox continuation and `folderId` for a folder continuation. The connector only
accepts global Graph v1.0 links for the selected mailbox and folder collection. `outlook.get_message`
requests a text body; read and draft-returning actions request immutable IDs.

Use `outlook.list_attachments` with a message ID to return an Effect `Chunk` of metadata for file,
item, reference, and inline attachments. It accepts `top` and returns an opaque `nextLink`; pass that link back unchanged
with the same `messageId` and `mailbox`. Pass a returned file attachment ID to
`outlook.get_attachment`; it requires a Graph file attachment with valid base64 `contentBytes` and
returns those bytes as required `contentBase64`. Item and reference attachments remain available only
as list metadata and are rejected by this action. Both actions use the existing signed-in, shared/delegated, or application `Mail.Read`
permission selection. Base64 content remains in the string/JSON HTTP boundary; hosts own decoding,
size policy, durable storage, and content scanning.

### Outlook read state and trash

- `outlook.set_read` takes `{ messageId, isRead, mailbox? }`: `true` marks read, `false` marks
  unread using Graph `PATCH` on the message.
- `outlook.trash` takes `{ messageId, mailbox? }` and moves the message to `deleteditems` using
  Graph `/move`; it never performs permanent deletion.
- `outlook.untrash` takes `{ messageId, mailbox?, destinationFolderId? }` and moves from Deleted
  Items to `inbox` by default, or the supplied destination folder ID/well-known name. It does not
  recover permanently deleted messages or infer the original folder.

All three return the provider's updated `OutlookMessage` and request immutable IDs. Use the returned
`id` for subsequent calls. They use `Mail.ReadWrite` for the signed-in mailbox/application mode and
`Mail.ReadWrite.Shared` for explicit delegated mailboxes, with the same application mailbox guard
as draft writes. Read-state and restore actions declare `write`; trash declares `destructive`.

Sending returns `{ accepted: true }` for Graph's `202 Accepted`; that confirms submission, not
processing or delivery.

OneDrive actions default to the signed-in user's `/me/drive`; set `driveId` to target
`/drives/{driveId}`. Delegated mode uses least-privilege `Files.Read` or `Files.ReadWrite`. Set
`oneDriveAccessMode` to `delegated_all` when the host has consented `Files.Read.All` or
`Files.ReadWrite.All` for broader delegated access. For application tokens, set it to `application`
and always provide `driveId`; application mode also uses the `Files.*.All` slots. List and search
continuations must repeat the same drive target; list continuations must also repeat `parentItemId`.

The OneDrive action set lists, searches, and gets file/folder metadata, creates folders, and moves
items to the recycle bin. Binary download is available only through the separate host helper below,
not the connector action inventory or string/JSON HTTP boundary. Host-only bounded create/update helpers are available below; resumable upload sessions remain unimplemented. The built-in
Microsoft endpoint targets the global cloud; national-cloud hosts need a cloud-specific connector
until the API base is configurable.

See Microsoft's [Outlook mail API overview](https://learn.microsoft.com/en-us/graph/outlook-mail-concept-overview), [shared/delegated folder guide](https://learn.microsoft.com/en-us/graph/outlook-share-messages-folders), [OneDrive DriveItem overview](https://learn.microsoft.com/en-us/graph/onedrive-concept-overview), and [DriveItem addressing guide](https://learn.microsoft.com/en-us/graph/onedrive-addressing-driveitems).

### Host integration: download OneDrive/SharePoint file bytes

`downloadOneDriveItem` from `@yolk-sdk/connectors/microsoft` downloads **bytes only**. It is not a
connector action and is never automatically serialized by `makeConnectorToolModule`. A host must
supply an **app-owned materialization/read tool** to store/scan/extract the bytes and expose bounded,
provenance-bearing reader output. A skill can help select drive/item IDs; it cannot itself download
or read a file. Search matches/snippets and `get_item` metadata are not full-file contents.

```ts
import { downloadOneDriveItem } from '@yolk-sdk/connectors/microsoft'

// Host code: provide existing CredentialResolver and a compliant ConnectorBinaryHttpClient layer.
// IDs come from discovery. This example assumes host-owned integration and selectedItem values.
const download = downloadOneDriveItem(
  integration,
  { itemId: selectedItem.id, driveId: selectedItem.parentReference?.driveId },
  { maxBytes: 20 * 1024 * 1024, maxMetadataBytes: 1024 * 1024, maxErrorBodyBytes: 16 * 1024 }
)
```

The third argument is trusted **host configuration**, separate from tool parameters. All three
nonnegative safe-integer budgets are required; `maxBytes: 0` permits valid empty files. The root
exports the additive `ConnectorBinaryHttpClient` port and its request/response/error types; the
existing `ConnectorHttpClient` and default `MicrosoftConnector` dependencies are unchanged. The
helper uses the binary port for bounded metadata JSON too; only metadata goes through UTF-8 decoding.
Office/PDF/content bytes are untouched `Uint8Array`, not text or base64 model content.

The helper reuses the existing `microsoft.oauth` binding and read-slot selection (`Files.Read`, or
`Files.Read.All` for `delegated_all`/`application`). Application access requires an explicit drive.
Scopes are permission hints to the existing resolver, not local proof of consent or access; hosts
still enforce authorization and token permissions. No new OAuth flow, consent, discovery, workbook
API, PDF conversion, native provider document support, or extractor is included.

Only stable `itemId` and optional `driveId` are accepted. Opaque IDs are encoded once (never decoded
as paths); empty/control/space-containing and dot-only IDs are rejected to avoid URL normalization.
Metadata `remoteItem` targets require both IDs, with a loop guard and at most four target transitions.
Folders/non-files and unresolved remote references fail explicitly. SharePoint files work with a
known document-library drive ID; this does not discover SharePoint sites or grant access to them.

Metadata redirects are rejected. The authenticated Graph `/content` request may follow at most
five absolute HTTPS redirects. Every redirected request has **empty headers**, even back to Graph.
There is no bearer transfer to `webUrl`, `web_fetch`, or another tool. Userinfo, fragments, unusual
ports, malformed/relative URLs, IP literals and obvious local names are rejected syntactically.
Preauthenticated URLs and all response headers/bodies are omitted from helper success/error fields.
Errors expose only the typed `OneDriveDownloadError.code` (including distinct `unauthorized`,
`forbidden`, `not_found`, `rate_limited`, `response_too_large`, and `partial_content`); wrapped
credential/transport/provider detail is discarded. Hosts must also avoid logging secrets at the
transport boundary. Programmer defects are not converted into safe typed failures.

**A compliant host adapter is required; the SDK does not implement network I/O.** For _every_ request:

- Disable automatic redirects, cookie jars and ambient authentication. Honor only explicit headers.
  Reject duplicate/ambiguous redirect headers instead of silently selecting a destination.
- Enforce public-network policy at connection time: resolve/validate all DNS addresses, reject
  loopback/private/link-local/reserved destinations, and pin/verify the address actually connected
  to (including redirects, proxies and DNS rebinding). Verify TLS. A hostname syntax check is not
  SSRF protection; allowed-looking names can resolve to private addresses.
- Apply timeouts, Effect interruption/cancellation, connection cleanup, response-header limits,
  and actual streamed byte limits **before buffering**, including any decompression. Do not trust
  `Content-Length` or metadata size. These limits are per response, not aggregate transfer quotas.
  Hosts may impose stricter aggregate/time budgets across the bounded request sequence.
- For status 200, cap `maxBytes` and fail with `ConnectorBinaryHttpError` code `response_too_large`
  on overflow. Return only complete bytes with `bodyComplete: true`. For **every non-200** response,
  including redirects/206/errors, use the separate `maxErrorBodyBytes` cap; bounded/truncated bodies
  may use `bodyComplete: false`. Always cancel/close the remainder. The helper checks returned byte
  length too, rejects incomplete/range-bearing 200 and all 206 responses, and never consumes an
  error body as a file.

The result includes `bytes`, actual `byteLength`, the original requested IDs, and allowlisted target
`source` fields: available filename/MIME, drive/item identity, HTTPS public-looking browser `webUrl`,
provider size, eTag/cTag, and creation/modification timestamps. Missing values remain missing.
Metadata size is a hint, not measured length. Metadata was observed **before** downloading; these
fields do **not** establish a consistent source snapshot or prove the bytes match a version tag.
The helper does not verify hashes, detect file type, parse documents, or prove extraction completeness.
Treat filenames/MIME/links as untrusted metadata; use safe host artifact names and validate formats.

Offline fake-port tests cover protocol flow, byte identity, bounds, status handling and redaction.
They do **not** test socket DNS enforcement, streaming cancellation or timeouts. Those adapter tests,
app materialization/read tools, extraction/provenance coverage and any live tenant validation remain
host work. Do not route the raw result into generic model tool JSON.

Notion and Todoist actions decode provider wire pagination and expose SDK outputs with camelCase fields such as `nextCursor`. Inputs accept documented camelCase fields and common provider-native snake_case aliases where useful, such as Notion `data_source_id` / `rich_text` and Todoist `project_id` / `task_id` / `filter_lang`.

LinkedIn email lookup may return `{ status: 'queued', email: null }` when Enrich Layer accepts the lookup asynchronously.

## Host-only file capabilities

New byte helpers are separate from connector actions and generic agent serialization. They use
root `ConnectorFileTransferBudget` (`maxBytes`, `maxMetadataBytes`, `maxErrorBodyBytes`) and fail
with code-only `ConnectorFileTransferError`. Existing Dropbox/OneDrive download APIs and all
base64 attachment actions remain unchanged. Full API/policy reference:
[Transfer connector files](../../apps/docs/content/docs/connectors/files.mdx).

| Subpath      | Retrieval helpers                                                             | Create/update helpers                      |
| ------------ | ----------------------------------------------------------------------------- | ------------------------------------------ |
| `dropbox`    | `downloadDropboxFile`                                                         | `createDropboxFile`, `updateDropboxFile`   |
| `microsoft`  | `downloadOneDriveItem`, `downloadOutlookAttachment`                           | `createOneDriveFile`, `updateOneDriveFile` |
| `r2-storage` | `getR2Object`                                                                 | `createR2Object`, `updateR2Object`         |
| `google`     | `downloadGoogleDriveFile`, `exportGoogleDriveFile`, `downloadGmailAttachment` | Not added                                  |
| `fortnox`    | `downloadFortnoxInvoicePreview`, `downloadFortnoxArchiveFile`                 | Not added                                  |
| `notion`     | `downloadNotionFile`                                                          | Not added                                  |
| `email`      | `downloadEmailAttachment`                                                     | Not added                                  |
| `telegram`   | `downloadTelegramFile`                                                        | Not added                                  |
| `todoist`    | `downloadTodoistAttachment`                                                   | Not added                                  |

Host integration fragment (approval, integration, transport layers and runtime omitted):

```ts
import { createDropboxFile, updateDropboxFile } from '@yolk-sdk/connectors/dropbox'
import { updateOneDriveFile } from '@yolk-sdk/connectors/microsoft'
import { downloadGoogleDriveFile } from '@yolk-sdk/connectors/google'

const budget = { maxBytes: 20_000_000, maxMetadataBytes: 1_000_000, maxErrorBodyBytes: 16_384 }
const create = createDropboxFile(dropboxIntegration, { path: '/new.pdf', bytes }, budget)
const update = updateDropboxFile(
  dropboxIntegration,
  { fileId: 'id:host-dropbox-file-id', expectedRev, bytes },
  budget
)
const replace = updateOneDriveFile(
  microsoftIntegration,
  { itemId, driveId, bytes, acknowledgeOverwrite: true },
  budget
)
const download = downloadGoogleDriveFile(googleIntegration, { fileId: driveFileId }, budget)
// Provide host services, run the Effect, then store/scan/extract bytes outside model/tool JSON.
```

### Write guarantees and limits

`ConnectorBinaryWriteHttpClient` is a new optional root service, independent of the unchanged
GET-only `ConnectorBinaryHttpClient`. Requests carry `Uint8Array`, `maxUploadBytes`, successful
metadata `maxBytes`, `maxErrorBodyBytes`, `successStatuses: [200, 201]`, `redirect: 'manual'` and
`credentials: 'omit'`. Only complete HTTP 200/201 metadata is accepted; redirects never replay writes.

- Dropbox uses `files.content.write`. Create is strict `add`; update requires stable `id:` and
  a concrete revision with `mode: update`. Both enforce `strict_conflict: true`, `autorename: false`;
  stale or deleted updates cannot become creates. Single-upload cap: **150,000,000 bytes**.
- OneDrive create takes `{ parentItemId, name, driveId?, bytes }` and sends conflict behavior `fail`.
  Update takes `{ itemId, driveId?, bytes, acknowledgeOverwrite: true }` and replaces unconditionally.
  **Acknowledgement is not CAS: concurrent edits can be overwritten.** No simple-upload `If-Match`
  guarantee is invented. Require informed host overwrite approval or decline when CAS is required.
  Write permission/application-drive guards match metadata writes. Cap: **250,000,000 bytes**.
- R2's separate `R2ObjectClient` host port supports binding or signed transport, not an AWS dependency.
  Get takes `{ bucket, key, expectedEtag? }`; create takes `{ bucket, key, bytes }`; update requires
  `expectedEtag`. Hosts atomically implement `condition: { kind: 'absent' }` as `If-None-Match: *`,
  or `{ kind: 'etag', etag }` as concrete `If-Match`; never HEAD-then-PUT or weaken conditions.
  Preserve HTTP ETag quoting; translate explicitly for bindings. Missing GET fails `not_found`,
  conditional GET without body/conditional PUT returning null fails `conflict`, not empty success.
  Host owns credentials, authorized integration/bucket/key selection, signing and bounded I/O.
  ETags cannot distinguish all identical-content rewrites. Cap: **100,000,000 bytes**.
  `R2Presigner`/`r2_storage.upload_url` stay unchanged and do not inherit these conditions.

Single-request bounded uploads only: larger files fail `upload_session_required` before transport;
smaller host budgets fail `response_too_large`. No sessions, resume or multipart implementation,
including no claim of conditional R2 multipart completion. No automatic write retry. A timeout,
cancellation or malformed success response may follow a committed write; hosts reconcile provider
state rather than dropping conditions or silently changing modes.

### Retrieval contracts

- Drive blob input: `{ fileId, resourceKey? }`; export additionally needs `mimeType`. Metadata checks
  caller-specific `capabilities.canDownload`, not role flags in isolation. Shared drives and resource
  keys are supported; no abuse acknowledgement, shortcut chasing or Vids long-running download.
  Default consent is `drive.file`; trusted budget `contentAccess: 'readonly'` selects the opt-in
  `GoogleDriveReadonlyOAuthCredentialSlot` (`drive.readonly`, restricted broad consent).
  Metadata-only consent is insufficient. Compatible native exports cap at **10,000,000 bytes**:
  Docs PDF/DOCX/ODT/RTF/text/HTML/ZIP/EPUB/Markdown; Sheets XLSX/ODS/PDF/CSV/TSV/ZIP;
  Slides PPTX/ODP/PDF/text; Drawings PDF/JPEG/PNG/SVG; Apps Script JSON. CSV/TSV is first-sheet only.
- Fortnox preview `{ documentNumber }` uses `/preview`, not `/print`, and does not mark Sent true.
  It is a generated PDF, not an immutable original. Archive `{ fileId }` uses `/3/archive/{id}`.
  New `fortnox.list_supplier_invoice_files` takes `{ givenNumber, page?, limit? }`, filters internal
  GivenNumber, and returns `{ files, pagination }`. `FortnoxConnectFileOAuthCredentialSlot` requests
  `connectfile`; `FortnoxArchiveOAuthCredentialSlot` requests `archive`; preview uses `invoice`.
  These scopes grant provider **read and write** and are not added to the existing combined slot.
  Provider archive/list OpenAPI modeling is imperfect; validate sanitized responses before production.
- Notion accepts hosted/external provider file objects from page/property/block reads. Fourth argument
  `NotionFileDownloadPolicy` requires `allowHostedUrl`; external files additionally require
  `allowExternalUrl`. Never forward Notion credentials. Refresh expired grants by rereading the owning
  object; `file_upload.id` is not a download URL. No arbitrary authenticated URL-fetch API is added.
- Gmail `{ messageId, attachmentId }` decodes canonical base64url internally, validates decoded size
  and budgets (including JSON expansion). Inline parts without attachment IDs are not modeled.
  Outlook adds optional `mailbox`, checks the file discriminator and uses raw `/$value`; item/reference
  attachments fail. Existing shared/application-mailbox and immutable-ID guards remain. Graph's
  metadata size is not treated as exact raw-byte length.
- IMAP/POP3 use `{ messageId, attachmentId, folder? }` through optional `EmailClient.getAttachmentBytes`.
  Hosts return raw decoded MIME bytes, matching IDs/byteLength and optional filename/contentType.
  Preserve IMAP flags, bound/release MIME streams; POP3 rejects folders and may fetch the whole message.
- Telegram `{ fileId }` uses hosted `getFile` and validated `api.telegram.org/file/botTOKEN/path`.
  Cap **20,000,000 bytes**; no local Bot API filesystem paths or `getUpdates` calls. Token-bearing
  URLs never leave the host. Do not infer filename/MIME from path. Reissue getFile after grant expiry.
- Todoist `todoist.list_comments` takes exactly one taskId/projectId and cursor/limit, returning
  metadata-only comments (Chunk) and nextCursor. Download `{ commentId }` rereads bounded metadata.
  Only initial `files.todoist.com` receives bearer auth; `todoist.b-cdn.net` and
  `d1ysz50cxb9zwl.cloudfront.net` are unauthenticated. At most five safe HTTPS redirects, no reauth.

### MCP reuse and host enforcement

Afloat's canonical `https://useafloat.com/mcp` metadata discovery confirms invoice/quote PDF and
receipt/logo/tax-return download grants (one hour), plus receipt/logo upload-intent completion
operations. Receipt completion attaches or replaces atomically; inspected upload inputs allow
JPEG/PNG/WebP/GIF/PDF, 1–2,147,483,647 bytes, optional SHA-256. Figma discovery confirms
`download_assets`, `upload_assets` (including SVG, 10 MB/asset), `use_figma` and `create_new_file`.
Use dynamic MCP contracts and structured/multipart results, not duplicated SDK wrappers. Deployed
Figma node-selection parameters can differ from docs. No whole `.fig` download claim. Keep grants
and bytes in bounded host pipelines; approve write-capable tools as writes, not read-only tools.
Evidence is metadata-only discovery and provider documentation, not live writes.

Hosts enforce streamed upload/response/error limits (including decompression), independent header
limits, timeouts, cancellation, TLS, public DNS/socket IP policy, no ambient credentials/cookies,
no automatic redirects/retries, and no URL/header/body logging. New downloads reject redirects
except the bounded Todoist flow; existing OneDrive behavior is unchanged. Syntax/post-buffer checks
are defense in depth, not proof of pre-buffer bounds or network isolation. Keep bytes outside agent
serialization; own authorization/consent, storage, scanning, retention, format readers and safe
telemetry. No app wiring or provider snapshot consistency is supplied. Fake-port tests prove SDK
orchestration only.

## Provider actions

| Subpath                                | Capabilities                                                                                                       |
| -------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| `@yolk-sdk/connectors/afloat`          | `afloat.mcp_auth`                                                                                                  |
| `@yolk-sdk/connectors/dropbox`         | list/continue, search/continue, metadata, create folder, move, copy, delete; host-only download plus create/update |
| `@yolk-sdk/connectors/email`           | list/get messages, attachments, drafts, send, and IMAP read-state/trash/restore                                    |
| `@yolk-sdk/connectors/figma`           | `figma.mcp_auth`                                                                                                   |
| `@yolk-sdk/connectors/fortnox`         | get company information; list/get customers, invoices, suppliers, supplier invoices, and supplier-invoice files    |
| `@yolk-sdk/connectors/google`          | Gmail mail actions; Calendar event actions; Drive metadata, folder-create, trash, and delete actions               |
| `@yolk-sdk/connectors/linkedin-search` | `linkedin_search.search`, `linkedin_search.profile`, `linkedin_search.email`                                       |
| `@yolk-sdk/connectors/microsoft`       | Outlook mail plus OneDrive metadata, search, folder-create, and recycle-bin actions                                |
| `@yolk-sdk/connectors/notion`          | Notion search, page, block, database, data source, user, and comment actions                                       |
| `@yolk-sdk/connectors/r2-storage`      | `r2_storage.upload_url` plus host-only `R2ObjectClient` get/create/update                                          |
| `@yolk-sdk/connectors/telegram`        | `telegram.send_message`, `telegram.validate`                                                                       |
| `@yolk-sdk/connectors/todoist`         | Todoist project, task, label, and comment actions                                                                  |

R2 presigning is host-provided through `R2Presigner`; no AWS SDK dependency is bundled. `r2_storage.upload_url` includes `publicUrl` only when integration config provides `publicUrl`.

## Agent adapter

```ts
import { makeConnectorToolModule } from '@yolk-sdk/connectors/agent'
import { GoogleConnector } from '@yolk-sdk/connectors/google'

const toolModule = makeConnectorToolModule(GoogleConnector, {
  integration,
  layer: HostConnectorLayer
})
```

`HostConnectorLayer` should provide `CredentialResolver`, `ConnectorHttpClient`, and any other connector dependencies.

Connector actions can declare default `read`, `write`, or `destructive` access metadata. The agent
adapter uses that declaration unless the host supplies `access`; host access resolvers always win.
Google Drive folder creation and Microsoft draft/folder-create actions declare `write`. Google Drive
trash/delete, Microsoft message sends, and OneDrive deletion declare `destructive`. Legacy actions without metadata default to `read`, so hosts should continue assigning explicit access
when adapting other write-capable connectors. This currently includes write-capable Gmail, Google
Calendar, Notion, Todoist, Telegram, and R2 actions; hosts should provide an `access` resolver for
those actions rather than relying on the fallback.

Afloat MCP auth reads an `afloat_` API key from the host runtime credential and returns the
canonical MCP endpoint and required `2026-07-28` protocol version. Keep the API key server-side;
never expose the auth action through a model-callable connector module.

Figma MCP auth reads `accessToken` plus optional `refreshToken`, `clientId`, and `clientSecret`
from the runtime `OAuthCredential`. Keep these values in the host credential store.

## Host responsibilities

- Store, encrypt, refresh, revoke, and audit credentials.
- Own OAuth routes, callbacks, state, token persistence, and required-scope consent.
- Provide the `ConnectorHttpClient` implementation and Effect layers required by enabled connectors.
- Provide `ConnectorBinaryHttpClient` / `ConnectorBinaryWriteHttpClient` when using host-only byte APIs; never log URLs/bodies; enforce streamed limits, TLS, and connection-time DNS/IP policy.
- Provide `R2ObjectClient` for conditional R2 get/create/update; provide `EmailClient` (including optional `getAttachmentBytes`) for email.
- Keep byte results out of `makeConnectorToolModule` / generic tool JSON; own materialization, scanning, and format readers.
- Preserve connector request headers and body content types while applying host networking policy.
- Map integrations to users, workspaces, agents, or projects outside this package.
- Authorize action execution before invoking connectors.

## Boundaries

- No DB, framework, UI, app auth, or product lifecycle code.
- No Promise facade; use Effect directly.
- Integrations contain credential refs only, never raw secrets.
