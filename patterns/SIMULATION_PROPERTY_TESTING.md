# Simulation and Property Testing

Use deterministic simulation seams first, then let property tests explore them. Keep simulations
near the tested domain, replace external effects at explicit boundaries, seed generated data, expose
reset/snapshot state, and start with small state-safety properties.

## Terms

| Term               | Meaning                                                         | Question answered                                              |
| ------------------ | --------------------------------------------------------------- | -------------------------------------------------------------- |
| Simulation testing | Real code in a controlled fake world                            | Can this run deterministically without real external services? |
| Property testing   | Generated inputs or action sequences checked against invariants | Can generated cases falsify this law?                          |
| Model testing      | A small expected-state model run beside real code               | Does implementation match the model after every step?          |
| Invariant          | A condition that must always hold                               | What must never be false?                                      |

Simulation is the environment. Property testing is the exploration strategy. Model testing is one way to provide the oracle.

Best use:

```txt
property tests drive real code inside simulation and assert invariants after each step
```

## Simulation seams

Build deterministic seams first:

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
import { Schema } from 'effect'

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

### Property discipline

Keep these rules in force:

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

## High-value targets

| Area                     | Example invariants                                                                   |
| ------------------------ | ------------------------------------------------------------------------------------ |
| HITL                     | Rejected/stale/mismatched responses never execute or mutate; terminal stays terminal |
| Tool schemas/registry    | Normalization is idempotent; unsupported schemas fail; enabled names stay unique     |
| Tool batches             | Start/result/error lifecycle pairs preserve call identity                            |
| Client reducer           | Duplicate event IDs are idempotent; active/terminal tool and HITL state stays legal  |
| Provider streams/retries | Terminal events occur once and in order; retry policy never widens                   |
| Session/event storage    | Revisions are monotonic; stale writes do not mutate; replay matches the pure model   |
| File mutation tools      | Writes stay in workspace; failed mutations are atomic                                |

Keep provider-, package-, app-, and Cloudflare-specific expected values beside their tests. The
shared pattern owns only the method: generated domain inputs/actions, a small model, observable
state, and invariants checked after each step.

## Replay and stress runs

On failure, preserve the generated seed, command index/trace, real snapshot, and model snapshot. Keep
normal validation cheap; package-local property areas may share a test-only `PROPERTY_RUNS` helper.
That env read is allowed only in test config, never package runtime code.

```txt
PROPERTY_RUNS=1000 pnpm test:run
```

## Test shape

Prefer `@effect/vitest` for Effect programs. Use direct `fast-check` if command shrinkers are needed.

Conceptual shape:

```ts
it.effect.prop(
  'HITL invariants hold',
  [CommandSequenceSchema],
  commands =>
    Effect.gen(function* () {
      const model = HitlModel.empty
      const harness = yield* HitlHarness.Service

      for (const command of commands) {
        yield* harness.apply(command)
        HitlModel.apply(model, command)
        yield* harness.assertInvariants(model)
      }
    }),
  propertyOptions
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
