# App Workflow Runtime

App-owned Vercel Workflow wrappers over `@yolk-sdk/vercel-workflows-runtime/workflow`.

## Boundaries

- Package owns generic durable model/tool step loop contract.
- App owns concrete `'use workflow'` / `'use step'` functions because auth, providers, tools, prompt policy, and telemetry are app-specific.
- Keep Effect runtime work inside `'use step'` functions only; orchestration body must not call `Effect.runPromise`.
- Workflow args/state are plain wire data; decode with Schema inside steps.

## Stream/event rules

- Steps write protocol events to `getWritable<Uint8Array>()` as NDJSON.
- App wrapper assigns deterministic event ids: `workflow:<turn>:<sequence>`.
- Carry `eventSequence` through model/tool step results so retries/replay can de-dupe.
- Client/react reducers de-dupe by optional `eventId`; events without ids still replay.
- `AgentAwaitingInput` pauses protocol while the Workflow writer stays open until resume/close/error; clients must not abort the HTTP body at HITL pause.

## Step split

- Model step runs one model turn, streams deltas, captures assistant message/tool calls/usage.
- Tool batch step executes host tools separately and appends ordered `ToolResultMessage`s.
- HITL tool step writes `AgentAwaitingInput`, returns hook metadata, and the workflow waits on `createHook` before rerunning the tool step with the response.
- Close/error steps own final stream closure and in-band `AgentError` writing.

## Tests

- `run-agent-workflow.test.ts` guards no Effect runtime calls in `'use workflow'` body.
- Route model tests live under `examples/next/app/api/agent/workflow*`.
- Package directive behavior is tested in `packages/vercel-workflows-runtime` with `@workflow/vitest`.
