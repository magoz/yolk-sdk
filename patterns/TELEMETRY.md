# Telemetry

Spans, error reporting, and observability patterns. All Effect programs should be observable.

## Stack

- **OpenTelemetry** — spans and structured logs via `TelemetryLayer`
- **Sentry** — error/warning capture via `reportError` / `reportWarning`
- **Effect Logger** — structured console output via `Logger.consolePretty()`

## Spans

Every operation gets a span via `Effect.withSpan`. Span names follow `domain.entity.action`:

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

### Two systems, two purposes

| System         | Purpose                          | Coverage                          | Mechanism                                                  |
| -------------- | -------------------------------- | --------------------------------- | ---------------------------------------------------------- |
| **OTel spans** | Observability — "what happened?" | Every domain function (automatic) | `Effect.withSpan` marks span as `STATUS: ERROR` on failure |
| **Sentry**     | Alerting — "wake someone up"     | Boundaries only (selective)       | `reportError` inside `tapError` or `catch`                 |

**Key insight:** `withSpan` automatically captures errors in OTel. When an effect fails inside a span, `@effect/opentelemetry` records the exception and sets `status: ERROR` — zero extra code needed. Sentry requires explicit `reportError` and should only fire for errors that need human investigation.

### Decision tree: where to report

```
Error occurs in domain function
  → withSpan automatically marks OTel span as ERROR ✓ (always)
  → Error propagates to caller
    │
    ├─ Caller is a SERVER ACTION
    │   → tapError(reportError) before catchTag/catch → Sentry ✓
    │
    ├─ Caller is a PAGE (Suspense + Content)
    │   → Auth errors: redirect (expected flow, no Sentry)
    │   → Catch-all: reportError inside catch → Sentry ✓
    │
    ├─ Caller is an API ROUTE
    │   → catch-all handler calls reportError → Sentry ✓
    │   → Auth errors: return HTTP 401/403 (no Sentry)
    │
    ├─ Caller CATCHES and RECOVERS (Effect.catch)
    │   → Error was handled — no Sentry (use reportWarning if degraded)
    │
    └─ Error is UNHANDLED (bare Effect.runPromise)
        → tapError(reportError) before runPromise → Sentry ✓
        → Error throws → Next.js error boundary renders error UI
```

### Why NOT report at the domain level

Domain functions don't know caller intent. A `NotFoundError` is:

- **Expected** in a page (stale URL → redirect silently)
- **A bug** in an admin batch operation (should alert)
- **Handled** in a "check if exists" flow (caught, no alert needed)

Reporting at domain level would flood Sentry with expected control flow. Only the boundary knows whether a failure is unexpected.

**The safety net:** `withSpan` gives automatic OTel coverage for ALL errors — including expected ones. You can query failed spans to find failures the boundary didn't Sentry-report. This eliminates blind spots without alert noise.

### reportError

Logs via Effect logger + captures in Sentry as error. Used at **boundaries only**:

```typescript
// Server actions: tapError before catchTag chains
Effect.tapError(error => reportError(error, { operation: 'action.post.create' }))

// Catch-all in pages/actions: report unexpected errors
Effect.catch(error => {
  reportError(error, { operation: 'page.posts' })
  return Effect.succeed(<ErrorUI message="Something went wrong" />)
})
```

The `context` parameter adds searchable metadata:

```typescript
reportError(error, {
  operation: 'action.post.delete',
  postId: input.postId,
  userId: session.user.id
})
```

### Infrastructure services: structured log only

Infrastructure services (S3, email, Telegram) use `Effect.logError` — structured log, but **no Sentry**. The boundary decides severity.

```typescript
// Infrastructure: log only (callers own Sentry decision)
Effect.tapError(error => Effect.logError('S3 upload failed', { error, key }))
```

This prevents double-reporting: if the error propagates to a boundary that also calls `reportError`, Sentry would get two events for one failure. Infrastructure logs for debugging context; boundaries report for alerting.

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

Same shape as `reportError` but Sentry warning level. For non-critical issues:

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

Retry helpers from `lib/services/retry.ts`:

- `retryPolicy` — exponential backoff (500ms, 1s, 2s, max 3 retries, ~3.5s total)
- `isTransientError` — checks `error.isTransient === true` or `SqlError` instance

## Layer Requirements

`AppLayer` must include both for telemetry to work:

- **`Logger.layer([Logger.consolePretty()])`** — routes `Effect.logError` / `Effect.logWarning` to structured console output. Without it, logs are silent.
- **`TelemetryLayer`** — wires OpenTelemetry spans + Sentry error capture. Without it, `withSpan` is a no-op and Sentry never receives errors.

Both are already in `AppLayer` (`lib/layers.ts`).

## Rules

- Every domain function ends with `Effect.withSpan` (OTel sees all errors automatically)
- Every server action has `tapError(reportError)` before error handling (Sentry alerting)
- Pages report only unexpected errors — auth/not-found are expected flow, no Sentry
- API route catch-all handlers call `reportError` — auth errors return HTTP codes without Sentry
- Infrastructure services use `Effect.logError` (structured log) — never `reportError` (callers own Sentry)
- Best-effort paths that catch errors must self-report (boundary will never see them)
- Never use `console.error` directly — use `reportError` or `Effect.logError` inside Effect
- Never use `Sentry.captureException` directly — use `reportError`
- Span name matches `operation` context key in `reportError`
- `annotateCurrentSpan` for IDs and context, not for large payloads

## Span Conventions

Span names use `domain.entity.action` format. Server actions prefix with `action.`:

| Span                         | Where           |
| ---------------------------- | --------------- |
| `post.get`                   | Domain function |
| `post.create`                | Domain function |
| `action.post.create`         | Server action   |
| `action.post.delete`         | Server action   |
| `Auth.signIn`                | Service method  |
| `Auth.getSessionFromCookies` | Service method  |
| `S3.saveFile`                | Service method  |
| `Email.sendEmail`            | Service method  |
| `Telegram.send`              | Service method  |

Custom attributes per span:

| Span              | Attributes                                  |
| ----------------- | ------------------------------------------- |
| `action.post.*`   | `post.id`, `user.id`, `user.email`          |
| `Auth.*`          | (none — session data is the result)         |
| `S3.*`            | `s3.bucket`, `s3.key`, `s3.size`            |
| `Email.sendEmail` | `email.to`, `email.subject`, `email.id`     |
| `Telegram.send`   | `telegram.messageLength`, `telegram.chatId` |

## Axiom Dashboards

Spans ship to Axiom via OpenTelemetry. Dashboards visualize them.

### API

Auth: personal access token + `X-Axiom-Org-Id` header.

```bash
# List dashboards
curl -H "Authorization: Bearer $AXIOM_TOKEN" \
     -H "X-Axiom-Org-Id: $AXIOM_ORG_ID" \
     "https://api.axiom.co/v2/dashboards"

# Create dashboard
curl -X POST \
     -H "Authorization: Bearer $AXIOM_TOKEN" \
     -H "X-Axiom-Org-Id: $AXIOM_ORG_ID" \
     -H "Content-Type: application/json" \
     "https://api.axiom.co/v2/dashboards" \
     -d '{"dashboard": { ...full dashboard object... }}'

# Update dashboard by UID (upsert)
curl -X PUT \
     -H "Authorization: Bearer $AXIOM_TOKEN" \
     -H "X-Axiom-Org-Id: $AXIOM_ORG_ID" \
     -H "Content-Type: application/json" \
     "https://api.axiom.co/v2/dashboards/uid/{uid}" \
     -d '{"overwrite": true, "dashboard": { ...full dashboard object... }}'
```

Key details:

- **Update endpoint is `/v2/dashboards/uid/{uid}`** (not `/v2/dashboards/{id}`) — requires the `uid` path segment
- `overwrite: true` bypasses version conflicts
- `owner: "X-AXIOM-EVERYONE"` makes dashboard visible to all org members
- Dashboard `uid` is in the URL: `app.axiom.co/{org}/dashboards/uid/{uid}`
