# @yolk-sdk/pool

Subscription account pools for Yolk agents
([ADR 0011](https://github.com/magoz/yolk-sdk/blob/main/docs/adr/0011-subscription-pools.md)).
Several accounts of one provider (for example two Claude Max subscriptions) serve as one
`LLMProvider`:

- each request goes to the account whose longest usage window (usually the weekly one) resets
  soonest and still has quota, so quota that would reset unused is spent first (expiring-first);
- without fresh usage readings, a route stays on the account that served it last (sticky
  fill-first);
- when an account runs out of quota or its credentials are rejected before any output, it cools
  down and the same request moves to the next account.

It is the in-process counterpart of a CLIProxyAPI gateway with the
[`expiring-first`](https://github.com/magoz/cpa-expiring-first) scheduler plugin.

## Install

```bash
pnpm add @yolk-sdk/pool@canary @yolk-sdk/agent@canary effect@4.0.0
```

Canary APIs are unstable. Keep all `@yolk-sdk/*` packages on the same version.
Use the SDK's matching Effect version (`4.0.0`) in host code.
Published package metadata requires Node.js 22+. The package is runtime-neutral.

## Subpaths

| Subpath                | Purpose                                                                                 |
| ---------------------- | --------------------------------------------------------------------------------------- |
| `@yolk-sdk/pool`       | `makePool`, the pure ranking (`rankPool`, `staleQuotaCooldowns`), Schemas, and errors   |
| `@yolk-sdk/pool/store` | `PoolStoreApi` port, `makeMemoryPoolStore`, and the `poolStoreContract` semantics cases |

## Usage

```ts
import { Effect, Layer } from 'effect'
import { LLMProvider } from '@yolk-sdk/agent/loop'
import { fetchAnthropicClaudeSubscriptionUsage } from '@yolk-sdk/agent/providers/anthropic/usage'
import { makePool } from '@yolk-sdk/pool'
import { makeMemoryPoolStore } from '@yolk-sdk/pool/store'

const program = Effect.gen(function* () {
  const pool = yield* makePool({
    id: 'claude',
    accounts: [
      // LLMProvider services the host builds, one per account and its credentials.
      { id: 'claude-work', priority: 1, provider: claudeWork },
      { id: 'claude-personal', provider: claudePersonal }
    ],
    // Serverless hosts implement PoolStoreApi on their database.
    store: makeMemoryPoolStore()
  })

  // The loop's provider: innermost, under host retry or attachment wrappers.
  const llm = Layer.succeed(LLMProvider, pool.provider)

  // On the host's own schedule (cron, background job), never per request.
  yield* pool.recordReading('claude-work', yield* fetchAnthropicClaudeSubscriptionUsage(workToken))

  // For a settings page: pins, active cooldowns, readings.
  const state = yield* pool.state
})
```

Accounts must be interchangeable for the requests the pool serves (same provider, same models).
Each account's provider is built by the host with that account's credentials; the pool never
sees tokens.

## Failover and retries

| Failure before the first event                            | Pool                                                                                           |
| --------------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| `rate_limit` with `quotaResetsAtMs` (Claude, Codex quota) | Cooldown until the reset, next account                                                         |
| `rate_limit` with `retryAfterMs` of 30 minutes or more    | Cooldown for that long, next account                                                           |
| `auth`                                                    | 30-minute cooldown, next account                                                               |
| anything else, or any failure after an event              | Unchanged to the caller; the loop retries it only when it is retryable and nothing was emitted |
| every account out on quota                                | `rate_limit`, `retryable: false`, earliest quota reset                                         |
| every account out on rejected credentials only            | `auth` (`provider_error`), `retryable: false`                                                  |

The loop's own retry calls the pool again, which picks again; the pool never retries transient
errors itself, so attempts never multiply. A hint that is not finite or is more than a year ahead
is ignored on its own; another trusted hint on the same error (a long `retryAfterMs`) can still
cool the account down, otherwise the error passes through.

When no account is usable by a fresh reading, the pool falls back to the route's pin or fill-first,
skipping accounts a fresh reading shows used up unless nothing else is left.

## Store

`PoolStoreApi` holds pins (per pool and route), one cooldown per account, and the latest reading
per account. Implementations must be atomic per key (`movePin` is a compare-and-set). Run every
case of `poolStoreContract` against a fresh store of your implementation in your tests. Store
failures never fail a request: the pool routes fill-first without state and logs a warning.

## Host responsibilities

- Credentials: one refresher per OAuth grant (refresh tokens rotate). Separate logins of the same
  account are separate grants.
- Readings: poll each account's usage (`@yolk-sdk/agent/providers/*/usage`) on a schedule and
  call `recordReading`. Readings older than `maxAgeMs` (default 30 minutes) are ignored.
- Which accounts form a pool, labels, alerts, and UI.
