---
'@yolk-sdk/pool': minor
---

New package `@yolk-sdk/pool`: subscription account pools (ADR 0011). One `LLMProvider` over several accounts of one provider, the in-process counterpart of CLIProxyAPI with the `expiring-first` scheduler plugin.

- `makePool({ id, accounts, store, maxAgeMs?, reservePercent? })` returns `{ provider, recordReading, state }`. Each request goes to the account whose longest applicable usage window resets soonest and still has quota (readings within `maxAgeMs`, default 30 minutes; model-scoped windows apply only to their models); without fresh readings the route stays on its pinned account, else fill-first (highest priority, then lowest id).
- Failover before the first event, only for account-scoped failures (`poolFailureCooldown`): a `rate_limit` with `quotaResetsAtMs` or a `Retry-After` of at least 30 minutes cools the account down until then, `auth` for 30 minutes, and the same request moves to the next account. Other failures, and failures after an event, reach the caller unchanged so the loop's retry handles them. With every account out the pool fails `rate_limit`, `retryable: false`, with the earliest quota reset (an auth-only outage fails `auth`).
- A quota cooldown clears when a fresh reading taken after it began shows quota left (a spent limit reset).
- `@yolk-sdk/pool/store`: the `PoolStoreApi` port (pins per pool and route with compare-and-set, one cooldown per account keeping the later end, latest reading per account), `makeMemoryPoolStore`, and `poolStoreContract` cases for host implementations. Store failures never fail a request.
- Pure `rankPool`, `staleQuotaCooldowns`, `poolReadingFromSnapshot`, and `poolRoute`; Schemas `PoolPin`, `PoolQuotaCooldown`, `PoolAuthCooldown`, `PoolCooldown`; errors `PoolConfigError`, `PoolStoreError`, `PoolUnknownAccountError`.
