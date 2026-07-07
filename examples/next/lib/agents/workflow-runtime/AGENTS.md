# App Workflow Runtime

App-owned Vercel Workflow wrappers over `@yolk-sdk/vercel-workflows`.

## Boundaries

- Package owns generic durable model/tool step loop contract.
- App imports `runVercelAgentWorkflow` from `@yolk-sdk/vercel-workflows`; route boundaries use `@yolk-sdk/vercel-workflows/effect` around public `workflow/api` calls.
- App owns concrete `'use workflow'` / `'use step'` functions because auth, providers, tools, prompt policy, and telemetry are app-specific.
- Keep Effect runtime work inside `'use step'` functions only; orchestration body must not call `Effect.runPromise`.
- Workflow args/state are plain wire data; decode with Schema inside steps.

## Stream/event rules

- Steps write protocol events to `getWritable<Uint8Array>()` as NDJSON.
- App steps use `writeDurableAgentEvent`; current normal ids are `workflow:<turn>:<sequence>`.
- Error events use run-scoped stream ids: `workflow:<runId>:error:<turn>:<sequence>`.
- Carry `eventSequence` through model/tool step results so retries/replay can de-dupe; reset it for
  fresh independent streams.
- Client/react reducers de-dupe by optional `eventId`; events without ids still replay.
- `AgentAwaitingInput` pauses protocol while the Workflow writer stays open until resume/close/error; clients must not abort the HTTP body at HITL pause.

## Step split

- Model step runs one model turn, streams deltas, captures assistant message/tool calls/usage.
- Tool batch step executes host tools separately and appends ordered `ToolResultMessage`s.
- Failed tools still append `ToolResultMessage.isError`; never resume the model with dangling host tool calls.
- HITL tool step writes `AgentAwaitingInput`, returns hook metadata, and the workflow waits on `createHook` before rerunning the tool step with the response.
- Close/error steps own final stream closure; `workflow-error.ts` maps typed route/loop/runtime errors to in-band `AgentError` codes.

## Tests

- `run-agent-workflow.test.ts` guards no Effect runtime calls in `'use workflow'` body.
- Route model tests live under `examples/next/app/api/agent/workflow*`.
- Package directive behavior is tested in `packages/vercel-workflows` with `@workflow/vitest`.
