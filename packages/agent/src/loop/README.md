# @yolk-sdk/agent/loop

Stateless provider-neutral LLM/tool loop.

## What it provides

- `run` for executing model turns over a protocol transcript.
- `runModelTurn` / `runToolBatch` for durable hosts that own the step boundary.
- `LLMProvider`, `ToolExecutor`, `LoopConfig`, and `ContextTransformer` Effect service contracts.
- `makeAgentLoopLayer` to merge those four services, `decorateLLMProvider` to intercept the provider, and `collectModelTurn` to fold a model-turn stream.
- Assistant text/reasoning/tool-call accumulation helpers.
- HITL pauses for manual tool approvals and structured questions.
- Typed loop errors.
- `@yolk-sdk/agent/loop/testing` test helpers.

## Use it when

- You have a provider adapter and tool executor and need to run an agent turn.
- You want protocol events, not UI-specific state.

## Composition kernel

The loop is four Effect Layers plus the stateless run functions:

- Provide `LLMProvider`, `ToolExecutor`, `ContextTransformer`, and `LoopConfig` with `makeAgentLoopLayer`.
- Run `run`, `runModelTurn`, or `runToolBatch` against that layer.
- Intercept by decorating a service (`decorateLLMProvider`), not by registering hooks.
- Durable hosts fold each `runModelTurn` stream with `collectModelTurn` instead of embedding host I/O in the kernel.

Defaults: identity transformer, `LoopConfig.defaultLayer`, and `ToolExecutor.unavailable` when tools are omitted.

## Boundaries

- No sessions or persistence.
- No provider SDK imports.
- No app tool catalogs or product permissions.
- No hook or plugin registry; interception is a Layer around an existing service.
