# Testing Strategy

## Philosophy

### What to Test

**Test behavior, not implementation.**

Focus on:

- **Domain logic correctness** - business rules, validation, transformations
- **Error handling** - expected errors surface correctly, defects are caught
- **Service integration** - services compose correctly via layers
- **Edge cases** - boundary conditions, empty inputs, nulls
- **Time-dependent logic** - delays, retries, timeouts (via TestClock)

### What NOT to Test

Avoid testing:

- **Framework internals** - don't test Next.js/Effect internals
- **Type system** - TypeScript already validates types
- **Mock implementations** - tests should verify real behavior
- **UI snapshots** - fragile, low value for this stack
- **Private internals** - test public API only

### Testing Philosophy

> Every test should answer: "If this breaks, what user-facing behavior fails?"

If the answer is "nothing" or "just the implementation changed", delete the test.

## Test Seams

A seam is where a test enters the system: browser UI, HTTP route, server action, package API,
Effect service/layer, pure function, or simulation harness. Prefer the fewest stable seams that
prove behavior.

| Seam                    | Use for                                         | Coupling risk |
| ----------------------- | ----------------------------------------------- | ------------- |
| Browser/UI              | critical user/admin flows                       | lowest        |
| HTTP route/transport    | API, protocol, stream, webhook contracts        | low           |
| Server action           | parse/auth/revalidate/client union behavior     | medium        |
| Package public API      | SDK contracts and provider compatibility        | medium-low    |
| Effect service + layer  | business behavior over services/DB              | medium        |
| Pure function/model     | dense domain rules/invariants                   | medium-low    |
| Simulation harness      | state machines, retries, HITL/session workflows | medium        |
| Mocked module internals | external IO/framework seams only                | highest       |

Rules:

- Start from the outermost practical seam, then move inward only for speed, isolation, or precision.
- Prefer one behavior test through a stable boundary over many tests of private helper steps.
- Mock external services, not own-domain implementation details.
- If a behavior-preserving refactor breaks tests, the seam is probably too internal.

## Test Organization

### File Location

App tests are usually colocated with source files using `*.test.ts`. Package tests may either be
colocated or live in package-owned `test/*` areas when that package's `AGENTS.md` says so.

```
packages/agent/src/providers/anthropic/claude-provider.ts
packages/agent/test/providers/anthropic/claude-provider.test.ts

packages/agent/test/loop/run.test.ts
```

## Coverage

Do not chase a numeric target. Prioritize behavior, error paths, boundary cases, service composition,
and invariants; type declarations and framework internals need no runtime coverage.

## Test Types

| Type        | Use for                                       | Preferred boundary                         |
| ----------- | --------------------------------------------- | ------------------------------------------ |
| Unit/model  | Pure rules and focused service behavior       | Public function or service with fake Layer |
| Integration | Service composition, DB, and adapter behavior | Documented real test Layer/environment     |
| E2E         | Critical user flows                           | Owning app's browser suite                 |

Effect test mechanics live in `patterns/EFFECT_TESTING.md`. Next Playwright setup and conventions
live in `examples/next/patterns/E2E_TESTING.md`.

### Protocol and Transport Tests

**When:** Testing client protocols, stream parsing, subprocess/stdio, or HTTP transport adapters.

**Pattern:** Stay below Playwright. Use Effect layers for dependency injection and tiny deterministic fixtures for external processes.

- Mock HTTP with `HttpClient` layers, not global fetch or real ports.
- Use checked-in fixture servers for subprocess protocols when real stdio behavior matters.
- Keep fixtures minimal and test-only; raw JSON is acceptable inside fixtures that simulate external systems.
- Use Playwright only when asserting browser-visible UI behavior.

**Example:** MCP client tests use fake `HttpClient` layers for remote JSON/SSE and the reusable `@yolk-sdk/mcp/server` fixture in `packages/mcp/test/server/fixtures/fake-stdio-mcp-server.ts` for local stdio. MCP server tests cover public JSON-RPC/HTTP entrypoints and behavior errors: unknown methods/tools, invalid params, and tool failures.

### Action and Route Tests

**When:** Testing framework boundary behavior: parsing, auth, revalidation/cache, route protocol,
and client-facing result unions.

**Pattern:** Keep boundary tests thin. Move validation, normalization, state transitions, and retry
rules into pure model/service tests before adding many route/action edge cases.

- Test successful call/revalidation and recoverable failure contracts.
- Do not duplicate every Schema invalid-input case across every action.
- Mock only external framework/protocol seams: cookies/cache, workflow runtime, provider IO, webhooks.
- Avoid mocking several own modules to test one action; that means the seam is too internal.

### Property and simulation tests

Use properties for always/never laws and simulations for stateful workflows. Prefer domain commands
over implementation calls and assert invariants after each step. See
`patterns/SIMULATION_PROPERTY_TESTING.md` for generators, replay, stress runs, and model seams.

### Effect service fakes

Replace external boundaries, not own-domain logic. Build typed fake Layers with configurable
behavior and observable state; share a Layer only when tests remain isolated. See
`patterns/EFFECT_TESTING.md` for current `@effect/vitest`, clock, Layer, and error patterns.

## Test Commands

| Command            | Description                      | Use When               |
| ------------------ | -------------------------------- | ---------------------- |
| `pnpm test`        | Run tests in watch mode          | Development            |
| `pnpm test:run`    | Run all tests once               | CI or pre-commit       |
| `pnpm test:e2e`    | Run Playwright E2E tests         | Full flow validation   |
| `pnpm test:e2e:ui` | Run E2E tests with Playwright UI | Debugging E2E failures |

**Pre-commit checklist:**

1. `pnpm test:run` - unit tests pass
2. `pnpm tsc` - types pass
3. `pnpm lint` - no lint errors

## Anti-Patterns

### Flaky Tests

Treat one flaky test as suite trust = 0.

1. Quarantine or narrow immediately to preserve signal.
2. Document failure mode, env, traces/logs, last stable step.
3. Reproduce isolated with minimum app/deps.
4. Fix or rewrite from intended behavior.
5. Delete if still untrusted.

### General

| Anti-Pattern                      | Why Bad                              | Do Instead                                    |
| --------------------------------- | ------------------------------------ | --------------------------------------------- |
| Testing private functions         | Couples tests to implementation      | Test public API                               |
| Mocking everything                | Tests don't catch integration issues | Use real services when reasonable             |
| Snapshot tests for UI             | Fragile, hard to maintain            | Test behavior, not markup                     |
| No error case tests               | Production errors surprise you       | Test all domain error paths                   |
| 100% coverage goal                | Wastes time on low-value tests       | Focus on high-risk code                       |
| Undocumented separate `/test` dir | Hard to find relevant tests          | Colocate or document package-owned test areas |
| Skipping integration tests        | Services might not compose           | Test critical integrations                    |
| Not using TestClock               | Tests are slow and flaky             | Use `it.effect` + TestClock                   |
| Forgetting to fork before adjust  | Tests hang forever                   | Always fork before TestClock.adjust           |

## Examples

See current test files for working examples:

- `packages/agent/test/providers/anthropic/claude-provider.test.ts` - provider HTTP/stream fixtures
- `packages/agent/test/property/*.test.ts` - property tests
- `packages/agent/test/loop/error.test.ts` - error handling
- `packages/mcp/test/client/client.test.ts` - protocol/transport fixtures
- `examples/next/lib/core/knowledge/*.test.ts` - app-owned domain tests
