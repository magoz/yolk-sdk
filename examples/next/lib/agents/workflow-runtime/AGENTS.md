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
- App steps use `writeDurableAgentEvent`; normal ids are `workflow:<runId>:<turn>:<sequence>`.
- Error events use run-scoped stream ids: `workflow:<runId>:error:<turn>:<sequence>`.
- Carry `eventSequence` through model/tool step results so retries/replay can de-dupe; reset it for
  fresh independent streams.
- Client/react reducers de-dupe by optional `eventId`; events without ids still replay.
- `AgentAwaitingInput` pauses protocol while the Workflow writer stays open until resume/close/error; clients must not abort the HTTP body at HITL pause.

## Step split

- Model step runs one model turn, streams deltas, captures assistant message/tool calls/usage.
- Parent tool orchestration preflights the entire batch, dispatches bounded individual tool/child work, then merges ordered `ToolResultMessage`s. Foreground child results add usage once; background observations never charge that usage to the parent.
- Failed tools still append `ToolResultMessage.isError`; never resume the model with dangling host tool calls.
- HITL tool step writes `AgentAwaitingInput`, returns hook metadata, and the workflow waits on `createHook` before rerunning the tool step with the response.
- Close/error steps own final stream closure; `workflow-error.ts` maps typed route/loop/runtime errors to in-band `AgentError` codes.

## Tests

- `run-agent-workflow.test.ts` guards no Effect runtime calls in `'use workflow'` body and dynamic step imports.
- `run-agent-workflow.ts` and `workflow-child-steps.ts` own the directive wrappers. Import `agent-workflow-steps.ts` / `child-control.ts` dynamically **inside** those steps; static runtime imports pull Node-only provider/MCP/tool dependencies into the Workflow bundle even when unit tests pass. `workflow-contract.ts` holds shared pure transport helpers. Runtime implementations have no directives; wrappers own retry policy.
- Route model tests live under `examples/next/app/api/agent/workflow*`.
- Package directive behavior is tested in `packages/vercel-workflows` with `@workflow/vitest`.

## Independent Workflow children

- `runAgentWorkflow` returns the structured SDK terminal outcome. `runChildAgentWorkflow` is a separate physical Workflow run, with its own model/tool steps and stream, bounded by `maxChildWorkflowTurns`. Effect/provider/tool work stays inside steps.
- Workflow `subagent` defaults to isolated foreground; `background: true` returns an accepted handle after durable reservation/attachment. Parent continues without waiting for child completion. Inline `/agent/next` execution remains unchanged.
- `subagent_status` and `subagent_wait` accept the original `tool_call_id` plus optional `parent_run_id` from the accepted handle, allowing later conversation runs to retrieve a prior child. All reads enforce the authenticated owner. Wait uses Workflow sleep plus short reads; lookup results nest the original result and do not emit a second launch ToolResult or usage delta. Background launches always return acceptance, even when the child finishes before the acknowledgement.
- After parent termination, `GET /api/agent/workflow/:runId/children/:toolCallId` remains an owned durable result lookup. No forced completion notification or automatic parent restart is implemented.
- `services/agent-workflow` owns a bounded registry in `agentWorkflowRun`: one locked parent row with immutable unique call-id reservations. `maxWorkflowChildren` caps lifetime reservations and `workflowToolConcurrency` bounds parent dispatch (pure `policy.ts`). The first child admission CAS fixes one physical owner; start-response attachment repairs a pre-admission failure without stealing an existing owner. Duplicate physical runs exit before model work. No time-based lease stealing.
- Stop serializes with reserve/admit on that same parent row, records a permanent tombstone **before** sweeping children and parent independently, and returns 503 for incomplete sweeps so callers can retry. Even a completed/failed parent can be stopped. Active provider/tool work is best-effort cancellation only; admission is rechecked before every subsequent model/tool step and each queued tool dispatch.
- Launch failures record uncertainty rather than a false terminal child outcome. Unadmitted reservations past `childAdmissionWaitMs` also end waits with an actionable unconfirmed result. Late self-admission remains possible until Stop; never steal ownership or claim the child failed solely because a start response was lost.
- Parent completion/failure never invokes Stop. Child terminal persistence is independent of parent finalization. Platform failed/cancelled/completed status is a short-read fallback when no terminal result was persisted; platform completed without an application outcome is an error, not success.
- Child steps rebuild provider credentials, prompt and tools from the host user/request. No providers, tokens, tool closures or Effect objects cross Workflow args. Children omit delegation, question, skill management and manually approved tools.
- Parallel parent calls use `workflow:<runId>:tool:<turn>:<index>` event namespaces, avoiding shared mutable sequence counters. Parent launch events precede child execution, and completion skips duplicate start events. Child events never write to or close the parent stream. Rejected dispatch stops new work but settles in-flight siblings and preserves their partial results/usage.
- Schema addition requires the host's normal reviewed schema rollout before running this example. This implementation does not provision or push/migrate any database. Registry retention/pruning is host policy; do not delete tombstones while late runs can still execute. Pre-existing runs without registry ownership rows are intentionally inaccessible to owned run routes.

### Offline validation

Fake registry/control tests run without DB and share the pure production transition. `workflow-host.test.ts` executes actual host entrypoints, serializers and the agent loop with fake provider/store/platform boundaries, including cross-run lookup, launch failure, foreground event order, HITL and Stop. Package
`@workflow/vitest` tests cover real isolated run/step behavior. Do not use root `test:run` here:
it pushes the DB schema. Run `pnpm --filter @yolk-example/next build` to validate the actual Workflow bundle graph (typecheck and fake-platform tests cannot catch Node-only dependency leakage). The build may need the Google Inter font cache/network. A successful build is not DB-locking, credential reconstruction or hosted cancellation validation.
