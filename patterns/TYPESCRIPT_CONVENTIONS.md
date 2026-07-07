# TypeScript Conventions

This document describes TypeScript configuration and coding conventions for this project.

## Code Style (Prettier)

- **No semicolons** (`semi: false`)
- **No trailing commas** (`trailingComma: "none"`)
- Single quotes, 2-space indent, max 100 chars
- Arrow parens avoided (`arrowParens: "avoid"`)

## File Naming

- **All files use kebab-case** — `chat-items.ts`, `claude-provider.ts`, `live-layer.ts`
- **Error definitions** — `errors.ts` colocated with the owning service/domain/package area when shared
- Owner docs define local service file shapes; Next services use `examples/next/lib/services/AGENTS.md`.

## Module Structure - Flat Modules, No Barrel Files

**Avoid barrel files** (index.ts re-exports). Create flat, focused modules:

```
feature/
├── feature.ts
├── errors.ts
└── feature.test.ts

service-name/
├── service.ts
└── model.ts
```

**Each module should be self-contained:**

```typescript
// live-layer.ts - everything related to the service in one file
import { Context, Effect, Layer, Config } from 'effect'
import { AuthError } from './errors'

export class Auth extends Context.Service<Auth>()('@app/Auth', {
  make: Effect.gen(function* () {
    // ...
  })
}) {
  static layer = Layer.effect(this, this.make).pipe(Layer.provide(AuthConfigLayer))
}
```

## Import Conventions

### Use the narrowest valid import path

```typescript
// CORRECT - direct owner module path, not a barrel
import { SomeService } from './services/some-service/live-layer'

// CORRECT - package-internal relative imports include .ts
import { parseAuthCode } from './claude.ts'
```

### Package Imports: Never Use Extensions

```typescript
// CORRECT - package imports are extensionless
import * as Effect from 'effect/Effect'
import * as Schema from 'effect/Schema'
import * as Option from 'effect/Option'

// WRONG - don't use extensions for package imports
import * as Effect from 'effect/Effect.js'
```

### Avoid internal index.ts barrel files

Package public entrypoints (`packages/*/src/index.ts`) are allowed. Avoid app/internal
`index.ts` re-export barrels; they cause:

- Circular dependency issues
- Slower build times (importing everything when you need one thing)
- Harder to trace imports
- Bundle size bloat

```typescript
// CORRECT - import from specific module
import { SomeService } from './live-layer'
import { SomeServiceError } from './errors'

// WRONG - avoid internal barrels
import { SomeService, SomeServiceError } from './index'

// WRONG - avoid app/internal files like this
// index.ts
export * from './live-layer'
export * from './errors'
```

If you see an internal barrel, prefer direct module imports. Do not delete package public
entrypoints.

---

## ESLint Disable Comments

### Always Require Justification

When you must disable an ESLint rule, **always include a comment explaining WHY**. Never disable `no-explicit-any` or `consistent-type-assertions`; use `unknown`, Schema, generics, or a typed wrapper.

```typescript
// WRONG - no explanation, disables banned rule
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const data: any = externalLib.getData()

// CORRECT - contain weak vendor output as unknown
const data: unknown = externalLib.getData()
const parsedEffect = Schema.decodeUnknownEffect(ExternalData)(data)
```

### Valid Reasons for Disabling Rules

| Rule                                | Valid Reason                                      |
| ----------------------------------- | ------------------------------------------------- |
| `@typescript-eslint/no-unused-vars` | Destructuring to omit properties (use `_` prefix) |

### Invalid Reasons (Never Do This)

- "TypeScript is being annoying"
- "I know what I'm doing"
- "It works fine"
- No comment at all

If you can't articulate a clear technical reason, you probably don't need the disable.

---

## Type-Safe Alternatives to Casting

Before reaching for `as` or `any`, try these alternatives:

### 1. Schema.make() for Branded Types

```typescript
// WRONG
const id = rawId as AccountId

// CORRECT
const id = AccountId.make(rawId)
```

### 2. Schema.decodeUnknownEffect() for Parsing

```typescript
// WRONG
const user = data as User

// CORRECT
const user = yield * Schema.decodeUnknownEffect(User)(data)
```

### 3. Option.some<T>() / Option.none<T>() for Options

```typescript
// WRONG - type assertion
const opt = Option.some(value) as Option.Option<SpecificType>

// CORRECT - type parameter
const opt = Option.some<SpecificType>(value)
const empty = Option.none<SpecificType>()
```

### 4. identity<T>() for Compile-Time Verification

```typescript
import { identity } from 'effect/Function'

// identity<T>() verifies the value is already of type T at compile time
// If it's not, you get a compile error (not a runtime error)
const verified = identity<Account>(maybeAccount)

// Useful when TypeScript can't infer the return type correctly
return identity<Effect.Effect<Result, MyError, Deps>>(someEffect)
```

### 5. Proper Generics

```typescript
// WRONG - any
function process(input: any): any {
  return transform(input)
}

// CORRECT - generics
function process<T, R>(input: T, transform: (t: T) => R): R {
  return transform(input)
}
```

### 6. Type Guards

```typescript
// WRONG - assertion
const user = data as User

// CORRECT - type guard with Schema.is()
const isUser = Schema.is(User)

if (isUser(data)) {
  // data is typed as User here
  console.log(data.name)
}
```

---

## Database Row Types

When working with database queries, usually no cast is needed if types are properly defined:

```typescript
// If your Drizzle schema is properly typed:
const users = await db.select().from(usersTable).where(eq(usersTable.id, id))
// users is already typed correctly based on the schema

// WRONG - casting row fields
const accountType = row.account_type as AccountType

// CORRECT - if you need to narrow, use identity (rarely needed)
const accountType = identity<AccountType>(row.account_type)

// BEST - trust the types from your ORM
const account = {
  id: row.id,
  type: row.account_type, // Already typed from Drizzle schema
  name: row.name
}
```

---

## Strict TypeScript Settings

This project uses strict TypeScript settings. Do not weaken them:

```json
{
  "compilerOptions": {
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "noImplicitReturns": true,
    "noFallthroughCasesInSwitch": true,
    "noImplicitOverride": true,
    "exactOptionalPropertyTypes": true
  }
}
```

### noUncheckedIndexedAccess

Array and object indexing returns `T | undefined`:

```typescript
const arr = [1, 2, 3]

// WRONG - arr[0] might be undefined
const first: number = arr[0] // Error!

// CORRECT - handle the undefined case
const first = arr[0]
if (first !== undefined) {
  console.log(first) // first is number here
}

// Or use Array methods that handle this
const first = arr.at(0) // number | undefined
const firstOrDefault = arr[0] ?? 0 // number
```

### exactOptionalPropertyTypes

Optional properties can't be explicitly set to `undefined`:

```typescript
interface Config {
  name: string
  description?: string
}

// WRONG
const config: Config = {
  name: 'test',
  description: undefined // Error!
}

// CORRECT - omit the property
const config: Config = {
  name: 'test'
}

// Or if you need to represent "explicitly unset", use a union:
interface Config {
  name: string
  description?: string | undefined // Now explicit undefined is allowed
}
```

---

## Readonly by Default

Prefer readonly types to prevent accidental mutation:

```typescript
// WRONG - mutable
interface User {
  name: string
  tags: string[]
}

// CORRECT - readonly
interface User {
  readonly name: string
  readonly tags: readonly string[]
}

// For function parameters
function process(users: readonly User[]): void {
  // users.push() would be an error
}

// Effect's Chunk is immutable by design
import { Chunk } from 'effect'
const items = Chunk.make(1, 2, 3) // Immutable
```

---

## Exhaustive Checks

Use `never` for exhaustive switch/if checks:

```typescript
type Status = 'pending' | 'active' | 'completed'

function handleStatus(status: Status): string {
  switch (status) {
    case 'pending':
      return 'Waiting...'
    case 'active':
      return 'In progress'
    case 'completed':
      return 'Done!'
    default:
      // This ensures all cases are handled
      // If a new status is added, TypeScript will error here
      const _exhaustive: never = status
      return _exhaustive
  }
}

// Or use Effect's Match for exhaustive pattern matching
import { Match } from 'effect'

const handleStatus = Match.type<Status>().pipe(
  Match.when('pending', () => 'Waiting...'),
  Match.when('active', () => 'In progress'),
  Match.when('completed', () => 'Done!'),
  Match.exhaustive // Ensures all cases are covered
)
```

---
