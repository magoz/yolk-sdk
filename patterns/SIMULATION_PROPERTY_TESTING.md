# Simulation and Property Testing

Use deterministic simulation seams first, then let property tests explore them.

This pattern is inspired by the current opencode simulation branch:

- simulation lives near the code under test
- external effects are replaced at explicit boundaries
- all generated data is seeded
- reset/snapshot APIs make invariants observable
- first properties are small and boring, usually no-crash or state-safety checks

It also follows the testing principles in fast-check's JavaScript testing skill:

- https://github.com/dubzzz/fast-check/blob/main/skills/javascript-testing-expert/SKILL.md

Use that skill as the upstream reference for property-testing discipline: tests should find bugs, document behavior, prevent regressions, and challenge assumptions without becoming random oracles.

## Terms

| Term | Meaning | Question answered |
| --- | --- | --- |
| Simulation testing | Real code in a controlled fake world | Can this run deterministically without real external services? |
| Property testing | Generated inputs or action sequences checked against invariants | Can generated cases falsify this law? |
| Model testing | A small expected-state model run beside real code | Does implementation match the model after every step? |
| Invariant | A condition that must always hold | What must never be false? |

Simulation is the environment. Property testing is the exploration strategy. Model testing is one way to provide the oracle.

Best use:

```txt
property tests drive real code inside simulation and assert invariants after each step
```

## What to copy from opencode

### Simulation before property tests

opencode first builds deterministic seams:

- fake filesystem
- fake network
- fake provider/model
- fake renderer
- central reset/snapshot state
- seeded scripts and generated actions

Then generated actions can explore the system. Without controlled seams, property tests become flaky random tests.

### Keep overrides narrow

Replace external effects, not business logic.

Good seams:

- provider/model responses
- tool execution boundary
- approval/question adapter
- storage/session persistence
- clock/timeouts
- network clients
- filesystem/process spawning for tools

Bad seams:

- replacing the agent loop wholesale
- bypassing domain transitions
- asserting against mocks instead of real state transitions

### Seed and snapshot everything

Every generated run must be reproducible:

- generated command sequence seed
- generated schema payload seed
- fake provider script seed
- fake filesystem seed
- network response seed

Every simulation should expose enough state to debug:

- `reset`
- `snapshot`
- execution log
- pending approvals/questions
- persisted state snapshot
- generated command trace

## Tooling

Use existing test stack:

- `vitest`
- `@effect/vitest`
- `effect`
- Effect `Schema.toArbitrary()`

Add `fast-check` only when command/model testing needs direct generators or shrinkers beyond `@effect/vitest` helpers.

Effect v4 already supports schema-derived arbitraries:

```ts
import { Schema } from "effect"

const inputArbitrary = Schema.toArbitrary(ToolInputSchema)
```

Use schema-derived arbitraries for data. Use explicit command generators for stateful flows.

`@fast-check/vitest` can be considered later if we want native Vitest fixtures for generated values. Do not add it by default while `@effect/vitest` covers Effectful properties.

## Property-writing guidelines

Property tests are for claims containing "always" or "never".

Good examples:

- rejected approvals never execute tools
- stale replies never mutate live state
- schema normalization is always idempotent
- persisted state always decodes after each generated operation

Property tests and example tests are complementary:

- example tests document key workflows and representative scenarios
- property tests challenge invariants over many generated cases

Start each area with documenting example tests, then add property tests for invariants and edge cases.

### JavaScript testing expert rules we adopt

From the fast-check JavaScript testing skill, keep these rules in force:

- Test through public behavior, not internals.
- Prefer stubs/fakes at boundaries over mocks and call-count assertions.
- Avoid network, real clocks, random values, and platform-dependent behavior in tests.
- Keep tests focused; one property defends one behavior class.
- Use example tests first for documentation, then properties for edge cases and invariants.
- Do not try to replace all examples with properties; they are complementary.
- Make sure a test fails if the behavior named by the test is removed.
- Keep helper functions small, explicit, and single-purpose; avoid all-purpose `prepare` helpers.
- Use realistic data in example tests when it improves readability.
- Avoid snapshots unless the captured shape is exactly what matters.

### Generators

- Do not over-constrain generated values unless the domain requires it.
- Avoid `maxLength`, `min`, `max`, or small arrays just to make tests convenient.
- Use domain constraints only when they are real requirements.
- Prefer generator options or `map` over `.filter`/preconditions.
- Prefer constructed values with known expected characteristics over arbitrary raw inputs.
- Generate mostly meaningful states, with deliberate invalid/stale cases for safety checks.
- Do not recreate the production algorithm inside the property assertion.
- If a trace cap is needed for runtime cost, document that it is a test-budget cap and stress with `PROPERTY_RUNS`.

Good:

```ts
const response = ToolApprovalResponse.make({
  requestId: mismatch === 'requestId' ? 'approval:stale' : 'approval:call_1',
  toolCallId: mismatch === 'toolCallId' ? 'stale' : 'call_1',
  decision,
  source
})
```

Bad:

```ts
Schema.String.pipe(Schema.maxLength(5)) // unless five chars is a real domain limit
```

### Assertions

- Assert characteristics, not full generated output when the exact output is not the point.
- Prefer invariants: no execution, no mutation, no duplicate terminal state, no illegal graph shape.
- Keep assertions focused; one property should defend one behavior class.
- Print or preserve replay data when a failure occurs: seed, command trace, real snapshot, model snapshot.
- Avoid asserting incidental call counts unless the count is the user-visible contract.

### Async/race properties

For async ordering bugs, use deterministic scheduling when possible.

Useful targets:

- concurrent HITL submissions
- overlapping session appends
- provider/tool races
- retry/abort ordering
- queued workflow resumes

If direct `fast-check` is added, consider `fc.scheduler()` for async race exploration. Keep Effect `TestClock` for time-based behavior.

## Organization

Do not create a shared package first. Put simulation near the tested domain.

Package-owned tests:

```txt
packages/agent/test/
  property/
    hitl.property.test.ts
    runtime-hitl.simulation.test.ts
    session-event.property.test.ts
    tool-schema.property.test.ts
    property-options.ts
```

Next app-owned tests:

```txt
examples/next/lib/**
  *.property.test.ts
  *.simulation.test.ts
```

Cloudflare-owned tests:

```txt
cloudflare/agent/test/
  property/
  simulation/
```

Promote reusable helpers only after repeated use across multiple areas:

```txt
test/property/
  options.ts
```

Avoid `packages/testing` until at least three domains need the same helpers.

## Naming

- `*.property.test.ts` — generated property/model tests
- `*.simulation.test.ts` — deterministic simulation seam tests
- `test/property/*` — property specs
- `test/simulation/*` — fake world, model, command generators, harnesses

## Best Yolk targets

### 1. HITL approvals/questions

Highest-value pilot.

State space:

- request approval
- approve
- reject
- abort
- timeout
- reload persisted state
- stale reply
- concurrent pending requests

Properties:

- rejected tools never execute
- stale replies never affect a new request
- terminal requests never change terminal state
- pending IDs are unique
- abort clears or terminalizes pending state according to domain rule
- reload preserves pending/terminal state
- every executed tool has a prior approval when approval was required

### 2. Tool schema provider compatibility

Good schema-derived generation target.

Properties:

- provider-normalized schema contains only supported features
- normalization is idempotent
- valid generated inputs decode at the internal boundary
- unsupported schema features fail before provider call
- tool names/descriptions remain provider-safe

### Tool registry rollout

Tool registry properties should compare resolved tool sets to a tiny model of enabled registrations.

Useful invariants:

- duplicate enabled tool names fail resolution
- disabled gated tools are absent from tool definitions and metadata
- metadata preserves module id, tool name, and access for enabled tools
- unknown or disabled tool execution fails with `not_found`
- enabled unique tools execute with the original tool call id

### Tool batch rollout

Loop tool batch properties should focus on lifecycle pairing and call/result identity.

Useful invariants:

- successful batches emit one start and one completion for every call
- completion result `toolCallId` matches the original call id
- completion content matches executor output for that tool
- execution failures emit start then error, and never emit completion for that failed call
- tool errors preserve the failing tool name/cause at the stream failure boundary

### Client reducer rollout

Client reducer properties should tolerate defensive/out-of-order event sequences, but still enforce structural invariants.

Useful invariants:

- duplicate event ids are idempotent
- tool runs stay unique by tool call id
- at most one active run exists per generated single-call scenario
- terminal HITL states are inactive and idempotent
- done states clear live messages when `AgentEnd` is the terminal event under normal event ordering
- starting a new user message clears `seenEventIds` and prunes non-completed tool runs
- error/abort transitions prune active tool runs and preserve completed tool history

### Provider stream and retry rollout

Provider stream properties should exercise real loop turn handling with a scripted provider boundary.

Useful invariants:

- valid provider streams emit exactly one `LLMStreamEnd`, `AssistantMessage`, and `TurnEnd`
- `LLMStreamStart` precedes provider-mapped deltas; `LLMStreamEnd` precedes `AssistantMessage`; `AssistantMessage` precedes `TurnEnd`
- generated text/reasoning/usage/tool-call fragments map to matching client-facing event counts
- exactly one provider `Done` event is required
- `Done.stopReason` is derived from host tool calls: `tool_use` when any host tool call exists, otherwise `stop`
- missing, duplicate, or wrong-reason `Done` fails with `LLMError { cause: "invalid_response" }`
- retryable pre-emission provider failures retry up to `maxRetries`
- non-retryable failures, `context_overflow`, and post-emission failures never retry

### Cloudflare storage parity rollout

Cloudflare adapter properties should keep Durable Object storage behavior matched to the package runtime append-log model.

Useful invariants:

- current or absent expected revisions append exactly like `appendRuntimeSessionEventsToLog`
- stale expected revisions fail with `SessionConflictError` and do not mutate storage
- reconnect interruption appends `RunInterrupted` only for the latest incomplete run
- durable revisions remain equal to event count after every generated operation
- durable log snapshots equal the pure package model after every step
- direct WebSocket input/HITL paths reject active-run conflicts without mutation
- stale WebSocket `expectedRevision` values fail with conflict and leave durable state unchanged
- duplicate or mismatched HITL responses never resume a terminal or unrelated request

### 3. Agent session/message/event model

State space:

- user messages
- assistant deltas
- tool calls
- tool results
- aborts
- retries
- compaction/summarization
- persistence/reload

Properties:

- message order is stable
- every tool result references an existing tool call
- terminal events are not duplicated
- counters never go negative
- persisted state decodes after every generated operation
- revert/unrevert preserve legal graph shape

### 4. File/write/edit/patch tools

Useful once tool execution boundaries are stable.

Properties:

- no write escapes workspace
- failed edit leaves file unchanged
- successful edit matches the model
- read after write returns written content
- patch either applies exact expected change or leaves state unchanged

## First pilot plan

Pilot: HITL approval/question model tests.

### Phase 1 — inventory

- Locate package/app ownership for HITL state and transitions.
- List all commands that mutate approval/question state.
- List all observable state needed for invariants.
- Decide which boundaries need fake services.

Deliverable: short note in the property test file header or local `README.md`.

### Phase 2 — deterministic simulation seam

Add local test-only harness:

```txt
test/simulation/
  hitl-model.ts
  hitl-commands.ts
  fake-tool-runner.ts
  harness.ts
```

Harness responsibilities:

- construct test layers
- expose `reset`
- expose `snapshot`
- record executed tools
- optionally persist/reload in memory

Keep implementation local to the first domain.

### Phase 3 — model and commands

Create a minimal model with only state needed for invariants:

```txt
pending approvals
terminal approvals
executed tool IDs
aborted sessions
```

Commands should be explicit and small:

```txt
requestApproval
approve
reject
abort
timeout
reload
replyStale
```

Generate mostly valid commands, but include some invalid/stale commands because they encode important safety properties.

### Phase 4 — first properties

Start with low `numRuns` in normal tests.

Initial invariants:

- no rejected tool executed
- no stale reply mutates live state
- no duplicate pending IDs
- reload snapshot equals model state
- no unhandled defect during any command

### Phase 5 — replay and stress mode

On failure, print:

- seed
- command index
- command trace
- real snapshot
- model snapshot

Normal test run stays cheap. Add opt-in stress by env:

```txt
PROPERTY_RUNS=1000 pnpm test:run
```

Package-local property tests should share a tiny test-config helper instead of repeating run counts. This helper is an approved test boundary; keep `process.env` reads out of package runtime code.

```ts
const defaultPropertyRuns = 50
const propertyRunsEnv = process.env.PROPERTY_RUNS
const parsedPropertyRuns = propertyRunsEnv === undefined ? defaultPropertyRuns : Number(propertyRunsEnv)

export const propertyRuns = Number.isInteger(parsedPropertyRuns) && parsedPropertyRuns > 0
  ? parsedPropertyRuns
  : defaultPropertyRuns

export const propertyOptions = { fastCheck: { numRuns: propertyRuns } }
```

Keep the default low in regular validation; raise only for local or scheduled stress.

## First rollout findings

The first HITL properties found two real bugs quickly:

- Loop matching accepted responses when either `requestId` or `toolCallId` matched. Correct rule: both must match.
- Runtime accepted stale or duplicate terminal HITL responses and appended them to the session log. Correct rule: append only when the response matches the latest active `RunAwaitingInput` request.

Useful first properties:

- matching approval executes iff approved
- stale approvals/questions never execute or answer pending work
- mismatched approval/question IDs never affect pending work
- stale/duplicate runtime responses return conflict and leave event logs unchanged
- mixed pending HITL requests stay isolated until each matching response arrives

These worked because the fake provider, fake tool executor, and in-memory session store let the real loop/runtime run deterministically while external boundaries stayed controlled.

## Session event model rollout

Session event properties should stay mostly pure and exercise append-log helpers first.

Useful invariants:

- appended revisions are contiguous and monotonic
- stored event IDs match `sessionId:revision`
- replayed transcript messages match only input, completed, and awaiting events
- replayed HITL responses match only appended HITL response events
- latest incomplete run ignores completed, awaiting, failed, and interrupted runs
- stale expected revisions fail and leave the in-memory log unchanged
- generated append sequences accept only current/no expected revisions and keep the real log equal to a small model after every step

## Test shape

Prefer `@effect/vitest` for Effect programs. Use direct `fast-check` if command shrinkers are needed.

Conceptual shape:

```ts
it.effect.prop(
  "HITL invariants hold",
  [CommandSequenceSchema],
  (commands) =>
    Effect.gen(function* () {
      const model = HitlModel.empty
      const harness = yield* HitlHarness.Service

      for (const command of commands) {
        yield* harness.apply(command)
        HitlModel.apply(model, command)
        yield* harness.assertInvariants(model)
      }
    }),
  propertyOptions,
)
```

If command generation needs state-aware shrinking, switch the generator to direct `fast-check` and keep the execution body as an Effect.

## Guardrails

- Never test random behavior without an invariant.
- Never mock the logic under test.
- Keep generators biased toward meaningful states.
- Include invalid/stale commands deliberately, not accidentally.
- Use property tests for always/never claims; use examples for documentation.
- Do not over-constrain arbitraries for convenience.
- Keep CI runs cheap; stress locally or nightly.
- Prefer local harnesses before global abstractions.
- Failing property tests are useful only if their replay is clear.

## Resolved pilot decisions

- HITL pilot lives in `@yolk-sdk/agent`; app tests can add app-specific policy later.
- Start with `@effect/vitest` props and `Schema.toArbitrary()`; add direct `fast-check` only for state-aware shrinkers/schedulers.
- First invariant set covers matching, stale/mismatched IDs, duplicate terminal responses, and mixed pending isolation.
