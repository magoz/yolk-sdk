---
'@yolk-sdk/agent': minor
---

Breaking: `OpenAiProviderConfig.extraBody` takes JSON-object input (`OpenAiRequestExtras`). Untyped runtime input is still snapshotted and validated at request lowering; layer creation stays Effect-lazy and does not walk extras or credentials.

Admission copies own data properties once (cycle-stack + DAG memo), then uses that snapshot. Surviving accessors, functions, `undefined`, nonfinite numbers, cycles, arrays-at-root, `null`, primitives, Date/Map, and class/custom-prototype objects fail non-retryable `LLMError` `provider_error` with a fixed `Invalid … extraBody JSON: expected a JSON object` message that does not echo values. Canonical keys `model`, `messages`, `stream`, `tools`, `parallel_tool_calls`, `max_completion_tokens`, and `max_tokens` — plus `reasoning` when `reasoningEffortFormat` is `'reasoning-object'` — are omitted by key without reading values. JSON `null`/`false`/`0`, own `__proto__`/`constructor` keys, dense arrays, and DAG aliases are kept. Identity is not preserved: extras on the request are a snapshot. Composed-body `Schema.Json` serialization after lone-surrogate rewrite remains the last finite-JSON defense. Vercel AI Gateway emits JSON `models` / `providerOptions` as `OpenAiRequestExtras`.

Migrate hosts: pass portable JSON objects only; do not rely on live getters, class instances, or serialize-time extraBody validation. See the agent README and migration guide for the new admission boundary.
