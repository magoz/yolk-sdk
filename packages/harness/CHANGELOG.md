# @yolk-sdk/harness

## 0.1.0-canary.83

### Patch Changes

- Advance unchanged public packages in lockstep with the agent's Vercel AI Gateway DeepSeek thinking-parameter fix. These packages have no direct implementation changes in this release; keep all `@yolk-sdk/*` dependencies on the same canary version.
- Updated dependencies [245e0b0]
  - @yolk-sdk/agent@0.1.0-canary.83

## 0.1.0-canary.82

### Patch Changes

- 79a074a: Add schema-backed typed input interactions through the existing HITL lifecycle. `makeInputTool`
  keeps original call/response validators server-side while serializable descriptors identify app-owned
  renderers. Hosts pass resolved input handlers to loop/runtime configs; input requests support submit,
  cancel, validation correction, and first-valid-response replay without authorizing actions.

  Preserve question compatibility, add HTTP/WebSocket and headless React input submission/projection,
  and match input responses in harness outcomes. Input tools reject approval/background policy and
  direct execution; voice remains approvals-only. React waits for server acceptance before creating
  replayable results, including across failed submissions and pending-state hydration.

- Updated dependencies [16fa58c]
- Updated dependencies [79a074a]
  - @yolk-sdk/agent@0.1.0-canary.82

## 0.1.0-canary.81

### Patch Changes

- 0fae398: Advance the unchanged public packages in lockstep with the agent chat-stream diagnostics and Microsoft Outlook connector fixes. These packages have no direct implementation changes in this release; keep all `@yolk-sdk/*` dependencies on the same canary version.
- Updated dependencies [9f85933]
  - @yolk-sdk/agent@0.1.0-canary.81

## 0.1.0-canary.80

### Patch Changes

- Updated dependencies [82c3cad]
- Updated dependencies [df007e7]
- Updated dependencies [b3acb64]
  - @yolk-sdk/agent@0.1.0-canary.80

## 0.1.0-canary.79

### Minor Changes

- 746648a: Introduce selected branded identities while preserving string wire representations. This is a breaking pre-1.0 TypeScript API migration for hosts constructing the affected inputs or implementing adapters.

  - Knowledge scope/document references use `KnowledgeScopeId` and `KnowledgeDocumentId` from `@yolk-sdk/knowledge/documents`, including store, chunking, ingestion, and search contracts. Decode external/persisted IDs with their schemas; construct trusted constants with `.make`.
  - Harness Inbox/Driver lifecycle contracts distinguish `DrainToken` and `ParkGeneration` from `@yolk-sdk/harness/inbox`. Forward live returned values. These brands deliberately accept arbitrary strings and do not replace freshness, instance, or run-ownership checks.
  - Sandbox `normalizeWorkspaceCwd` returns `NormalizedWorkspaceCwd`, exported from the root. Raw command cwd inputs remain strings; normalization preserves directory-name whitespace and proves lexical shape only, not filesystem confinement.
  - Fortnox file discovery uses canonical `FortnoxGivenNumber` in both input and metadata; nonnumeric metadata is rejected. Invoice previews require `FortnoxDocumentNumber` and share invoice-read validation plus URL encoding rather than archive-ID restrictions. Archive IDs remain strings.
  - `defineAction` returns additive `TypedConnectorAction` with `executeTyped`, accepting and validating decoded input without replaying wire transforms, and retaining output types. Existing dynamic `execute`/`invoke` paths remain compatible. Implementations still validate external output data.

  Brands do not establish authorization or ownership. No database schema migration or agent-protocol ID changes are required.

### Patch Changes

- 3c243ee: Align all public SDK packages for the Go Responses replay fix and the branded-identity TypeScript migration. MCP and Vercel Workflows have no direct API or runtime changes in this release; they advance with the fixed SDK package group.
- Updated dependencies [3c243ee]
- Updated dependencies [2ab26c7]
  - @yolk-sdk/agent@0.1.0-canary.79

## 0.1.0-canary.78

### Minor Changes

- 5ff44d6: Export canonical tagged constructors on existing subpaths: `PlainHitlResponse` and `RuntimeRequest` values, React chat ADTs, harness inbox/outcome/`StopDecision` companions, knowledge source/scope `.make`, and workflow `WorkflowStepResult` / `VercelAgentWorkflowRunResult`.

  `Data.taggedEnum` values are plain objects with `_tag` last, not Equal/Hash classes. Prefer constructors over handwritten `{ _tag }` objects and omit absent optionals.

- 5ff44d6: Upgrade the coordinated Effect runtime and platform dependencies to 4.0.0-rc.115. Hosts must use the matching Effect version.

  Adopt rc.115 schema-order construction, including `_tag` first: JSON field values and optional presence remain unchanged, but serialized property order can change. Schema errors now use the rc.115 native Error/SchemaIssue representation. Preserve strict Calendar boundary validation, closed empty tool schemas, portable custom JSON Schema output, and explicit WebSocket close semantics.

  Contributor property tests use native Effect arbitraries and Vitest 5. See the migration guide for API replacements and JSON Schema definition-name changes.

- 5ff44d6: **Breaking type imports** (runtime and wire unchanged; no compatibility aliases):

  - `LoopConfigShape` → `LoopConfigSettings` from `@yolk-sdk/agent/loop`
  - `RunStoreShape` → `RunStoreApi` from `@yolk-sdk/harness/store`
  - `InboxShape` → `InboxApi` from `@yolk-sdk/harness/inbox`
  - `DriverShape` → `DriverApi` from `@yolk-sdk/harness/driver`

  ```ts
  import type { LoopConfigSettings } from "@yolk-sdk/agent/loop";
  import type { RunStoreApi } from "@yolk-sdk/harness/store";
  import type { InboxApi } from "@yolk-sdk/harness/inbox";
  import type { DriverApi } from "@yolk-sdk/harness/driver";
  ```

### Patch Changes

- 5ff44d6: Move service construction into owning static layer factories (`RunStore.inMemoryLayer`/`snapshotLayer`, `Inbox.layer`, `RunCoordinator.layer`, `Driver.layer`) with the public `make*` factories delegating; model step outcomes with `Data.taggedEnum` constructors.
- Updated dependencies [5ff44d6]
- Updated dependencies [5ff44d6]
- Updated dependencies [00e4d60]
- Updated dependencies [5ff44d6]
- Updated dependencies [5ff44d6]
- Updated dependencies [5ff44d6]
- Updated dependencies [5ff44d6]
- Updated dependencies [5ff44d6]
- Updated dependencies [5ff44d6]
- Updated dependencies [5ff44d6]
- Updated dependencies [5ff44d6]
- Updated dependencies [5ff44d6]
  - @yolk-sdk/agent@0.1.0-canary.78

## 0.1.0-canary.77

### Minor Changes

- 0b008d8: Add `@yolk-sdk/harness` with a process-local run coordinator, RunStore/Inbox/Driver contracts, in-memory driver, snapshot Durable Object claim driver, inbox admit, bounded claim resume, and loop step outcomes.
- 0ef7acd: Add Inbox/Driver HITL pause, resume, and user-stop on the existing coordinator, with payload-free park tokens and outcome protocol-match helpers. Memory Inbox waiting state is process-local, including Durable Object snapshot-claim factories.

  Canary API tightening: `Inbox.takePromotable(runId, scope, drainToken)` requires the live drain token (same explicit-token rule as `park`) and checks ownership atomically with dequeue. Missing, empty, inactive, stale, or wrong-run tokens do not take an item. There is no optional/unchecked take. `beginDrain(runId, scope)` and `wakeIfUnblocked(runId, scope, wake)` record/consume scope-aware pending intent; input subsumes steer, and a steer drain does not consume a later input wake.

- 4198aa7: Admit in-process restart recovery through the existing Inbox gate with current-key eligibility, a validated finite resume budget, and host-owned HITL re-parking via Driver.run/pause.

  Optional factory configuration remains forwardable (`options?: DriverLayerOptions`). Omitted or explicit `undefined` `maxResumeAttempts` stays infallible (`E = never`); a numeric or `number | undefined` config types `InvalidMaxResumeAttempts`.

  `resumeSuspended` is an explicit finite sweep: serialize concurrent calls, recheck live claim and coordinator activity at admission, charge or exhaust before granting pending input, and never wait for drain settlement while holding that gate. `Driver.stop` captures `terminalStop` under that same Inbox `invalidate` gate so a stale Idle receipt cannot release a live recovered owner's claim. Invalid `maxResumeAttempts` fails Layer init. Automatic failed-start settlement does not release a prior or unacquired claim. Explicit user interruption or `Driver.stop` still releases an existing leftover claim after that owner has actually settled. Wake/resume schedule work; awaitIdle is quiescence; run observes failures. Persisted partial HITL responses are re-admitted only against a fresh park.

- 7827908: Classify one model-turn attempt into Compacted, Retry, Continue, and RecoverFull without adding an outer retry loop; configured loop/provider retries still apply.

  `attemptModelTurn` isolates state per Effect execution. Incomplete streams recover only via kernel `responseIssue: 'missing_done'`. Continue keeps partial text/reasoning/completed calls without new IDs or tool execution. Durable overflow compact is persist-then-retry through `overflowCompactionAttempt` (once per logical step). Sink, compact, Abort, and mixed defect/interrupt Causes are not classified as provider failures. Hosts that own physical-attempt scheduling should use `LoopConfig.maxRetries: 0` and skip retry decorators.

### Patch Changes

- 6b9c60b: Release all seven public packages together.

  This canary introduces `@yolk-sdk/harness` run lifecycle and related agent loop composition, collection, Codex missing-final-output, and overflow-after-output changes. `@yolk-sdk/connectors`, `@yolk-sdk/knowledge`, `@yolk-sdk/mcp`, `@yolk-sdk/sandbox`, and `@yolk-sdk/vercel-workflows` are unchanged except for lockstep compatibility.

- 7827908: Publish snapshot RunStore claims only after durable save succeeds. Tool-batch Completed now continues when tools executed; pending HITL still fences mixed execution.
- 4198aa7: Acknowledge Coordinator interruption when the interruption-request fiber is joined: that receipt means the stop was delivered, not that the owner has settled. LiveStopping reuses the same outstanding request. Explicit whole `undefined` factory options keep `E = never`.
- 4e2099f: Carry Coordinator settlement as a successful `Exit` payload and flatten it at public waiters so interruption can reach every observer on Effect 4.0.0-beta.80. This does not globally fix native `Deferred.done`.
- Updated dependencies [978ea8f]
- Updated dependencies [978ea8f]
- Updated dependencies [7827908]
- Updated dependencies [6b9c60b]
  - @yolk-sdk/agent@0.1.0-canary.77
