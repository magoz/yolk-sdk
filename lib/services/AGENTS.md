# Services Architecture

This document defines the patterns for creating services in this codebase. All services must follow these conventions for consistency.

## File Structure

```
lib/services/
├── [service-name]/
│   ├── live-layer.ts    # Service definition and layer
│   ├── errors.ts        # Service-specific errors (optional)
│   ├── schemas.ts       # Service boundary schemas (optional)
│   └── [helpers].ts     # Additional utilities (optional)
```

- **No barrel files** - Import directly from `live-layer.ts`
- **One service per directory** - Keep services focused and single-purpose
- `as const` is allowed for literal/discriminant inference; `as Type` casts remain banned.

## Service Definition Pattern

Use `Context.Service` with `make` and a static `layer` property:

```typescript
import { Context, Effect, Layer, Config } from 'effect'
import { ServiceNameError } from './errors'

// Internal configuration (if needed)
class ServiceConfig extends Context.Service<ServiceConfig, { readonly apiKey: string }>()(
  '@app/ServiceConfig'
) {}

const ServiceConfigLive = Layer.effect(
  ServiceConfig,
  Effect.gen(function* () {
    const apiKey = yield* Config.string('SERVICE_API_KEY')
    return { apiKey }
  }).pipe(Effect.mapError(() => new ServiceConfigError({ message: 'Config missing' })))
)

// Service definition
export class ServiceName extends Context.Service<ServiceName>()('@app/ServiceName', {
  make: Effect.gen(function* () {
    const config = yield* ServiceConfig

    const methodOne = (arg: string) =>
      Effect.gen(function* () {
        // Implementation
        return result
      }).pipe(Effect.withSpan('ServiceName.methodOne'))

    const methodTwo = () =>
      Effect.gen(function* () {
        // Implementation
      }).pipe(Effect.withSpan('ServiceName.methodTwo'))

    return { methodOne, methodTwo } as const
  })
}) {
  // Composed layer with all dependencies satisfied
  static layer = Layer.effect(this, this.make).pipe(Layer.provide(ServiceConfigLive))
}
```

Key patterns:

- `Context.Service<Self>()('id', { make: ... })` for services with effectful constructors
- `Context.Service<Self, Shape>()('id')` for interface-only services (used in tests)
- `Layer.effect(this, this.make)` builds a layer from the make effect
- `Layer.provide(...)` wires dependencies externally (no `dependencies` option)
- Convention: single `layer` property (not `layer` + `Live`)

## Naming Conventions

| Element       | Convention               | Example                   |
| ------------- | ------------------------ | ------------------------- |
| Service class | PascalCase, noun         | `Auth`, `Email`, `Db`     |
| Service tag   | `@app/ServiceName`       | `@app/Auth`               |
| Static layer  | `layer`                  | `Auth.layer`              |
| Methods       | camelCase, verb-first    | `sendEmail`, `getSession` |
| Spans         | `ServiceName.methodName` | `Auth.signIn`             |

## Error Definition Pattern

Define errors in a separate `errors.ts` file. Use `Data.TaggedError` for simple internal service errors; use `Schema.TaggedErrorClass` when you need `Schema.is`, serialization, or schema-boundary validation.

```typescript
import * as Schema from 'effect/Schema'

// Schema.TaggedErrorClass provides automatic type guards via Schema.is()
export class ServiceApiError extends Schema.TaggedErrorClass<ServiceApiError>()('ServiceApiError', {
  error: Schema.Unknown
}) {
  get message(): string {
    return `API error: ${String(this.error)}`
  }
}

export class ServiceConfigError extends Schema.TaggedErrorClass<ServiceConfigError>()(
  'ServiceConfigError',
  { message: Schema.String }
) {}

// Type guards are automatically derived
export const isServiceApiError = Schema.is(ServiceApiError)
export const isServiceConfigError = Schema.is(ServiceConfigError)
```

**When to choose Schema.TaggedErrorClass:**

- `Schema.is()` creates type guards automatically
- Better integration with Schema validation
- Enables serialization/deserialization of errors
- See `patterns/EFFECT_BEST_PRACTICES.md` for detailed patterns
- Existing simple internal errors (`Auth`, `Email`) use `Data.TaggedError`; schema-boundary errors (`OpenAiCodexOAuth`) use `Schema.TaggedErrorClass`

**Error naming:**

- Prefix with service name: `AuthApiError`, `EmailConfigError`
- Common suffixes: `ApiError`, `ConfigError`, `ValidationError`

**Domain-owned errors** belong in `lib/core/[domain]/errors.ts`; service-owned integration errors may be reused by domain code when the failure originates in that service.

## Configuration Pattern

Use Effect's `Config` module for environment values. Only infrastructure-level sync callbacks may read `process.env` directly (example: `TelemetryLayer`, because `NodeSdk.layer()` requires sync setup).

Config values are **Yieldable** but NOT `Effect` subtypes — yield directly, map errors on the whole block:

```typescript
// Correct — yield directly
const url = yield* Config.string('DATABASE_URL')
const apiKey = yield* Config.redacted('API_KEY') // For secrets

// Error mapping — wrap the whole block, not individual configs
Effect.gen(function* () {
  const url = yield* Config.string('DATABASE_URL')
  const key = yield* Config.redacted('API_KEY')
  return { url, key }
}).pipe(Effect.mapError(() => new ConfigError({ message: 'Config missing' })))

// Wrong — Config is not an Effect, cannot pipe with Effect operators
Config.string('URL').pipe(Effect.mapError(...)) // ERROR in v4
```

Config-aware APIs may receive Config values directly:

```typescript
layerConfig({ url: Config.redacted('DATABASE_URL') })
```

For optional environment variables:

```typescript
import { Option } from 'effect'

const optional = yield* Config.option(Config.string('OPTIONAL_VAR'))
const value = Option.getOrUndefined(optional)
```

Raw `process.env` is allowed only in sync infra callbacks/config boundaries; document any exception inline.

## External HTTP Pattern

- Use Effect `HttpClient` from `effect/unstable/http` inside services.
- Static live layers provide `FetchHttpClient.layer` internally.
- HTTP-backed services should expose an injectable layer factory accepting `Layer.Layer<HttpClient.HttpClient>`.
- `makeOpenAiCodexOAuthLayer(httpClientLayer)` is the current example.
- Avoid raw `fetch` or storing `typeof fetch` in service config.

## Observability Pattern

All service methods must include tracing; add `tapError` where it gives useful external/boundary diagnostics without duplicate noise:

```typescript
const methodName = (arg: string) =>
  Effect.gen(function* () {
    // Add attributes to the span
    yield* Effect.annotateCurrentSpan({
      'service.arg': arg
    })

    const result = yield* doSomething()

    // Add result attributes
    yield* Effect.annotateCurrentSpan({
      'service.resultId': result.id
    })

    return result
  }).pipe(
    Effect.withSpan('ServiceName.methodName'),
    Effect.tapError(error => Effect.logError('Operation failed', { arg, error }))
  )
```

## Layer Composition

Services are composed in `lib/layers.ts`:

```typescript
import { Layer, Logger } from 'effect'
import { Auth } from './services/auth/live-layer'
import { Db } from './services/db/live-layer'
import { OpenAiCodexOAuth } from './services/openai-codex-oauth/live-layer'
import { TelemetryLayer } from './services/telemetry/live-layer'

// Combined app layer — each .layer is fully self-contained
export const AppLayer = Layer.mergeAll(
  Auth.layer,
  Db.layer,
  OpenAiCodexOAuth.layer,
  Logger.layer([Logger.consolePretty()]),
  TelemetryLayer
)
```

`Auth.layer` provides `Email.layer` internally for OTP delivery. Auth uses its own Neon HTTP `AuthDb` for the better-auth adapter; do not dedupe with `Db.layer` unless the adapter supports it. `OpenAiCodexOAuth.layer` is standalone because agent route/actions need it directly. Add standalone services to `AppLayer` only when app code needs them directly.

**Note:** `Logger.consolePretty()` is required for `Effect.logError` / `Effect.logWarning` to produce output. Without it, logs are silent.

### Layer Composition Functions

| Function             | Purpose                                                |
| -------------------- | ------------------------------------------------------ |
| `Layer.provide`      | Satisfies dependencies, removes them from requirements |
| `Layer.provideMerge` | Satisfies dependencies AND keeps them in output        |
| `Layer.merge`        | Combines two independent layers                        |
| `Layer.mergeAll`     | Combines multiple independent layers                   |

## Using Services

```typescript
import { Effect } from 'effect'
import { Auth } from '@/lib/services/auth/live-layer'

const program = Effect.gen(function* () {
  const auth = yield* Auth
  const session = yield* auth.getSessionFromCookies()
  return session
})

// Run with layer
Effect.runPromise(program.pipe(Effect.provide(Auth.layer)))
```

## Checklist for New Services

- [ ] Create directory: `lib/services/[name]/`
- [ ] Create `live-layer.ts` with `Context.Service` + `make` pattern
- [ ] Add static `layer` property (fully composed with all deps)
- [ ] Create `errors.ts` with `Data.TaggedError` or `Schema.TaggedErrorClass` errors (if needed)
- [ ] Use `Config` for environment variables (`yield*` in `Effect.gen`, direct Config for config-aware APIs)
- [ ] Use `Config.redacted` for secrets
- [ ] Use `Config.option` + `Option.match`/`Option.getOrUndefined` for optional env
- [ ] Add `Effect.withSpan()` to all methods
- [ ] Add `Effect.annotateCurrentSpan()` for relevant attributes
- [ ] Add `Effect.tapError()` where boundary error logs help without duplication
- [ ] Add to `lib/layers.ts` AppLayer if app code needs service directly
- [ ] Return `as const` from service make effect for type inference; never cast with `as Type`
