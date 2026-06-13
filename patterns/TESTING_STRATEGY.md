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

| Seam | Use for | Coupling risk |
| --- | --- | --- |
| Browser/UI | critical user/admin flows | lowest |
| HTTP route/transport | API, protocol, stream, webhook contracts | low |
| Server action | parse/auth/revalidate/client union behavior | medium |
| Package public API | SDK contracts and provider compatibility | medium-low |
| Effect service + layer | business behavior over services/DB | medium |
| Pure function/model | dense domain rules/invariants | medium-low |
| Simulation harness | state machines, retries, HITL/session workflows | medium |
| Mocked module internals | external IO/framework seams only | highest |

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

**Why colocated?**

- Easy to find tests for any file
- Encourages testing during development
- Clear 1:1 mapping between source and tests
- Deleted code = deleted tests

### Test Organization Pattern

```typescript
import { describe, expect, it, layer } from '@effect/vitest'

describe('feature name', () => {
  // Group related tests
  describe('happy path', () => {
    it.effect('does the thing', () => /* ... */)
  })

  describe('error cases', () => {
    it.effect('handles invalid input', () => /* ... */)
    it.effect('handles missing resources', () => /* ... */)
  })
})
```

## Coverage Targets

### Coverage Expectations

| Code Type          | Target | Priority |
| ------------------ | ------ | -------- |
| Domain logic       | 80%+   | High     |
| Server actions     | 60%+   | Medium   |
| Services           | 70%+   | Medium   |
| UI components      | 30%+   | Low      |
| Type definitions   | 0%     | N/A      |
| Config/setup files | 0%     | N/A      |

**Don't chase 100% coverage** - focus on high-value tests.

### What Matters More Than Coverage

- **Error paths tested** - all domain errors have tests
- **Edge cases covered** - empty arrays, nulls, boundaries
- **Integration tests exist** - services compose correctly
- **Property tests where applicable** - invariants hold

## Test Types

### Unit Tests (Most Common)

**When:** Testing isolated domain functions or single service methods

**Pattern:** Mock dependencies via layers

**Example:**

```typescript
import { layer, expect } from '@effect/vitest'
import { Effect } from 'effect'

layer(createMockAuth())('post operations', it => {
  it.effect('creates post with valid input', () =>
    Effect.gen(function* () {
      const post = yield* createPost({ title: 'Test', content: 'Content' })
      expect(post.title).toBe('Test')
    })
  )
})
```

**Location:** Colocated with source for app/service units, or package-owned `test/*` dirs when documented locally.

### Integration Tests

**When:** Testing service composition or database operations

**Pattern:** Real services (Db, etc.) via testcontainers or shared test Layer

**Example:**

```typescript
// With testcontainers (see patterns/EFFECT_TESTING.md for setup)
layer(TestDbLayer)('database operations', it => {
  it.effect('persists and retrieves posts', () =>
    Effect.gen(function* () {
      const db = yield* Db
      // Use real database operations
    })
  )
})
```

**Location:** Colocated with source or `examples/next/lib/services/*/integration.test.ts`

**Note:** Integration tests require additional setup (testcontainers for Postgres). See `patterns/EFFECT_TESTING.md` for details.

### E2E Tests

**When:** Testing full user flows through the UI

**Pattern:** Playwright tests in the owning app's `e2e/` directory

**Example:**

```typescript
test('user can login with OTP', async ({ page }) => {
  await page.goto('/login')
  // ...
})
```

**Location:** `examples/next/e2e/` for Next app flows (separate from unit/integration tests)

**Run:** `pnpm test:e2e`

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

### Property and Simulation Tests

**When:** Example tests are really invariants: many inputs, same always/never law.

Good property targets:

- parsers, Schema codecs, provider schema compatibility
- protocol encoders/decoders and transport events
- tool registry availability and policy
- sorting/filtering/ranking/cleanup predicates
- HITL/session/event-log invariants

Good simulation targets:

- agent loop, HITL approvals/questions, tool execution boundaries
- workflow run/resume/retry/abort behavior
- chat/session append/edit/delete/regenerate flows
- event logs and persisted snapshots

Prefer model-level commands (`ApproveTool`, `AppendUserMessage`, `AbortRun`) over UI clicks or
implementation helper calls. Assert invariants: no stale mutation, no dangling references,
idempotent retries, monotonic revisions, terminal states stay terminal.

## Mock Strategy for Effect Services

### Factory Pattern for Mocks

**Create factory functions that return layer + test helpers:**

```typescript
const createMockAuth = (options?: { authenticated: boolean }) => {
  const calls: Array<{ method: string; args: unknown[] }> = []

  const layer = Layer.succeed(Auth, {
    getSession: () => {
      calls.push({ method: 'getSession', args: [] })
      return options?.authenticated
        ? Effect.succeed({ user: testUser })
        : Effect.fail(new UnauthenticatedError())
    }
  })

  return { layer, calls }
}
```

**Benefits:**

- Reusable across tests
- Track method calls for assertions
- Configure behavior per test
- Type-safe mock implementations

### Layer Sharing with `layer()`

Share mocks across multiple tests:

```typescript
const { layer: authLayer, calls } = createMockAuth()
const { layer: dbLayer } = createMockDb()

const testLayer = Layer.mergeAll(authLayer, dbLayer)

layer(testLayer)('post operations', it => {
  it.effect('test 1', () => /* ... */)
  it.effect('test 2', () => /* ... */)
  // All tests share authLayer + dbLayer
})
```

### When to Use Real vs Mock Services

| Service | Unit Tests | Integration Tests | E2E Tests |
| ------- | ---------- | ----------------- | --------- |
| Auth    | Mock       | Mock              | Real      |
| Db      | Mock       | Real (container)  | Real      |
| Email   | Mock       | Mock              | Mock      |

**Rule:** Mock external services (email, integrations) in automated tests. Use real Db only in integration/E2E tests with test isolation.

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

## Implementation Patterns

For detailed Effect testing patterns, see:

- **[patterns/EFFECT_TESTING.md](EFFECT_TESTING.md)** - @effect/vitest usage, TestClock, property testing, mocking, testcontainers

Key patterns from EFFECT_TESTING.md:

- `it.effect` - most tests (provides TestClock + Scope)
- `it.live` - real time/IO needed (also provides Scope)
- TestClock - fork before adjust (blocks forever otherwise)
- Property testing - `it.prop([Schema])` for invariants
- Error testing - `Effect.result`, `Effect.exit`, `Effect.catchTag`
- Mock services - factory pattern with layer sharing

## Anti-Patterns

### Flaky Tests

Treat one flaky test as suite trust = 0.

1. Quarantine or narrow immediately to preserve signal.
2. Document failure mode, env, traces/logs, last stable step.
3. Reproduce isolated with minimum app/deps.
4. Fix or rewrite from intended behavior.
5. Delete if still untrusted.

### General

| Anti-Pattern                     | Why Bad                              | Do Instead                          |
| -------------------------------- | ------------------------------------ | ----------------------------------- |
| Testing private functions        | Couples tests to implementation      | Test public API                     |
| Mocking everything               | Tests don't catch integration issues | Use real services when reasonable   |
| Snapshot tests for UI            | Fragile, hard to maintain            | Test behavior, not markup           |
| No error case tests              | Production errors surprise you       | Test all domain error paths         |
| 100% coverage goal               | Wastes time on low-value tests       | Focus on high-risk code             |
| Undocumented separate `/test` dir | Hard to find relevant tests          | Colocate or document package-owned test areas |
| Skipping integration tests       | Services might not compose           | Test critical integrations          |
| Not using TestClock              | Tests are slow and flaky             | Use `it.effect` + TestClock         |
| Forgetting to fork before adjust | Tests hang forever                   | Always fork before TestClock.adjust |

## Examples

See current test files for working examples:

- `packages/agent/test/providers/anthropic/claude-provider.test.ts` - provider HTTP/stream fixtures
- `packages/agent/test/property/*.test.ts` - property tests
- `packages/agent/test/loop/error.test.ts` - error handling
- `packages/mcp/test/client/client.test.ts` - protocol/transport fixtures
- `examples/next/lib/core/knowledge/*.test.ts` - app-owned domain tests
