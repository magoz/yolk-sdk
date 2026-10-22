# @yolk-sdk/pool

## 0.1.0-canary.121

### Patch Changes

- 59d338d: Advance in lockstep with `@yolk-sdk/mcp`, whose `makeMcpToolServer().handleHttpRequest` now finishes every exchange before it returns, so no tool call runs after the caller's scope has closed. These packages have no direct changes in this release.
- Updated dependencies [59d338d]
  - @yolk-sdk/agent@0.1.0-canary.121

## 0.1.0-canary.120

### Patch Changes

- 79595fc: Advance in lockstep with `@yolk-sdk/agent`, which now shows Claude (compatibility mode) the real type of `Schema.optional` tool params instead of an unconstrained value. These packages have no direct changes in this release.
- Updated dependencies [a9eee1b]
  - @yolk-sdk/agent@0.1.0-canary.120

## 0.1.0-canary.119

### Patch Changes

- Updated dependencies [67cfa52]
  - @yolk-sdk/agent@0.1.0-canary.119

## 0.1.0-canary.118

### Patch Changes

- f7f6d58: Republish every public package in lockstep after an incomplete `0.1.0-canary.117` publish: npm held `@yolk-sdk/extractors@0.1.0-canary.117`, so `@yolk-sdk/extractors`, `@yolk-sdk/pool`, `@yolk-sdk/sandbox` and `@yolk-sdk/vercel-workflows` were never published at that version. This release contains no implementation changes beyond `0.1.0-canary.117`; install this version (with all `@yolk-sdk/*` packages on it) instead of `0.1.0-canary.117`.
- Updated dependencies [f7f6d58]
  - @yolk-sdk/agent@0.1.0-canary.118

## 0.1.0-canary.117

### Patch Changes

- 47827d8: Advance unchanged public packages in lockstep with the `@yolk-sdk/connectors` fix for email attachments above ~3 MB (the attachment base64 is no longer pattern-checked) and the one-copy byte decoding and new `base64ToBytes` in `@yolk-sdk/agent`. These packages have no direct implementation changes in this release; keep all `@yolk-sdk/*` dependencies on the same canary version.
- Updated dependencies [190c928]
  - @yolk-sdk/agent@0.1.0-canary.117

## 0.1.0-canary.116

### Minor Changes

- 995762e: New package `@yolk-sdk/pool`: subscription account pools (ADR 0011). One `LLMProvider` over several accounts of one provider, the in-process counterpart of CLIProxyAPI with the `expiring-first` scheduler plugin.

  - `makePool({ id, accounts, store, maxAgeMs?, reservePercent? })` returns `{ id, provider, recordReading, state }`. Each request goes to the account whose longest applicable usage window resets soonest and still has quota (readings within `maxAgeMs`, default 30 minutes; model-scoped windows apply only to their models; windows without a length, such as OpenCode Go's month, block a used-up account but never rank); when no account is usable by a fresh reading the route stays on its pinned account, else fill-first (highest priority, then lowest id), skipping accounts a fresh reading shows used up unless nothing else is left. A window that reports only `resetsAfterSeconds` resets that long after its reading. A request without a model id fails `validation_error`.
  - Failover before the first event, only for account-scoped failures (`poolFailureCooldown`): a `rate_limit` with `quotaResetsAtMs` or a `Retry-After` of at least 30 minutes cools the account down until then, `auth` for 30 minutes, and the same request moves to the next account. Hints that are not finite or are more than a year ahead (`poolMaxCooldownMs`) are not trusted. Other failures, and failures after an event, reach the caller unchanged so the loop's retry handles them. With every account out the pool fails `rate_limit`, `retryable: false`, with the earliest quota reset (an auth-only outage fails `auth`).
  - A quota cooldown clears when a fresh reading taken after it began shows quota left on every account-wide window (a spent limit reset).
  - `@yolk-sdk/pool/store`: the `PoolStoreApi` port (pins per pool and route with compare-and-set, one cooldown per account keeping the later end and, on a tie, the later start, latest reading per account), `makeMemoryPoolStore`, and `poolStoreContract` cases for host implementations. Store failures never fail a request.
  - Pure `rankPool`, `staleQuotaCooldowns`, `poolReadingFromSnapshot`, and `poolRoute`; Schemas `PoolAccountId`, `PoolPin`, `PoolQuotaCooldown`, `PoolAuthCooldown`, `PoolCooldown`; errors `PoolConfigError`, `PoolStoreError`, `PoolUnknownAccountError`.

### Patch Changes

- 02953b4: Upgrade the coordinated Effect runtime and platform dependencies to Effect 4.0.5. Hosts must use the matching Effect version.

  Effect 4.0.5 drops a typed failure when an interruption skipped its recovery handler, so a connector conformance run interrupted while a case's cleanup fails, a write's outcome is unknown, or a cleanup is refused now ends interrupt-only instead of with the case's error. The problem still reaches `ConformanceCleanupReporter`. See the migration guide.

- Updated dependencies [02953b4]
- Updated dependencies [995762e]
  - @yolk-sdk/agent@0.1.0-canary.116
