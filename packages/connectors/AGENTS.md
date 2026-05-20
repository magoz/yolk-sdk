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

| Export area | Purpose |
| --- | --- |
| `connector` | connector definition and action dispatch |
| `agent` | optional adapter from connector actions to `@yolk-sdk/agent/tools` modules |
| `integration` | configured invokable connector instance data |
| `action` | typed action definitions over Effect Schema |
| `credential` | slots, bindings, host resolver service, runtime credential values |
| `result` | value-level success/failure results for expected upstream failures |
| `error` | typed package/runtime failures |
| `figma` | Figma remote MCP auth data action and OAuth constants |
| `google` | Gmail/Calendar actions plus Google OAuth slot constants |
| `linkedin-search` | Exa people search plus Enrich Layer profile/email actions |
| `notion` | Notion search/page actions plus API token slot constants |
| `r2-storage` | Cloudflare R2 upload URL action with host-provided presigner |
| `telegram` | Telegram bot send/validate actions |
| `todoist` | Todoist task actions plus API token slot constants |

## Design rules

- Connector = reusable implementation; Integration = host-owned config that makes a connector invokable.
- Actions declare typed input/output schemas; action execution stays Effect-native.
- Hosts provide credential resolution, storage, OAuth callbacks, refresh, auditing, and authorization.
- Use `ActionResult.failure` for expected provider/API failures; use Effect errors for missing config, credential, validation, or transport/runtime failures.
- Agent adapters require a host-provided Effect layer for connector dependencies; adapters must not construct HTTP or credential services themselves.
