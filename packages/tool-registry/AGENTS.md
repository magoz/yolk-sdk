# Tool Registry

`@yolk/tool-registry` resolves host-provided tool modules into executable tool sets for the agent loop. It owns generic tool metadata and scope filtering only.

## Role

- Define `ToolModule<Context>` and `ToolRegistration<Context>` patterns.
- Resolve enabled tools from modules and context.
- Reject duplicate tool names before runtime execution.
- Adapt resolved tool sets to `ToolExecutor` for `@yolk/agent-loop`.

## Boundaries

- No app/domain tool catalogs in this package.
- No auth, database, provider SDK, MCP config, or product permission logic.
- `access: read | write | destructive` is metadata only; app owns enforcement and approvals.
- Context is generic and opaque to this package.

## Public model

| Export area | Purpose                                                                 |
| ----------- | ----------------------------------------------------------------------- |
| `registry`  | Tool module types, resolution, duplicate checks, executor layer adapter |

## Design rules

- Keep tool definitions compatible with protocol `ToolDef` / `ToolResult`.
- Prefer Effect collection helpers over mutable accumulation.
- Make duplicate/invalid registrations fail early with typed errors.
- Keep scope/policy data declarative so apps can make final decisions.

## Tests

- Cover enabled/disabled filtering, context-sensitive tools, duplicate names, and executor adaptation.
- Use simple fake tools; do not import app tool modules.
