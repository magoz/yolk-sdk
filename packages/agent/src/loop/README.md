# @yolk/agent/loop

Stateless provider-neutral LLM/tool loop.

## What it provides

- `run` for executing model turns over a protocol transcript.
- `LLMProvider`, `ToolExecutor`, `LoopConfig`, and `ContextTransformer` Effect service contracts.
- Assistant text/reasoning/tool-call accumulation helpers.
- Typed loop errors.
- `@yolk/agent/loop/testing` test helpers.

## Use it when

- You have a provider adapter and tool executor and need to run an agent turn.
- You want protocol events, not UI-specific state.

## Boundaries

- No sessions or persistence.
- No provider SDK imports.
- No app tool catalogs or product permissions.
