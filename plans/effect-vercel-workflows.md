# Effect-native Vercel Workflows

## Goal

Make Yolk's Vercel Workflow usage as Effect-native as possible while keeping Vercel Workflow SDK as the runtime/transport.

## Current conclusion

- Use Effect around public Vercel Workflow SDK APIs.
- Do not replace Vercel Workflow internals.
- Do not direct-call Vercel backend HTTP/CBOR/queue APIs.
- Keep `runVercelAgentWorkflow` Promise-based and Workflow-safe.
- Keep Effect runtime out of `'use workflow'` orchestration.
- Use strict `@workflow/vitest` integration tests for real directive behavior.

## Motivation

- Typed errors for Workflow API failures.
- Effect spans around start/resume/replay/cancel/tail operations.
- Injectable fake layer for route/package tests.
- Less scattered `Effect.promise(...)` / direct `workflow/api` usage in app routes.
- Cleaner SDK surface at canary stage.
- Preserve Vercel Workflow semantics and supportability.

## Research findings

### Public Vercel Workflow contract

- `workflow/api` exports `start`, `getRun`, `resumeHook`, `Run`, `WorkflowReadableStream`.
- `start(...)` returns a `Run` with `runId`, `getReadable(...)`, `cancel()`, `status`, `returnValue`.
- `Run.getReadable(...)` returns a native `ReadableStream` with `getTailIndex()`.
- `getReadable({ startIndex })` supports replay from an absolute chunk index.
- `getReadable({ startIndex: -1 })` can be used to resolve stream tail index before HITL resume.
- `resumeHook(token, payload)` resumes a pending `createHook`.

### Streaming contract

- Workflow streams are native Web streams.
- App-visible protocol is HTTP NDJSON, not SSE/WebSocket.
- Workflow step writes bytes/chunks through `getWritable()`.
- `getWritable()` may be obtained in workflow or step context.
- `getWriter()`, `write()`, and `close()` must happen in `'use step'` functions.
- Yolk writes `AgentEvent` lines as `JSON.stringify(event)` plus a newline, encoded as bytes.
- Durable replay safety depends on stable `eventId` values and client de-dupe.

### Vercel SDK internals

- Vercel backend protocol is private/managed.
- SDK internals use HTTP endpoints, Vercel Queues, CBOR, OIDC, stream chunk indexing, and generated workflow handlers.
- Streaming backend uses length-prefixed binary batches internally.
- Reimplementing this in Effect HTTP would duplicate private SDK behavior and create upgrade risk.

### Existing Yolk coverage

- `packages/vercel-workflows/test/package-directives.integration.test.ts`
  - uses real `@workflow/vitest` transforms/runtime.
  - covers `start`, stream read, replay via `startIndex`, HITL resume, cancel.
- `packages/vercel-workflows/test/fixtures/workflow-fixture.ts`
  - package-owned `'use workflow'` / `'use step'` fixtures.
  - writes/ closes Workflow streams.
  - uses `createHook` and `sleep`.
- `examples/next/lib/agents/workflow-runtime/run-agent-workflow.test.ts`
  - source guard: no Effect runtime inside `'use workflow'` orchestration.
- Route model tests already cover HTTP headers, stream response, replay index parsing, cancel response.

## Non-goals

- No Vercel Workflow replacement.
- No direct Vercel backend calls.
- No custom Workflow `World` implementation.
- No Effect rewrite of `runVercelAgentWorkflow`.
- No app auth/HITL/token policy in public package.
- No package dependency on `@yolk-sdk/agent`, Next, DB, providers, or UI.

## Desired public API

Add a new public package subpath:

```txt
@yolk-sdk/vercel-workflows/effect
```

Effect service shape:

```txt
VercelWorkflows
  start(workflow, args)
  getRun(runId)
  getReadable(runId, options?)
  tailIndex(runId)
  resumeHook(token, payload)
  cancel(runId)
```

`start` and `getRun` return an Effect-native handle:

```txt
VercelWorkflowRun
  runId
  getReadable(options?)
  cancel
  status
  returnValue
```

Design constraints:

- Internally call only public `workflow/api` APIs.
- Return typed `Effect` errors.
- Preserve native `ReadableStream` return values.
- Avoid leaking raw Vercel `Run`; expose an Effect-native handle instead.
- Keep HITL token construction app-owned.
- Keep NDJSON response headers app-owned.

## Affected files

### Package

- `packages/vercel-workflows/src/effect.ts`
  - new Effect service/wrapper.
- `packages/vercel-workflows/package.json`
  - add `./effect` in `exports` and `publishConfig.exports`.
- `packages/vercel-workflows/README.md`
  - document Effect API and boundaries.
- `packages/vercel-workflows/AGENTS.md`
  - mention `./effect` if package-local rules need it.
- `packages/vercel-workflows/test/effect.test.ts`
  - fake unit tests for wrapper behavior/errors.
- `packages/vercel-workflows/test/package-directives.integration.test.ts`
  - add/convert tests to use Effect API with real workflows.
- `packages/vercel-workflows/test/fixtures/workflow-fixture.ts`
  - maybe add stricter stream/tail fixtures.

### Repo package checks

- `scripts/check-package-exports.ts`
  - add `./effect` expected export.
- `scripts/smoke-package-imports.ts`
  - smoke import `@yolk-sdk/vercel-workflows/effect`.

### Next example

- `examples/next/lib/layers.ts`
  - provide Workflow API layer if app routes consume the service.
- `examples/next/app/api/agent/workflow/route.ts`
  - replace direct `start(...)` with Effect service.
- `examples/next/app/api/agent/workflow/[runId]/route.ts`
  - replace direct `getRun`, `resumeHook`, `cancel`, tail-index logic with Effect service.
- `examples/next/app/api/agent/workflow/route-model.ts`
  - maybe simplify stream response types around service output.
- `examples/next/app/api/agent/workflow/[runId]/route-model.ts`
  - maybe simplify resolver helpers.
- route model tests
  - keep HTTP contract unchanged.

### Docs

- `apps/docs` package docs if `@yolk-sdk/vercel-workflows` is documented there.
- Package README update is mandatory for public subpath.

## External contract impact

Expected unchanged:

- `POST /api/agent/workflow`
- `GET /api/agent/workflow/:runId?startIndex=...`
- `POST /api/agent/workflow/:runId`
- `DELETE /api/agent/workflow/:runId`
- `application/x-ndjson` response bodies.
- `AgentEvent` line format.
- `x-workflow-run-id` header.
- `x-workflow-stream-tail-index` header.
- HITL request body: `{ hitlResponses: [response] }`.
- Client replay/de-dupe behavior.
- `runVercelAgentWorkflow(...)` API.

Changed:

- New package integration API: `@yolk-sdk/vercel-workflows/effect`.
- App route internals use Effect service instead of direct `workflow/api` calls.

## Strict test plan

### 1. Wrapper unit tests

File:

```txt
packages/vercel-workflows/test/effect.test.ts
```

Use fakes/mocks only. Cover:

- `start` calls SDK start with workflow + args.
- `start` returns typed run handle/run id.
- `getReadable` passes `startIndex` through.
- `tailIndex` calls `getTailIndex()`.
- `resumeHook` passes token and payload exactly.
- `cancel` calls the run cancel method.
- thrown/rejected SDK failures map to typed tagged errors.
- no `any`, no type assertions.

### 2. Real Workflow integration tests

File:

```txt
packages/vercel-workflows/test/package-directives.integration.test.ts
```

Use `@workflow/vitest` and real fixtures. Cover through the new Effect API:

- Start a real workflow and await `returnValue`/status.
- Stream chunks written by `'use step'` functions.
- Replay stream with `startIndex: 1` and get only later chunks.
- Tail index after stream writes is correct.
- Empty/tail case returns expected `-1` or no chunks, depending fixture.
- HITL: wait for hook, resume via Effect API, assert final state.
- HITL resume reads tail before resume and replay after tail.
- Cancel sleeping workflow and assert status/returnValue failure.

This is the critical safety gate.

### 3. App route model tests

Files:

```txt
examples/next/app/api/agent/workflow/route-model.test.ts
examples/next/app/api/agent/workflow/[runId]/route-model.test.ts
```

Keep coverage for:

- NDJSON headers unchanged.
- run id header unchanged.
- tail index header unchanged.
- response body streams unchanged.
- `startIndex` parsing strictness unchanged.
- cancel JSON unchanged.

### 4. Workflow orchestration source guard

File:

```txt
examples/next/lib/agents/workflow-runtime/run-agent-workflow.test.ts
```

Keep/extend coverage:

- No `Effect.runPromise` inside exported `'use workflow'` body.
- No `Effect.tryPromise` / Effect runtime helpers in orchestration body.
- Delegates to step callbacks.
- Uses `runVercelAgentWorkflow` unchanged.

## Verification commands

Minimum for package work:

```bash
pnpm --filter @yolk-sdk/vercel-workflows test
pnpm --filter @yolk-sdk/vercel-workflows test:workflow
pnpm packages:check
pnpm tsc
pnpm lint
```

If app routes/layers touched:

```bash
pnpm --filter @yolk-example/next check
```

If docs touched:

```bash
pnpm docs:check
```

Broad confidence before merge:

```bash
pnpm test:run
```

## Implementation phases

### Phase 0 — Plan only

- [x] Research Vercel Workflow public API.
- [x] Inspect SDK internals enough to reject direct backend rewrite.
- [x] Inspect current package integration tests.
- [x] Define test matrix.
- [x] Create this plan.

### Phase 1 — Package API + unit tests

- [x] Add `src/effect.ts` Effect service.
- [x] Add typed errors.
- [x] Add fakeable wrapper unit tests.
- [x] Add `./effect` package exports.
- [x] Update package export/smoke scripts.
- [x] Update README subpath docs.

### Phase 2 — Real Workflow integration tests

- [x] Extend `@workflow/vitest` integration tests to use new Effect API.
- [x] Add strict stream replay/tail assertions.
- [x] Add HITL resume assertions through wrapper.
- [x] Add cancel assertion through wrapper.

### Phase 3 — Next example adoption

- [x] Add route-local Workflow API layer.
- [x] Refactor start route to use Effect API.
- [x] Refactor run route to use Effect API.
- [x] Keep route HTTP contract unchanged.
- [x] Update route-model tests only as needed.

### Phase 4 — Docs/checks

- [x] Update docs if public package docs mention Workflow APIs.
- [x] Run required commands.
- [x] Record results here.

## Progress log

- 2026-07-01: Confirmed desired direction: Effect-native integration, not Vercel Workflow replacement.
- 2026-07-01: Confirmed app-visible protocol remains HTTP NDJSON.
- 2026-07-01: Confirmed Vercel backend protocol should stay SDK-owned/private.
- 2026-07-01: Confirmed existing `@workflow/vitest` coverage can be strengthened instead of rebuilt.
- 2026-07-01: Created plan file.
- 2026-07-01: Added `@yolk-sdk/vercel-workflows/effect` Effect service and fake SDK unit tests.
- 2026-07-01: Extended real `@workflow/vitest` integration tests through the Effect API.
- 2026-07-01: Refactored Next Workflow routes to consume `VercelWorkflows` via route-local layers.
- 2026-07-01: Updated package/docs subpath references for `./effect`.
- 2026-07-01: Renamed initial `./api` public subpath to `./effect` before release.
- 2026-07-01: Validation passed: package tests, real Workflow integration tests, Next check, package checks, docs check, package smoke after build, root `tsc`, lint, and `test:run`.
- 2026-07-01: Final post-rename broad validation and stale-name sweep passed.

## Validation log

- `pnpm --filter @yolk-sdk/vercel-workflows test` — passed.
- `pnpm --filter @yolk-sdk/vercel-workflows test:workflow` — passed.
- `pnpm --filter @yolk-example/next check` — passed.
- `pnpm packages:check` — passed.
- `pnpm docs:check` — passed.
- `pnpm build:docs` — passed.
- `pnpm tsc` — passed.
- `pnpm lint` — passed.
- `pnpm packages:smoke` — first failed before package build because `dist/api.mjs` did not exist; obsolete after rename to `dist/effect.mjs`.
- `pnpm packages:build && pnpm packages:smoke` — passed.
- `pnpm test:run` — passed.
- `git diff --check` — passed.
- Stale-name sweep for old `./api` symbols/files — passed.

## Risks

- Wrapper leaks raw `Run` too broadly and becomes a weak abstraction.
- Tests rely on fake SDK behavior but miss directive/runtime regressions.
- App route refactor accidentally changes HTTP headers/replay semantics.
- Tail index semantics differ between local world and Vercel production.
- Effect service accidentally gets used inside `'use workflow'` orchestration.

## Risk controls

- Integration tests must use real `@workflow/vitest` directives.
- Keep native `ReadableStream` at HTTP boundary.
- Keep route model tests for headers/resume/cancel.
- Keep source guard against Effect runtime in `'use workflow'`.
- Avoid direct dependency on SDK internals.

## Unresolved questions

- Tail empty semantics: assert `-1`?
