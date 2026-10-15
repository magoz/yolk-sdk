# Pool Package

`@yolk-sdk/pool` implements subscription account pools
([ADR 0011](../../docs/adr/0011-subscription-pools.md)): one `LLMProvider` over several accounts of
one provider, ported from the CLIProxyAPI `expiring-first` scheduler plugin
(`magoz/cpa-expiring-first`). Quota reset hints (`ProviderErrorInfo.quotaResetsAtMs`) and usage
windows (`windowDurationMinutes`, `models`) come from `@yolk-sdk/agent`.

## Subpaths

| Subpath                | Source         | Role                                                                                      |
| ---------------------- | -------------- | ----------------------------------------------------------------------------------------- |
| `@yolk-sdk/pool`       | `src/index.ts` | `makePool`, `poolFailureCooldown`, pure `rankPool`/`staleQuotaCooldowns`, Schemas, errors |
| `@yolk-sdk/pool/store` | `src/store.ts` | `PoolStoreApi`, `PoolStoredReading`, `makeMemoryPoolStore`, `poolStoreContract`           |

## Boundaries

- Depends only on `@yolk-sdk/agent/{loop,protocol,providers/subscription-usage}` and Effect; no
  Node builtins (boundary-enforced). `@yolk-sdk/agent` never imports this package.
- Hosts own accounts, credentials and refresh, the store implementation, reading schedules, labels,
  and UI. The pool never sees tokens and never calls usage endpoints.

## Rules

- `src/rank.ts` is pure (no Effect services, no clock): ranking, sticky fallback, and stale
  cooldown detection take `nowMs` and plain data. Keep behavior changes there and port new plugin
  tests as table tests (`test/rank.test.ts`); `test/rank.property.test.ts` holds the invariants.
- Failover only for account-scoped failures before the first event (`poolFailureCooldown`: quota
  reset, `Retry-After` of at least 30 minutes, `auth`). Never cool down or switch accounts for
  transient failures, failures after an event, or interruptions: the loop's retry re-runs the pick,
  and doing both multiplies attempts.
- Every account out fails `retryable: false` (else the loop sleeps until a far reset). Quota
  cooldowns carry `quotaResetsAtMs`; an auth-only outage reports `auth` without it.
- Routes are `poolRoute(model)` (trimmed, lowercased); never fold reasoning effort into them.
- Pins are written only when they change (compare-and-set); no per-request store writes.
- Store failures never fail a request: reads fall back to stateless fill-first, writes are logged.
- The fallback (no account usable by a fresh reading) skips accounts a fresh reading shows used up
  unless nothing else is left; stale-cooldown clearing reads account-wide windows only (model-scoped
  windows block their models through ranking).
- Cooldowns are trusted only when finite and at most `poolMaxCooldownMs` ahead.
- Logs and spans name pools, routes, account ids, and store operations only; never tokens, emails, or host store error messages (they may carry connection details).
- `poolStoreContract` cases are the store semantics; change them only together with the ADR and
  `makeMemoryPoolStore`.
