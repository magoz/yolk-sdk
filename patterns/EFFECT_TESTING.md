# Effect Testing

This document covers testing patterns using `@effect/vitest` for Effect-based code.

## Setup

Install the testing dependencies:

```bash
pnpm add -D @effect/vitest vitest
```

Import from `@effect/vitest` for Effect-aware testing:

```typescript
import { describe, expect, it, layer } from '@effect/vitest'
import { Effect, Fiber, Duration } from 'effect'
import * as TestClock from 'effect/testing/TestClock'
```

---

## Test Variants

| Method      | TestServices | Scope | Use Case                        |
| ----------- | ------------ | ----- | ------------------------------- |
| `it.effect` | TestClock    | Yes   | Most tests - deterministic time |
| `it.live`   | Real clock   | Yes   | Tests needing real time/IO      |

> **v4 change:** `it.scoped` and `it.scopedLive` were removed. `it.effect` and `it.live` now provide Scope automatically, so `acquireRelease` resources are cleaned up without needing a separate variant.

### it.effect - Use for Most Tests (with TestClock + Scope)

`it.effect` provides a `TestClock` that you control. Time doesn't pass unless you advance it. Scope is provided automatically.

```typescript
import { it, expect } from '@effect/vitest'
import { Effect, Fiber, Duration } from 'effect'
import * as TestClock from 'effect/testing/TestClock'

it.effect('processes after delay', () =>
  Effect.gen(function* () {
    // Fork the effect that uses time (v4: fork → forkChild)
    const fiber = yield* Effect.forkChild(
      Effect.sleep(Duration.minutes(5)).pipe(Effect.map(() => 'done'))
    )

    // Advance the TestClock - no real waiting!
    yield* TestClock.adjust(Duration.minutes(5))

    // Now the fiber completes instantly
    const result = yield* Fiber.join(fiber)
    expect(result).toBe('done')
  })
)
```

### it.live - Use When You Need Real Time/External IO

```typescript
it.live('calls external API', () =>
  Effect.gen(function* () {
    // This actually waits 100ms
    yield* Effect.sleep(Duration.millis(100))
    // Real HTTP calls, file system, etc.
  })
)
```

### Resource Cleanup (automatic in v4)

In v4, `it.effect` and `it.live` both provide Scope automatically. No separate `it.scoped` needed.

```typescript
it.effect('manages resources correctly', () =>
  Effect.gen(function* () {
    // acquireRelease resources are automatically cleaned up
    const resource = yield* Effect.acquireRelease(Effect.succeed({ connection: 'open' }), r =>
      Effect.sync(() => console.log('Cleaned up:', r))
    )

    expect(resource.connection).toBe('open')
    // Resource is cleaned up after test completes
  })
)
```

---

## TestClock Patterns

> **v4 change:** TestClock is imported from `effect/testing/TestClock`, not from `effect`.

### Always Fork Effects That Sleep

The TestClock only affects forked effects. If you call `Effect.sleep` directly without forking, it will block forever because the clock never advances.

```typescript
// WRONG - blocks forever
it.effect('broken test', () =>
  Effect.gen(function* () {
    yield* Effect.sleep(Duration.seconds(10)) // Blocks forever!
    yield* TestClock.adjust(Duration.seconds(10)) // Never reached
  })
)

// CORRECT - fork first, then adjust (v4: fork → forkChild)
it.effect('timeout test', () =>
  Effect.gen(function* () {
    const fiber = yield* Effect.forkChild(
      Effect.sleep(Duration.seconds(30)).pipe(Effect.timeout(Duration.seconds(10)))
    )

    // Advance past timeout
    yield* TestClock.adjust(Duration.seconds(10))

    const result = yield* Fiber.join(fiber)
    expect(result._tag).toBe('None') // Timed out
  })
)
```

### Testing Retries and Delays

```typescript
it.effect('retries with exponential backoff', () =>
  Effect.gen(function* () {
    let attempts = 0

    const effect = Effect.gen(function* () {
      attempts++
      if (attempts < 3) {
        return yield* Effect.fail(new Error('not yet'))
      }
      return 'success'
    }).pipe(
      Effect.retry({
        times: 5,
        schedule: Schedule.exponential(Duration.millis(100))
      })
    )

    const fiber = yield* Effect.forkChild(effect)

    // First retry after 100ms
    yield* TestClock.adjust(Duration.millis(100))
    // Second retry after 200ms (exponential)
    yield* TestClock.adjust(Duration.millis(200))

    const result = yield* Fiber.join(fiber)
    expect(result).toBe('success')
    expect(attempts).toBe(3)
  })
)
```

### Testing Scheduled Effects

```typescript
it.effect('runs scheduled task', () =>
  Effect.gen(function* () {
    const results: number[] = []

    const scheduled = Effect.sync(() => results.push(Date.now())).pipe(
      Effect.repeat(Schedule.fixed(Duration.seconds(1)).pipe(Schedule.both(Schedule.recurs(3))))
    )

    const fiber = yield* Effect.forkChild(scheduled)

    // Advance through 3 intervals
    yield* TestClock.adjust(Duration.seconds(1))
    yield* TestClock.adjust(Duration.seconds(1))
    yield* TestClock.adjust(Duration.seconds(1))

    yield* Fiber.join(fiber)
    expect(results).toHaveLength(4) // Initial + 3 repeats
  })
)
```

---

## Sharing Layers Between Tests

Use `layer()` or `it.layer()` to share services across multiple tests:

```typescript
import { layer, it, expect } from '@effect/vitest'
import { Effect, Layer } from 'effect'
import { Auth } from './auth/live-layer'
import { Db } from './db/live-layer'

// Create a test layer
const TestLayer = Layer.mergeAll(Auth.layer, Db.layer)

layer(TestLayer)('Auth Service', it => {
  it.effect('finds user by id', () =>
    Effect.gen(function* () {
      const auth = yield* Auth
      const session = yield* auth.getSessionFromCookies()
      expect(session).toBeDefined()
    })
  )

  it.effect('handles invalid session', () =>
    Effect.gen(function* () {
      const auth = yield* Auth
      // Test error case...
    })
  )

  // Nested layers for additional dependencies
  it.layer(AuditServiceLive)('with audit logging', it => {
    it.effect('logs auth actions', () =>
      Effect.gen(function* () {
        const auth = yield* Auth
        const audit = yield* AuditService
        // Both services available
      })
    )
  })
})
```

### Use Real Clock Even with Layer

```typescript
layer(MyService.layer, { timeout: '30 seconds' })('live tests', it => {
  it.live('uses real time', () =>
    Effect.gen(function* () {
      yield* Effect.sleep(Duration.millis(10)) // Actually waits
    })
  )
})
```

---

## Property-Based Testing

FastCheck is re-exported from `effect/FastCheck`. Use `Schema.toArbitrary()` to create arbitraries from Schema. @effect/vitest provides `it.prop` and `it.effect.prop` for property testing.

> **v4 change:** `Arbitrary.make(schema)` → `Schema.toArbitrary(schema)`

```typescript
import { it, expect } from '@effect/vitest'
import { Effect, Schema } from 'effect'

// Synchronous property test - array syntax
it.prop('addition is commutative', [Schema.Number, Schema.Number], ([a, b]) => a + b === b + a)

// Synchronous property test - object syntax
it.prop(
  'addition is commutative',
  { a: Schema.Number, b: Schema.Number },
  ({ a, b }) => a + b === b + a
)

// Effectful property test
it.effect.prop('async symmetry', [Schema.Number, Schema.Number], ([a, b]) =>
  Effect.gen(function* () {
    yield* Effect.void
    return a + b === b + a
  })
)

// With custom fastCheck options
it.effect.prop('[custom runs]', [Schema.Number], ([n]) => Effect.succeed(n === n), {
  fastCheck: { numRuns: 200 }
})
```

### Creating Arbitraries from Schema

```typescript
import { Schema } from 'effect'

// Define your domain schema
export class User extends Schema.Class<User>('User')({
  id: Schema.String,
  name: Schema.Trimmed.pipe(Schema.check(Schema.isNonEmpty())),
  age: Schema.Number.pipe(Schema.int(), Schema.between(0, 150)),
  email: Schema.String.pipe(Schema.check(Schema.isPattern(/^[^@]+@[^@]+\.[^@]+$/)))
}) {}

// Create arbitrary from Schema (v4: Arbitrary.make → Schema.toArbitrary)
const userArb = Schema.toArbitrary(User)

it.prop('user validation', [userArb], ([user]) => {
  // user is guaranteed to be a valid User
  expect(user.name.length).toBeGreaterThan(0)
  expect(user.age).toBeGreaterThanOrEqual(0)
  expect(user.age).toBeLessThanOrEqual(150)
})
```

### Testing Domain Invariants

```typescript
import { Schema } from 'effect'

// Money must always have positive amount and valid currency
export class Money extends Schema.Class<Money>('Money')({
  amount: Schema.BigDecimal.pipe(Schema.positive()),
  currency: Schema.Literal('USD', 'EUR', 'GBP')
}) {
  add(other: Money): Money {
    if (this.currency !== other.currency) {
      throw new Error('Currency mismatch')
    }
    return Money.make({
      amount: BigDecimal.sum(this.amount, other.amount),
      currency: this.currency
    })
  }
}

const moneyArb = Schema.toArbitrary(Money)

it.prop('money addition is associative', [moneyArb, moneyArb, moneyArb], ([a, b, c]) => {
  // Only test if currencies match
  if (a.currency !== b.currency || b.currency !== c.currency) {
    return true // Skip this case
  }

  const left = a.add(b).add(c)
  const right = a.add(b.add(c))
  return Equal.equals(left.amount, right.amount)
})
```

### Property Rules

- Test laws/invariants, not random examples.
- Keep arbitraries domain-shaped and small.
- Prefer `Schema.toArbitrary()` for boundary/domain schemas.
- Assert one or two invariants per property; split broad laws.
- Use deterministic `now`, IDs, clocks, and layers.
- Keep explicit example tests for named regressions and edge cases.
- Avoid property tests against browser UI or real external services.

Good property seams:

- pure domain functions
- Schema decode/encode round trips
- Effect services with in-memory layers
- route/action model helpers before Next boundary wiring

### Simulation Tests

Use simulation tests for Effect workflows, task lifecycles, sessions, and event-sourced state. Model
commands, apply them through one stable seam, then assert invariants after each step or at the end.

Simulation rules:

- Commands are user/domain events, not implementation calls.
- The model owns expected behavior; implementation owns mechanics.
- Check invariants after each command when debugging state machines.
- Keep failing command sequences reproducible by logging the shrunk case.
- Use in-memory stores/layers first; add DB-backed simulation only for persistence invariants.

Common invariants:

- revisions are monotonic
- terminal states do not transition
- retries are idempotent
- deletes leave no dangling references
- replay equals accumulated state
- permissions never expand after denial

---

## Testing with Mock Services

Create test implementations of services for isolated unit tests:

```typescript
import { Layer, Effect, Context } from 'effect'
import { it, expect } from '@effect/vitest'

// Production service (v4: Context.Service)
class EmailService extends Context.Service<
  EmailService,
  {
    readonly send: (to: string, subject: string, body: string) => Effect.Effect<void>
  }
>()('@app/EmailService') {}

// Test implementation that captures calls
const createMockEmailService = () => {
  const sent: Array<{ to: string; subject: string; body: string }> = []

  const layer = Layer.succeed(EmailService, {
    send: (to, subject, body) =>
      Effect.sync(() => {
        sent.push({ to, subject, body })
      })
  })

  return { layer, sent }
}

it.effect('sends welcome email on signup', () =>
  Effect.gen(function* () {
    const { layer, sent } = createMockEmailService()

    const result = yield* signupUser({ email: 'test@example.com', name: 'Test' }).pipe(
      Effect.provide(layer)
    )

    expect(sent).toHaveLength(1)
    expect(sent[0].to).toBe('test@example.com')
    expect(sent[0].subject).toContain('Welcome')
  })
)
```

---

## Database Testing with Testcontainers

For integration tests against a real database, use testcontainers to spin up isolated PostgreSQL instances.

### Setup Container Layer

```typescript
// test/utils.ts
import { Effect, Layer, Data, Redacted, Context } from 'effect'
import { PostgreSqlContainer } from '@testcontainers/postgresql'

// Error type for container failures
export class ContainerError extends Data.TaggedError('ContainerError')<{
  cause: unknown
}> {}

// Container as Context.Service with scoped lifecycle
export class PgContainer extends Context.Service<PgContainer>()('test/PgContainer', {
  make: Effect.acquireRelease(
    Effect.tryPromise({
      try: () => new PostgreSqlContainer('postgres:alpine').start(),
      catch: cause => new ContainerError({ cause })
    }),
    container => Effect.promise(() => container.stop())
  )
}) {
  // Layer that provides database connection from the container
  static ClientLayer = Layer.unwrapEffect(
    Effect.gen(function* () {
      const container = yield* PgContainer
      // Return your database client layer using container.getConnectionUri()
      return Db.layer({
        connectionString: container.getConnectionUri()
      })
    })
  ).pipe(Layer.provide(Layer.scoped(this, this.make)))
}
```

### Using the Container in Tests

```typescript
import { it, expect, layer } from '@effect/vitest'
import { Effect } from 'effect'
import { PgContainer } from './utils'
import { Db } from './db/live-layer'

// Use layer() with 30s timeout (container startup is slow)
layer(PgContainer.ClientLayer, { timeout: '30 seconds' })('Database Tests', it => {
  it.effect('creates and retrieves user', () =>
    Effect.gen(function* () {
      const db = yield* Db

      // Run migrations
      yield* db.migrate()

      // Insert
      yield* db.insert('users', { id: 'user_1', name: 'Test User' })

      // Query
      const user = yield* db.findById('users', 'user_1')
      expect(user.name).toBe('Test User')
    })
  )

  it.effect('handles transactions', () =>
    Effect.gen(function* () {
      const db = yield* Db

      // Transaction that rolls back on error
      const result = yield* db.transaction(
        Effect.gen(function* () {
          yield* db.insert('users', { id: 'user_2', name: 'Transaction User' })
          return yield* db.findById('users', 'user_2')
        })
      )

      expect(result).toBeDefined()
    })
  )
})
```

### Key Points

- Container starts once per `layer()` block, shared across all tests in that block
- Container stops automatically when tests complete (acquireRelease cleanup)
- Use `{ timeout: '30 seconds' }` because container startup takes time
- Each test gets the same database - use transactions or cleanup between tests
- `Layer.unwrapEffect` defers layer creation until container is running

---

## Shared Database Container (Global Setup)

For faster test runs, share a single container across all test files:

### Step 1: Create Global Setup File

```typescript
// vitest.global-setup.ts
import { PostgreSqlContainer, StartedPostgreSqlContainer } from '@testcontainers/postgresql'

let container: StartedPostgreSqlContainer

export async function setup({ provide }: { provide: (key: string, value: unknown) => void }) {
  console.log('Starting shared PostgreSQL container...')

  container = await new PostgreSqlContainer('postgres:alpine').start()

  // Make connection URL available to tests via inject()
  provide('dbUrl', container.getConnectionUri())

  console.log(`PostgreSQL ready at ${container.getConnectionUri()}`)
}

export async function teardown() {
  console.log('Stopping shared PostgreSQL container...')
  await container?.stop()
}
```

### Step 2: Update Vitest Config

```typescript
// vitest.config.ts
import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    globalSetup: ['./vitest.global-setup.ts'],
    hookTimeout: 120000
    // ... rest of config
  }
})
```

### Step 3: Create Type Declarations

```typescript
// vitest.d.ts
declare module 'vitest' {
  export interface ProvidedContext {
    dbUrl: string
  }
}
```

### Step 4: Use Injected URL in Tests

```typescript
// test/utils.ts
import { Layer, Effect } from 'effect'
import { inject } from 'vitest'
import { Db } from './db/live-layer'

export const SharedDbLayer = Layer.effect(
  Db,
  Effect.gen(function* () {
    const url = inject('dbUrl')
    return yield* Db.make({ connectionString: url })
  })
)
```

---

## Testing Error Cases

### Testing That Effects Fail

```typescript
// Pattern 1: Effect.result (v4: Effect.either → Effect.result)
it.effect('fails with NotFound for missing user', () =>
  Effect.gen(function* () {
    const auth = yield* Auth

    const result = yield* auth.findUser('nonexistent').pipe(Effect.result)

    expect(result._tag).toBe('Failure')
    if (result._tag === 'Failure') {
      expect(result.failure._tag).toBe('UserNotFound')
    }
  })
)

// Pattern 2: Effect.exit for Cause inspection
it.effect('exits with expected error', () =>
  Effect.gen(function* () {
    const auth = yield* Auth

    const exit = yield* auth.findUser('nonexistent').pipe(Effect.exit)

    expect(exit._tag).toBe('Failure')
    if (exit._tag === 'Failure') {
      // v4: Cause is flattened — use findErrorOption
      const error = Cause.findErrorOption(exit.cause)
      expect(error._tag).toBe('Some')
      if (error._tag === 'Some') {
        expect(error.value._tag).toBe('UserNotFound')
      }
    }
  })
)
```

### Testing Error Recovery

```typescript
it.effect('recovers from NotFound with default', () =>
  Effect.gen(function* () {
    const service = yield* MyService

    const result = yield* service
      .findOrCreate('missing-id')
      .pipe(Effect.catchTag('NotFound', () => Effect.succeed({ id: 'default', name: 'Default' })))

    expect(result.id).toBe('default')
  })
)
```

---

## Best Practices

### 1. One Assertion Per Test (When Possible)

```typescript
// WRONG - multiple unrelated assertions
it.effect('user operations', () =>
  Effect.gen(function* () {
    const user = yield* createUser()
    expect(user.id).toBeDefined()
    expect(user.createdAt).toBeDefined()

    yield* updateUser(user.id, { name: 'New Name' })
    const updated = yield* findUser(user.id)
    expect(updated.name).toBe('New Name')

    yield* deleteUser(user.id)
    const deleted = yield* findUser(user.id).pipe(Effect.option)
    expect(deleted._tag).toBe('None')
  })
)

// CORRECT - separate tests for each behavior
it.effect('creates user with id and timestamp', () =>
  Effect.gen(function* () {
    const user = yield* createUser()
    expect(user.id).toBeDefined()
    expect(user.createdAt).toBeDefined()
  })
)

it.effect('updates user name', () =>
  Effect.gen(function* () {
    const user = yield* createUser()
    yield* updateUser(user.id, { name: 'New Name' })
    const updated = yield* findUser(user.id)
    expect(updated.name).toBe('New Name')
  })
)
```

### 2. Use Descriptive Test Names

```typescript
// WRONG
it.effect('test1', () => /* ... */)
it.effect('works', () => /* ... */)

// CORRECT
it.effect('returns empty array when no users exist', () => /* ... */)
it.effect('throws NotFound when user id is invalid', () => /* ... */)
```

### 3. Isolate Tests

Each test should be independent. Don't rely on state from previous tests.

```typescript
// WRONG - tests depend on each other
let userId: string

it.effect('creates user', () =>
  Effect.gen(function* () {
    const user = yield* createUser()
    userId = user.id // Shared state!
  })
)

it.effect('updates user', () =>
  Effect.gen(function* () {
    yield* updateUser(userId, { name: 'New' }) // Depends on previous test
  })
)

// CORRECT - each test is self-contained
it.effect('updates user', () =>
  Effect.gen(function* () {
    const user = yield* createUser() // Create within the test
    yield* updateUser(user.id, { name: 'New' })
    const updated = yield* findUser(user.id)
    expect(updated.name).toBe('New')
  })
)
```

### 4. Test Edge Cases

```typescript
describe('parseAmount', () => {
  it.effect('parses positive numbers', () => /* ... */)
  it.effect('parses negative numbers', () => /* ... */)
  it.effect('parses zero', () => /* ... */)
  it.effect('fails on empty string', () => /* ... */)
  it.effect('fails on non-numeric string', () => /* ... */)
  it.effect('handles very large numbers', () => /* ... */)
  it.effect('handles decimal precision', () => /* ... */)
})
```
