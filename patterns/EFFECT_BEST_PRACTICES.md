# Effect Best Practices

This document covers critical rules and patterns for using Effect in this project.

## Critical Rules

### 1. NEVER Use `any` Type or Type Casts (`x as Y`)

```typescript
// WRONG - never use any
const result: any = someValue
const data = value as any
function process(input: any): any { ... }

// WRONG - never use type casts
const account = data as Account
const id = value as AccountId
const amount = num as number

// CORRECT - use proper types, generics, or unknown
const result: SomeType = someValue
function process<T>(input: T): Result<T> { ... }

// CORRECT - use Schema.make() for branded types
const id = AccountId.make(rawId)
const amount = Percentage.make(value)

// CORRECT - use Schema.decodeUnknownEffect for parsing
const account = yield* Schema.decodeUnknownEffect(Account)(data)
```

Using `any` defeats TypeScript's type system. Type casts (`x as Y`) bypass type checking and can hide bugs.

**AVOID `eslint-disable` comments** - Using disable comments should be an absolute last resort. Before adding one, exhaust ALL alternatives:

1. Use `Schema.make()` for branded types
2. Use `Schema.decodeUnknownEffect()` for parsing unknown data
3. Use `Option.some<T>()` / `Option.none<T>()` for explicit Option types
4. Use `identity<T>()` from `effect/Function` for compile-time type verification
5. Use proper generics and type parameters
6. Refactor the code to avoid the need for casting

**Only use eslint-disable when:**

- Interfacing with external libraries that have incorrect/missing types
- Working around a known TypeScript limitation (document which one)
- Schema.suspend for recursive types (rare)

```typescript
// eslint-disable-next-line @typescript-eslint/consistent-type-assertions -- Schema.suspend requires cast for recursive type
const children: Schema.Schema<TreeNode, TreeNodeEncoded> = Schema.suspend(
  () => TreeNode
) as Schema.Schema<TreeNode, TreeNodeEncoded>

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- Third-party library returns untyped data
const externalData: any = thirdPartyLib.getData()
```

The comment MUST explain WHY the cast is necessary. If you can't articulate a clear reason, you probably don't need the cast.

#### Type-Safe Alternatives to Casting

```typescript
// When you need to specify the type for Option.some/none, use type parameters
const someValue = Option.some<Account>(account) // Option<Account>
const noneValue = Option.none<Account>() // Option<Account>

// Use Option.fromNullishOr for nullable values (enforced by ESLint rule local/prefer-option-from-nullable)
// WRONG - verbose ternary
const desc = row.description !== null ? Option.some(row.description) : Option.none<string>()

// CORRECT - use Option.fromNullishOr
const desc = Option.fromNullishOr(row.description)

// When you need to assert a value matches a type (without casting), use identity
import { identity } from 'effect/Function'

// This verifies x is already of type Account at compile time - if it isn't, you get an error
const verified = identity<Account>(x)

// identity is useful when returning values that TypeScript can't infer correctly
return identity<Effect.Effect<Result, MyError, Deps>>(someEffect)
```

#### Database Row Types - Usually No Cast Needed

```typescript
// WRONG - using `as` to cast database row fields
const accountType = row.account_type as AccountType

// WRONG - using Schema.decode for simple type aliases (overkill)
const accountType = yield * Schema.decodeUnknownEffect(AccountType)(row.account_type)

// CORRECT - if the type is a simple string literal union, just use identity (if needed at all)
const accountType = identity<AccountType>(row.account_type)

// BEST - most of the time no cast is needed at all!
// If your SQL query returns the right type and your row type is properly defined:
const account = {
  id: row.id,
  type: row.account_type, // TypeScript infers this correctly if row is typed
  name: row.name
}
```

The key insight: if your database row type is properly defined, you don't need any cast. Only use `identity<T>()` when TypeScript can't infer the type correctly, and even then question if your types are set up right.

### 2. NEVER Use `catch` When Error Type Is `never`

```typescript
// If the effect never fails, error type is `never`
const infallibleEffect: Effect.Effect<Result, never> = Effect.succeed(value)

// WRONG - catch on never is useless and indicates misunderstanding
infallibleEffect.pipe(Effect.catch(e => Effect.fail(new SomeError({ message: String(e) }))))

// CORRECT - if error is never, just use the effect directly
infallibleEffect
```

The `never` error type means the effect cannot fail. Adding `catch` to a `never` error is a code smell - it means either:

- The effect truly can't fail and catch is dead code
- The effect can fail but you're hiding errors with improper typing (often from using `any`)

### 3. NEVER Use Global `Error` in Effect Error Channel

```typescript
// WRONG - global Error breaks Effect's typed error handling
const bad: Effect.Effect<Result, Error> = Effect.fail(new Error('failed'))
Effect.catch(e => Effect.fail(new Error(`Wrapped: ${e}`)))

// CORRECT - use Schema.TaggedErrorClass for all domain errors
export class ValidationError extends Schema.TaggedErrorClass<ValidationError>()('ValidationError', {
  message: Schema.String
}) {
  // Optional: custom message getter
  get formattedMessage(): string {
    return `Validation failed: ${this.message}`
  }
}

const good: Effect.Effect<Result, ValidationError> = Effect.fail(
  new ValidationError({ message: 'failed' })
)
```

Using the global `Error` type:

- Breaks type-safe error handling (all errors merge into `Error`)
- Prevents using `Effect.catchTag` for precise error handling
- Makes error discrimination impossible
- Prevents the compiler from tracking which errors are handled

Always use `Schema.TaggedErrorClass` with a unique `_tag` for every error type.

### 3.1 `Effect.die` Is for Defects Only

Use `Effect.die` only for impossible programmer defects: invariant violations that mean the
code is wrong and should crash. Do not use it for persistence anomalies, missing rows,
validation, auth, provider failures, config failures, or user-correctable input.

```typescript
// WRONG - empty returning() is an expected persistence failure shape
if (row === undefined) {
  return yield* Effect.die(new Error('Could not create row'))
}

// CORRECT - typed failure reaches boundary handlers and telemetry cleanly
if (row === undefined) {
  return yield* Effect.fail(new PersistenceError({ message: 'Could not create row' }))
}
```

Rule of thumb: if a server action can return a user-safe message or retry/report the failure,
it belongs in the typed error channel, not the defect channel.

### 4. NEVER Use `{ disableValidation: true }` - It Is Banned

```typescript
// WRONG - disableValidation defeats Schema's purpose
const account = Account.make(data, { disableValidation: true }) // BANNED
const id = AccountId.make(rawId, { disableValidation: true }) // BANNED

// CORRECT - let Schema validate the data, always
const account = Account.make(data)
const id = AccountId.make(rawId)
```

Disabling validation defeats the purpose of using Schema. If you're seeing validation errors:

- Fix the data to match the schema
- Fix the schema if the validation is too strict
- NEVER disable validation to work around the issue

This is enforced by ESLint rule `local/no-disable-validation`.

### 5. Don't Wrap Safe Operations in Effect Unnecessarily

```typescript
// WRONG - Effect.try is for wrapping operations that might throw
const result = Effect.try(() => someValue) // unnecessary if someValue can't throw
const mapped = Effect.try(() => array.map(fn)) // array.map doesn't throw

// ALSO WRONG - Effect.succeed is often unnecessary too
const mapped = Effect.succeed(array.map(fn)) // why wrap in Effect at all?

// CORRECT - for pure transformations, just use a normal function
const mapAccounts = (rows: Row[]): Account[] => rows.map(toAccount)

// CORRECT - use Effect.try ONLY for operations that might throw
const parsed = Effect.try(() => JSON.parse(jsonString)) // JSON.parse can throw
const file = Effect.try(() => fs.readFileSync(path)) // file operations can throw

// CORRECT - use Effect only when you need its capabilities (errors, async, dependencies)
const fetchAccount = (id: AccountId): Effect.Effect<Account, NotFoundError, AccountRepo> =>
  Effect.gen(function* () {
    const repo = yield* AccountRepo
    return yield* repo.findById(id)
  })
```

**Key insight**: If an operation can't fail and doesn't need dependencies or async, it's just a function. Don't wrap everything in Effect - use Effect for what it's good at (typed errors, dependency injection, async composition).

### 6. NEVER Use `Effect.catchCause` to Wrap Errors - It Catches Defects

```typescript
// WRONG - catchCause catches BOTH errors AND defects (bugs)
const wrapError =
  (operation: string) =>
  <A, E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<A, ServiceError, R> =>
    Effect.catchCause(effect, cause =>
      Effect.fail(new ServiceError({ operation, cause: Cause.squash(cause) }))
    )

// CORRECT - use catch to only catch expected errors, let defects propagate
const wrapError =
  (operation: string) =>
  <A, E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<A, E | ServiceError, R> =>
    Effect.catch(effect, error => Effect.fail(new ServiceError({ operation, cause: error })))

// OR use mapError for simple error transformation
const wrapError =
  (operation: string) =>
  <A, E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<A, ServiceError, R> =>
    Effect.mapError(effect, error => new ServiceError({ operation, cause: error }))
```

**Why this matters:**

- **Errors** are expected failures (user not found, validation failed) - they should be handled
- **Defects** are bugs (null pointer, division by zero) - they should crash and be fixed
- `catchCause` catches both, hiding bugs that should be fixed
- Use `catch` or `mapError` to transform only expected errors

This is enforced by ESLint rule `local/no-catch-all-cause`.

---

## Pipe Composition

### Long Pipes - Chain `.pipe()` Calls for Readability

When composing many operations, instead of putting all functions in a single `.pipe()` call, you can chain multiple `.pipe()` calls. This improves readability for long pipelines.

```typescript
// Single pipe with many operations - can be hard to read
const result = effect.pipe(
  Effect.map(transformA),
  Effect.flatMap(fetchRelated),
  Effect.map(transformB),
  Effect.catchTag('NotFound', handleNotFound),
  Effect.map(transformC),
  Effect.tap(logResult),
  Effect.withSpan('myOperation')
)

// Chained pipes - easier to read and group related operations
const result = effect
  .pipe(Effect.map(transformA))
  .pipe(Effect.flatMap(fetchRelated))
  .pipe(Effect.map(transformB))
  .pipe(Effect.catchTag('NotFound', handleNotFound))
  .pipe(Effect.map(transformC))
  .pipe(Effect.tap(logResult))
  .pipe(Effect.withSpan('myOperation'))

// You can also group related operations together
const result = effect
  .pipe(Effect.map(transformA), Effect.flatMap(fetchRelated), Effect.map(transformB))
  .pipe(
    Effect.catchTag('NotFound', handleNotFound),
    Effect.catchTag('ValidationError', handleValidation)
  )
  .pipe(Effect.tap(logResult), Effect.withSpan('myOperation'))
```

**Why chained pipes are necessary:**

- **`.pipe()` has a maximum of 20 arguments** - TypeScript's type inference breaks down beyond this limit, so long pipelines must be split
- When you want to visually group related operations
- When debugging - you can easily comment out a single `.pipe()` step
- When the single-pipe style becomes hard to scan

**Both styles are valid** for shorter pipelines - use whichever is clearer. For pipelines with 20+ operations, chaining is required.

---

## Schema Patterns

### Always Use Schema for Data Classes

**Never manually implement Equal/Hash** - always use Schema.Class or Schema.TaggedClass which provide them automatically.

```typescript
// WRONG - manual class with Equal/Hash implementation
export class AccountNode implements Equal.Equal {
  readonly _tag = 'AccountNode'

  constructor(
    readonly account: Account,
    readonly children: ReadonlyArray<AccountNode>
  ) {}

  // DON'T DO THIS - Schema provides it automatically
  [Equal.symbol](that: unknown): boolean {
    return (
      that instanceof AccountNode &&
      Equal.equals(this.account, that.account) &&
      this.children.length === that.children.length &&
      this.children.every((child, i) => Equal.equals(child, that.children[i]))
    )
  }

  // DON'T DO THIS - Schema provides it automatically
  [Hash.symbol](): number {
    return Hash.combine(Hash.hash(this.account))(Hash.array(this.children))
  }
}

// CORRECT - Schema.TaggedClass with automatic Equal/Hash
export class AccountNode extends Schema.TaggedClass<AccountNode>()('AccountNode', {
  account: Account,
  children: Schema.Array(Schema.suspend((): Schema.Schema<AccountNode> => AccountNode))
}) {
  get hasChildren(): boolean {
    return this.children.length > 0
  }

  get childCount(): number {
    return this.children.length
  }
}

// Usage - .make() is automatic, Equal/Hash work automatically
const node = AccountNode.make({ account, children: [] })
Equal.equals(node1, node2) // Works without manual implementation
```

### Defining Recursive Schema Classes

For self-referencing (recursive) types, use `Schema.suspend()` to defer the schema reference. Define an interface for the encoded type to properly type the suspend:

```typescript
import * as Schema from 'effect/Schema'

// Step 1: Declare and export the encoded type interface (before the class)
export interface TreeNodeEncoded extends Schema.Schema.Encoded<typeof TreeNode> {}

// Step 2: Define the class with Schema.suspend referencing both type and encoded
export class TreeNode extends Schema.TaggedClass<TreeNode>()('TreeNode', {
  value: Schema.String,
  // Use Schema.suspend() with both type parameters: <Type, Encoded>
  children: Schema.Array(Schema.suspend((): Schema.Schema<TreeNode, TreeNodeEncoded> => TreeNode))
}) {}

// Usage
const tree = TreeNode.make({
  value: 'root',
  children: [
    TreeNode.make({ value: 'child1', children: [] }),
    TreeNode.make({ value: 'child2', children: [] })
  ]
})
```

**Key points:**

- Declare `export interface MyClassEncoded extends Schema.Schema.Encoded<typeof MyClass> {}` before the class
- Export both the class and the encoded interface together
- Use `Schema.Schema<MyClass, MyClassEncoded>` in the suspend thunk
- This pattern ensures proper typing for both the decoded and encoded types
- Works with both `Schema.Class` and `Schema.TaggedClass`

### Prefer Schema.Class Over Schema.Struct

**Always prefer `Schema.Class`** - it gives you a proper class with constructor, type guard support, and Equal/Hash.

```typescript
// WRONG - Schema.Struct creates plain objects
export const Account = Schema.Struct({
  id: AccountId,
  name: Schema.String
})
type Account = typeof Account.Type // just a plain object type

// CORRECT - Schema.Class creates a proper class
export class Account extends Schema.Class<Account>('Account')({
  id: AccountId,
  name: Schema.String
}) {
  // Can add methods
  get displayName() {
    return `${this.name} (${this.id})`
  }
}
```

### Branded Types for IDs

Use `Schema.brand` to create type-safe IDs:

```typescript
import * as Schema from 'effect/Schema'

// Define the branded type
export const AccountId = Schema.Trimmed.pipe(
  Schema.check(Schema.isNonEmpty()),
  Schema.brand('AccountId')
)

// Export the type
export type AccountId = typeof AccountId.Type

// Use .make() to create instances (validates by default)
const id = AccountId.make('acc_123')

// For DB rows, if the row type is properly defined, no cast needed
// The value is already validated when it was written to the DB
```

### Never Use \*FromSelf Schemas

**All `*FromSelf` schemas were removed in Effect v4.** In v3, variants like `Schema.OptionFromSelf`, `Schema.EitherFromSelf`, `Schema.ChunkFromSelf` expected runtime representations and didn't serialize to JSON properly. In v4, only the standard variants exist.

```typescript
// v3 (removed in v4) - these no longer exist
Schema.OptionFromSelf(AccountId) // Does not exist
Schema.EitherFromSelf(Schema.String, Schema.Number) // Does not exist
Schema.BigIntFromSelf // Does not exist — use Schema.BigInt

// CORRECT - use the standard variants (same as v3)
export class Account extends Schema.Class<Account>('Account')({
  id: AccountId,
  parentId: Schema.Option(AccountId) // Encodes to JSON properly
}) {}
```

The ESLint rule `local/no-schema-from-self` catches any accidental use of stale v3 `*FromSelf` patterns.

### Schema.TaggedErrorClass for Domain Errors

Use `Schema.TaggedErrorClass` for all domain errors. Schema automatically provides type guards via `Schema.is()`.

```typescript
import * as Schema from 'effect/Schema'
import * as Effect from 'effect/Effect'

// Simple error with fields
export class AccountNotFound extends Schema.TaggedErrorClass<AccountNotFound>()('AccountNotFound', {
  accountId: Schema.String
}) {
  // Optional: custom message getter
  get message(): string {
    return `Account not found: ${this.accountId}`
  }
}

// Error with cause (for wrapping other errors)
export class PersistenceError extends Schema.TaggedErrorClass<PersistenceError>()(
  'PersistenceError',
  {
    operation: Schema.String,
    cause: Schema.Unknown
  }
) {
  get message(): string {
    return `Persistence error during ${this.operation}`
  }
}

// Union type for all errors in module
export type AccountError = AccountNotFound | PersistenceError

// Type guards are automatically derived using Schema.is()
export const isAccountNotFound = Schema.is(AccountNotFound)
export const isPersistenceError = Schema.is(PersistenceError)

// Usage example
const checkError = (error: unknown) => {
  if (isAccountNotFound(error)) {
    console.log(`Account ${error.accountId} not found`)
  }
}
```

### Schema.Class for Domain Entities

Use `Schema.Class` for domain entities. Equal, Hash, and constructors are auto-provided.

```typescript
import * as Schema from 'effect/Schema'

export class Account extends Schema.Class<Account>('Account')({
  id: AccountId,
  code: Schema.Trimmed.pipe(Schema.check(Schema.isNonEmpty())),
  name: Schema.Trimmed.pipe(Schema.check(Schema.isNonEmpty())),
  type: Schema.Literal('Asset', 'Liability', 'Equity', 'Revenue', 'Expense'),
  normalBalance: Schema.Literal('Debit', 'Credit'),
  isActive: Schema.Boolean
}) {
  // Add custom methods as needed
  get isExpenseOrRevenue(): boolean {
    return this.type === 'Expense' || this.type === 'Revenue'
  }
}

// Type guard is automatically derived
export const isAccount = Schema.is(Account)
```

**Always use `.make()` - never `new`:**

```typescript
// CORRECT - use .make()
const account = Account.make({ id, code: '1000', name: 'Cash' /* ... */ })

// WRONG - don't use new
const account = new Account({ id, code: '1000', name: 'Cash' /* ... */ })
```

**All schemas have `.make()` - not just classes:**

```typescript
// Branded types
export const AccountId = Schema.String.pipe(Schema.brand('AccountId'))
const id = AccountId.make('acc_123') // Creates branded AccountId

// Structs (if you must use them)
export const Money = Schema.Struct({
  amount: Schema.BigDecimal,
  currency: CurrencyCode
})
const money = Money.make({ amount, currency })
```

**Constructor defaults:**

```typescript
export class JournalEntry extends Schema.Class<JournalEntry>('JournalEntry')({
  id: JournalEntryId,
  date: Schema.DateFromSelf,
  description: Schema.String,
  // Default value for constructor
  status: Schema.propertySignature(Schema.String).pipe(Schema.withConstructorDefault(() => 'draft'))
}) {}

// status defaults to "draft"
const entry = JournalEntry.make({ id, date: new Date(), description: '...' })
```

### Schema Decoding/Encoding - Use Effect Variants

**NEVER** use `decodeUnknownSync` or `encodeUnknownSync` - they throw exceptions. Always use the Effect variants that return `Effect<A, ParseError>`:

```typescript
import * as Schema from 'effect/Schema'
import * as Effect from 'effect/Effect'

// WRONG - throws exceptions
const account = Schema.decodeUnknownSync(Account)(data) // DON'T DO THIS

// CORRECT - returns Effect (v4: decodeUnknown → decodeUnknownEffect)
const accountEffect = Schema.decodeUnknownEffect(Account)(data) // Effect<Account, ParseError>

// Usage in Effect.gen
const program = Effect.gen(function* () {
  const account = yield* Schema.decodeUnknownEffect(Account)(data)
  // account is now typed as Account
  return account
})

// For encoding
const encoded = yield * Schema.encodeEffect(Account)(account) // Effect<AccountEncoded, ParseError>
```

---

## Value-Based Equality in Effect

Effect provides **value-based equality** through the `Equal` and `Hash` modules. This means two separate objects with the same field values are considered equal.

**Why this matters for domain entities:**

```typescript
// With JavaScript ===, two objects with same data are NOT equal
const acc1 = { id: 'acc_123', name: 'Cash' }
const acc2 = { id: 'acc_123', name: 'Cash' }
console.log(acc1 === acc2) // false - different object references

// With Effect's Equal.equals, objects with same data ARE equal
import { Equal } from 'effect'

class Account extends Schema.Class<Account>('Account')({
  id: AccountId,
  name: Schema.String
}) {}

const account1 = Account.make({ id, name: 'Cash' })
const account2 = Account.make({ id, name: 'Cash' })
console.log(Equal.equals(account1, account2)) // true - same values!
```

**How it works:**

1. **Schema.Class extends Data.Class** - which implements `Equal` and `Hash` traits
2. **Fields are compared recursively** using `Equal.equals()`, not `===`
3. **Nested Effect objects** (other Schema.Class instances, Options, etc.) are compared by value
4. **Hash is consistent** - equal objects produce the same hash code

**Using Equal.equals in practice:**

```typescript
import { Equal, Hash } from 'effect'

// Compare any two values
if (Equal.equals(account1, account2)) {
  console.log('Same account data')
}

// Works in collections - HashMap, HashSet use Equal/Hash
import { HashMap, HashSet } from 'effect'

const accounts = HashSet.make(account1, account2)
// If account1 and account2 have same values, set has size 1

const map = HashMap.make([account1, 'value1'])
HashMap.get(map, account2) // Returns "value1" because account2 equals account1
```

**Important:** Always use `Equal.equals()` to compare Effect objects, not `===`:

```typescript
// WRONG
if (account1 === account2) {
  /* ... */
} // Only true for same reference

// CORRECT
if (Equal.equals(account1, account2)) {
  /* ... */
} // True for same values
```

### Use Chunk Instead of Array for Structural Equality

**Plain JavaScript arrays do NOT implement Equal/Hash** - this means `Equal.equals` doesn't work correctly with nested arrays, even inside Schema classes.

```typescript
import { Equal } from 'effect'

// Arrays break structural equality - WRONG
const arr1 = [1, 2, 3]
const arr2 = [1, 2, 3]
Equal.equals(arr1, arr2) // false! Arrays don't implement Equal

// Even inside Schema classes - WRONG
export class AccountHierarchy extends Schema.Class<AccountHierarchy>('AccountHierarchy')({
  root: Account,
  children: Schema.Array(Account) // Arrays won't compare by value
}) {}

const h1 = AccountHierarchy.make({ root, children: [child1, child2] })
const h2 = AccountHierarchy.make({ root, children: [child1, child2] })
Equal.equals(h1, h2) // false! Even though all fields are equal
```

**Always use `Chunk` instead of `Array`** in domain models - Chunk implements Equal and Hash properly:

```typescript
import { Chunk, Equal } from 'effect'
import * as Schema from 'effect/Schema'

// Chunks work with structural equality - CORRECT
const c1 = Chunk.make(1, 2, 3)
const c2 = Chunk.make(1, 2, 3)
Equal.equals(c1, c2) // true!

// Use Schema.Chunk in domain models - CORRECT
export class AccountHierarchy extends Schema.Class<AccountHierarchy>('AccountHierarchy')({
  root: Account,
  children: Schema.Chunk(Account) // Chunk compares by value!
}) {}

const h1 = AccountHierarchy.make({ root, children: Chunk.make(child1, child2) })
const h2 = AccountHierarchy.make({ root, children: Chunk.make(child1, child2) })
Equal.equals(h1, h2) // true! Structural equality works

// Creating Chunk values
const empty = Chunk.empty<Account>()
const single = Chunk.of(account)
const fromArray = Chunk.fromIterable([acc1, acc2])
const built = Chunk.make(acc1, acc2, acc3)
```

**Why this matters:**

- Domain models should be comparable by value for testing, caching, and change detection
- Using `Array` silently breaks equality even when all elements are equal
- `Chunk` is Effect's immutable sequence that properly implements Equal/Hash
- This applies to all collection fields in Schema classes

---

## Error Handling

### Using Effect.catchTag for Error Handling

```typescript
import { Effect, Match } from 'effect'

const program = fetchAccount(accountId).pipe(
  Effect.catchTag('AccountNotFound', error => Effect.succeed(createDefaultAccount())),
  Effect.catchTag('PersistenceError', error => Effect.logError(`Database error: ${error.cause}`))
)

// Or use Match for exhaustive handling
const handleError = Match.type<AccountError>().pipe(
  Match.tag('AccountNotFound', err => `Account ${err.accountId} not found`),
  Match.tag('PersistenceError', err => `Database error occurred`),
  Match.exhaustive
)
```

---

## Service Pattern (Context.Service + Layer)

```typescript
import { Effect, Layer, Context, Config } from 'effect'

// Service with make: constructor logic is part of the class definition
export class AccountService extends Context.Service<AccountService>()('@app/AccountService', {
  make: Effect.gen(function* () {
    const db = yield* Db
    const connectionString = yield* Config.string('DATABASE_URL')

    return {
      findById: (id: AccountId): Effect.Effect<Account, AccountNotFound> =>
        Effect.gen(function* () {
          const rows = yield* db.query(/* ... */)
          // ...
        }),
      findAll: (): Effect.Effect<ReadonlyArray<Account>> =>
        Effect.gen(function* () {
          // ...
        }),
      create: (account: Account): Effect.Effect<Account, PersistenceError> =>
        Effect.gen(function* () {
          // ...
        })
    } as const
  })
}) {
  // Layer using Layer.effect(this, this.make) — no this.Default in v4
  static layer = Layer.effect(this, this.make).pipe(Layer.provide(Db.layer))
}
```

### Layer Pattern

**Use `Layer.effect(this, this.make)`** — there is no `this.Default` in v4.

```typescript
// Simple service
export class MyService extends Context.Service<MyService>()('@app/MyService', {
  make: Effect.gen(function* () {
    return {
      /* service shape */
    } as const
  })
}) {
  static layer = Layer.effect(this, this.make)
}

// Service with dependencies
export class AccountService extends Context.Service<AccountService>()('@app/AccountService', {
  make: Effect.gen(function* () {
    const db = yield* Db
    return {
      /* service shape */
    } as const
  })
}) {
  static layer = Layer.effect(this, this.make).pipe(Layer.provide(Db.layer))
}
```

**Layer.scoped** - When the service needs resource cleanup (subscriptions, background fibers, etc.):

```typescript
// Example: Service with a PubSub for change notifications
export class NotificationService extends Context.Service<NotificationService>()(
  '@app/NotificationService',
  {
    make: Effect.gen(function* () {
      const db = yield* Db

      // Create a PubSub that will be cleaned up when layer is released
      const changes = yield* PubSub.unbounded<AccountChange>()

      // Start a background fiber that will be interrupted on cleanup
      yield* Effect.forkScoped(
        db
          .subscribe('account_changes')
          .pipe(Stream.runForEach(change => PubSub.publish(changes, change)))
      )

      return {
        subscribe: PubSub.subscribe(changes)
      } as const
    })
  }
) {
  // Layer.scoped cleans up PubSub and background fiber
  static layer = Layer.scoped(this, this.make).pipe(Layer.provide(Db.layer))
}
```

**Composing layers:**

```typescript
// Provide dependencies externally with Layer.provide
export const AppLayer = Layer.mergeAll(AccountService.layer, NotificationService.layer, Db.layer)
```
