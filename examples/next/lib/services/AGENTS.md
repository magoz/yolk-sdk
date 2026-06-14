# Services Architecture

App-owned infrastructure adapters and Effect services. Services talk to DBs, providers, HTTP APIs, object storage, and env config; core domain code composes them.

## Shape

```txt
examples/next/lib/services/[service-name]/
  live-layer.ts          # service class + layer
  errors.ts             # service errors, optional
  schemas.ts            # boundary schemas, optional
  live-layer.test.ts    # fake-layer tests for HTTP/config services
```

## Rules

- No barrel files; import directly from `live-layer.ts`.
- One service per directory; keep adapters focused.
- Use `Context.Service` + `make` + static `layer`; see `patterns/EFFECT_BEST_PRACTICES.md`.
- `Context.Service<Self>()('id', { make })` for effectful constructors.
- `Context.Service<Self, Shape>()('id')` for interface-only services in tests.
- Use `Layer.effect(this, this.make)`; compose deps with `Layer.provide(...)`.
- Single static `layer` property; avoid `layer` + `Live` twins.
- Return `as const` from service `make` for literal inference; `as Type` casts stay banned.

## Config

- Use Effect `Config.*` in service/layer construction; see `patterns/EFFECT_BEST_PRACTICES.md#config-pattern`.
- Use `Config.redacted` for secrets.
- Use `Config.option` + `Option` helpers for optional env.
- Raw `process.env` only in sync infra callbacks/config boundaries; document exceptions inline.

## HTTP

- Use Effect `HttpClient` from `effect/unstable/http` inside services.
- Static live layers provide `FetchHttpClient.layer` internally.
- HTTP-backed services expose injectable layer factories accepting `Layer.Layer<HttpClient.HttpClient>`.
- Current examples: `makeOpenAiCodexOAuthLayer(httpClientLayer)`, `makeAnthropicClaudeOAuthLayer(httpClientLayer)`.
- Email is the current SDK-client exception: `email/live-layer.ts` wraps Resend directly.
- Avoid raw `fetch` or storing `typeof fetch` in service config.

## Errors

- Service-owned integration errors live beside the service.
- Domain-owned errors live in `examples/next/lib/core/errors` or beside the owning domain file.
- Use `Data.TaggedError` for simple internal service errors.
- Use `Schema.TaggedErrorClass` when `Schema.is`, serialization, or schema-boundary validation is needed.
- Prefix service errors with the service name; common suffixes: `ApiError`, `ConfigError`, `ValidationError`.

## Observability

- Public IO methods get `Effect.withSpan('Service.method')`.
- Add `Effect.annotateCurrentSpan` for useful boundary ids/counts.
- Add `Effect.tapError` only where boundary diagnostics help without duplicate noise.
- `Logger.layer([Logger.consolePretty()])` is required for `Effect.logError` / `Effect.logWarning`; see `patterns/TELEMETRY.md`.

## Layer composition

- Services are composed in `examples/next/lib/layers.ts`.
- `Auth.layer` provides `Email.layer` internally for OTP delivery.
- Auth uses its own Neon HTTP `AuthDb` for better-auth; do not dedupe with `Db.layer` unless adapter support changes.
- OAuth services stay standalone because agent routes/actions need them directly.
- `AppKnowledgeSearchLayer` is composed at storage/knowledge search boundaries, not in `AppLayer`; it requires `OPENAI_API_KEY` only for ingestion/search.
- Add standalone services to `AppLayer` only when app code needs them directly.

## Checklist

- [ ] `live-layer.ts` exports service + fully composed static `layer`
- [ ] `errors.ts` / `schemas.ts` added only when needed
- [ ] Config uses `Config.*`, not raw env
- [ ] HTTP uses injectable `HttpClient` layer when external
- [ ] Public methods have spans and useful annotations
- [ ] AppLayer updated only if app code needs direct service access
