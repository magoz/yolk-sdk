# @yolk-sdk/harness

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
