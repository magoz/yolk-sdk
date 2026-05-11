# Agent Runtime

`@yolk/agent-runtime` adds generic session load/save orchestration around `@yolk/agent-loop`. It is still domain-free and storage-provider-neutral.

## Role

- Load previous session transcript from `SessionStore`.
- Run the stateless loop with restored messages.
- Persist updated session state after loop completion.
- Expose runtime errors separately from loop/provider errors.

## Boundaries

- No concrete database, auth, HTTP, WebSocket, or app route code.
- No provider SDKs or app tool catalogs.
- No product assumptions about users, orgs, projects, billing, or permissions.
- Persistence is an injected interface; app/services own implementation and tenancy.

## Public model

| Export area        | Purpose                                         |
| ------------------ | ----------------------------------------------- |
| `run-runtime`      | Session orchestration entrypoint                |
| `session-store`    | Storage interface for transcripts/session state |
| `error`            | Runtime-specific typed errors                   |
| `RuntimeSessionId` | Opaque session id alias                         |

## Design rules

- Treat session ids as opaque strings.
- Keep loop behavior in `@yolk/agent-loop`; runtime only coordinates lifecycle.
- Persist protocol transcript/state, not app render models.
- Keep resume/fanout adapters outside this package until generic enough.

## Tests

- Test with fake stores and fake loop/provider layers.
- Cover load failure, save failure, and successful transcript update semantics.
