# Agent Package

`@yolk/agent` is the main package for building and running agents. Root export stays intentionally tiny; use explicit subpaths.

## Subpaths

| Subpath | Source | Role |
| --- | --- | --- |
| `@yolk/agent/protocol` | `src/protocol` | Agent wire/message/event schemas |
| `@yolk/agent/loop` | `src/loop` | Stateless LLM/tool loop |
| `@yolk/agent/loop/testing` | `src/loop/testing` | Loop test helpers |
| `@yolk/agent/runtime` | `src/runtime` | Generic runtime/session orchestration |
| `@yolk/agent/client` | `src/client` | Client transport/state helpers |
| `@yolk/agent/tools` | `src/tools` | Generic tool module registry |

## Boundaries

- No React, Next.js, app imports, auth, storage drivers, provider SDKs, or product concepts.
- Do not import `@yolk/rag`, `@yolk/mcp`, `@yolk/react`, or concrete adapter packages from core agent subpaths.
- Protocol has no package dependencies except Effect.
- Loop depends on protocol only.
- Runtime depends on protocol + loop only.
- Client depends on protocol only.
- Tools depend on protocol + loop only.
- Package architecture constraints live in `patterns/PACKAGE_ARCHITECTURE.md`.
- Keep all subpaths ESM/tree-shakeable: no top-level env reads, SDK clients, network calls, or side effects.
- `@yolk/agent/tools` owns the domain-free `task` tool contract for subagents; host apps provide subagent execution, models, prompts, and tool policy.
- v1 subagents may use normal tools but must not receive the `task` tool recursively unless a future explicit capability enables it.

## Tests

- Area tests live under `test/protocol`, `test/loop`, `test/runtime`, `test/client`, and `test/tools`.
- Use `@yolk/agent/loop/testing` for fake providers/tool executors outside loop internals.
- Cover task tool schema, unknown subagent rejection, and result formatting in `test/tools`.
