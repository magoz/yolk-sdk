# @yolk/agent-runtime

Generic session orchestration for `@yolk/agent-loop`.

## What it provides

- `runRuntime` for loading a session, running the loop, and saving the updated session.
- `SessionStore` service contract.
- In-memory session store layer for tests/simple hosts.
- Runtime-specific errors.

## Use it when

- You need reusable load/run/save lifecycle around the stateless loop.
- Your app owns storage and wants to inject it through an Effect service.

## Boundaries

- No database implementation.
- No HTTP/WebSocket routes.
- No app auth or tenancy logic.
