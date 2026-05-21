# @yolk-sdk/agent/tools

Generic host tool registration and resolution.

## What it provides

- `ToolModule<Context>` and `ToolRegistration<Context>` types.
- Tool resolution from host modules and context.
- Duplicate tool name validation.
- Adapter from resolved tools to `@yolk-sdk/agent/loop` `ToolExecutor`.
- Package-owned `task` and `question` tool contracts.

## Use it when

- A host app wants declarative tool modules with generic context.
- You need to filter/resolve tools before running the agent loop.

## Boundaries

- No app tool catalogs.
- No provider SDKs.
- Tool access/approval is metadata; host apps enforce product policy.
