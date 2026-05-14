# MCP Server Test Fixtures

Tiny process-boundary programs used by MCP server tests.

## Rules

- Fixtures may import `@effect/platform-node` and use Node process behavior.
- Keep fixtures minimal and deterministic.
- Provide `NodeStdio.layer` explicitly when exercising stdio.
- Keep app tools, credentials, network calls, and product behavior out.

## Anti-Patterns

- Reusable package logic hidden inside fixtures.
- Long-running daemons or external services.
- Secret or environment dumping to stderr/stdout.
