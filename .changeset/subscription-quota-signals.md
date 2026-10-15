---
'@yolk-sdk/agent': minor
'@yolk-sdk/emulators': patch
---

Report subscription quota exhaustion and model-scoped usage windows (ADR 0011).

- `ProviderErrorInfo.quotaResetsAtMs` (epoch milliseconds): when an exhausted subscription quota resets. The Claude subscription provider reads it from the unified rate-limit headers of a `429` (the latest reset among the rejected five-hour and weekly windows, else the unified reset when the account is rejected; model-scoped weekly and overage-only rejections carry none, so a model limit never reads as account exhaustion). The Responses providers read it from a `429` whose error type is `usage_limit_reached` (`resets_at`, else `resets_in_seconds`), which ChatGPT Codex sends. Resets in the past or more than a year ahead are dropped. Transient rate limits never carry it; the failure kind stays `rate_limit` and retry behavior is unchanged. `classifyProviderFailure` accepts a parsed `quotaResetsAtMs` and keeps it only on `rate_limit`.
- `ProviderSubscriptionUsageWindow.models`: lowercase model id substrings a model-scoped window limits; absent means every model of the account.
- Claude subscription usage now sets `windowDurationMinutes` (300 for `five-hour`, 10080 for `seven-day`) and parses the model-scoped weekly limits in `limits[]` (`kind: "weekly_scoped"`) as `seven-day-<model>` windows with `models: [<model>]`, keyed by the lowercase model id or else the display name slugged; a non-string model id or a numeric `resets_at` (epoch seconds) is accepted. Window JSON gains these keys after `resetsAt`.
- OpenCode Go usage sets `windowDurationMinutes` on its fixed rolling windows (300 for `five-hour`, 10080 for `seven-day`); `monthly` follows the billing month and stays without a length.
- The Claude usage conformance case accepts and checks those scoped windows (`scopedWindowIdPrefix` on the shared usage case builder), and its synthetic fixture reports one.
- The `/anthropic` usage route's recorded body matches the updated fixture.
