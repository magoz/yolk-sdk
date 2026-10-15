# Subscription pools

Status: accepted.

Hosts that run agents on consumer subscriptions (Claude Max over OAuth, ChatGPT/Codex over OAuth,
OpenCode Go over an API key) often hold several accounts of the same provider. With one
`LLMProvider` per account, an exhausted weekly quota stops every run until the host switches
accounts by hand, and quota on the other accounts resets unused.

Outside Yolk this is solved by a gateway: [CLIProxyAPI](https://github.com/router-for-me/CLIProxyAPI)
pools accounts, cools an account down after a quota `429`, and retries on the next one. The
[`expiring-first`](https://github.com/magoz/cpa-expiring-first) scheduler plugin orders accounts by
quota: each request goes to the account whose longest usage window resets soonest and still has
quota, so quota that would reset unused is spent first. Yolk hosts deploy on serverless platforms,
already shape requests per provider, and already read subscription usage, so they need the routing
policy in process, not a gateway.

## Decision summary

| Area        | Decision                                                                                                                       |
| ----------- | ------------------------------------------------------------------------------------------------------------------------------ |
| Package     | New `@yolk-sdk/pool`, depending only on `@yolk-sdk/agent`; subpaths `.` and `./store`                                          |
| Shape       | `makePool` decorates one `LLMProvider` per account of one provider into one `LLMProvider`                                      |
| Policy      | Expiring-first with fresh readings, sticky fill-first without; a pure `rank` function                                          |
| Failover    | Only account-scoped failures before the first event; everything else goes to the loop's retry unchanged                        |
| Exhausted   | All accounts out: `rate_limit`, `retryable: false`, earliest reset in the error                                                |
| State       | `PoolStoreApi` port (pins, cooldowns, readings); in-memory store and `poolStoreContract` cases in `./store`                    |
| Readings    | Pushed by the host (`recordReading`); never fetched on the request path                                                        |
| Reset hints | `ProviderErrorInfo.quotaResetsAtMs` (epoch ms, like `retryAfterMs`), from Claude and Codex quota errors; kind stays rate_limit |
| Usage       | `ProviderSubscriptionUsageWindow.models`; Claude windows gain durations and model-scoped weekly limits                         |
| Host-owned  | Accounts, credentials and their refresh, persistence, reading schedule, labels, UI                                             |

## Ownership

The package `AGENTS.md` rule "apps own provider selection" holds: the host chooses which accounts
form a pool and builds each account's provider with its own credentials. The pool only chooses among
the accounts it was given, by a fixed, documented policy. It never sees tokens, never refreshes, and
never fetches usage.

Credentials stay with the host. Refresh tokens rotate on Anthropic and OpenAI, so each grant must
have exactly one refresher. Separate OAuth logins of the same account are separate grants with their
own refresh-token chains and do not interfere.

## Behavior

A route is the pool id plus the request's model id, lowercased. Reasoning effort is a separate
`LLMRequest` field and never part of the route; aliases (a dated and an undated id of the same
model) are separate routes.

Every request:

1. Candidates are the configured accounts without an active cooldown (cooldowns are account-wide).
2. With fresh readings (`fetchedAt` within `maxAge`, default 30 minutes):
   - drop accounts with an applicable window at or above `100 - reservePercent` used; a window whose
     reset has passed counts as fresh;
   - rank by the reset of each account's longest applicable window, soonest first; accounts whose
     longest window has not started (no reset, or a reset in the past) come after them;
   - ties go to the higher priority, then the lower account id;
   - a window applies when it has no `models` or the route contains one of them (case-insensitive).
3. Serve the top-ranked account and pin the route to it. The ranking only changes at a window reset,
   at exhaustion, or when a reading moves a reset, so pins stay put and prompt caches survive.
4. When no candidate is usable by a fresh reading: keep the route's pin while it is a candidate,
   otherwise move to fill-first (highest priority, then lowest id). Candidates a fresh reading shows
   used up are skipped unless nothing else is left; then the provider's own answer decides (a quota
   `429` cools the account down). The pool knows why an account is out, so there is no grace period
   and no cooldown-length heuristic. A pin to an account no longer configured moves at once.
5. A pin is written only when it changes, and every move is logged with its reason.

A fresh reading with `fetchedAt` later than a quota cooldown's `startedAt` that shows quota left on
every account-wide window (none started and fully used; model-scoped windows block only their
models, through ranking) clears that cooldown (a limit reset was spent, or the
provider reset early). A reading from before the lockout never clears it, and readings never clear
an auth cooldown.

Windows without a length (OpenCode Go's billing month) still make a used-up account unusable but
never rank it; an account whose applicable windows all lack a length ranks as not started.

## Failover and the loop's retry

The loop already retries a provider stream that failed before its first event when the error is
`retryable` (`withProviderRetries`), and each retry calls the provider again, so the pool picks
again. Retrying transient errors inside the pool as well would multiply attempts. The pool
therefore switches accounts within one call only for account-scoped failures, and only when no
`LLMEvent` was emitted:

| Failure                                            | Pool                                                                                            |
| -------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| `rate_limit` with `quotaResetsAtMs`                | Quota cooldown until that reset, next account                                                   |
| `rate_limit` with `retryAfterMs` of 30 min or more | Quota cooldown for that long, next account                                                      |
| `auth`                                             | Auth cooldown (30 min), next account                                                            |
| anything else, or any failure after an event       | Unchanged to the caller; no cooldown                                                            |
| interruption                                       | Unchanged; never a cooldown                                                                     |
| no candidate left                                  | `rate_limit`, `retryable: false`, earliest quota reset (`auth` when only auth cooldowns remain) |
| hint not finite or more than a year ahead          | Unchanged; no cooldown                                                                          |

The 30-minute line is the plugin's `QuotaCooldownFloor`: provider quota lockouts are hours away,
transient rate limits are seconds or minutes. A non-retryable error when every account is out keeps
the loop from sleeping until a reset days away (the loop honors `retryAfterMs` up to about 24.8
days). Failovers are invisible to the loop: no `AgentRetry` is emitted for them.

## State

Serverless instances share nothing, so state goes through `PoolStore`, implemented by the host on
its database:

- pins: `(poolId, route) → accountId, pinnedAt`, created if absent and moved by compare-and-set on
  the expected account, so concurrent instances converge;
- cooldowns: one per account, a tagged union `PoolQuotaCooldown` or `PoolAuthCooldown` with
  `startedAtMs` and `untilMs`; writing keeps the one that ends later (of two that end together, the
  later-started one, so a newer failure is never cleared by an older reading), clearing requires
  the observed `startedAtMs`. Model-scoped exhaustion is handled through readings (model-scoped windows), not
  cooldowns: Claude's model-only rejections carry no quota reset, and a Codex quota error does not
  say whether it is model-scoped, so it cools the whole account;
- readings: the latest `ProviderSubscriptionUsageSnapshot` per account.

The in-memory store serves tests and single-process hosts. `poolStoreContract` pins the semantics
every store must meet; hosts run its cases against their implementation. Store failures never fail
a request: reads fall back to stateless fill-first and writes are logged.

## Reset hints

`ProviderErrorInfo` gains an optional `quotaResetsAtMs`, in epoch milliseconds like the protocol's
other times (`createdAtMs`, `retryAfterMs`). A new failure kind was rejected: every
exhaustive switch over `ProviderFailureKind` and the `AgentErrorCode` mapping would change for every
consumer. Sources:

- Claude: the unified rate-limit headers of a `429`, the latest reset among the rejected
  account-wide windows (`5h`, `7d`), else the unified reset when the account itself is rejected.
  A model-scoped weekly rejection (`7d_oi`) and an overage-only rejection carry none, so a model
  limit never locks the account's other models (derived from CLIProxyAPI's
  `ParseClaudeRateLimitReset`, which also counts `7d_oi`);
- Codex: a `429` whose error type is `usage_limit_reached`, `resets_at` or else `resets_in_seconds`.

Claude usage now reports window durations (300 and 10080 minutes) and the model-scoped weekly limits
of `limits[]` as `seven-day-<model>` windows with `models: [<model>]`, so a pool skips an account
whose model weekly limit is used up only for routes of that model.

## Risks

- One account used from two places (for example a Yolk host and a local gateway) presents two client
  fingerprints and two network origins to the provider. That is outside the pool's control; hosts
  accept it or keep accounts separate.
- Pools sharing accounts with another router pick independently and may drain the same account at
  once. Shared readings keep them roughly aligned.
- Each pick costs a store read; the store port allows a host cache if it matters.

## Not done

- No cross-provider failover (Claude to Codex): models and capabilities differ.
- No usage fetching in the pool: the Anthropic usage endpoint rate-limits, so hosts poll on their
  own schedule.
- No change for unpooled providers. A single-account host still retries a quota `429` with a far
  `retryAfterMs`; making far-off resets non-retryable everywhere is a separate decision.
