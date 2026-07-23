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

| Export area       | Purpose                                                                                   |
| ----------------- | ----------------------------------------------------------------------------------------- |
| `connector`       | connector definition and action dispatch                                                  |
| `agent`           | optional adapter from connector actions to `@yolk-sdk/agent/tools` modules                |
| `integration`     | configured invokable connector instance data                                              |
| `action`          | typed action definitions over Effect Schema                                               |
| `config`          | required/optional string config helpers for integration config                            |
| `credential`      | slots, bindings, host resolver service, runtime credential values                         |
| `http`            | host-provided HTTP request/response port; not a connector                                 |
| `result`          | value-level success/failure results for expected upstream failures                        |
| `error`           | typed package/runtime failures                                                            |
| `figma`           | Figma remote MCP auth data action and OAuth constants                                     |
| `google`          | Gmail/Calendar actions plus Google OAuth slot constants                                   |
| `linkedin-search` | Exa people search plus Enrich Layer profile/email actions                                 |
| `notion`          | Notion search/page/block/database/data-source/comment/user actions plus API token slot constants |
| `r2-storage`      | Cloudflare R2 upload URL action with host-provided presigner                              |
| `telegram`        | Telegram bot send/validate actions                                                        |
| `todoist`         | Todoist project/task/label actions plus API token slot constants                          |

## Design rules

- Connector = reusable implementation; Integration = host-owned config that makes a connector invokable.
- Actions declare typed input/output schemas; action execution stays Effect-native.
- `http.ts` is infrastructure: connectors emit typed requests; hosts provide `ConnectorHttpClient` and preserve headers/body content type.
- Hosts provide credential resolution, storage, OAuth callbacks, refresh, auditing, and authorization.
- Use `ActionResult.failure` for expected provider/API failures; use Effect errors for missing config, credential, validation, or transport/runtime failures.
- Best-effort provider error-body detail parsing uses `Schema.decodeUnknownEffect(Schema.UnknownFromJsonString).pipe(Effect.result)`; never `try/catch`, raw `JSON.parse`, or sync Schema option decoders.
- If a provider failure builder performs Effect decoding, action executors must `yield*` it so non-2xx responses remain `ActionResult.failure` values.
- Google action-scoped OAuth slots share the `google.oauth` binding id; `requiredScopes` are consent hints, not separate storage slots.
- `gmail.get_thread` is a bounded normalized boundary: require an explicit format, decode text bodies with plain text preferred over HTML, retain selected headers and attachment metadata, and never expose raw MIME payloads or attachment bytes. Fetch attachment content through `gmail.get_attachment`.
- Agent adapters require a host-provided Effect layer for connector dependencies; adapters must not construct HTTP or credential services themselves.
