# @yolk-sdk/connectors

Effect-native connector primitives and reusable provider actions for hosts that bring their own auth, storage, and policy.

## Install

```bash
pnpm add @yolk-sdk/connectors@canary @yolk-sdk/agent@canary effect@4.0.0
```

Running the experimental `@yolk-sdk/connectors/*/conformance` cases? Also add `@yolk-sdk/conformance@canary` (usually as a dev dependency); the examples import `@yolk-sdk/conformance/*` subpaths directly.

Canary APIs are unstable. Keep all `@yolk-sdk/*` packages on the same version.
Use the SDK's matching Effect version (`4.0.0`) in host code.
Published package metadata requires Node.js 22+.

## Subpaths

| Subpath                                            | Purpose                                                                                                        |
| -------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| `@yolk-sdk/connectors`                             | Core connector/action/integration/credential primitives plus binary HTTP ports and file-transfer types         |
| `@yolk-sdk/connectors/agent`                       | Adapter from connector actions to `@yolk-sdk/agent/tools` modules                                              |
| `@yolk-sdk/connectors/afloat`                      | Afloat remote MCP auth action, API-key slot, endpoint, and protocol version                                    |
| `@yolk-sdk/connectors/afloat/conformance`          | Experimental Afloat target, seeds, and derived fixtures for the `@yolk-sdk/mcp/conformance` cases              |
| `@yolk-sdk/connectors/conformance`                 | Experimental, conformance/testing only: Effect `HttpClient` bridges, a static resolver, and a cleanup reporter |
| `@yolk-sdk/connectors/dropbox`                     | Dropbox metadata, search, file-management actions, OAuth slots, and host-only download plus create/update      |
| `@yolk-sdk/connectors/dropbox/conformance`         | Experimental Dropbox conformance cases, seed config, and synthetic replay fixtures                             |
| `@yolk-sdk/connectors/email`                       | Portable IMAP reads/drafts/message state/labels, POP3 reads, and SMTP submission through a host email port     |
| `@yolk-sdk/connectors/email/conformance`           | Experimental email port conformance cases, `PortFixture` replay, seeds, and a plain-JSON `EmailClient` bridge  |
| `@yolk-sdk/connectors/figma`                       | Figma remote MCP auth action and OAuth constants                                                               |
| `@yolk-sdk/connectors/fortnox`                     | Company, customer, invoice, supplier, and supplier-invoice actions with OAuth; customer/invoice create/update  |
| `@yolk-sdk/connectors/fortnox/conformance`         | Experimental Fortnox conformance cases, seed config, and synthetic replay fixtures                             |
| `@yolk-sdk/connectors/github`                      | Repo-scoped GitHub issue/PR/repository actions plus host-only App tokens and attachment upload                 |
| `@yolk-sdk/connectors/github/conformance`          | Experimental GitHub conformance cases, seed config, and synthetic replay fixtures                              |
| `@yolk-sdk/connectors/google`                      | Gmail, Calendar, and Drive actions plus Google OAuth slot constants                                            |
| `@yolk-sdk/connectors/google/conformance`          | Experimental Gmail, Calendar, and Drive conformance cases, seed config, and synthetic replay fixtures          |
| `@yolk-sdk/connectors/linkedin-search`             | Exa people search and Enrich Layer profile/email actions                                                       |
| `@yolk-sdk/connectors/linkedin-search/conformance` | Experimental LinkedIn search (Exa, Enrich Layer) conformance cases, seed config, and synthetic replay fixtures |
| `@yolk-sdk/connectors/microsoft`                   | Outlook/OneDrive Graph actions, shared OAuth slots, host-only file download/upload and draft attachments       |
| `@yolk-sdk/connectors/microsoft/conformance`       | Experimental Microsoft Graph conformance cases, seed config, and synthetic replay fixtures                     |
| `@yolk-sdk/connectors/notion`                      | Notion search/page/block/database/data-source/comment/user actions and API token slot                          |
| `@yolk-sdk/connectors/notion/conformance`          | Experimental Notion conformance cases, seed config, and synthetic replay fixtures                              |
| `@yolk-sdk/connectors/r2-storage`                  | Cloudflare R2 upload URL action plus host-only `R2ObjectClient` get/create/update                              |
| `@yolk-sdk/connectors/r2-storage/conformance`      | Experimental R2 port conformance cases, seed config, synthetic port fixtures, and a plain-JSON bridge          |
| `@yolk-sdk/connectors/telegram`                    | Telegram bot send/validate actions                                                                             |
| `@yolk-sdk/connectors/telegram/conformance`        | Experimental Telegram conformance cases, seed config, and synthetic replay fixtures                            |
| `@yolk-sdk/connectors/todoist`                     | Todoist project/task/label/comment actions and API token slot constants                                        |
| `@yolk-sdk/connectors/todoist/conformance`         | Experimental Todoist conformance cases, seed config, and synthetic replay fixtures                             |

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

`makeConnectorToolModule` uses the connector `description` as the module description (override
with `description`) and returns each action result as the JSON encoding of its `outputSchema`
(`Chunk`s become arrays, dates ISO strings) in both `structuredContent` and the text. Fields the
output schema does not declare are not returned; a value that does not encode fails the call with
an `execution` `ToolError`, and provider failures carry the JSON-encoded `ProviderFailure` as
`structuredContent`. Agent tools decode arguments like `makeTool`: `null` optionals are absent and
unknown keys are model-visible validation errors (`execute`/`invoke` and `executeTyped` are
unchanged).

## Portable metadata

`ConnectorIntegration.metadata` and `CredentialBinding.metadata` use the exported
`PortableMetadata` schema. Omission stays absent. Decode/make admit a snapshot of plain JSON-object
data: finite primitives, dense ordinary arrays, and plain/null-prototype objects. Objects are copied
onto null prototypes, own `__proto__`/`constructor` keys survive, and DAG aliases share a copied node.
Snapshots are not frozen and do not retain input identity. Cycles, nonfinite/undefined/function
values, exotic prototypes (including Date/Map/classes), hidden/symbol keys, and accessors fail;
accessors are not invoked. Proxy reflection traps are not covered by a side-effect guarantee.

Migrate annotations to explicit JSON data before constructing integrations/bindings; serialize Dates
to strings and Maps to the intended data shape yourself. Integration `config`, credential secrets,
error `underlying`, and host database contracts are unchanged.

## HTTP port

The root export includes connector HTTP infrastructure, not a connector. It defines the typed HTTP request/response model, the `ConnectorHttpClient` Effect service, and JSON response decoding helpers.

Provider connectors build `ConnectorHttpRequest` values; hosts execute them by providing a `ConnectorHttpClient` layer. This keeps connector packages portable and avoids bundling `fetch`, Node HTTP clients, or app-specific networking policy.

Host adapters must preserve connector headers and body content type. Several provider actions send JSON and rely on `content-type: application/json` reaching the upstream API unchanged. When a request sets `redirect: 'manual'` or `credentials: 'omit'`, adapters must not follow redirects and must not add cookie jars or ambient credentials. These request policies are security boundaries for capability URLs such as OneDrive copy monitors; ignoring them can leak credentials or bypass connector URL validation.

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

`defineAction` also returns an additive typed entrypoint, `executeTyped`, alongside the dynamic
`execute` used by `invoke` and the agent adapter. It preserves `InputSchema.Type` and the output
type for direct host callers. It validates **decoded** input with `Schema.toType(inputSchema)`,
without replaying wire transformations. For example, a `NumberFromString` field accepts a number
through `executeTyped` and a string through dynamic `execute`. Implementations still own validation
of external output data; the generic executor does not automatically decode `outputSchema`.

Fragment using the action and integration above:

```ts
const typed = listTasks.executeTyped({ integration, input: {} })
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

The common action set includes list/get/attachment/draft/send, the existing single-message IMAP
mutations, batch variants (`email.batch_set_read`, `email.batch_set_flag`, `email.batch_move`,
`email.batch_trash`, `email.batch_untrash`, `email.batch_modify_labels`), and the separate destructive
`email.delete_permanently` action.
Draft creation requires IMAP and uses the incoming
credential. An optional
`folder` selects the target mailbox; when omitted, the host adapter discovers a mailbox advertised
with `\Drafts` by the IMAP SPECIAL-USE extension and may fall back to `Drafts`. Drafts may omit
recipients.
The result reports `{ saved: true, folder, draftId? }` because IMAP servers without UIDPLUS may not
return an `APPENDUID`. `draftId`, when present, is an opaque adapter identifier; UIDPLUS adapters
must encode both UIDVALIDITY and UID rather than exposing a bare UID. The host adapter generates MIME
and performs `APPEND` with the `\Draft` flag.

Message list/get outputs expose normalized addresses, text/HTML bodies, attachment metadata, and
optional `isRead` / `isFlagged` booleans; omission means unavailable or unknown and remains backward
compatible. `email.list_messages` accepts optional `isRead` / `isFlagged` filters. Filtered IMAP
requests use optional `EmailClient.listMessagesFiltered` and never silently fall back to legacy
`listMessages`; POP3 filters fail before credential resolution. Successful list output is
schema-validated. Outputs never contain raw MIME. `email.get_message` additionally requires
`headers` name/value pairs (including
`List-Unsubscribe` when the mail carries it); hosts fetch them via IMAP `BODY.PEEK[HEADER]` or
POP3 `TOP` without marking the message read. Successful host output is schema-validated, so a
missing `headers` array fails. List summaries carry no headers. The package root exports the pure
`parseUnsubscribeMethods` helper for `List-Unsubscribe` discovery; see the [unsubscribe recipe](../../apps/docs/content/docs/integrations/connectors.mdx#unsubscribe-from-mailing-lists-and-report-spam). When `EmailAttachmentMetadata.id` is present, pass it with the parent message ID to
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
`{ accepted: true, submissionId?, sentCopy }`, which means the SMTP server accepted submission,
not that the message was delivered. `email.send_message` accepts optional `saveToSentItems`
(default: save when possible) and `sentFolder`. When saving is requested and the incoming
account uses IMAP, the connector resolves the IMAP connection plus the separate incoming
credential before SMTP invocation and passes them as `sentCopy` with the SMTP request, so the
host can render once, submit the same bytes, and append the Sent copy without resubmission.
The host owns all APPEND mechanics and reports `sentCopy.status` as `saved | failed | skipped |
unsupported` with the storage `folder` when known. `failed` after acceptance never means the
message was not sent: do not resend. `skipped` means saving was disabled; `unsupported` means
saving was requested but unavailable (POP3, missing IMAP incoming, or a legacy host that omits
`sentCopy`, which the action synthesizes rather than implying `saved`).

### Read state, trash, and move (IMAP only)

| Action                | Input                                               | Host method                | Access        |
| --------------------- | --------------------------------------------------- | -------------------------- | ------------- |
| `email.set_read`      | `{ messageId, isRead, folder? }`                    | `EmailClient.setRead`      | `write`       |
| `email.set_flag`      | `{ messageId, isFlagged, folder? }`                 | `EmailClient.setFlag`      | `write`       |
| `email.trash`         | `{ messageId, folder?, trashFolder? }`              | `EmailClient.trash`        | `destructive` |
| `email.untrash`       | `{ messageId, folder?, destinationFolder? }`        | `EmailClient.untrash`      | `write`       |
| `email.modify_labels` | `{ messageId, folder?, addLabels?, removeLabels? }` | `EmailClient.modifyLabels` | `write`       |
| `email.move`          | `{ messageId, folder?, destinationFolder }`         | `EmailClient.move`         | `write`       |

Batch inputs replace only the identifier field with `messageIds`: 1-100 unique, nonempty IDs, one
source folder, and the same operation-specific payload/defaults as the single-message action. They
use optional `EmailClient.batchSetRead`, `batchSetFlag`, `batchMove`, `batchTrash`, `batchUntrash`,
and `batchModifyLabels` methods. `email.delete_permanently` takes `{ messageIds, folder? }`, defaults
`folder` to `INBOX`, uses optional `EmailClient.deletePermanently`, and is destructive. Missing
optional methods fail clearly; old adapters remain valid.

Every successful batch/delete output contains one result for every requested ID, preserves
`messageIds` input order, uses status `succeeded | failed | unknown | not_attempted`, includes an
optional sanitized code, and has exact summary counts. Every succeeded result from
`email.batch_move`, `email.batch_trash`, or
`email.batch_untrash` must include destination `folder`; only `movedMessageId` is optional, and
only when the adapter knows the destination UIDVALIDITY/UID mapping. The connector validates the
schema, requested-ID coverage, and counts. Hosts must never return raw provider errors.

Permanent deletion means removing exactly the identified UID-scoped messages from the selected
folder. Hosts must never use blanket `EXPUNGE`; approval/authorization remain downstream host
policy. Success does not promise erasure from backups, provider retention, journaling, or compliance
systems.

Set `isRead: true` to mark read, or `false` to mark unread. Set `isFlagged: true` to star for
follow-up via `\Flagged`, or `false` to unstar. These actions use the incoming
credential and require IMAP; POP3 is rejected before credential resolution or adapter calls.
SMTP is submission-only. These host methods are optional for compatibility: old adapters
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

`email.move` takes `{ messageId, folder?, destinationFolder }` with a required destination and
returns `EmailMoveMessageOutput` with the destination folder and the new message ID when the host
can map it. Like the other mutations it requires IMAP, defaults `folder` to `INBOX`, rejects an
identical source/destination before dispatch, and fails with a typed validation error when the
optional `EmailClient.move` method is missing. Hosts move with UID `MOVE` (RFC 6851) when the
server advertises it, otherwise `COPY` plus flagging `\Deleted` and expunging only the moved UID;
they preserve flags and keywords, never blanket-expunge, and own partial-move reconciliation.
Destination UIDs differ from source UIDs, so callers must use the returned ID for subsequent
operations or re-list the destination. Hosts that resolve agent-declared access should treat moves
into `\Trash`-advertised mailboxes as destructive, matching `email.trash`.

### Labels (IMAP keywords only)

`email.modify_labels` takes `{ messageId, folder?, addLabels?, removeLabels? }` (at least one
of the two label lists) and returns `{ messageId, labels }` with the resulting keyword set as an Effect `Chunk`.
Hosts return `Chunk.fromIterable(keywords)`; message list/get discovery uses optional arrays.
Like the other mutations it uses the incoming credential, requires IMAP, defaults `folder` to
`INBOX`, and fails with a typed validation error when the optional `EmailClient.modifyLabels`
method is missing. POP3 and SMTP cannot persist labels: POP3 is rejected before credential
resolution, and SMTP is submission-only.

Labels are IMAP keywords only, never system flags. The connector schema-validates every
`addLabels`/`removeLabels` entry as an RFC 3501 `atom` (ASCII printable except `(`, `)`, `{`,
space, CTLs, `%`, `*`, `"`, `\`, `]`), so `\Seen` and other backslash flags, whitespace,
control characters, and atom specials fail before dispatch. Message list/get outputs may carry
an optional `labels` array for host discovery.

There is no standalone create/delete label catalog in IMAP: keywords implicitly exist through
message assignment, so hosts assign them directly and remove usage by removing a keyword from
messages. Hosts implement `modifyLabels` with UID-addressed `STORE` (`+FLAGS.SILENT` for
additions, `-FLAGS.SILENT` for removals), preserving all other keywords and system flags rather
than overwriting the whole flags list. Hosts check `PERMANENTFLAGS` first and return a failure
for unsupported keywords; a keyword listed in both inputs is removed.

### Email conformance cases (experimental)

`@yolk-sdk/connectors/email/conformance` exports ten port-level conformance cases for
`@yolk-sdk/conformance/runner` (`emailConformanceCases`), their synthetic `PortFixture`s
(`emailConformanceFixtures`; no `observed`, so `unverified`), and the seeds they replay with
(`emailConformanceFixtureSeeds`). Yolk never speaks IMAP, POP3, or SMTP: each case runs the real
email actions over the host `EmailClient` plus `CredentialResolver` and `EmailConformanceConfig`
(practice-mailbox seeds; a missing seed fails with a `precondition:` mismatch before any port
call). They cover required `get_message` headers without marking a message read, filtered listing
without `listMessages` fallback, `\Drafts` discovery, `set_read`/`set_flag`, trash and untrash to
INBOX, moves returning destination ids (the stale source id must answer the `message_not_found`
failure code, `emailMessageNotFoundCode`), POP3 rejections of every mutation action, Sent-copy statuses (including the legacy
`unsupported`/`skipped` synthesis), and SMTP acceptance that is not delivery. Case table:
[Email conformance guide](../../apps/docs/content/docs/connectors/email.mdx#conformance-cases).

The subpath also ships a small bridge for conformance and tests only: `emailClientLayerFromBackend`
(and `emailClientFromBackend`) turn any plain-JSON backend `{ call(method, request) }` into the
`EmailClient` port. Requests reach the backend as plain JSON without credential fields; a
`response` is decoded with the method's output schema, a `failure` becomes an
`ActionResult.failure` (`expected`) or a `ConnectorError` (`error`), and `notEmulated` fails closed
with a `transport_failed` `ConnectorError`. `makeEmailReplayBackend(fixtures)` replays email
`PortFixture`s (each fixture answers at most once; a call takes the first unused matching fixture; anything else is refused and ledgered), and the
fixture-driven fake in `@yolk-sdk/emulators/email` plugs in the same way (connectors never depend on
emulators). Neither is a production adapter. Write cases create their own `yolk-conformance`
draft and permanently delete it again (or restore the seeded flags), failing with
`EmailConformanceRestoreFailed` instead of hiding a failed restore; the three send cases are
`write-irreversible` and run live only when started by id. Live verification needs a host
`EmailClient` implementation connected to a practice mailbox; no live probe ships in this
repository.

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

Provide `CredentialResolver` and `ConnectorHttpClient` layers from host code. Hosts own OAuth refresh before returning `OAuthCredential`. If using Effect HTTP, adapt `effect/http` in host code rather than importing a Yolk wrapper. Preserve connector request headers and body content type when adapting HTTP; provider connectors may rely on `content-type: application/json` for request parsing.

Gmail draft compose, update, and reply inputs accept optional `from` values for Gmail send-as aliases. Explicit `from` values are validated through `users.settings.sendAs`; reply drafts can infer a matching alias from recipient headers. Google exports action-scoped OAuth slots such as `GoogleGmailComposeOAuthCredentialSlot`, `GoogleGmailDraftReplyOAuthCredentialSlot`, `GoogleCalendarEventsOAuthCredentialSlot`, `GoogleDriveMetadataReadonlyOAuthCredentialSlot`, and `GoogleDriveFileOAuthCredentialSlot`; hosts should request the selected slot's `requiredScopes`. `GoogleOAuthCredentialSlot` keeps the generic `google.oauth` binding id for existing integrations, while `GoogleCombinedOAuthCredentialSlot` contains the existing broad-consent scope set (its `gmail.compose` grant already permits sending).

`gmail.send_message` (`gmailSendMessageAction`, access `destructive`) accepts
`GmailSendMessageInput`: `{ raw, threadId? }`. `raw` is a complete host-generated RFC 5322 MIME
message encoded as canonical padded or unpadded base64url (`GmailRawMessage`); the SDK validates
encoding and forwards the decoded MIME unchanged, but does not parse MIME or validate recipients/send-as aliases.
The action always sends exactly one request, never resumable and never retried. 7-bit MIME uses
the simple multipart media upload
`POST https://gmail.googleapis.com/upload/gmail/v1/users/me/messages/send?uploadType=multipart`
with `Content-Type: multipart/related`: an `application/json; charset=UTF-8` metadata part (`{}`,
or `{ "threadId": ... }` only when provided) and a `message/rfc822` part holding the decoded MIME.
The boundary is chosen so it never occurs in the MIME. MIME containing any byte `>= 0x80` cannot
cross the string HTTP port exactly, so it keeps the JSON `{ raw, threadId? }` request to
`/gmail/v1/users/me/messages/send` (the previous behaviour); prefer 7-bit transfer encodings for
large messages. Host HTTP adapters must preserve the `multipart/related` content type and forward
the string body exactly (CRLF line endings, no re-encoding) and accept outgoing bodies up to about
35 MiB. Before resolving credentials or sending anything, decoded MIME larger than 35 MiB
(`gmailSendMessageMaxBytes`) fails with a `ConnectorError` `validation_failed` carrying
`underlying: { outcome: 'rejected', retryable: false, reason: 'too_large' }`: nothing was sent.
`reason: 'invalid_encoding'` is a defensive guard for undecodable base64url. The
`ConnectorHttpRequest` port has no timeout field; host adapters own request timeouts, and a timeout
after dispatch must surface as a transport failure (unknown outcome).
Hosts own MIME construction, header-injection protection, sender/account binding, recipient and
content review, size limits, and explicit sending authorization. Gmail routes to the MIME
To/Cc/Bcc headers, not a separate SMTP envelope: configure the encoder to retain Bcc for submission.
No MIME or transport library is added to the SDK. Replies need the original RFC Message-ID in `In-Reply-To`, the appropriate
`References` chain, and a matching Subject plus Gmail `threadId`; a Gmail resource ID is not an RFC
Message-ID. Changing the subject can start a new conversation. See Google's
[threading requirements](https://developers.google.com/workspace/gmail/api/guides/threads).

Sending selects `GoogleGmailSendOAuthCredentialSlot` with `googleGmailSendScopes` (`gmail.send`)
and the existing `google.oauth` binding. These are least-privilege consent hints: Google's
[`messages.send`](https://developers.google.com/workspace/gmail/api/reference/rest/v1/users.messages/send)
also accepts `gmail.compose`, `gmail.modify`, or `https://mail.google.com/`. The action inspects the
resolved OAuth credential's scopes through the scope-free binding, then re-resolves through the
selected operation slot: send first, otherwise an existing compose/modify/full-mail grant. The host
still enforces that slot; inspection alone never authorizes sending. Bearer credentials or absent
scope metadata fall back to the send slot. No additional consent or combined-scope change is made. Success returns `GmailSendMessageOutput`
`{ accepted: true, id, threadId? }`, meaning provider submission, **not delivery**. Recognized HTTP rejections
return `gmail_send_message_rejected`; ambiguous HTTP failures return `gmail_send_message_unknown`.
Both omit retry hints and carry `underlying: { outcome: 'rejected' | 'unknown', retryable: false }`.
Transport errors or invalid success acknowledgements are typed `ConnectorError`s with the unknown
metadata. No automatic retry occurs. Hosts must reconcile an unconfirmed send before proposing
another; a deterministic Message-ID does not make sending idempotent. Keep raw sending out of
model tool allowlists when it is intended only for a host-owned reviewed action.

`gmail.get_thread` requires `threadId` and `format: 'full' | 'metadata' | 'minimal'`. It returns `GmailThreadOutput` with normalized messages, selected headers, decoded message text when the provider includes it, and attachment metadata. Plain text is preferred over HTML; text attachments never become message bodies. Raw MIME and attachment content are omitted. Use `gmail.list_attachments` with one `messageId` for metadata-only discovery without fetching a whole thread; its `attachments` field is an Effect `Chunk`, and metadata includes inline/content-ID details when Gmail supplies them. When an attachment has `attachmentId`, fetch it with `gmail.get_attachment`; the typed output preserves Gmail's `size` and base64url `data` fields and adds standard-base64 `contentBase64` plus the input IDs. Gmail inline attachments may omit `attachmentId` and remain discoverable but cannot be retrieved through that action. Use `full` when decoded bodies are required.

Gmail labels use `gmail.list_labels`, `gmail.create_label`, `gmail.get_label`,
`gmail.update_label`, `gmail.delete_label`, and `gmail.modify_labels`, plus `gmail.set_starred`
for starring via the `STARRED` system label. Label reads use the
existing `gmail.readonly` slot; label lifecycle mutations and message label changes reuse the
existing `gmail.modify` slot, so no broader consent is needed. Create and update accept `name`
plus optional `messageListVisibility` (`show` | `hide`) and `labelListVisibility` (`labelShow` |
`labelShowIfUnread` | `labelHide`); update renames through `PATCH` and requires at least one
field. Delete answers `204` with an empty body and returns a typed `{ id, deleted: true }`
result without JSON decoding. Label ids are encoded once and dot-only ids are rejected to avoid
URL normalization. Labels with `type: 'system'` (such as `INBOX`) cannot be renamed or deleted;
the provider rejects those mutations.

Gmail messages report `isRead` (derived as `!labelIds.includes('UNREAD')`) and `isFlagged`
(`labelIds.includes('STARRED')`) wherever labels are present; omitted labels assert neither, and
provider-supplied lookalikes are ignored. `gmail.search` and `gmail.list` accept optional
`isRead`/`isFlagged` booleans composed into one `q` value with the existing query grouped first.
`gmail.set_read` flips `UNREAD` through the `gmail.modify` slot and returns the normalized message
with sanitized failures.

Explicit Gmail batch actions (`gmail.batch_set_read`, `gmail.batch_set_starred`,
`gmail.batch_modify_labels`, `gmail.batch_trash`, `gmail.batch_untrash`, and the destructive
`gmail.delete_permanently`) take 1-100 unique nonempty path-safe message IDs and return shared
`EmailBatchOperationOutput` with complete per-ID outcomes in `messageIds` order, exact counts, and
sanitized codes only. Execution issues individually addressed requests sequentially and never the bulk
endpoints, whose empty success cannot establish per-ID outcomes. Label deltas are deduplicated with removal winning
and capped at 100 entries each; labels are never created. Permanent deletion issues individual
`DELETE` requests (only 204 confirms success; 404 is an honest rejection) through the opt-in
`GoogleGmailFullMailOAuthCredentialSlot` (`https://mail.google.com/`), which is never added to the
combined/default consent. It is immediate deletion, not trash, and claims no backup erasure.

Gmail discovery omits invalid optional attachment sizes; present sizes are nonnegative integers.
Best-effort malformed **optional** sizes (`-1`, `1.5`, `null`, `"12"`, missing) still omit size and
keep siblings, including zero. Null / array-shaped / non-object parts are skipped.
`message/rfc822` stays an attachment (no nested body recursion). Attachment identity and bytes are
unchanged. Public action classes, `GmailUnknownOutput`, and `gmail.get_attachment` (`size` plus
base64url `data`) are unchanged.

`gmail.get_thread` and `gmail.list_attachments` admit internal MIME `payload` as `Schema.Json` after
`Schema.fromJsonString(Schema.Unknown)`. `Schema.Json` requires finite numbers: raw HTTP JSON `1e999` parses to
`Infinity` and rejects the **whole** thread/message payload (`ConnectorError` `validation_failed`,
`Invalid response shape`). That is not a general collapse of malformed optional MIME fields. Do not
demonstrate overflow with `JSON.stringify(Infinity)` — that becomes `null` and would hit the
omit-size path. Provider size metadata is not a substitute for validating actual bytes. The host
`ConnectorHttpClient` adapter must cap streamed bytes before returning its string body. Keep
ordinary/error limits separate from successful attachment retrieval limits, allowing bounded base64
expansion and JSON overhead only for trusted attachment routes. Hosts also validate encoded length
and actual decoded per-file/aggregate size, and own canonical encoding checks, MIME policy, storage,
scanning, and extraction.

Calendar create/update boundaries use exactly one non-empty field: `{ date, timeZone? }` for an
all-day boundary or `{ dateTime, timeZone? }` for a date-time boundary. `start` and `end` reject
`null`, empty values, missing boundary fields, and objects that provide both `date` and `dateTime`.
`calendar.update_event` is a PATCH: omitted fields stay unchanged, but `attendees` replaces the whole
guest list when given.

Calendar create, update, and delete accept optional `sendUpdates` (`GoogleCalendarSendUpdates`),
sent as Google's `sendUpdates` query parameter: `all` notifies every guest, `externalOnly` only
guests who do not use Google Calendar, and `none` nobody (Google warns `none` can stop the event
syncing to guests' other calendars or lose it for some guests). Without it, Google's default sends no invitation, update, or
cancellation email (Google notes some emails might still be sent), so hosts that want guests
notified must pass it. `calendar.delete_event` takes `GoogleCalendarDeleteEventInput`.

Google Drive actions list, search, and get metadata; create folders; move items to trash; and permanently delete items. The action ids are `drive.list_files`, `drive.search_files`, `drive.get_file`, `drive.create_folder`, `drive.trash_file`, and `drive.delete_file`. Metadata reads request `drive.metadata.readonly`. Mutations request the least-privilege `drive.file` scope, which only covers files the app created or that a user explicitly opened/shared with the app. Hosts that need mutations across arbitrary existing files own broader restricted-scope consent, verification, and policy. All slots still bind through `google.oauth`.

`drive.list_files` and `drive.search_files` return `GoogleDriveListFilesOutput` with a `Chunk` of files and an opaque `nextPageToken`; pass the token back through `pageToken`. Repeated file metadata such as parents and owners also decodes to `Chunk`. Trashed items are excluded unless `includeTrashed` is true. Optional `driveId` targets one shared drive using `corpora=drive`; requests include current shared-drive support parameters. Pass a returned link-shared file `resourceKey` with get/trash/delete, or `parentResourceKey` with parent-scoped list/search/create, so the connector sends `X-Goog-Drive-Resource-Keys`; `parentResourceKey` requires `parentId`. `drive.trash_file` is reversible until Google removes the item, while `drive.delete_file` permanently deletes it without moving it to trash. Hosts should authorize both as destructive and may inspect returned `capabilities` first.

Binary Drive download/export uses the host-only helpers below; uploads remain outside this SDK surface. Hosts own file-content transfer, OAuth code exchange, refresh, storage, consent UX, Google Picker integration, and restricted-scope compliance.

## GitHub connector

`GithubConnector` works against exactly one repository taken from integration config. The model
never supplies `owner` or `repo`.

```ts
import { makeCredentialBinding, makeIntegration } from '@yolk-sdk/connectors'
import { GithubConnector, githubTokenSlotId } from '@yolk-sdk/connectors/github'

const integration = makeIntegration({
  connectorId: 'github',
  config: { owner: 'acme', repo: 'widgets' },
  credentialBindings: [makeCredentialBinding({ slotId: githubTokenSlotId, credentialRef: 'gh' })]
})
```

- `github.token` (`GithubTokenSlot`) accepts `BearerTokenCredential`, `ApiKeyCredential`, or
  `OAuthCredential` (installation token, PAT, or OAuth token) and is used by every action.
- Requests send `X-GitHub-Api-Version: 2026-03-10`. Outputs are normalized (never raw payloads),
  long bodies, messages, patches, fragments, and file contents are truncated with a sibling
  boolean flag (`bodyTruncated`, `patchTruncated`, `truncated`, …), and lists take
  `perPage`/`page` and return `hasNextPage` from the `Link` header.
- Provider errors return `ActionResult.failure` with `github_unauthorized`, `github_forbidden`,
  `github_not_found`, `github_rate_limited` (with `retryAfterMs`), `github_validation`,
  `github_conflict`, or `github_request_failed`; `merge_pull_request` adds
  `github_not_mergeable` and `get_file_contents` adds `github_unsupported_content`.

| Family          | Actions (`github.*`) and access                                                                                                                                                                                                                                                                                                                                                      |
| --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Issues          | read: `search_issues`, `list_issues`, `get_issue`, `list_assignees`, `list_issue_timeline`; write: `create_issue`, `update_issue`, `lock_issue`, `unlock_issue`, `add_assignees`, `remove_assignees`                                                                                                                                                                                 |
| Comments/labels | read: `list_issue_comments`, `list_labels`, `list_milestones`; write: `create_issue_comment`, `update_issue_comment`, `add_labels`, `remove_label`, `create_reaction`; destructive: `delete_issue_comment`                                                                                                                                                                           |
| Structure       | read: `list_sub_issues`, `list_issue_dependencies`, `list_issue_types`, `list_issue_fields`; write: `add_sub_issue`, `remove_sub_issue`, `add_blocked_by`, `remove_blocked_by`, `set_issue_field_values`                                                                                                                                                                             |
| Pull requests   | read: `list_pull_requests`, `get_pull_request`, `list_pull_request_files`, `list_pull_request_commits`, `get_pull_request_checks`, `list_pull_request_reviews`, `list_pull_request_review_comments`; write: `create_pull_request`, `update_pull_request`, `request_reviewers`, `create_pull_request_review`, `create_pull_request_review_comment`; destructive: `merge_pull_request` |
| Repository      | read: `compare_commits`, `list_releases`, `get_file_contents`, `search_code`                                                                                                                                                                                                                                                                                                         |

Issue and code search always add `repo:{owner}/{repo}` and reject queries with their own
`repo:`, `org:`, `user:`, or `owner:` qualifiers. Issue types and issue fields are org-level
and only work when `owner` is an organization. Sub-issue and dependency actions take issue
numbers and resolve GitHub's internal issue ids. `set_issue_field_values` adds or updates the
listed fields only. `merge_pull_request` requires `expectedHeadSha`, so a head that moved
after review fails with `github_conflict` instead of merging unreviewed commits.

### Host-only GitHub helpers

These are not actions and never appear in `GithubConnector.actions`:

- `createGithubAppInstallationToken({ appId, installationId, privateKeyPem, repositories?, repositoryIds?, permissions? })`
  signs an RS256 App JWT with WebCrypto (PKCS#8 or GitHub's PKCS#1 download format; literal
  `\n` escapes are normalized) and exchanges it for an installation token, optionally
  down-scoped. Returns `{ token, expiresAt }` (epoch ms). It needs `ConnectorHttpClient`, does
  no caching, and fails with a code-only `GithubAppTokenError`.
- `uploadGithubAttachment(integration, { name, contentType, bytes, repositoryId?, alt? }, budget, options?)`
  uploads a PNG, JPEG, GIF, WebP, SVG, MP4, MOV, or WebM file (10 MB images, 100 MB videos;
  `options` may only lower these) and returns `{ url, markdown }`. It uses GitHub's
  **undocumented, unstable** `uploads.github.com/user-attachments/assets` endpoint through
  `ConnectorBinaryWriteHttpClient`, and requires the optional `github.upload_token` slot to hold a
  user token (OAuth or PAT). GitHub refuses installation tokens there (they surface as `not_found`,
  so the helper rejects `ghs_` tokens up front). A 404 otherwise means no push access. Without
  `repositoryId`, the helper looks it up via `GET /repos/{owner}/{repo}`.

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
do not restrict the underlying token to reads. Read actions use `read` metadata; customer and invoice
create/update actions use `write` metadata: `fortnox.create_customer`, `fortnox.update_customer`,
`fortnox.create_invoice`, and `fortnox.update_invoice`. The connector intentionally exposes no send
or book action, so no Fortnox action is marked `destructive`. The read actions are
`fortnox.get_company_information`, `fortnox.list_customers`, `fortnox.get_customer`,
`fortnox.list_invoices`, `fortnox.get_invoice`, `fortnox.list_suppliers`, `fortnox.get_supplier`,
`fortnox.list_supplier_invoices`, `fortnox.get_supplier_invoice`, and `fortnox.list_supplier_invoice_files` (described below).

Write inputs preserve Fortnox's PascalCase wire names. Creating a customer requires `Name` and lets
Fortnox assign `CustomerNumber`; updating a customer includes `CustomerNumber` for the URL but omits
it from the JSON body. Creating an invoice requires `CustomerNumber` and lets Fortnox assign
`DocumentNumber`; updating one includes `DocumentNumber` for the URL. Invoice `InvoiceRows` inputs
are JSON arrays, while returned row collections are Effect `Chunk` values. Customer write inputs
omit Fortnox's read-only `Country` (set `CountryCode`) and list-only `Phone` (use `Phone1`/`Phone2`),
and the customer create/update actions reject unknown keys instead of stripping them; customer and
supplier responses keep both fields. Those actions' `inputSchema` is a closed wrapper, not the
class: build typed inputs with `FortnoxCreateCustomerInput.make` /
`FortnoxUpdateCustomerInput.make`; decoding those classes directly strips unknown keys. Action
descriptions document Fortnox update semantics (partial customer updates, invoice row replacement,
pre-existing referenced records). See the
[Fortnox guide](../../apps/docs/content/docs/connectors/fortnox.mdx) for the action table and schema
conventions.

List inputs support `page` (at least 1), `limit` (1–500; provider default 100), `lastModified`, and
one `search: { field, value }` pair with resource-specific fields. Customers accept active/inactive
`filter`; invoice lists accept status `filter` and `fromDate`/`toDate`. Each list returns one page:
`{ customers | invoices | suppliers | supplierInvoices, pagination }`. Collections are runtime
Effect Chunks. `pagination` contains `currentPage`, `totalPages`, `totalResources`, and optional
`nextPage`; repeat the same selection and limit with `page: nextPage` until it is absent.

Get inputs use branded `customerNumber` (`FortnoxCustomerNumber`), `documentNumber`
(`FortnoxDocumentNumber`), `supplierNumber` (`FortnoxSupplierNumber`), or numeric-string
`givenNumber` (`FortnoxGivenNumber`). The latter is Fortnox's **GivenNumber**, not the supplier's
plain-string InvoiceNumber; the brands are nominally incompatible and keep their string wire
representation. File discovery (`fortnox.list_supplier_invoice_files`) filters by GivenNumber and
returns it on each file entry. Preview downloads take the canonical `FortnoxDocumentNumber` (URL
encoded, without archive-ID restrictions); archive downloads take the opaque discovery file ID.
Get outputs
unwrap the resource. Resource fields retain Fortnox spelling and selected contact, status, reference,
amount, and row data; they are bounded read models, not lossless accounting exports. Unknown fields
and supplier bank details are omitted. Optional fields can be absent from list responses; use get
for available `InvoiceRows` / `SupplierInvoiceRows` Chunks. Customer-invoice `Total` / `Balance` remain
numbers, supplier-invoice equivalents remain strings. No monetary arithmetic or rounding occurs.

Non-2xx responses are value-level provider failures, with status-specific unauthorized, forbidden,
not-found, and rate-limit codes. Provider error messages and codes are retained without raw error
bodies. Valid delta-seconds `Retry-After` becomes `retryAfterMs`; there are no automatic retries.
Validation, credential, malformed success, and transport failures remain typed Effect errors.
The HTTP adapter must preserve Bearer authorization, JSON accept headers, and JSON content-type on
writes; hosts own redirect safety, response-size limits, and sensitive-data handling. Customer and
invoice create/update are the only financial writes: sending and booking remain outside this connector.
Host-only preview/archive downloads are described below.

See the [official API reference](https://apps.fortnox.se/apidocs),
[scopes](https://www.fortnox.se/developer/guides-and-good-to-know/scopes),
[OAuth lifecycle](https://www.fortnox.se/developer/authorization/), and
[pagination/search](https://www.fortnox.se/developer/guides-and-good-to-know/parameters/).

### Fortnox conformance cases (experimental)

`@yolk-sdk/connectors/fortnox/conformance` exports conformance cases for
`@yolk-sdk/conformance/runner`, each checking one claim about how the real Fortnox API behaves where
it differs from, or goes beyond, its docs. Each case runs the real connector actions and helpers over
`ConnectorHttpClient`, `ConnectorBinaryHttpClient`, and `CredentialResolver`, plus the
`FortnoxConformanceConfig` service, which holds host-supplied seed identities in a Fortnox developer
test company (practice account). Cases never hard-code account data; a missing seed fails the case
with a `precondition:` mismatch before any request. Credentials bind through
`fortnoxConformanceIntegration` (`fortnox.oauth`, credential ref `fortnox.conformance`). The case
table, seeds, and claims live in the
[Fortnox guide](../../apps/docs/content/docs/connectors/fortnox.mdx#conformance-cases).

The row and customer mutation cases read the original state first, always restore it afterwards
(also after a failed assertion or interruption), verify the restore by reading back, and fail with
`FortnoxConformanceRestoreFailed` when the restore fails (check the account and restore it by hand
if it still differs). A failed restore raised while the case is being interrupted is also handed,
with its full message, to `ConformanceCleanupReporter` from `@yolk-sdk/connectors/conformance`
(default: `Effect.logWarning`), since the interruption may replace it. The repository runner
(`pnpm conformance:fortnox`) turns a first Ctrl-C into an interruption and prints these reports on
stderr as `WARN` lines; like the shared runners, it prints every live-run line with the live access
token redacted. The rejection case restores nothing: it only confirms the customer is absent
before its write and names any invoice Fortnox unexpectedly creates for manual cancellation. The
email case aborts unless the invoice's `EmailInformation.EmailAddressTo` equals the `emailRecipient`
seed exactly; the runner never runs it live unless its exact id is allowed. Neither the rejection
case nor the email send reports through `ConformanceCleanupReporter`.

`fortnoxConformanceFixtures` are synthetic placeholders (`evidence: 'unverified'`) that replay with
`fortnoxConformanceFixtureSeeds`. `pnpm conformance:fortnox` in this repository dry-runs by default;
its `--live --owner-approved --account <label>` mode (refused whenever `CI` is non-empty) is for
owners running a practice account by hand, and a first Ctrl-C interrupts the run so a running write
case still restores. `--record` stages verified recordings all or nothing in a new gitignored run
directory, `.conformance-recordings/fortnox/<YYYY-MM-DD>T<HHMMSS>Z-<random>/`, and never writes
committed sources. Promotion is manual: scrub, copy into `src/fortnox/conformance/`, and update the
tests in the same change, because promoted fixtures change fixture ids, `evidence`, and `account`. A
promoted payment-filter recording also needs the tests' fixed clock (`atTestNow`) moved past the
recorded `DueDate`.

`@yolk-sdk/connectors/conformance` supplies the ports for such runs:
`connectorHttpClientFromEffectHttpClientLayer`, `connectorBinaryHttpClientFromEffectHttpClientLayer`,
`connectorBinaryWriteHttpClientFromEffectHttpClientLayer` (POST/PUT bytes plus `uploadSession`
ranges and cancellation to pre-authenticated session URLs, refusing credential headers there), or
all three via `connectorHttpClientsFromEffectHttpClientLayer`, over any Effect `HttpClient` (for
example `ReplayHttpClient.layer` or `FetchHttpClient.layer`), and `staticCredentialResolverLayer`.
**These are for conformance and tests only, not production adapters:** they enforce no streamed
byte limits, redirect, DNS/IP, timeout, or TLS policy (binary `maxBytes`/`maxErrorBodyBytes` are
checked only after buffering), forward `redirect: 'manual'`/`credentials: 'omit'` as
`FetchHttpClient.RequestInit` options, and map transport failures to code-only errors without URLs,
headers, or bodies. The static resolver ignores scopes and never refreshes; hosts own real
credential storage.

```ts
import { Layer } from 'effect'
import { OAuthCredential } from '@yolk-sdk/connectors'
import {
  connectorHttpClientsFromEffectHttpClientLayer,
  staticCredentialResolverLayer
} from '@yolk-sdk/connectors/conformance'
import {
  FortnoxConformanceConfig,
  fortnoxConformanceCases,
  fortnoxConformanceFixtureSeeds,
  fortnoxConformanceFixtures
} from '@yolk-sdk/connectors/fortnox/conformance'
import { ReplayHttpClient } from '@yolk-sdk/conformance/replay'
import { runConformance } from '@yolk-sdk/conformance/runner'

const report = runConformance(fortnoxConformanceCases, {
  target: { kind: 'replay' },
  fixtures: fortnoxConformanceFixtures,
  layer: testCase =>
    Layer.mergeAll(
      connectorHttpClientsFromEffectHttpClientLayer.pipe(
        Layer.provide(
          ReplayHttpClient.layer(
            fortnoxConformanceFixtures.filter(fixture => testCase.fixtures.includes(fixture.id))
          )
        )
      ),
      staticCredentialResolverLayer(
        OAuthCredential.make({ provider: 'fortnox', accessToken: 'replay', expiresAt: 0 })
      ),
      Layer.succeed(FortnoxConformanceConfig, fortnoxConformanceFixtureSeeds)
    )
})
```

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

### Dropbox conformance cases (experimental)

`@yolk-sdk/connectors/dropbox/conformance` exports eight conformance cases for
`@yolk-sdk/conformance/runner` (`dropboxConformanceCases`), synthetic replay fixtures
(`dropboxConformanceFixtures`, `evidence: 'unverified'`), and the seeds they replay with
(`dropboxConformanceFixtureSeeds`). Every case runs the real connector actions, or the host-only
`createDropboxFile` / `updateDropboxFile` helpers, over `ConnectorHttpClient`,
`ConnectorBinaryWriteHttpClient`, and `CredentialResolver` plus `DropboxConformanceConfig`, which
holds host-supplied seed paths in a practice Dropbox account. They cover list and search cursor
paging, case-insensitive path lookups, the HTTP 409 error envelope, folder conflicts, delete then
not-found, single-item copy/move metadata, and the upload rev precondition. Credentials bind through
`dropboxConformanceIntegration` (`dropbox.oauth`, credential ref `dropbox.conformance`). The case
table, seeds, and claims live in the
[Dropbox conformance guide](../../apps/docs/content/docs/connectors/dropbox.mdx#conformance-cases).
The Dropbox emulator (`@yolk-sdk/emulators/dropbox`) passes every case offline.

Every write case works only inside its own `yolk-conformance-<runId>-<case>` folder under the
`workFolderPath` seed. The `runId` seed makes that namespace unique per invocation (the fixtures
replay with `run-synthetic`; the live runner generates a fresh random id every time), so concurrent
runs are supported only through distinct run ids. A case proves its folder path absent before
writing, and registers the created entry together with the create (uninterruptibly). A definitive
create rejection (HTTP 4xx other than 408, such as `path/conflict`) deletes nothing. An ambiguous create (a
transport or decoding failure, no status, HTTP 408, or HTTP 5xx) gets one best-effort delete of the owned path
but always fails with `DropboxConformanceActionFailed` (`createOutcome: 'unknown'`) naming the
exact path to check by hand; so do the conflict case's duplicate creates, after the known original
is cleaned up. Every later write inside the case folder is masked too, so no aborted request lands
after the cleanup. After a successful create, the cleanup deletes the entry by id (a not-found answer
proves it gone; any other failure falls back to the owned path), also after a failed assertion or a
fiber interruption, then checks that `get_metadata` answers not-found; a failed cleanup fails with
`DropboxConformanceRestoreFailed` naming the path, and a create answering a path outside the case
folder is never deleted (`DropboxConformanceCleanupRefused`). Neither the runner nor the bridges set
a request timeout, so a hanging request delays an interruption. The live runner turns the first
SIGINT/SIGTERM into a fiber interruption, so the cleanup is attempted (not confirmed) and no
further case starts: a cleanup problem raised meanwhile prints as a WARN line through
`ConformanceCleanupReporter` and ends the run with that failure (exit 1); only an interrupt-only
exit (130) runs the read-only leftover lookup again. Duplicate signals within a second (one Ctrl-C
reaches every process of the foreground group) are ignored; a later signal or a kill skips the
cleanup. Run live runs as `pnpm conformance:dropbox` or with `tsx` directly: `pnpm exec tsx`
returns to the prompt at once on Ctrl-C (observed), so later lines print after the prompt, `$?` is
pnpm's own code, and the runner must be stopped with `kill -TERM <pid>` (printed by the first-signal
message). Before any write case, the runner warns read-only about `yolk-conformance-run-*` folders
earlier runs left under `workFolderPath` (`findDropboxConformanceLeftovers`; bounded to 50 listing
pages; every valid `runId` starts with `run-`, and a missing work folder holds none); it never
deletes them. `pnpm conformance:dropbox` in this repository dry-runs by default;
`--live --owner-approved --account <label>` (refused whenever `CI` is non-empty; needs
`DROPBOX_ACCESS_TOKEN` and the seeds) is for owners running a practice account by hand,
`--allow-writes reversible` adds the write cases, and `--record` stages verified recordings all or
nothing in `.conformance-recordings/dropbox/<run>/` (gitignored) for manual scrubbing and promotion.

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
Microsoft Graph is the shared API and OAuth resource boundary. The sole exception is the
pre-authenticated Outlook attachment upload-session URLs that Graph issues to `addOutlookAttachment`,
contacted without Authorization.

All action-scoped slots share the `microsoft.oauth` binding id, so one host credential can serve
Outlook and OneDrive when its consent includes the selected actions' `Mail.*` and `Files.*`
permissions. Use `MicrosoftCombinedOAuthCredentialSlot` only when broad consent is appropriate.

Outlook inputs default to the signed-in mailbox (`/me`). Set `mailbox` to a user ID or user principal
name to target an Exchange Online shared/delegated mailbox through `/users/{mailbox}`. Signed-in
mailbox actions request `Mail.Read`, `Mail.ReadWrite`, or `Mail.Send`. An explicit mailbox that
case-insensitively matches `OAuthCredential.accountId` uses those same ordinary slots; other explicit
targets request `Mail.Read.Shared`, `Mail.ReadWrite.Shared`, or `Mail.Send.Shared`. Hosts resolve the
scope-free identity slot first, then enforce the selected operation slot. Missing identity and bearer
credentials do not qualify for the own-mailbox exception. Populate `accountId` with the same Graph
user ID or `userPrincipalName` callers pass as `mailbox`: the comparison ignores case only, not
whitespace, and does not resolve aliases or equate a user ID with a principal name.

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

Outlook messages report `isRead` plus follow-up flag state as `isFlagged` (`flagged` is true;
`notFlagged` and `complete` are false; omitted, null, or unrecognized states assert nothing).
`outlook.list_messages` accepts optional `isRead`/`isFlagged` booleans composed into `$filter`
with any raw filter (grouped when combined); fresh typed filters cannot be combined with `nextLink`.

Explicit Outlook batch actions (`outlook.batch_set_read`, `outlook.batch_set_flag`,
`outlook.batch_move`, `outlook.batch_trash`, `outlook.batch_untrash`,
`outlook.batch_modify_categories`, and the destructive `outlook.delete_permanently`) take 1-100
unique nonempty path-safe message IDs plus optional `mailbox` and return complete per-ID outcomes
in `messageIds` order with exact counts and sanitized codes only. Execution uses Graph JSON batching
(`src/microsoft/mail-batch.ts`) with at most 20 subrequests per sequential envelope, unique correlation IDs, per-subrequest
immutable-ID preferences, outer authorization headers only, and responses matched by correlation
ID. Move-shaped results report the provider-returned message ID and actual `parentFolderId`
(never a fabricated destination); category updates read before PATCHing and leave failed reads
`not_attempted`. Permanent deletion POSTs `permanentDelete` (documented 204); items enter
Recoverable Items/Purges, so retention or holds may still preserve them.

Pass Outlook Graph `@odata.nextLink` values back through `nextLink` unchanged. Repeat `mailbox` for
an explicit mailbox continuation and `folderId` for a folder continuation. The connector only
accepts global Graph v1.0 links for the selected mailbox and folder collection. `outlook.get_message`
requests a text body plus required `internetMessageHeaders` (name/value pairs: `List-Unsubscribe`,
`References`, and authentication results when the message carries them); list, draft, and mutation
actions return the base `OutlookMessage` without headers. Read and draft-returning actions request immutable IDs.

`outlook.update_draft` (`outlookUpdateDraftAction`, `OutlookUpdateDraftInput`, access `write`)
edits an existing draft with `{ messageId, mailbox?, to?, cc?, bcc?, subject?, body?, contentType? }`.
At least one editable field is required; `contentType` alone is invalid. Omission preserves a field;
empty recipient arrays clear it. `body` is the **complete replacement**, text by default or HTML
when explicitly selected, with no prepended quote or rewritten whitespace. Retain any desired
quoted history in that replacement. Graph enforces that these fields are draft-only. The SDK
issues one PATCH, preserves immutable-ID headers and existing own/shared/application mailbox
permission selection, and validates the returned identified draft as `OutlookMessage`. It never
sends. Failures after dispatch retain `{ draftId, retryable: false,
recovery: 'read_edit_existing_draft' }` in `underlying`, omit retry hints and provider bodies, and
require reconciliation of the same draft, not recreation. This operation is not compare-and-swap;
update followed by `outlook.send_draft` is not an atomic transaction, and other mailbox clients can
change a draft between those requests. Hosts own serialization and review of the full final content.

`outlook.reply` (`outlookReplyAction`, `OutlookReplyInput`, access `destructive`) sends the
complete reviewed reply for an existing message in one Graph `POST .../messages/{id}/reply` with
`{ message: { subject, body, toRecipients, ccRecipients, bccRecipients } }`. The original
`messageId` plus required `to`/`cc`/`bcc` arrays (explicit, including empty), `subject`, and full
`body` travel in that single request: at least one To address is required, no recipient field is
left implicit, and no `comment`, `from`, quoted history, subject prefix, recipient inference, or
draft round-trip is involved. `body` is the caller's exact string, text by default
or HTML when explicitly selected, with whitespace preserved. The `mailbox` selects the authorized
`/me` or `/users/{id}` send path with existing own/shared/application send permissions and
immutable-ID headers; Graph chooses the sender identity and documents saving replies in Sent
Items. Only HTTP 202 Accepted returns `OutlookSendOutput` `{ accepted: true }`. Other HTTP statuses
return `outlook_reply_rejected` or `outlook_reply_unknown` failures with
`underlying: { outcome: 'rejected' | 'unknown', retryable: false }`. After-dispatch transport
failures are typed `ConnectorError`s with the unknown metadata. Neither includes retry hints or
provider bodies. Acceptance is submission, not delivery, with no message ID or exactly-once
claim. Prefer this over `update_draft` followed by `send_draft` for reviewed replies, since no
intermediate mutable draft can change between requests.

`outlook.create_reply_draft` creates a bodyless reply draft, then prepends the supplied text or HTML
to Graph's generated quoted history and saves it. This is a multi-step write: once a draft ID is
known, read/save failures retain that ID with reconciliation guidance. Read and edit the existing
draft rather than retrying creation; a failed response can follow a successful save. Post-create
HTTP failures use `outlook_create_reply_draft_partial`, retain the HTTP `status`, and omit
`retryAfterMs` even for a 429. The same partial-failure code covers a read-back without the requested
body format; `status` then records the last Graph response and can be 2xx. Branch on the failure
code/recovery metadata, not HTTP status alone. Both these failures and post-create typed `ConnectorError`s expose
`underlying: { draftId, retryable: false, recovery: 'read_edit_existing_draft' }` once the ID is
known. This metadata describes recovery of the whole action, not whether an individual Graph
request can later be retried. Hosts must inspect it before any retry policy and use the original
`mailbox` when reading/editing the named draft. If the creation response is lost or contains no
usable ID, reconcile mailbox state rather than blindly retrying. A text reply converts the quote to
text; it does not preserve the quote's original HTML formatting.

Use `outlook.list_attachments` with a message ID to return an Effect `Chunk` of metadata for file,
item, reference, and inline attachments. It accepts `top` and returns an opaque `nextLink`; pass that link back unchanged
with the same `messageId` and `mailbox`. Listing selects base attachment properties only, so do not
expect `contentId` there; fetch the individual file attachment for `cid:` mapping. Pass a returned file attachment ID to
`outlook.get_attachment`; it requires a Graph file attachment with valid base64 `contentBytes` and
returns those bytes as required `contentBase64`. Item and reference attachments remain available only
as list metadata and are rejected by this action. Both actions use the existing signed-in, shared/delegated, or application `Mail.Read`
permission selection. Base64 content remains in the string/JSON HTTP boundary; hosts own decoding,
size policy, durable storage, and content scanning.

To add a file to an existing draft (for example one from `outlook.create_draft` or
`outlook.create_reply_draft`) before `outlook.send_draft`, host code calls the host-only
`addOutlookAttachment` helper described under [host-only file transfers](#write-guarantees-and-limits).
It is deliberately not a connector action, so attachment bytes never enter model tool JSON.

### Outlook read state, flags, and trash

- `outlook.set_read` takes `{ messageId, isRead, mailbox? }`: `true` marks read, `false` marks
  unread using Graph `PATCH` on the message.
- `outlook.set_flag` takes `{ messageId, isFlagged, mailbox? }`: `true` flags for follow-up,
  `false` clears the flag, using Graph `PATCH` `flagStatus`.
- `outlook.trash` takes `{ messageId, mailbox? }` and moves the message to `deleteditems` using
  Graph `/move`; it never performs permanent deletion.
- `outlook.untrash` takes `{ messageId, mailbox?, destinationFolderId? }` and moves from Deleted
  Items to `inbox` by default, or the supplied destination folder ID/well-known name. It does not
  recover permanently deleted messages or infer the original folder.
- `outlook.move_message` takes `{ messageId, mailbox?, destinationFolderId }` with a required
  destination folder ID/well-known name and moves the message there using Graph `/move`. The source
  folder is not an input, so the connector performs no same-folder check; Graph decides the outcome.
  A `deleteditems` destination performs the same Graph call as `outlook.trash`: hosts that gate on
  declared access should override `move_message` to `destructive` for well-known destructive
  destinations.

All five return the provider's updated `OutlookMessage` and request immutable IDs. Use the returned
`id` for subsequent calls. They use `Mail.ReadWrite` for the signed-in mailbox/application mode and
`Mail.ReadWrite.Shared` for other explicit delegated mailboxes, with the same own-mailbox identity
exception and application mailbox guard
as draft writes. Read-state, restore, and move actions declare `write`; trash declares `destructive`.

### Outlook categories

- `outlook.list_categories` takes `{ mailbox?, top?, nextLink? }` and returns typed
  `{ categories, nextLink? }` from Graph `/outlook/masterCategories`; `categories` is an Effect
  `Chunk`. It requires
  `MailboxSettings.Read` consent.
- `outlook.create_category` takes `{ mailbox?, displayName, color? }` where `color` is
  `none` or `preset0` through `preset24`. It requires `MailboxSettings.ReadWrite` consent.
  `displayName` is immutable after creation: there is no category rename action because Graph
  does not support renaming categories, only color updates.
- `outlook.delete_category` takes `{ mailbox?, categoryId }` and answers Graph `204` with
  an empty body, returning typed `{ id, deleted: true }` without JSON decoding. It requires
  `MailboxSettings.ReadWrite` consent. Existing message assignments keep their category
  `displayName` strings.
- `outlook.get_category` takes `{ mailbox?, categoryId }` and returns the typed category. It
  requires `MailboxSettings.Read` consent.
- `outlook.update_category` takes `{ mailbox?, categoryId, color }` and PATCHes only the color
  (`displayName` stays immutable). It requires `MailboxSettings.ReadWrite` consent.
- `outlook.set_categories` takes `{ messageId, mailbox?, categories }` and replaces the
  message's category `displayName` strings with Graph `PATCH`; an empty array clears all
  categories. It reuses the `Mail.ReadWrite` / `Mail.ReadWrite.Shared` message permission
  selection, own-mailbox identity exception, immutable IDs, and application mailbox guard.
- `outlook.modify_categories` takes `{ messageId, mailbox?, addCategories?, removeCategories? }`
  (at least one of the two) and merges through GET-then-PATCH: removals win over additions and
  the resulting names are deduped by exact case-sensitive match. Both requests use `Mail.ReadWrite` (or its Shared variant),
  without requiring separate read consent. The GET requires a valid `categories` array and never defaults
  omitted or malformed data to `[]`, so a failed or invalid read sends no PATCH. This
  read/modify/write is non-atomic: hosts must serialize competing updates. There are no
  retries or implied compare-and-swap.

Message category assignment uses `displayName` strings, not master category IDs, and never
creates or deletes master categories automatically. Master-category lifecycle consent is
opt-in through the `MicrosoftOutlookCategoryReadOAuthCredentialSlot` and
`MicrosoftOutlookCategoryWriteOAuthCredentialSlot` action slots; the existing combined slot is
not widened. There are no `.Shared` mailbox-settings scopes, so delegated access to another
mailbox's settings keeps the ordinary category slot and remains subject to Graph
authorization. Application mode still requires an explicit `mailbox` for category operations.
List continuations must repeat the same mailbox; only global Graph v1.0 links for the selected
master-category collection are accepted. Create declares `write`; delete declares `destructive`;
set/modify declare `write`.

Sending returns `{ accepted: true }` for Graph's `202 Accepted`; that confirms submission, not
processing or delivery.

OneDrive actions default to the signed-in user's `/me/drive`; set `driveId` to target
`/drives/{driveId}`. Delegated mode uses least-privilege `Files.Read` or `Files.ReadWrite`. Set
`oneDriveAccessMode` to `delegated_all` when the host has consented `Files.Read.All` or
`Files.ReadWrite.All` for broader delegated access. For application tokens, set it to `application`
and always provide `driveId`; application mode also uses the `Files.*.All` slots. List and search
continuations must repeat the same drive target; list continuations must also repeat `parentItemId`.

The OneDrive action set lists, searches, and gets file/folder metadata; creates folders; moves items
within one drive; queues asynchronous copies; polls copy status; and moves items to the recycle bin.
Binary download is available only through the separate host helper below, not the connector action
inventory or string/JSON HTTP boundary. Host-only bounded create/update helpers are available below;
OneDrive resumable upload sessions remain unimplemented. The built-in Microsoft endpoint targets the
global cloud; national-cloud hosts need a cloud-specific connector until the API base is configurable.

`onedrive.move_item` sends a synchronous `PATCH` with a destination parent ID and optional rename.
Graph does not support moving an item between drives through this request, so the action exposes no
destination-drive field and never invents copy-then-delete atomicity. An optional `ifMatch` forwards
the caller's eTag/cTag precondition; a mismatch returns Graph's `412` failure. Moving to drive root
requires the root folder's actual item ID, not the literal `root` alias.

`onedrive.copy_item` requires destination drive and parent IDs and returns
`{ status: 'accepted', monitorUrl }` only after Graph responds `202 Accepted` with one trusted monitor
location. **Accepted does not mean completed:** name conflicts and other errors can appear later.
Omitting `conflictBehavior` uses Graph's documented `fail` default; `rename` is available for
work/school drives, while OneDrive Consumer does not support the conflict query parameter. Destructive
`replace` is intentionally not exposed because it deletes the preexisting file and its history, which
would make one input mode exceed the action's `write` side-effect classification. Copies create a new
item identity, do not retain source metadata or permissions, inherit destination permissions, and copy
only the latest major version because version-history copying is not exposed. Graph limits one copy to
30,000 drive items. Cross-drive copy is supported by the request shape; app-only cross-geo copy remains
unsupported by Graph.

`onedrive.get_copy_status` performs one poll and returns the provider operation status, optional
percentage, completed item ID, or sanitized failure code/message. It rechecks the OneDrive write scope
but sends **no authorization header** to the short-lived capability URL. Only canonical raw forms of
documented global-cloud `api.onedrive.com` or tenant `*.sharepoint.com` monitor URL shapes are
accepted; parser-normalized variants and coalesced locations fail closed. Requests set
`redirect: 'manual'` and `credentials: 'omit'`; redirects are never followed. A manual `303` is mapped
to `completed` without decoding its body or exposing its `Location`, while rejected monitor responses
discard provider bodies. Hosts must treat monitor URLs as secrets, avoid logs/persistence, enforce
public DNS/IP policy and TLS, and bound response bodies, timeouts, and total polling. Approval, polling
cadence, retries, expiry handling, and reconciliation remain host policy.

See Microsoft's [Outlook mail API overview](https://learn.microsoft.com/en-us/graph/outlook-mail-concept-overview), [shared/delegated folder guide](https://learn.microsoft.com/en-us/graph/outlook-share-messages-folders), [OneDrive DriveItem overview](https://learn.microsoft.com/en-us/graph/onedrive-concept-overview), [DriveItem move reference](https://learn.microsoft.com/en-us/graph/api/driveitem-move?view=graph-rest-1.0), [DriveItem copy reference](https://learn.microsoft.com/en-us/graph/api/driveitem-copy?view=graph-rest-1.0), [long-running actions guide](https://learn.microsoft.com/en-us/graph/long-running-actions-overview), and [DriveItem addressing guide](https://learn.microsoft.com/en-us/graph/onedrive-addressing-driveitems).

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

### Microsoft conformance cases (experimental)

`@yolk-sdk/connectors/microsoft/conformance` exports eleven conformance cases for
`@yolk-sdk/conformance/runner` (`microsoftConformanceCases`), synthetic replay fixtures
(`microsoftConformanceFixtures`, `evidence: 'unverified'`), and the seeds they replay with
(`microsoftConformanceFixtureSeeds`). Outlook and OneDrive cases run the real connector actions over
`ConnectorHttpClient` and `CredentialResolver` plus `MicrosoftConformanceConfig`, which holds
host-supplied seed identities in a Microsoft 365 practice tenant. **The connector has no calendar
actions yet:** the four calendar cases send raw Graph v1.0 requests through the same ports, token
resolution, and Graph failure mapping, and pin expected Graph behaviour (unverified until a live
run) for hosts and the Microsoft Graph emulator (`@yolk-sdk/emulators/microsoft`). Credentials bind through `microsoftConformanceIntegration` (`microsoft.oauth`, credential
ref `microsoft.conformance`). The case table, seeds, and claims live in the
[Microsoft conformance guide](../../apps/docs/content/docs/connectors/microsoft.mdx#conformance-cases).

Every write case creates its own event, recipient-free draft, or folder and registers its id for
cleanup before any claim runs (the create and the registration are not interruptible, and the
runner sets no request timeout, so a hanging create delays an interruption). When the id
is recoverable, the case removes the item again automatically (also after a failed assertion or
interruption), verifies the removal where Graph allows it, and fails with
`MicrosoftConformanceRestoreFailed` when the removal fails. A create that succeeds without an id also
fails with `MicrosoftConformanceRestoreFailed`, and an ambiguous create (a transport or decoding
failure, no status, HTTP 408, or HTTP 5xx) fails with `MicrosoftConformanceActionFailed`
(`createOutcome: 'unknown'`, code and status kept): both messages advise manual recovery of the
`yolk-conformance` item. Each of these (a failed removal, an id-less create, an ambiguous create)
raised while the case is being interrupted is also handed, with its full message, to
`ConformanceCleanupReporter` (default: `Effect.logWarning`), since the interruption may replace it;
an ambiguous create's report starts with the case id. No case sends mail or invitations.
`pnpm conformance:microsoft` in this repository dry-runs by default;
`--live --owner-approved --account <label>` (refused whenever `CI` is non-empty; with
`MICROSOFT_ACCESS_TOKEN` and the seeds) is for owners running a practice tenant by hand (a first
Ctrl-C interrupts the run so a running write case still removes its item, and the reports above
print on stderr as `WARN` lines; every live-run line is printed with the live access token
redacted, as in the shared runners), `--allow-writes reversible` adds the write cases, and `--record`
stages verified recordings all or nothing in `.conformance-recordings/microsoft/<run>/` (gitignored)
for manual scrubbing and promotion.

### Notion conformance cases (experimental)

`@yolk-sdk/connectors/notion/conformance` exports eight conformance cases for
`@yolk-sdk/conformance/runner` (`notionConformanceCases`), synthetic replay fixtures
(`notionConformanceFixtures`, `evidence: 'unverified'`), and the seeds they replay with
(`notionConformanceFixtureSeeds`). Every case runs the real connector actions over
`ConnectorHttpClient` and `CredentialResolver` plus `NotionConformanceConfig`, which holds
host-supplied seed ids in a practice Notion workspace. They cover search, block children, and page
property cursor paging (including the connector's second percent-encoding of property ids), the
pinned `Notion-Version`, the `{ object: "error", status, code,
message }` envelope, title rich text, the 2025-09-03 database/data source split, and archiving a
page to the trash. **Every action sends `Notion-Version: 2025-09-03`**; the pinned-version case
observes that header at the `ConnectorHttpClient` port and sends no request of its own. Credentials bind through
`notionConformanceIntegration` (`notion.api_token`, credential ref `notion.conformance`). The case
table, seeds, and claims live in the
[Notion conformance guide](../../apps/docs/content/docs/connectors/notion.mdx#conformance-cases).
The Notion emulator (`@yolk-sdk/emulators/notion`) passes every case offline.

The write case creates its own page under the `parentPageId` seed and registers its id before any
claim runs (the create and registration are not interruptible, and no request timeout is set, so a
hanging create delays an interruption). Any response showing the page trashed (`archived` or
`in_trash`), or a not-found read after a successful archive, counts as trashed; otherwise the cleanup
trashes the page and checks that `notion.get_page` reports `archived: true`. A failed cleanup fails
with `NotionConformanceRestoreFailed`, and an ambiguous create fails with
`NotionConformanceActionFailed` (`createOutcome: 'unknown'`) with manual-recovery advice. The live
runner turns the first SIGINT/SIGTERM into a fiber interruption, so the cleanup is attempted (not
confirmed; a cleanup problem raised meanwhile prints as a WARN line and ends the run with exit 1,
and only an interrupt-only exit (130) runs the leftover search again; duplicate signals within a
second are ignored, a later one or a kill skips the cleanup; use `pnpm conformance:notion` or `tsx`
directly, not `pnpm exec tsx`, which returns to the prompt at once) and, before the write case,
warns about untrashed `yolk-conformance page` pages found by a read-only, bounded (10 search pages),
best-effort search (`findNotionConformanceLeftovers`); it never trashes them.
`pnpm conformance:notion` in this repository dry-runs by default; `--live --owner-approved --account
<label>` (refused whenever `CI` is non-empty; needs `NOTION_API_TOKEN` and the seeds) is for owners
running a practice workspace by hand, `--allow-writes reversible` adds the write case, and
`--record` stages verified recordings all or nothing in `.conformance-recordings/notion/<run>/`
(gitignored) for manual scrubbing and promotion.

### Todoist conformance cases (experimental)

`@yolk-sdk/connectors/todoist/conformance` exports seven conformance cases for
`@yolk-sdk/conformance/runner` (`todoistConformanceCases`), synthetic replay fixtures
(`todoistConformanceFixtures`, `evidence: 'unverified'`), and the seeds they replay with
(`todoistConformanceFixtureSeeds`). Every case runs the real connector actions over
`ConnectorHttpClient` and `CredentialResolver` plus `TodoistConformanceConfig`, which holds
host-supplied seed ids in a practice Todoist account. They cover filtered task list cursor paging,
the HTTP 404 error body, task labels as label names, the create/get/update/close task lifecycle
(a closed task leaves the active list), `due_date` / `due_datetime` as the connector sends them
answering a due dated 2030-01-15 (its representation unchecked), project `parent_id`, and delete then
not-found. Credentials bind through `todoistConformanceIntegration` (`todoist.api_token`, credential
ref `todoist.conformance`). The case table, seeds, and claims live in the
[Todoist conformance guide](../../apps/docs/content/docs/connectors/todoist.mdx#conformance-cases).

Every write case creates its own `yolk-conformance-<runId>-<case>` project under the
`workProjectId` seed and works only inside it. The `runId` seed makes that namespace unique per
invocation (the fixtures replay with `run-synthetic`; the live runner generates a fresh random id
every time). The project create, its decoding, and the id registration are not interruptible, and
neither is any later write. A definitive create rejection (HTTP 4xx other than 408) deletes
nothing; an ambiguous create (a transport or decoding failure, no status, HTTP 408, or HTTP 5xx)
fails with
`TodoistConformanceActionFailed` (`createOutcome: 'unknown'`) naming the exact project or task to
check by hand, and nothing is deleted by name. After a successful create, the cleanup deletes the
project by id (also after a failed assertion or an interruption) and checks that
`todoist.get_project` answers not found; a failed cleanup fails with
`TodoistConformanceRestoreFailed` naming the project and id, and a project without the requested
name or with a seeded project's id, or a task outside the case project, is never deleted
(`TodoistConformanceCleanupRefused`). The cleanup verifies only that the project is gone; that its
tasks go with it is the delete case's unverified claim.
Before any write case, and again after an interrupt-only exit (130), the runner warns read-only
about `yolk-conformance-run-*` projects earlier runs left behind
(`findTodoistConformanceLeftovers`, bounded to 20 listing pages); it never deletes them.
`pnpm conformance:todoist` in this repository dry-runs by default; `--live --owner-approved
--account <label>` (refused whenever `CI` is non-empty; needs `TODOIST_API_TOKEN` and the seeds) is
for owners running a practice account by hand, `--allow-writes reversible` adds the write cases, and
`--record` stages verified recordings all or nothing in `.conformance-recordings/todoist/<run>/`
(gitignored) for manual scrubbing and promotion.
For offline tests, the experimental Todoist emulator (`@yolk-sdk/emulators/todoist`) is a
stateful, fixture-only stand-in that passes these cases; it does not emulate the leftover lookup's
project listing (no fixture records it), so that lookup fails closed against it.

### Telegram conformance cases (experimental)

`@yolk-sdk/connectors/telegram/conformance` exports four conformance cases for
`@yolk-sdk/conformance/runner` (`telegramConformanceCases`), synthetic replay fixtures
(`telegramConformanceFixtures`, `evidence: 'unverified'`, whose URLs carry the synthetic
`telegramConformanceReplayBotToken`), and the seeds they replay with
(`telegramConformanceFixtureSeeds`). Every case runs the real connector actions, or the host-only
`downloadTelegramFile`, over `ConnectorHttpClient`, `ConnectorBinaryHttpClient`, and
`CredentialResolver` plus `TelegramConformanceConfig` (a practice chat id, a file id, and the run
id). The Telegram actions read only HTTP statuses, so claims about the Bot API `ok` field are
observed at those ports; the host-only `downloadTelegramFile` decodes the `getFile` result. They
cover `telegram.validate` (one `getChat`, not `getMe`), errors as a 4xx status with `ok: false`
(never `200` with `ok: false`), `getFile` for downloads (the seeded file must report a size), and
`telegram.send_message`. Credentials bind through `telegramConformanceIntegration(chatId)`
(`telegram.bot_token`, credential ref `telegram.conformance`). The case table, seeds, and claims
live in the
[Telegram conformance guide](../../apps/docs/content/docs/connectors/telegram.mdx#conformance-cases).

**The send case is write-irreversible:** it posts a real message naming the run id to the seeded
chat, and the connector cannot delete it. It never runs under `allowWrites: 'reversible'`; a runner
starts it only when a person names its exact id (`allowIrreversible`, or the live runner's
`--allow-irreversible telegram.messages.send-message`). The send is not interruptible; a definitive
rejection (4xx other than 408; 429 included) sent nothing, and an ambiguous send (a transport or
decoding failure, no status, HTTP 408 or 5xx, or a 2xx whose body lacks `ok: true`) fails with
`TelegramConformanceActionFailed` (`sendOutcome: 'unknown'`) naming the exact text to look for in
the chat, also through `ConformanceCleanupReporter` when the case is being interrupted. There is
nothing to clean up and no leftover lookup; the live runner prints the run id when the send is
enabled.
`pnpm conformance:telegram` in this repository dry-runs by default; `--live --owner-approved
--account <label>` (refused whenever `CI` is non-empty; needs `TELEGRAM_BOT_TOKEN` and the seeds) is
for owners running a practice bot by hand, and `--record` replaces the live bot token with the
replay token in every recorded URL, then refuses to stage or print a checklist for any recording in
which the token or its secret part survives anywhere (URLs, headers, decoded base64 bodies,
reassembled stream chunks, unescaped JSON strings; raw, percent-encoded, escaped, or
base64-encoded) or that holds a body outside the inspectable allowlist (strict UTF-8 text without NUL
characters: binary, compressed, and UTF-16 bodies are refused, so the `fileId` seed must be a plain
UTF-8 text file), and stages verified recordings all or nothing in
`.conformance-recordings/telegram/<run>/` (gitignored) for manual scrubbing and promotion.
For offline tests, the experimental Telegram emulator (`@yolk-sdk/emulators/telegram`) is a
stateful, fixture-only stand-in that passes these cases, records the send in its state, and never
keeps or echoes the bot token.

### GitHub conformance cases (experimental)

`@yolk-sdk/connectors/github/conformance` exports seven conformance cases for
`@yolk-sdk/conformance/runner` (`githubConformanceCases`), synthetic replay fixtures
(`githubConformanceFixtures`, `evidence: 'unverified'`), and the seeds they replay with
(`githubConformanceFixtureSeeds`). Every case runs the real connector actions over
`ConnectorHttpClient` and `CredentialResolver` plus `GithubConformanceConfig`, which holds the
practice repository's `owner` and `repo` and a few seeded items. They cover label list paging
through `Link` `rel="next"`, the 404 and 422 error envelopes the connector maps, base64 file
contents, a comment created and deleted by id, a label added and removed, and the issue
create/get/update/close lifecycle. Credentials bind through `githubConformanceIntegration(owner, repo)`
(`github.token`, credential ref `github.conformance`). The case table, seeds, and claims live in the
[GitHub conformance guide](../../apps/docs/content/docs/connectors/github.mdx#conformance-cases).

Every write names the invocation-unique `runId` (the fixtures replay with `run-synthetic`; the live
runner generates a fresh random id every time) or touches only the seeded work issue and label. The
create, its decoding, and its registration are not interruptible, and neither is any later write.
A definitive rejection (HTTP 4xx other than 408) undoes nothing; an ambiguous write (a transport or
decoding failure, no status, HTTP 408, or HTTP 5xx) fails with `GithubConformanceActionFailed`
(`writeOutcome: 'unknown'`) naming the exact item; an answer outside the run namespace is never
adopted (`GithubConformanceCleanupRefused`). The comment and label cases are write-reversible: the
cleanup deletes the comment by id or removes the label, verifies it, and fails with
`GithubConformanceRestoreFailed` when that fails. They cannot undo what they trigger (the comment
notifies the work issue's subscribers; the label add and remove stay on its timeline), so the work
issue must be a practice issue nobody else watches. **The issue lifecycle case is
write-irreversible:** GitHub issues cannot be deleted through the REST API, so the issue it opens
stays in the repository, closed; it runs only when a person names its exact id
(`--allow-irreversible github.issues.lifecycle-close`). Before any write case, and again after an
interrupt-only exit, the runner warns read-only about open `yolk-conformance run-*` issues, run
comments on the work issue, and the seeded label on it (`findGithubConformanceLeftovers`).
`pnpm conformance:github` in this repository dry-runs by default; `--live --owner-approved
--account <label>` (refused whenever `CI` is non-empty; needs `GITHUB_TOKEN` and the seeds) is for
owners running a practice repository by hand, `--allow-writes reversible` adds the comment and
label cases, and `--record` keeps the `link` response header, refuses any recording in which the
token survives, and stages verified recordings all or nothing in
`.conformance-recordings/github/<run>/` (gitignored) for manual scrubbing and promotion.
For offline tests, the experimental GitHub emulator (`@yolk-sdk/emulators/github`) is a stateful,
fixture-only stand-in that passes these cases; it does not emulate the leftover lookup's open-issue
listing (no fixture records it), so that lookup fails closed against it.

### Google conformance cases (experimental)

`@yolk-sdk/connectors/google/conformance` exports thirteen conformance cases for
`@yolk-sdk/conformance/runner` (`googleConformanceCases`), synthetic replay fixtures
(`googleConformanceFixtures`, `evidence: 'unverified'`), and the seeds they replay with
(`googleConformanceFixtureSeeds`). Every case runs the real Gmail, Calendar, and Drive actions over
`ConnectorHttpClient` and `CredentialResolver` plus `GoogleConformanceConfig`, which holds a
practice mailbox address, practice messages and a label, a practice calendar and time range, and a
practice Drive folder and file. They cover `gmail.list` paging through `nextPageToken`, base64url
attachment data, the 404 error envelope, a label created, applied, and deleted, a draft composed,
updated, and deleted, trash and untrash, a send to the practice address, Calendar range paging, an
event lifecycle and its deleted state, Drive folder paging, the `get_file` field selection, and a
folder trashed and deleted. Credentials bind through `googleConformanceIntegration` (`google.oauth`,
credential ref `google.conformance`). The case table, seeds, and claims live in the
[Google conformance guide](../../apps/docs/content/docs/connectors/google.mdx#conformance-cases).

Every write names the invocation-unique `runId` (the fixtures replay with `run-synthetic`; the live
runner generates a fresh random id every time) or touches only the seeded work message. The create,
its decoding, and its registration are not interruptible, and neither is any later write. A
definitive rejection (HTTP 4xx other than 408) undoes nothing; an ambiguous write fails with
`GoogleConformanceActionFailed` (`writeOutcome: 'unknown'`) naming the exact item; an answer the
case cannot prove is its own (for a draft, a metadata read of its message: `DRAFT`, the run subject,
no recipient) is never adopted, updated, or deleted (`GoogleConformanceCleanupRefused`). The label, draft, trash,
event, and folder cases are write-reversible: the cleanup undoes by id, verifies, and fails with
`GoogleConformanceRestoreFailed` when that fails. Events never have attendees (no invitation is ever
sent), drafts never have recipients, and the folder case trashes its folder and then deletes it
permanently, so nothing stays in Drive Trash. **The send case is write-irreversible:** Gmail cannot
unsend; it sends one message whose only recipient is the seeded practice address, and runs only
when a person names its exact id (`--allow-irreversible google.gmail.send-practice-address`).
`practiceAddress` and `runId` are branded seed types (`GooglePracticeAddress`,
`GoogleConformanceRunId`), and every case decodes the seeds it reads again before any request, so
a list, display name, header injection, or control character fails a precondition and sends
nothing, whether or not the host went through the runner.
Before any write case, and again after an interrupt-only exit, the runner warns read-only about run
labels and drafts, the work message in Trash, run events, and run Drive items
(`findGoogleConformanceLeftovers`). `pnpm conformance:google` in this repository dry-runs by
default; `--live --owner-approved --account <label>` (refused whenever `CI` is non-empty; needs
`GOOGLE_ACCESS_TOKEN`, refused before any request unless it looks like `ya29.…`, and the seeds) is
for owners running a practice account by hand, `--allow-writes reversible` adds the reversible
cases, and `--record` refuses any recording in which the token survives and stages verified
recordings all or nothing in `.conformance-recordings/google/<run>/` (gitignored) for manual
scrubbing and promotion.
For offline tests, the experimental Google emulator (`@yolk-sdk/emulators/google`) is a stateful,
fixture-only stand-in that passes these cases, records the practice send in its state (never
delivering it), and never keeps or echoes the access token; no fixture records the leftover
lookup's reads, so that lookup fails closed against it.

### LinkedIn search conformance cases (experimental)

`@yolk-sdk/connectors/linkedin-search/conformance` exports seven conformance cases for
`@yolk-sdk/conformance/runner` (`linkedInSearchConformanceCases`), synthetic replay fixtures
(`linkedInSearchConformanceFixtures`, `evidence: 'unverified'`), and the seeds they replay with
(`linkedInSearchConformanceFixtureSeeds`). Every case runs the real connector actions over
`ConnectorHttpClient` and `CredentialResolver` plus `LinkedInSearchConformanceConfig` (an Exa people
query, a profile URL, and a profile URL that names no profile), and every case is a read. They cover
Exa people results (1 to 10, each with a `url`, no `null` field the connector decodes), the
`numResults` limit (a control search with `numResults: 3` must answer more than 2 people first; no
paging exists), the Enrich Layer profile answered as a non-empty object, the email lookup answering
an `email` or a queued `email_queue_count` with the connector never reporting `status: "unknown"`,
an unknown key at each provider answering a 4xx status, and a missing profile answering a 4xx status
rather than an empty 2xx profile. Rate limiting is not a case: the connector maps a 429 like any
other non-2xx answer and reads no `Retry-After`. Credentials bind through
`linkedInSearchConformanceIntegration()` (both API key slots);
`linkedInSearchConformanceCredentials` keys the two keys by slot id for
`staticCredentialResolverLayer`. Every 2xx fixture body keeps only the keys and types its case
reads, and a strict allowlist test (`test/linkedin-search-conformance.test.ts`, whose comment lists
exactly what it enforces) refuses anything in a 2xx body, request query, or seed that is not
obviously synthetic. The case table, seeds, and claims live in the
[LinkedIn search conformance guide](../../apps/docs/content/docs/connectors/linkedin-search.mdx#conformance-cases).
For offline tests, the experimental LinkedIn search emulator
(`@yolk-sdk/emulators/linkedin-search`) is a stateful, fixture-only stand-in for the Exa and Enrich
Layer routes that passes these cases, answering each from a fixture byte for byte (the recorded 401
for a key its seed marks as rejected on that provider), and never keeps or echoes an API key.

`pnpm conformance:linkedin-search` in this repository dry-runs by default;
`--live --owner-approved --account <label>` (refused whenever `CI` is non-empty) needs
`EXA_API_KEY` and `ENRICH_LAYER_API_KEY` from the environment only (each refused before any
request unless it has 16 to 256 letters, digits, `_`, or `-`) and the seeds, with `linkedin.com`
profile URLs. Neither provider has a sandbox: the keys are real, paid keys (use dedicated
low-credit ones), and `--profile-url` should name a profile whose owner consented, for example the
repository owner's own; a run needs the owner's approval although nothing is written. Every
printed line is redacted of both keys, and `--record` refuses any recording, rendered file, or
checklist line carrying either one (naming which) and stages verified recordings all or nothing in
`.conformance-recordings/linkedin-search/<run>/` (gitignored), listing every string value they hold
for review. **They hold real third parties' personal data, and this repository is public:** before
promoting, replace each recorded 2xx body wholesale with a minimal synthetic body that keeps only
the keys and types the case reads, never scrubbing field by field.

### R2 conformance cases (experimental)

`@yolk-sdk/connectors/r2-storage/conformance` exports six port-level conformance cases
(`r2ConformanceCases`), synthetic `PortFixture`s (`r2ConformanceFixtures`), and the seeds they
replay with (`r2ConformanceFixtureSeeds`). The connector never talks to R2 itself: the cases run
`r2_storage.upload_url` over the host `R2Presigner` and `getR2Object` / `createR2Object` /
`updateR2Object` over the host `R2ObjectClient`, plus `CredentialResolver` and
`R2ConformanceConfig`. They cover the presigned PUT URL (bucket and key, SigV4 parameters, an expiry
within the SigV4 limit, the signed content type, and a credential for the access key id the
connector passed), `maxBytes` and `expectedEtag` on get, a missing key, an absent-only create, and
an `If-Match` update. `r2PortsLayerFromBackend` bridges a plain-JSON backend to both ports without
ever handing it the credentials, and `makeR2ReplayBackend` replays the fixtures. The two write cases
are **write-irreversible** (the connector cannot delete R2 objects): they write only under
`yolk-conformance/<runId>/` and report an ambiguous put with the exact bucket and key; a live host
must generate a fresh `run-<hex>` per invocation. Presigned URLs in fixtures carry only synthetic
credential placeholders: run both `scanPortFixtureForSecrets` and `findR2PortFixtureSecrets`
(fail-closed: any credential name outside an exact canonical placeholder occurrence, in any letter
case, raw or percent-, JSON-, `\x`-, or HTML-escape-decoded up to the stated depth);
`scrubR2PortFixture` rewrites live ones except escaped URLs, so rerun both scans after it. The
fixture-driven fake in `@yolk-sdk/emulators/r2` plugs into `r2PortsLayerFromBackend` the same way
(connectors never depend on emulators). Live verification needs a host implementation of both ports;
no live R2 runner ships. The case table lives in the
[R2 conformance guide](../../apps/docs/content/docs/connectors/r2-storage.mdx#conformance-cases).

## Host-only file capabilities

New byte helpers are separate from connector actions and generic agent serialization. They use
root `ConnectorFileTransferBudget` (`maxBytes`, `maxMetadataBytes`, `maxErrorBodyBytes`) and fail
with `ConnectorFileTransferError` carrying only `code` plus an optional HTTP `status` number. Existing Dropbox/OneDrive download APIs and all
base64 attachment actions remain unchanged. Full API/policy reference:
[Transfer connector files](../../apps/docs/content/docs/connectors/files.mdx).

| Subpath      | Retrieval helpers                                                             | Create/update helpers                                              |
| ------------ | ----------------------------------------------------------------------------- | ------------------------------------------------------------------ |
| `dropbox`    | `downloadDropboxFile`                                                         | `createDropboxFile`, `updateDropboxFile`                           |
| `microsoft`  | `downloadOneDriveItem`, `downloadOutlookAttachment`                           | `createOneDriveFile`, `updateOneDriveFile`, `addOutlookAttachment` |
| `r2-storage` | `getR2Object`                                                                 | `createR2Object`, `updateR2Object`                                 |
| `google`     | `downloadGoogleDriveFile`, `exportGoogleDriveFile`, `downloadGmailAttachment` | Not added                                                          |
| `fortnox`    | `downloadFortnoxInvoicePreview`, `downloadFortnoxArchiveFile`                 | Not added                                                          |
| `notion`     | `downloadNotionFile`                                                          | Not added                                                          |
| `email`      | `downloadEmailAttachment`                                                     | Not added                                                          |
| `telegram`   | `downloadTelegramFile`                                                        | Not added                                                          |
| `todoist`    | `downloadTodoistAttachment`                                                   | Not added                                                          |
| `github`     | Not added                                                                     | `uploadGithubAttachment`                                           |

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
The optional `uploadSession` method (request type `ConnectorBinaryUploadSessionRequest`) sends
`PUT` ranges or a `DELETE` cancellation to a provider-issued, pre-authenticated upload-session URL.
Existing adapters without it still compile; helpers that need it fail `upload_session_required`
before credentials or network, including when no binary write port is provided at all. Outlook
draft attachments use this port only for session ranges: their authenticated Graph JSON POSTs
(`fileAttachment`, `createUploadSession`) travel over `ConnectorHttpClient`, whose host adapter
must allow those Graph POSTs and a success body of `maxMetadataBytes` plus the echoed base64 content
(about 4 MiB for a file just under 3 MiB), and must not log, trace or persist those request or
response bodies (file content and the token-bearing `uploadUrl`). The helper never reads their error
bodies; cap oversized ones without failing so the status still maps. Hosts implementing `uploadSession`
must allowlist the origin and path shape (Outlook: `https://outlook.office.com/api/{v1.0,v2.0,gv1.0,beta}/.../AttachmentSessions(...)` only), send the URL
unchanged with no Authorization/cookies/ambient credentials, never log/trace/persist the URL (it
embeds an auth token) or bodies, follow no redirects, never retry, apply the same TLS, DNS/socket,
timeout, cancellation and streamed limits as `request`, and return response headers including
`Location` on a final 201.

- Dropbox uses `files.content.write`. Create is strict `add`; update requires stable `id:` and
  a concrete revision with `mode: update`. Both enforce `strict_conflict: true`, `autorename: false`;
  stale or deleted updates cannot become creates. Single-upload cap: **150,000,000 bytes**.
- OneDrive create takes `{ parentItemId, name, driveId?, bytes }` and sends conflict behavior `fail`.
  Update takes `{ itemId, driveId?, bytes, acknowledgeOverwrite: true }` and replaces unconditionally.
  **Acknowledgement is not CAS: concurrent edits can be overwritten.** No simple-upload `If-Match`
  guarantee is invented. Require informed host overwrite approval or decline when CAS is required.
  Write permission/application-drive guards match metadata writes. Cap: **250,000,000 bytes**.
- `addOutlookAttachment` takes `{ messageId, name, contentType, bytes, mailbox? }` and attaches one
  file to an existing Outlook **draft**; it never sends. It reuses Outlook write-slot selection
  (`Mail.ReadWrite`, `Mail.ReadWrite.Shared` for delegated non-own mailboxes, application mailbox
  guard). Files under 3 MiB (`outlookAttachmentSingleRequestMaxBytes`) use one Graph `POST
/messages/{id}/attachments` `#microsoft.graph.fileAttachment`; the success metadata budget is
  `maxMetadataBytes` plus the echoed base64 length. 3 MiB through 150 MiB
  (`outlookAttachmentUploadSessionMaxBytes`) use `POST .../attachments/createUploadSession`
  (bounded by `maxMetadataBytes`). Both authenticated Graph POSTs go through the regular
  `ConnectorHttpClient` as ASCII-only JSON string bodies with the Outlook Bearer, JSON
  accept/content-type and `Prefer: IdType="ImmutableId"` headers, `redirect: 'manual'` and
  `credentials: 'omit'`; the helper requires `CredentialResolver | ConnectorHttpClient` only.
  `ConnectorBinaryWriteHttpClient` is read optionally and used only for session ranges, so hosts
  without any binary write port can still attach files under 3 MiB. Session uploads then send
  sequential 3,932,160-byte (12 x 320 KiB) `PUT` ranges through `uploadSession` with
  `Content-Range: bytes start-end/total`, `Content-Type: application/octet-stream` and no
  Authorization. Every intermediate 200 must report exactly the next expected range; the final
  range must return 201, whose `Location` yields `attachmentId` when parseable. Session URLs outside
  the allowlist fail `network_policy_rejected` without being contacted; after any later failure or
  interruption the helper sends one best-effort `DELETE` to cancel the session. Result:
  `{ attachmentId?, name, size }` where `size` is the uploaded byte count. A created attachment
  whose ID is missing still succeeds without `attachmentId`. Failures are code/status-only
  `ConnectorFileTransferError`s and never include the session URL, token or provider bodies; the
  draft is never sent, but a failure after dispatch may still have attached the file, so list
  attachments before retrying. Graph documents a known issue for large attachments in shared or
  delegated mailboxes.
- R2's separate `R2ObjectClient` host port supports binding or signed transport, not an AWS dependency.
  Get takes `{ bucket, key, expectedEtag? }`; create takes `{ bucket, key, bytes }`; update requires
  `expectedEtag`. Hosts atomically implement `condition: { kind: 'absent' }` as `If-None-Match: *`,
  or `{ kind: 'etag', etag }` as concrete `If-Match`; never HEAD-then-PUT or weaken conditions.
  Preserve HTTP ETag quoting; translate explicitly for bindings. Missing GET fails `not_found`,
  conditional GET without body/conditional PUT returning null fails `conflict`, not empty success.
  Host owns credentials, authorized integration/bucket/key selection, signing and bounded I/O.
  ETags cannot distinguish all identical-content rewrites. Cap: **100,000,000 bytes**.
  `R2Presigner`/`r2_storage.upload_url` stay unchanged and do not inherit these conditions.

Dropbox, OneDrive and R2 are single-request bounded uploads only: larger files fail
`upload_session_required` before transport; smaller host budgets fail `response_too_large`. Only
Outlook draft attachments use upload sessions; there is no resume, and no claim of conditional R2
multipart completion. No automatic write retry. A timeout,
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
  It is a generated PDF, not an immutable original. The preview request sends no `Accept` header;
  success is verified by `%PDF-` magic bytes, not the response content type. Archive `{ fileId }` uses `/3/archive/{id}`.
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

Afloat's canonical `https://useafloat.com/mcp` exposes invoice/quote PDF and
receipt/logo/tax-return download grants (one hour), plus receipt/logo upload-intent completion
operations (`get-invoice-pdf`, `create-receipt-upload`, ...; the published schemas are in
`@yolk-sdk/connectors/afloat/conformance`, see "Afloat MCP conformance" below). Receipt completion
attaches or replaces atomically; receipt upload inputs allow JPEG/PNG/WebP/GIF/PDF,
1–2,147,483,647 bytes, optional SHA-256. Figma discovery confirms
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
| `@yolk-sdk/connectors/email`           | list/get messages, attachments, drafts, send, and IMAP read-state/flag/trash/restore/move/labels                   |
| `@yolk-sdk/connectors/figma`           | `figma.mcp_auth`                                                                                                   |
| `@yolk-sdk/connectors/fortnox`         | company info; list/get customers, invoices, suppliers, supplier invoices/files; create/update customers, invoices  |
| `@yolk-sdk/connectors/github`          | Issues, comments, labels, sub-issues, dependencies, issue fields, pull requests, reviews, merge, repo context      |
| `@yolk-sdk/connectors/google`          | Gmail mail and label actions; Calendar event actions; Drive metadata, folder-create, trash, and delete actions     |
| `@yolk-sdk/connectors/linkedin-search` | `linkedin_search.search`, `linkedin_search.profile`, `linkedin_search.email`                                       |
| `@yolk-sdk/connectors/microsoft`       | Outlook mail/category and OneDrive metadata/folder/move/copy/recycle actions; host-only file and attachment I/O    |
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
trash/delete, Gmail `send_message`, Microsoft message sends, and OneDrive deletion declare `destructive`. OneDrive move/copy declare `write`; copy-status polling remains `read`, and hosts own approval for the initiating copy. Legacy actions without metadata default to `read`, so hosts should continue assigning explicit access
when adapting other write-capable connectors. This currently includes write-capable Gmail, Google
Calendar, Notion, Todoist, Telegram, and R2 actions; hosts should provide an `access` resolver for
those actions rather than relying on the fallback.

Code mode exposure is host policy too. Pass `exposure` as one `ToolExposure` value or a resolver
`(actionId, action) => ToolExposure` (`action` carries the declared `access`, or is `undefined` for
an undeclared action id). Without it the tools keep the agent default (`callableBy: 'all'`).
`resolveTools` still rejects invalid combinations, such as `codemode` on a tool that needs approval:

```ts
const toolModule = makeConnectorToolModule(GoogleConnector, {
  integration,
  layer: HostConnectorLayer,
  exposure: (_actionId, action) =>
    action?.access === 'read'
      ? { callableBy: 'codemode', discovery: 'search' }
      : { callableBy: 'model' }
})
```

Afloat MCP auth reads an `afloat_` API key from the host runtime credential and returns the
canonical MCP endpoint and required `2026-07-28` protocol version. Keep the API key server-side;
never expose the auth action through a model-callable connector module.

### Afloat MCP conformance (experimental)

`@yolk-sdk/connectors/afloat/conformance` holds no case code and never imports `@yolk-sdk/mcp`: the
cases are the generic `@yolk-sdk/mcp/conformance` cases, and this subpath supplies Afloat's target
and seeds. `makeAfloatMcpConformanceTarget()` runs the real `afloat.mcp_auth` over the host's
`CredentialResolver` and answers the target value (`https://useafloat.com/mcp`, modern
`2026-07-28`, `Authorization: Bearer <afloat_ key>`, and the public reserved invalid key
`afloat_yolkconformanceinvalid0000` for the auth case). `afloatMcpConformanceLiveSeeds` name the
published nine-tool subset (`afloatMcpConformanceTools`, in the provider's listing order: the
source's names, titles, schemas, and annotations; the descriptions and server instructions are
rewritten generically) and the two receipt-upload tools that write, and no `readTool`;
`afloatMcpConformanceFixtureSeeds` add the synthetic `list-invoices` call. The eight fixtures
(`afloatMcpConformanceFixtures`, every case but `mcp.legacy.session`, which does not apply to a
modern server) are derived from the provider's source (owner-supplied), not a live recording: the
pinned official MCP server SDK run in-process with the provider's handler options, over synthetic
data, `evidence: 'unverified'`. In this repository, `pnpm conformance:mcp --target afloat` previews the run (a dry run:
no network, no credential read); `--live --owner-approved --account <label>` runs the cases by hand
against a practice account (a tool is called only when named with the `--read-tool` flag, never
from the environment), and `@yolk-sdk/emulators/mcp` serves the fixtures as profile `afloat`.

Figma MCP auth reads `accessToken` plus optional `refreshToken`, `clientId`, and `clientSecret`
from the runtime `OAuthCredential`. Keep these values in the host credential store.

## Host responsibilities

- Store, encrypt, refresh, revoke, and audit credentials.
- Own OAuth routes, callbacks, state, token persistence, and required-scope consent.
- Provide the `ConnectorHttpClient` implementation and Effect layers required by enabled connectors.
- Provide `ConnectorBinaryHttpClient` / `ConnectorBinaryWriteHttpClient` when using host-only byte APIs; never log URLs/bodies; enforce streamed limits, TLS, and connection-time DNS/IP policy.
- Implement optional `ConnectorBinaryWriteHttpClient.uploadSession` only with an origin/path allowlist for pre-authenticated session URLs, no Authorization, redirects, retries, or URL logging, and response headers (including `Location`) returned intact.
- Provide `R2ObjectClient` for conditional R2 get/create/update; provide `EmailClient` (including optional `getAttachmentBytes`) for email.
- Keep byte results out of `makeConnectorToolModule` / generic tool JSON; own materialization, scanning, and format readers.
- Preserve connector request headers and body content types while applying host networking policy.
- Map integrations to users, workspaces, agents, or projects outside this package.
- Authorize action execution before invoking connectors.

## Boundaries

- No DB, framework, UI, app auth, or product lifecycle code.
- No Promise facade; use Effect directly.
- Integrations contain credential refs only, never raw secrets.
