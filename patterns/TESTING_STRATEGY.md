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

## Test Organization

### File Location

**Tests are colocated with source files** using `*.test.ts` pattern:

```
lib/core/post/
├── get-posts.ts
├── get-posts.test.ts        # ← Test next to implementation
├── create-post-action.ts
└── create-post-action.test.ts
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

**Location:** Colocated with source (`lib/core/post/create-post.test.ts`)

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

**Location:** Colocated with source or `lib/services/*/integration.test.ts`

**Note:** Integration tests require additional setup (testcontainers for Postgres). See `patterns/EFFECT_TESTING.md` for details.

### E2E Tests

**When:** Testing full user flows through the UI

**Pattern:** Playwright tests in `e2e/` directory

**Example:**

```typescript
// e2e/auth.spec.ts
test('user can login with OTP', async ({ page }) => {
  await page.goto('/login')
  // ...
})
```

**Location:** `e2e/` directory (separate from unit/integration tests)

**Run:** `pnpm test:e2e`

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

| Service  | Unit Tests | Integration Tests | E2E Tests |
| -------- | ---------- | ----------------- | --------- |
| Auth     | Mock       | Mock              | Real      |
| Db       | Mock       | Real (container)  | Real      |
| Email    | Mock       | Mock              | Mock      |
| S3       | Mock       | Real (localstack) | Real      |
| Telegram | Mock       | Mock              | Mock      |

**Rule:** Mock external services (email, Telegram) in all automated tests. Use real Db/S3 only in integration tests with testcontainers.

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

| Anti-Pattern                     | Why Bad                              | Do Instead                          |
| -------------------------------- | ------------------------------------ | ----------------------------------- |
| Testing private functions        | Couples tests to implementation      | Test public API                     |
| Mocking everything               | Tests don't catch integration issues | Use real services when reasonable   |
| Snapshot tests for UI            | Fragile, hard to maintain            | Test behavior, not markup           |
| No error case tests              | Production errors surprise you       | Test all domain error paths         |
| 100% coverage goal               | Wastes time on low-value tests       | Focus on high-risk code             |
| Tests in separate `/test` dir    | Hard to find relevant tests          | Colocate with source files          |
| Skipping integration tests       | Services might not compose           | Test critical integrations          |
| Not using TestClock              | Tests are slow and flaky             | Use `it.effect` + TestClock         |
| Forgetting to fork before adjust | Tests hang forever                   | Always fork before TestClock.adjust |

## Examples

See test files for working examples:

- `lib/core/post/get-posts.test.ts` - Test variants (it.effect, it.live)
- `lib/core/post/test-clock.test.ts` - TestClock patterns (fork, timeout, retry)
- `lib/core/post/layer-sharing.test.ts` - Mock services with layer()
- `lib/core/post/property-testing.test.ts` - Property-based testing
- `lib/core/post/error-testing.test.ts` - Error handling patterns
