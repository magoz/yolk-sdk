# Telemetry

Spans, error reporting, and observability patterns. All Effect programs should be observable.

## Stack

- **OpenTelemetry** — spans and structured logs via `TelemetryLayer`
- **Effect Logger** — structured console output via `Logger.consolePretty()`

## Spans

Every operation gets a span via `Effect.withSpan`. Domain/package spans prefer `domain.entity.action`; service-method spans may use `Service.method` when that matches existing code:

```
post.get
post.create
auth.get-session
action.post.delete
```

### Where spans go in the pipe

```typescript
// Domain functions: withSpan at the end
Effect.gen(function* () { ... }).pipe(
  Effect.withSpan('post.get')
)

// Server actions: withSpan first (wraps everything including provide/scoped)
Effect.gen(function* () { ... }).pipe(
  Effect.withSpan('action.post.create'),
  Effect.provide(AppLayer),
  Effect.scoped,
  ...
)
```

### Span attributes

Use `attributes` for values known at span creation (inputs, config). Use `annotateCurrentSpan` inside the body for values computed during execution (result IDs, counts):

```typescript
Effect.gen(function* () {
  yield* Effect.annotateCurrentSpan({ 'user.id': session.user.id })
  const result = yield* someOperation()
  yield* Effect.annotateCurrentSpan({ 'result.id': result.id })
  return result
}).pipe(
  Effect.withSpan('domain.entity.action', {
    attributes: { 'entity.id': id }
  })
)
```

### Attribute naming

Dot-separated, lowercase: `post.id`, `user.email`, `result.count`. Prefix with the entity or domain.

## Error Reporting

### Two signals, two purposes

| Signal              | Purpose                          | Coverage                          | Mechanism                                                  |
| ------------------- | -------------------------------- | --------------------------------- | ---------------------------------------------------------- |
| **OTel spans**      | Observability — "what happened?" | Every domain function (automatic) | `Effect.withSpan` marks span as `STATUS: ERROR` on failure |
| **Structured logs** | Boundary diagnostics             | Boundaries only (selective)       | `reportError` inside `tapError` or `catch`                 |

**Key insight:** `withSpan` automatically captures errors in OTel. When an effect fails inside a span, `@effect/opentelemetry` records the exception and sets `status: ERROR` — zero extra code needed. `reportError` adds boundary-owned structured context.

### Decision tree: where to report

```
Error occurs in domain function
  → withSpan automatically marks OTel span as ERROR ✓ (always)
  → Error propagates to caller
    │
    ├─ Caller is an app boundary
    │   → boundary reports unexpected failures with structured context ✓
    │
    ├─ Caller CATCHES and RECOVERS (Effect.catch)
    │   → Error was handled — no report (use reportWarning if degraded)
    │
    └─ Error is UNHANDLED (bare Effect.runPromise)
        → tapError(reportError) before runPromise → structured log ✓
```

Next-specific page/action/API placement lives in `examples/next/patterns/*`.

### Why NOT report at the domain level

Domain functions don't know caller intent. A `NotFoundError` is:

- **Expected** in a page (stale URL → redirect silently)
- **A bug** in an admin batch operation (should alert)
- **Handled** in a "check if exists" flow (caught, no alert needed)

Reporting at domain level would flood logs with expected control flow. Only the boundary knows whether a failure is unexpected.

**The safety net:** `withSpan` gives automatic OTel coverage for ALL errors — including expected ones. You can query failed spans to find failures the boundary didn't report. This eliminates blind spots without log noise.

### reportError

Logs via Effect logger. Used at **boundaries only**:

```typescript
// Server actions: catch expected tags first, then report unexpected failures before final fallback
program.pipe(
  Effect.catchTag('ValidationError', error => Effect.succeed({ _tag: 'Error', message: error.message })),
  Effect.tapError(error => reportError(error, { operation: 'action.domain.create' })),
  Effect.catch(() => Effect.succeed({ _tag: 'Error', message: 'Something went wrong' }))
)

// Catch-all in pages/actions: report unexpected errors
Effect.catch(error => {
  reportError(error, { operation: 'page.domain' })
  return Effect.succeed(<ErrorUI message="Something went wrong" />)
})
```

The `context` parameter adds searchable metadata:

```typescript
reportError(error, {
  operation: 'action.domain.delete',
  entityId: input.entityId,
  userId: session.user.id
})
```

### Infrastructure services: structured log only

Infrastructure services (email, file storage, integrations) use `Effect.logError`. The boundary decides severity.

```typescript
// Infrastructure: log only (callers own severity decision)
Effect.tapError(error => Effect.logError('Email send failed', { error, to }))
```

This prevents double-reporting: if the error propagates to a boundary that also calls `reportError`, logs would get duplicate events for one failure. Infrastructure logs for debugging context; boundaries report user-facing failures.

**Exception:** If an error is **caught before reaching any boundary** (best-effort paths with `Effect.catch`), it must self-report — no boundary will ever see it:

```typescript
// Best-effort: error caught, never reaches boundary — self-report is correct
yield *
  sendNotification(userId).pipe(
    Effect.tapError(e => reportWarning(e, { operation: 'notification.send' })),
    Effect.catch(() => Effect.void)
  )
```

### reportWarning

Same shape as `reportError` but warning level. For non-critical issues:

```typescript
yield *
  reportWarning(
    { _tag: 'RetryExhausted', message: 'Fell back to cached result' },
    { operation: 'external.fetch', retries: 3 }
  )
```

Use cases:

- Operation succeeded after retries
- Fallback behavior activated (best-effort paths)
- Missing optional config
- Data quality issues that don't block

## Retry + Span Ordering

When retrying, put `withSpan` AFTER `retry` so each retry attempt is within the span:

```typescript
Effect.gen(function* () {
  yield* Effect.annotateCurrentSpan({ 'entity.id': id })
  const result = yield* someOperation()
  return result
}).pipe(
  Effect.retry({ while: isTransientError, schedule: retryPolicy }),
  Effect.withSpan('domain.entity.action'),
  Effect.tapError(error => reportError(error, { operation: 'domain.entity.action' }))
)
```

Keep shared retry policies near the service/app layer that owns the transient error model.

## Layer Requirements

Runtime layers must include both for telemetry to work:

- **`Logger.layer([Logger.consolePretty()])`** — routes `Effect.logError` / `Effect.logWarning` to structured console output. Without it, logs are silent.
- **`TelemetryLayer`** — wires OpenTelemetry spans. Without it, `withSpan` is a no-op.

The Next example wires both in `examples/next/lib/layers.ts`.

## Rules

- Every domain function ends with `Effect.withSpan` (OTel sees all errors automatically)
- Every public package/service IO function has `Effect.withSpan` and stable low-cardinality attrs
- App boundaries report unexpected failures; expected auth/not-found/control-flow errors are not log errors.
- Infrastructure services use `Effect.logError` (structured log) — never `reportError` (callers own severity)
- Best-effort paths that catch errors must self-report (boundary will never see them)
- Never use `console.error` directly — use `reportError` or `Effect.logError` inside Effect
- Span name matches `operation` context key in `reportError`
- `annotateCurrentSpan` for IDs and context, not for large payloads
- Do not annotate raw prompts, file contents, request bodies, or other large/sensitive payloads

## Span Conventions

Span names use `domain.entity.action` format. Server actions prefix with `action.`:

| Span                         | Where           |
| ---------------------------- | --------------- |
| `domain.entity.get`          | Domain function |
| `domain.entity.create`       | Domain function |
| `action.entity.create`       | Server action   |
| `action.entity.delete`       | Server action   |
| `Auth.signIn`                | Service method  |
| `Auth.getSessionFromCookies` | Service method  |
| `Integration.call`           | Service method  |

Custom attributes per span:

| Span              | Attributes                           |
| ----------------- | ------------------------------------ |
| `action.entity.*` | `entity.id`, `user.id`, `user.email` |
| `Auth.*`          | (none — session data is the result)  |
| `Integration.*`   | low-cardinality integration metadata |

## Exporters

Current repo wiring uses `TelemetryLayer` plus `Logger.consolePretty()`. No external exporter/env is canonical in repo docs. Add exporter-specific setup only when matching code/config lands.
