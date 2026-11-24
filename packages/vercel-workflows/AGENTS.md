# Vercel Workflows

Vercel Workflow-backed agent loop primitives. Package stays Vercel-specific but product-agnostic.

## Role

- Own durable Workflow orchestration contracts over model/tool steps.
- Keep continuation state plain serializable wire data.
- Coordinate model-step, tool-batch-step, close, and error callbacks.
- Carry generic awaiting-input wire data between host tool steps and Workflow hooks.
- Provide deterministic durable stream event id sequencing for JSON-serializable events.
- Provide contract tests for Workflow lifecycle without app auth/provider/tool/UI coupling.

## Boundaries

- No Next routes, server actions, auth, telemetry, provider adapters, app tools, DB, or UI.
- No product transcript persistence; host app owns storage/resume policy beyond Workflow execution stream.
- Host app supplies product route/auth/provider/tool wiring; package-owned `'use workflow'` / `'use step'` exports are allowed only with `@workflow/vitest` coverage.
- Keep Effect runtime work out of workflow orchestration helpers; Effect may run inside host/package step callbacks.
- Import Workflow orchestration APIs from `@yolk-sdk/vercel-workflows`; `./workflow` remains an explicit equivalent subpath.
- Effect-native Workflow client/layer lives under `./effect`: `VercelWorkflows.layer` wraps public `workflow/api`; `VercelWorkflows.layerFromSdk` is the fake SDK seam. `start` forwards only `attributes` from the SDK's start options (`VercelWorkflowStartOptions`); add others there when a host needs them, never as a pass-through of the SDK type.
- `./testing` ships `TestWorkflowWorld`: a behavioral platform emulator (run lifecycle,
  append-only durable streams with write-after-close -> 409 conflicts and idempotent close (as
  `@workflow/world-vercel`), retrying step executor, hooks/resume, cancellation, `sdk.start`
  attributes checked with the installed `@workflow/world` validator and shown in `inspect`) plus
  `testWorkflowModule` for mocking the ambient `workflow` module.
  Its step executor stores every step error with the installed `workflow` runtime's own serializer
  (`@workflow/core/serialization`, resolved through `workflow` natively so `vi.mock('workflow')`
  never replaces it) and throws only the value read back, with the platform's FatalError rules
  (duck-typed `FatalError.is`, AbortError promoted, no retry; exhausted steps wrapped). Only the
  serializer's `SerializationError` means unstorable: such a value is retried as the platform's
  redelivery is, then the step fails with "exceeded max retries" (no cause), and it is recorded in
  `unstorableStepErrors`; any other serializer failure is an emulator fault and throws. Loading that
  serializer makes step execution need the node vitest environment. Keep it as faithful as the
  platform: hosts rely on it to see what a deployment does to their errors.
- Requires `workflow@^5.0.0-beta.42` (region-pinned runs; the 4.x backend was `iad1`-only and
  cross-region streaming arrived in multi-second bursts). v5's hardened serialization captures
  Node `URL` intrinsics at import and rejects jsdom's URL shape: any test whose import graph
  reaches the `workflow` package must run in a node vitest environment, never jsdom (this repo's
  root jsdom vitest excludes `packages/**` for exactly this reason).

## Design Rules

- Workflow inputs/state use `unknown` wire payloads after host encoding.
- Awaiting-input state stays `unknown` payloads; host app owns HITL hook tokens and response validation.
  Document that each pause needs its own token, that `resumeHook` success does not mean the
  payload was read (a live hook accepts every payload; the rest drop on dispose), and that an
  answer names its pause (its `AgentAwaitingInput` `eventId`); request ids alone are ambiguous. The loop does not
  refuse a reused token: hosts that key tokens per run or by pending request id would fail runs
  that today only risk a late duplicate.
- `TestWorkflowWorld` hooks match the platform: every resume of a live hook succeeds, `await hook`
  reads the first payload, a disposed hook or ended run answers `HookNotFoundError`, and a freed
  token can be taken by a later hook of any run. The platform creates a hook at its run's next
  suspension, after the run's disposals since; the emulator decides once the creating code yields.
  A token another live hook (any run, its own included) still holds then is refused: awaiting the
  new hook fails with `TestWorkflowHookConflictError`, and its dispose never frees the holder's
  token. Unlike Vercel, a non-suspending `await` before the holder's disposal still refuses, and a
  dispose frees the token at once (Vercel records it at the next suspension).
- Durable event helpers are pure/Effect-native: `sequenceDurableAgentEvent`, `writeDurableAgentEvent`, and `commitThenWriteTerminalEvent`; hosts own storage policy.
- Host-provided durable `streamId`s must be scoped to one independent run/session; clients de-dupe
  by `eventId`, so duplicate ids across runs drop legitimate live events.
- Every execution of a step starts from the same `eventSequence`, so every event a model call
  produces (`LLMStreamStart` through `AssistantMessage`/`UsageUpdate`) needs an `executionId`
  unique per execution (`${stepId}:${attempt}` from `getStepMetadata()`; non-empty, trimmed, or
  sequencing throws). The sequencer appends it to the id and sets the event's `executionId` field
  and `executionTurn` (its `turn`, a non-negative safe integer or sequencing throws; it must equal
  the model call's `LLMStreamStart.turn`: clients that missed the start start the turn from it, and
  a lower turn drops the execution as stale), both removed without it, and, on every event,
  `streamId` (so a terminal event closes its own run),
  which `@yolk-sdk/agent` clients route by; without it a re-execution's different answer reuses the first one's ids and de-dupe splices
  them. Host events (promoted user messages, the terminal event written after the commit) never
  carry it, and a receipt replay rewrites only that terminal event. Without it ids are unchanged.
  Tool-batch steps are out of scope: their ids stay plain; only ledgered calls replay identically
  (read calls rerun).
- Terminal durable event helpers model commit-before-write ordering only; they never infer closure
  from an event tag or close writers. `closeStream` owns successful `AgentEnd` closure;
  `writeError` owns safe `AgentError` write plus failure closure; successful
  `AgentAwaitingInput` releases its writer lock but leaves the Workflow stream open for resume.
- Keep APIs Workflow-specific and free of app/provider/tool/storage policy.
- Preserve tool result order by original model tool-call order.
- A model result with `done: false` and no tool calls continues directly to the next model step; do not invoke a tool-batch step solely to continue host-promoted input.
- Tool batch steps must return one `ToolResultMessage` per host call, including failed `isError` results, before the next model step.
- Treat cancellation as host-observable state; do not assume Vercel preempts active steps.
- Keep max-turn guard explicit and terminal.
- Model/tool/await-input step retries are opt-in; their default is `noWorkflowStepRetry` (`maxAttempts: 1`) because streamed retries replay chunks. `eventId` de-dupe alone never makes a retried model step safe; its live events need an `executionId`. The close step defaults to `defaultCloseStreamRetry` (`maxAttempts: 3`, any rejection including `FatalError`): a Vercel close is idempotent, so a close-only step's retry writes nothing, and a close applied by an attempt that then failed ends `Completed` when a later attempt succeeds (`CloseStreamFailed` only once every attempt failed).
- Steps are still at-least-once (queue redelivery re-executes a step, also concurrently with a running first execution). Document that hosts must supply a durable tool ledger (`resolveTools(..., { ledger })` from `@yolk-sdk/agent/tools`) in their tool-batch steps; this package never builds tool sets or imports agent protocol, so it carries no ledger wiring.
- `runVercelAgentWorkflow` returns structured terminal status (`Completed`, step failures, `AwaitInputFailed`, `CloseStreamFailed`, `MaxTurnsExceeded`) even after writing errors.
- Destructure callback config before invoking workflow steps/hooks; hook suspension may serialize functions otherwise.
- Test observable runtime contract, not Vercel SDK implementation details.
- `./effect` tests must include fake SDK unit tests plus `@workflow/vitest` directive integration coverage.

## Tests

- Contract tests live under `test/`.
- Test-local rules live in `test/AGENTS.md`.
- Cover no-tool completion, tool continuation, HITL await/resume, tool ordering, step failure, retry policy, close failure, and max-turn guard.
- Run `pnpm --filter @yolk-sdk/vercel-workflows test:workflow` after touching package-owned directive fixtures.
- Use fake step callbacks for pure contract tests; use `@workflow/vitest` for real directive transform/start behavior.

## Cloudflare runtime

- `src/cloudflare/**` is a Vercel Workflow-compatible runtime on Durable Objects, exported as
  `./cloudflare` (`WorkflowRun`, `registerWorkflowModules`, `WorkflowExecution`, stores, errors),
  `./cloudflare/workflow` and `./cloudflare/api` (drop-ins hosts alias `workflow` and `workflow/api`
  to), `./cloudflare/directives` (what compiled directives import), and `./cloudflare/vite` (the
  `workflowDirectives` plugin). README "Cloudflare runtime" documents the semantics and wiring.
- It never imports `workflow`, `@workflow/*`, or the package's Vercel side (hosts alias `workflow`
  to it), and the Vercel side never imports it, `cloudflare:workers`, devalue, or Vite (both
  boundary-enforced). Type `cloudflare:workers` only through `src/cloudflare/cloudflare-workers.d.ts`
  (type check only, not shipped), never `@cloudflare/workers-types` (its globals clash with the DOM
  library); `vite` is an optional peer used for types only.
- Keep its semantics aligned with the platform: devalue serialization of values and errors
  (`fatal`, `retryAfter`, `cause`), at-least-once steps, `maxRetries` (default 3) with exhaustion
  wrapped in `FatalError`, journal keys `<kind>:<id>#<call count>` replayed in order, durable
  sleeps, deterministic default hook tokens. A journal or key format change strands in-flight runs.
- Hook tokens follow `TestWorkflowWorld`'s token rules (one live hook, undisposed and its run not
  ended, holds a token; a claim on a token another live hook holds journals the holder's run id and
  awaiting the hook rejects with `HookConflictError`) with different decision timing: the emulator
  decides once the creating code yields (a microtask) and frees a token at dispose; this runtime
  applies a run's disposals, then its new hooks' claims, once the body is idle (the next
  macrotask). README "Cloudflare runtime" lists what differs from Vercel.
- A run's `wf_hook` row (token -> journal key) is written once the index granted the claim (never
  for a hook disposed meanwhile) and deleted when the hook's disposal applies (a replayed dispose
  deletes it again); it counts as held only while the run has not ended. Rows from builds before
  canary.145 may predate a grant, so a replay claims again for a hook that has a row. Only a held
  hook takes payloads (a payload for a hook disposed in memory is dropped, never journaled);
  `hookHeld` also answers true while an undisposed hook of the run awaits the index's answer to its
  claim.
- The `hook:<token>` index decides claims one at a time (an in-memory chain; `hookHeld` never calls
  an index) and asks the run it names last (`hookHeld`, answered within 10 s or the claim fails
  undecided) before letting another run take the token, so a disposal or a run's end never has to
  reach the index. A failed claim is retried with the step backoff under the step guard alarm, never
  journaled; a disposal ends its wait. A run applies releases at once and chains claims per token,
  so a failing index holds up only its own token. Keep three rules together: one claim at a time
  per index, the row only after the grant, and `hookHeld` counting an undecided claim.
- All `./cloudflare*` modules share module state (`AsyncLocalStorage` scopes, the registry): one
  copy per Worker.
- Tests: `test/cloudflare-execution.test.ts` (execution over the memory store) and
  `test/cloudflare-runtime.test.ts` (`WorkflowRun` over `node:sqlite` through the `workflow/api`
  module, evictions, alarms, hooks, streams, cancel, lazy modules, the SQLite store, serialization,
  the directive compiler). The package Vitest aliases `cloudflare:workers` to
  `test/cloudflare-workers-stub.ts`; `test/cloudflare-fakes.ts` is the fake namespace.

## Independent children

- `orchestrateWorkflowToolBatch` and `awaitWorkflowChild` are Workflow-safe generic callback seams, exported from root and `./workflow`; no new subpath.
- Tool-batch callbacks may orchestrate separate steps/independent Workflow 5 `start` calls. Never wrap a complete child in one step; nested step calls from a step execute inline.
- `awaitWorkflowChild` supplies zero-based attempts to `read`/`sleep` for host-owned observation ceilings and capped backoff. Zero-argument callbacks/default unbounded behavior remain source-compatible; hosts must explicitly end long waits with a truthful still-running value at their ceiling.
- Hosts supply durable preflight/read/sleep callbacks, reservations/admission, ownership and tombstones. Child failures are values to the parent but must remain visible failures within the child boundary.
- `test/child-directives.integration.test.ts` covers independent physical child runs, internal model/tool steps, background parent completion/failure survival, and foreground defect isolation.
