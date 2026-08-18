# Connectors

`@yolk-sdk/connectors` defines Effect-native primitives for reusable external-system connectors.

## Boundaries

- No DB, encryption, token storage, refresh persistence, app auth, routes, UI, or product permissions.
- No user/team/org/workspace/project concepts; hosts own identity and lifecycle.
- No Promise facade; public APIs are Effect-native only.
- Do not repackage Effect HTTP/runtime adapters; expose ports and let hosts wire Effect layers.
- Raw secrets may flow through host-provided Effect services at invocation time, but integrations store only opaque credential refs.
- Provider modules may define vendor mechanics and schemas, not host policy.

## Public model

| Export area       | Purpose                                                                                          |
| ----------------- | ------------------------------------------------------------------------------------------------ |
| `connector`       | connector definition and action dispatch                                                         |
| `agent`           | optional adapter from connector actions to `@yolk-sdk/agent/tools` modules                       |
| `integration`     | configured invokable connector instance data                                                     |
| `action`          | typed action definitions over Effect Schema                                                      |
| `config`          | required/optional string config helpers for integration config                                   |
| `credential`      | slots, bindings, host resolver service, runtime credential values                                |
| `http`            | host-provided HTTP request/response port; not a connector                                        |
| `result`          | value-level success/failure results for expected upstream failures                               |
| `error`           | typed package/runtime failures                                                                   |
| `afloat`          | Afloat remote MCP auth data action, API-key slot, endpoint, and protocol version                 |
| `dropbox`         | Dropbox metadata/file-management actions plus OAuth slot constants                               |
| `figma`           | Figma remote MCP auth data action and OAuth constants                                            |
| `google`          | Gmail/Calendar actions plus Google OAuth slot constants                                          |
| `linkedin-search` | Exa people search plus Enrich Layer profile/email actions                                        |
| `microsoft`       | Microsoft Outlook and OneDrive actions through Microsoft Graph plus OAuth slot constants         |
| `notion`          | Notion search/page/block/database/data-source/comment/user actions plus API token slot constants |
| `r2-storage`      | Cloudflare R2 upload URL action with host-provided presigner                                     |
| `telegram`        | Telegram bot send/validate actions                                                               |
| `todoist`         | Todoist project/task/label actions plus API token slot constants                                 |

## Design rules

- Connector = reusable implementation; Integration = host-owned config that makes a connector invokable.
- Actions declare typed input/output schemas and optional `read`/`write`/`destructive` access metadata; action execution stays Effect-native. Agent adapter host overrides win, otherwise declared access is used.
- `http.ts` is infrastructure: connectors emit typed requests; hosts provide `ConnectorHttpClient` and preserve headers/body content type.
- Hosts provide credential resolution, storage, OAuth callbacks, refresh, auditing, and authorization.
- Use `ActionResult.failure` for expected provider/API failures; use Effect errors for missing config, credential, validation, or transport/runtime failures.
- Best-effort provider error-body detail parsing uses `Schema.decodeUnknownEffect(Schema.UnknownFromJsonString).pipe(Effect.result)`; never `try/catch`, raw `JSON.parse`, or sync Schema option decoders.
- If a provider failure builder performs Effect decoding, action executors must `yield*` it so non-2xx responses remain `ActionResult.failure` values.
- Google action-scoped OAuth slots share the `google.oauth` binding id; `requiredScopes` are consent hints, not separate storage slots.
- Dropbox action-scoped OAuth slots share the `dropbox.oauth` binding id; metadata reads require `files.metadata.read`, file-management writes require `files.content.write`, and binary upload/download stays outside the string-body HTTP port.
- Dropbox HTTP 409 covers not-found and conflict cases; classify from `error_summary`, not status alone. Single-item `move_v2`/`copy_v2` return `{ metadata }`; async job unions belong to batch routes.
- Microsoft actions use Microsoft Graph v1.0, not the retired Outlook REST endpoint, direct Exchange APIs, or legacy OneDrive endpoints. Outlook and OneDrive action-scoped slots share the `microsoft.oauth` binding id; hosts own OAuth authority/tenant selection and token lifecycle.
- Outlook inputs default to `/me`; optional `mailbox` targets `/users/{id|userPrincipalName}` for Exchange Online mailboxes. Delegated mode selects `Mail.*.Shared`; integration config `mailboxAccessMode: 'application'` selects non-Shared application permission hints and requires `mailbox`. Exchange mailbox grants and application-token scoping remain host/admin policy.
- OneDrive inputs default to `/me/drive`; optional `driveId` targets `/drives/{driveId}`. Delegated mode uses least-privilege `Files.Read`/`Files.ReadWrite`; `oneDriveAccessMode: 'delegated_all'` selects `Files.*.All`, while `application` also selects `Files.*.All` and requires `driveId`. Binary upload/download and upload-session mechanics are outside the current string/JSON HTTP port.
- Treat Graph `@odata.nextLink` as opaque and only replay links on the configured Graph origin and selected workload collection. Outlook send actions report accepted submission, not delivery.
- Afloat MCP auth actions are server-side connection helpers; never expose returned API keys through model-callable connector modules.
- Figma MCP `refreshToken`, `clientId`, and `clientSecret` come from the runtime
  `OAuthCredential`; never read them from integration config.
- `gmail.get_thread` is a bounded normalized boundary: require an explicit format, decode message text with plain text preferred over HTML, retain selected headers and attachment metadata, and never expose raw MIME or attachment content. Text/nested attachment parts must not enter the message body. Fetch external attachment content through `gmail.get_attachment` only when metadata includes `attachmentId`; inline attachment data is intentionally omitted.
- Agent adapters require a host-provided Effect layer for connector dependencies; adapters must not construct HTTP or credential services themselves.
