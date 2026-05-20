# Migration Guide: Effect v4 + Drizzle 1.0

**Status:** Complete (RC)
**Branch:** `v4`
**Last updated:** 2026-05-03

## Overview

This codebase has been migrated from Effect v3 + Drizzle ORM beta to Effect v4 + Drizzle ORM 1.0 RC. All code compiles (`pnpm tsc`), lints (`pnpm lint`), and tests pass (`pnpm test:run`).

### Version Changes

| Package                 | Before     | After           | Notes                               |
| ----------------------- | ---------- | --------------- | ----------------------------------- |
| `effect`                | `^3.19.14` | `4.0.0-beta.59` | Major rewrite                       |
| `@effect/platform`      | `^0.94.1`  | **Removed**     | Merged into `effect`                |
| `@effect/platform-node` | `^0.104.0` | **Removed**     | Db uses `PgDrizzle.make()` directly |
| `@effect/sql`           | `^0.49.0`  | **Removed**     | Merged into `effect`                |
| `@effect/sql-pg`        | `^0.50.1`  | `4.0.0-beta.59` | Stays separate                      |
| `@effect/opentelemetry` | `^0.60.0`  | `4.0.0-beta.59` | Stays separate                      |
| `@effect/vitest`        | `^0.27.0`  | `4.0.0-beta.59` | Stays separate                      |
| `@effect-aws/client-s3` | `^1.10.7`  | `2.0.0-beta.4`  | v4-compatible                       |
| `drizzle-orm`           | `beta`     | `1.0.0-rc.1`    | RC with Effect-native driver        |

---

## Table of Contents

1. [Services](#1-services)
2. [Error Handling](#2-error-handling)
3. [Forking](#3-forking)
4. [Schema](#4-schema)
5. [Package Consolidation](#5-package-consolidation)
6. [Either → Result](#6-either--result)
7. [Cause (Flattened)](#7-cause-flattened)
8. [Config (Yieldable)](#8-config-yieldable)
9. [HTTP / API Routes](#9-http--api-routes)
10. [Testing](#10-testing)
11. [Drizzle Queries](#11-drizzle-queries)
12. [Error Handling Pattern (matchEffect → catchTag)](#12-error-handling-pattern)
13. [Gotchas](#13-gotchas)

---

## 1. Services

`Context.Tag` / `Effect.Service` → `Context.Service` (was `Context.Service` in earlier v4 betas, renamed to `Context.Service` in beta.59)

### Internal tags (interface-only services)

```typescript
// v3
class AuthDb extends Context.Tag('@app/AuthDb')<AuthDb, ReturnType<typeof drizzle>>() {}

// v4
class AuthDb extends Context.Service<AuthDb, ReturnType<typeof drizzle>>()('@app/AuthDb') {}
```

Note the argument reorder: type params via `Context.Service<Self, Shape>()`, then id string `(id)`.

### Services with `make`

```typescript
// v3
export class Db extends Effect.Service<Db>()('@app/Db', {
  effect: Effect.gen(function* () { ... })
}) {
  static layer = this.Default
  static Live = this.layer.pipe(Layer.provide(...))
}

// v4
export class Db extends Context.Service<Db>()('@app/Db', {
  make: Effect.gen(function* () { ... })
}) {
  static layer = Layer.effect(this, this.make).pipe(Layer.provide(...))
}
```

Key changes:

- `effect:` → `make:`
- `this.Default` → `Layer.effect(this, this.make)`
- Convention: single `layer` property (drop `Live`)
- `dependencies` option removed — use `Layer.provide` externally

### Layer composition

```typescript
// v3: Auth.Live, Db.Live, ...
// v4: Auth.layer, Db.layer, ...
export const AppLayer = Layer.mergeAll(Auth.layer, Db.layer, S3.layer, ...)
```

---

## 2. Error Handling

| v3                     | v4                   |
| ---------------------- | -------------------- |
| `Effect.catchAll`      | `Effect.catch`       |
| `Effect.catchAllCause` | `Effect.catchCause`  |
| `Effect.catchSome`     | `Effect.catchFilter` |
| `Effect.catchTag`      | `Effect.catchTag`    |
| `Effect.either`        | `Effect.result`      |

---

## 3. Forking

| v3                  | v4                  |
| ------------------- | ------------------- |
| `Effect.fork`       | `Effect.forkChild`  |
| `Effect.forkDaemon` | `Effect.forkDetach` |
| `Effect.forkScoped` | `Effect.forkScoped` |

---

## 4. Schema

| v3                             | v4                                          |
| ------------------------------ | ------------------------------------------- |
| `Schema.compose(A, B)`         | Removed; use `Schema.decodeTo`              |
| `Schema.pattern(regex)`        | `.check(Schema.isPattern(regex))`           |
| `Schema.NonEmptyTrimmedString` | `Schema.Trimmed.check(Schema.isNonEmpty())` |
| `.pipe(Schema.maxLength(N))`   | `.check(Schema.isMaxLength(N))`             |
| `Schema.annotations({})`       | `Schema.annotate({})`                       |
| `Schema.decodeUnknown`         | `Schema.decodeUnknownEffect`                |
| `Arbitrary.make(schema)`       | `Schema.toArbitrary(schema)`                |

---

## 5. Package Consolidation

### `@effect/platform` → `effect/unstable/http/*`

```typescript
// v3
import { HttpApp, HttpServerResponse } from '@effect/platform'

// v4
import * as HttpServerResponse from 'effect/unstable/http/HttpServerResponse'
import * as HttpEffect from 'effect/unstable/http/HttpEffect'
```

### `@effect/sql` → `effect/unstable/sql/*`

```typescript
// v3
import { SqlError } from '@effect/sql'

// v4
import { SqlError } from 'effect/unstable/sql/SqlError'
```

### `@effect/platform-node`

`NodeContext.layer` → `NodeServices.layer`. However, this package is no longer needed for the Db service — `PgDrizzle.make()` from `drizzle-orm/effect-postgres` handles the connection internally via `@effect/sql-pg`.

```typescript
// v3
import { NodeContext } from '@effect/platform-node'
Layer.provide(NodeContext.layer)

// v4 (if still needed for other platform services)
import { NodeServices } from '@effect/platform-node'
Layer.provide(NodeServices.layer)

// v4 Db service (no NodeServices needed)
import * as PgDrizzle from 'drizzle-orm/effect-postgres'
export class Db extends Context.Service<Db>()('@app/Db', {
  make: PgDrizzle.make({ relations })
}) {
  static layer = Layer.effect(this, this.make).pipe(
    Layer.provide(PgDrizzle.DefaultServices),
    Layer.provide(PgLive)
  )
}
```

---

## 6. Either → Result

`Either` module removed. Use `Result` with `_tag: 'Success' | 'Failure'` and fields `.success` / `.failure`:

```typescript
// v3
import { Either } from 'effect'
const r = Either.right(42) // { _tag: 'Right', right: 42 }
const l = Either.left('err') // { _tag: 'Left', left: 'err' }

// v4
import { Result } from 'effect'
const r = Result.succeed(42) // { _tag: 'Success', success: 42 }
const l = Result.fail('err') // { _tag: 'Failure', failure: 'err' }
```

`Effect.either` → `Effect.result` (returns `Result`).

---

## 7. Cause (Flattened)

Cause is now flat: `{ reasons: ReadonlyArray<Reason<E>> }` where `Reason = Fail | Die | Interrupt`.

| v3                           | v4                                                       |
| ---------------------------- | -------------------------------------------------------- |
| `Cause.isFailType(cause)`    | `Cause.isFailReason(reason)` (on individual reasons)     |
| `Cause.isDieType(cause)`     | `Cause.isDieReason(reason)`                              |
| `Cause.failureOption(cause)` | `Cause.findErrorOption(cause)` (returns `Option`)        |
| `Cause.dieOption(cause)`     | `Cause.findDefect(cause)` (returns `Result`, not Option) |
| `Cause.isFailure(cause)`     | `Cause.hasFails(cause)`                                  |

---

## 8. Config (Yieldable)

Config values are `Yieldable` but NOT `Effect` subtypes. Cannot pipe with Effect operators directly:

```typescript
// v3 — works because Config is Effect subtype
const url = yield* Config.string('URL').pipe(Effect.mapError(...))

// v4 — Config is Yieldable, not Effect
const url = yield* Config.string('URL')  // yield* directly
// For error mapping, wrap the whole block:
Effect.gen(function* () {
  const url = yield* Config.string('URL')
  const key = yield* Config.redacted('KEY')
  return { url, key }
}).pipe(Effect.mapError(() => new ConfigError({ message: 'Config missing' })))
```

Optional config: `yield* Config.option(Config.string('OPTIONAL_VAR'))` returns `Option`.

---

## 9. HTTP / API Routes

`HttpApp.toWebHandlerRuntime` → `HttpEffect.toWebHandlerLayer`:

```typescript
// v3
const managedRuntime = ManagedRuntime.make(AppLayer)
const runtime = await managedRuntime.runtime()
const effectHandler = HttpApp.toWebHandlerRuntime(runtime)(getHandler)
export const GET = (request: Request) => effectHandler(request)

// v4
const { handler } = HttpEffect.toWebHandlerLayer(getHandler, AppLayer)
export const GET = (request: Request) => handler(request)
```

`toWebHandlerLayer` returns `{ dispose, handler }`. The handler takes `(request: Request)` when all services are provided.

---

## 10. Testing

### `@effect/vitest` changes

| v3                 | v4                                                      |
| ------------------ | ------------------------------------------------------- |
| `it.scoped`        | Removed — `it.effect` provides `Scope` auto             |
| `it.scopedLive`    | Removed — `it.live` provides `Scope` auto               |
| `TestClock` import | `import * as TestClock from 'effect/testing/TestClock'` |

### `it.prop` with Schema

v4 `@effect/vitest` does NOT support passing Schema directly to `it.prop`. Convert to Arbitrary first:

```typescript
// v3 — Schema directly
it.prop('test', [Schema.Array(PostInput)], ([posts]) => { ... })

// v4 — must use Arbitrary
const postInputArb = Schema.toArbitrary(PostInput)
const postInputArrayArb = Schema.toArbitrary(Schema.Array(PostInput))
it.prop('test', [postInputArrayArb], ([posts]) => { ... })
```

### `Schedule.intersect` → `Schedule.both`

```typescript
// v3
Schedule.intersect(Schedule.exponential('100 millis'), Schedule.recurs(3))

// v4
Schedule.both(Schedule.exponential('100 millis'), Schedule.recurs(3))
```

---

## 11. Drizzle Queries

### `.execute()` no longer needed

In Drizzle v1 RC with `drizzle-orm/effect-postgres`, all query builders implement `Effectable.Prototype` — they are `Yieldable`. When you `yield*` a query, it calls `.execute()` internally.

```typescript
// Both are equivalent:
const posts = yield* db.select().from(schema.post).where(...)
const posts = yield* db.select().from(schema.post).where(...).execute()
```

**Note:** Earlier v4 betas required explicit `.execute()` due to an `R` channel typing issue. This was fixed in Drizzle `1.0.0-rc.1`.

---

## 12. Error Handling Pattern

### `matchEffect` → `catchTag` chains

v4 changes how error types flow through `Effect.provide` + `Effect.scoped`. The old `matchEffect` + `Match.value(error._tag)` pattern produces `unknown` error types. Replace with `catchTag` chains:

```typescript
// v3 — matchEffect with Match
;(Effect.provide(AppLayer),
  Effect.scoped,
  Effect.matchEffect({
    onFailure: error =>
      Match.value(error._tag).pipe(
        Match.when('UnauthenticatedError', () => NextEffect.redirect('/login')),
        Match.orElse(() => Effect.succeed({ _tag: 'Error', message: error.message }))
      ),
    onSuccess: post =>
      Effect.sync(() => {
        revalidatePath('/')
        return { _tag: 'Success', post }
      })
  }))

// v4 — catchTag chains
;(Effect.provide(AppLayer),
  Effect.scoped,
  Effect.catchTag('UnauthenticatedError', () => NextEffect.redirect('/login')),
  Effect.map(post => {
    revalidatePath('/')
    return { _tag: 'Success' as const, post }
  }),
  Effect.catch(error =>
    Effect.succeed({
      _tag: 'Error' as const,
      message: error instanceof Error ? error.message : 'Unknown error'
    })
  ))
```

Benefits:

- Each `catchTag` preserves full type information
- No `unknown` error type issues
- Cleaner, more declarative pipeline
- `Effect.catch` at the end acts as catch-all for remaining errors

---

## 13. Gotchas

### LSP shows stale v3 errors

The in-editor LSP may read from stale `effect@3.19.14` types. **Always use `pnpm tsc` for accurate type checking.** LSP errors about `ServiceMap` not existing, `Effect.result` not existing, etc. are false positives.

### `Array.partition` takes `Filter`, not predicate

```typescript
// v3 — predicate returning boolean
const [excluded, included] = EffectArray.partition(posts, p => p.published)

// v4 — Filter returning Result
const [excluded, included] = EffectArray.partition(posts, p =>
  p.published ? Result.succeed(p) : Result.fail(p)
)
```

### `NextEffect.runPromise` — no `as` assertion

The redirect handler uses `Effect.catch` + `Effect.die` instead of type assertions to handle the generic `E` type:

```typescript
const runPromise = async <A, E>(effect: Effect.Effect<A, E>): Promise<A> => {
  const result = await Effect.runPromise(
    effect.pipe(
      Effect.map((a): Result.Result<A, RedirectError> => Result.succeed(a)),
      Effect.catch(
        (e): Effect.Effect<Result.Result<A, RedirectError>> =>
          e instanceof RedirectError ? Effect.succeed(Result.fail(e)) : Effect.die(e)
      )
    )
  )
  if (Result.isFailure(result)) {
    return redirect(result.failure.path)
  }
  return result.success
}
```

### `Ref` is no longer yieldable

```typescript
// v3
const value = yield * ref

// v4
const value = yield * Ref.get(ref)
```

---

## Files Changed

| File                                     | Changes                                                          |
| ---------------------------------------- | ---------------------------------------------------------------- |
| `package.json`                           | Deps updated, removed `@effect/platform` and `@effect/sql`       |
| `examples/next/lib/layers.ts`            | `.Live` → `.layer`                                               |
| `examples/next/lib/next-effect/index.ts` | `Either` → `Result`, `catchAll` → `catch`, remove `as` assertion |
| `examples/next/lib/services/db/live-layer.ts` | `Context.Service`, `PgDrizzle.make()`, removed `NodeServices` |
| `examples/next/lib/services/auth/live-layer.ts` | `Context.Service`, Config pattern                          |
| `examples/next/lib/services/email/live-layer.ts` | `Context.Service`, Config pattern                         |
| `examples/next/lib/services/s3/live-layer.ts` | `Context.Service`, Config pattern                            |
| `examples/next/lib/services/telegram/live-layer.ts` | `Context.Service`, Config pattern                      |
| `examples/next/lib/services/activity/live-layer.ts` | `Context.Service`, `Ref`, `forkDetach`, `catch`       |
| `examples/next/lib/services/retry.ts`    | `SqlError` import, `Schedule.both`                               |
| `examples/next/lib/schemas/email.ts`     | Full Schema v4 rewrite                                           |
| `app/api/example/route.ts`               | HTTP modules, `toWebHandlerLayer`, `catchTag` chain              |
| `app/api/auth/[...all]/route.ts`         | `Auth.layer`                                                     |
| `app/page.tsx`                           | `catchTag` chain, extracted `PostList` component                 |
| `app/(auth)/login/page.tsx`              | `catchTag` chain                                                 |
| `examples/next/lib/core/post/create-post-action.ts` | `catchTag` chain, removed `.execute()`                |
| `examples/next/lib/core/post/delete-post-action.ts` | `catchTag` chain, removed `.execute()`                |
| `examples/next/lib/core/post/get-posts.ts` | removed `.execute()`                                          |
| `examples/next/lib/core/file/delete-file-action.ts` | `catchTag` chain                                      |
| `examples/next/lib/core/file/get-upload-url-action.ts` | `catchTag` chain                                  |
| `examples/next/lib/core/post/error-testing.test.ts` | `Effect.result`, `Cause.isFailReason`, `findDefect`   |
| `examples/next/lib/core/post/get-posts.test.ts` | `forkChild`, `TestClock` import                           |
| `examples/next/lib/core/post/test-clock.test.ts` | `forkChild`, `TestClock` import                        |
| `examples/next/lib/core/post/layer-sharing.test.ts` | `Context.Service()()` syntax, `Effect.result`       |
| `examples/next/lib/core/post/property-testing.test.ts` | Schema v4, `toArbitrary`, `Result` for partition  |
| `examples/next/e2e/utils/setup.ts`       | `Db.layer`                                                       |
| `examples/next/e2e/utils/create-test-user.ts` | removed `.execute()`                                       |
| `examples/next/e2e/fixtures.ts`          | `Effect.orDie`                                                   |
