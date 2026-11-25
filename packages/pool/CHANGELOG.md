# @yolk-sdk/pool

## 0.1.0-canary.162

### Patch Changes

- aab270f: Advance in lockstep with `@yolk-sdk/codemode`, which upgrades its script engine to `@earendil-works/pi-codemode` 1.6.0 (frozen built-ins, output limits, constraint tags in tool declarations). These packages have no direct changes in this release.
- Updated dependencies [aab270f]
  - @yolk-sdk/agent@0.1.0-canary.162

## 0.1.0-canary.161

### Patch Changes

- 34b7f96: Advance in lockstep with `@yolk-sdk/codemode`: `readOnlyNestedCallGate` can admit model-invoking reads such as `classify` through `admitModelCall`. These packages have no direct changes in this release.
- Updated dependencies [34b7f96]
  - @yolk-sdk/agent@0.1.0-canary.161

## 0.1.0-canary.160

### Patch Changes

- d55175d: Advance in lockstep with `@yolk-sdk/agent` and `@yolk-sdk/codemode`: hosts can run code mode scripts outside a model turn (`runCodeModeScript` over `ResolvedToolSet.nestedExecutor`), gate them to reads (`readOnlyNestedCallGate`), mark tools that call a model (`invokesModel`), and render annotated host messages from chat items. These packages have no direct changes in this release.
- Updated dependencies [6f9a9e3]
  - @yolk-sdk/agent@0.1.0-canary.160

## 0.1.0-canary.159

### Patch Changes

- 0e5d1ac: Advance in lockstep with `@yolk-sdk/agent`, `@yolk-sdk/codemode`, `@yolk-sdk/harness` and `@yolk-sdk/vercel-workflows`: tool results can mark their nested usage incomplete (`ToolResult.usageIncomplete`), and durable model events name their execution's turn (`executionTurn`) so a client rebuilt from a snapshot mid-turn starts that turn. These packages have no direct changes in this release.
- Updated dependencies [0e5d1ac]
- Updated dependencies [628ebd5]
  - @yolk-sdk/agent@0.1.0-canary.159

## 0.1.0-canary.158

### Patch Changes

- d4141e3: Advance in lockstep with `@yolk-sdk/connectors`, which adds Fortnox bookkeeping actions (financial years, accounts, voucher series, vouchers, voucher file connections, and SIE files). These packages have no direct changes in this release.
- Updated dependencies [d4141e3]
  - @yolk-sdk/agent@0.1.0-canary.158

## 0.1.0-canary.157

### Patch Changes

- 7892f30: Advance in lockstep with `@yolk-sdk/connectors`, whose Fortnox supplier invoice reads now accept the JSON forms Fortnox sends beyond its OpenAPI types, and whose Fortnox reads fail an amount past the double range as `validation_failed`. These packages have no direct changes in this release.
- Updated dependencies [7892f30]
  - @yolk-sdk/agent@0.1.0-canary.157

## 0.1.0-canary.156

### Patch Changes

- @yolk-sdk/agent@0.1.0-canary.156

## 0.1.0-canary.155

### Patch Changes

- d4d8714: Upgrade the coordinated Effect runtime and platform dependencies to Effect 4.1.5 (patch releases of Effect 4.1). Hosts must move `effect` and the coordinated `@effect/*` runtime packages to 4.1.5 together with Yolk. Yolk APIs are unchanged.
- Updated dependencies [d4d8714]
  - @yolk-sdk/agent@0.1.0-canary.155

## 0.1.0-canary.154

### Patch Changes

- @yolk-sdk/agent@0.1.0-canary.154

## 0.1.0-canary.153

### Patch Changes

- @yolk-sdk/agent@0.1.0-canary.153

## 0.1.0-canary.152

### Patch Changes

- @yolk-sdk/agent@0.1.0-canary.152

## 0.1.0-canary.151

### Patch Changes

- @yolk-sdk/agent@0.1.0-canary.151

## 0.1.0-canary.150

### Patch Changes

- @yolk-sdk/agent@0.1.0-canary.150

## 0.1.0-canary.149

### Patch Changes

- Updated dependencies [c112350]
- Updated dependencies [c112350]
- Updated dependencies [22f42c0]
- Updated dependencies [5039d29]
  - @yolk-sdk/agent@0.1.0-canary.149

## 0.1.0-canary.148

### Patch Changes

- Updated dependencies [1cd7e4c]
- Updated dependencies [e5bcedb]
- Updated dependencies [b501399]
- Updated dependencies [2c8e618]
- Updated dependencies [cb15a7b]
  - @yolk-sdk/agent@0.1.0-canary.148

## 0.1.0-canary.147

### Patch Changes

- Updated dependencies [e7bb9e6]
- Updated dependencies [6dc0b32]
- Updated dependencies [e7bb9e6]
  - @yolk-sdk/agent@0.1.0-canary.147

## 0.1.0-canary.146

### Patch Changes

- Updated dependencies [0de4b07]
- Updated dependencies [964b602]
- Updated dependencies [ad085cd]
  - @yolk-sdk/agent@0.1.0-canary.146

## 0.1.0-canary.145

### Patch Changes

- Updated dependencies [c1aaaeb]
  - @yolk-sdk/agent@0.1.0-canary.145

## 0.1.0-canary.144

### Patch Changes

- 6afa1c5: Advance in lockstep with `@yolk-sdk/sandbox`, which adds a Cloudflare Containers backend (`@yolk-sdk/sandbox/cloudflare`). These packages have no direct changes in this release.
- Updated dependencies [0bd8166]
- Updated dependencies [d8758cf]
- Updated dependencies [6afa1c5]
  - @yolk-sdk/agent@0.1.0-canary.144

## 0.1.0-canary.143

### Patch Changes

- Updated dependencies [bfbc4e9]
- Updated dependencies [83e4a7b]
  - @yolk-sdk/agent@0.1.0-canary.143

## 0.1.0-canary.142

### Patch Changes

- 8a3c032: Advance in lockstep with `@yolk-sdk/vercel-workflows` and `@yolk-sdk/codemode`, which add Cloudflare Workers runtimes (`@yolk-sdk/vercel-workflows/cloudflare*` and `@yolk-sdk/codemode/cloudflare`). These packages have no direct changes in this release.
- Updated dependencies [8a3c032]
  - @yolk-sdk/agent@0.1.0-canary.142

## 0.1.0-canary.141

### Minor Changes

- 11280d4: `putCooldown` keeps the newest failure with the cooldown it keeps. When an account already cooling down failed again with a cooldown that ends sooner (a quota error or rejected credentials from a concurrent request, or from the loop's retry after a failed store read), the store kept the longer cooldown with its old `startedAtMs`, so a reading taken between the two failures cleared it and the next request went straight back to the account that had just failed (#301).

  Writing a cooldown over an existing one now works like this: a cooldown that ended before the other began gives way to it; two that overlap merge into the later end and that cooldown's kind (of two that end together, the later-started one's; of two that also start together, quota), with the later `startedAtMs` of the two, so only a reading taken after the newest failure can clear the result. A kept quota cooldown records the end of an auth failure it absorbed in the new optional `PoolQuotaCooldown.authUntilMs`, and `staleQuotaCooldowns` does not clear it before then: a reading cannot vouch for the rejected credential (the host may fetch it with another grant). A kept auth cooldown stays auth, and an ended auth cooldown never turns a later quota cooldown into auth.

  Store contract change: every host `PoolStoreApi` must merge cooldowns this way in `putCooldown`, atomically (concurrent writes for one account are exactly the failure above): one statement, for example an upsert that sets the greatest start, picks the end and kind with a `CASE` on which ends later (then which started later, then quota), and sets `authUntilMs` to the greatest auth end of the two when the kept one is quota and that end is after the merged start, else null. `clearCooldown` takes the observed `authUntilMs` (required, `undefined` when absent) and removes only a `PoolQuotaCooldown` whose `startedAtMs` and `authUntilMs` match, so a clear observed before a same-millisecond auth failure merged in fails. `makeMemoryPoolStore` does all this, and `poolStoreContract` checks every merge in both write orders; rerun the contract against your store.

### Patch Changes

- Updated dependencies [d634a02]
- Updated dependencies [38f38cf]
- Updated dependencies [3fe00ec]
  - @yolk-sdk/agent@0.1.0-canary.141

## 0.1.0-canary.140

### Patch Changes

- Updated dependencies [8998b9e]
  - @yolk-sdk/agent@0.1.0-canary.140

## 0.1.0-canary.139

### Patch Changes

- 7c3a30d: Upgrade the coordinated Effect runtime and platform dependencies to Effect 4.1.4 (patch releases of Effect 4.1). Hosts must move `effect` and the coordinated `@effect/*` runtime packages to 4.1.4 together with Yolk. Yolk APIs are unchanged.
- Updated dependencies [7c3a30d]
  - @yolk-sdk/agent@0.1.0-canary.139

## 0.1.0-canary.138

### Patch Changes

- @yolk-sdk/agent@0.1.0-canary.138

## 0.1.0-canary.137

### Patch Changes

- Updated dependencies [41ba67b]
  - @yolk-sdk/agent@0.1.0-canary.137

## 0.1.0-canary.136

### Patch Changes

- Updated dependencies [12dfd4e]
  - @yolk-sdk/agent@0.1.0-canary.136

## 0.1.0-canary.135

### Patch Changes

- @yolk-sdk/agent@0.1.0-canary.135

## 0.1.0-canary.134

### Patch Changes

- dc74275: Advance in lockstep with `@yolk-sdk/agent`, whose tool argument validation errors now name a number or boolean the model sent as a JSON string, with the literal to send instead. The tools of `@yolk-sdk/connectors`, `@yolk-sdk/knowledge`, `@yolk-sdk/sandbox` and `@yolk-sdk/files` already append that hint, so their errors gain the line. These packages have no direct changes in this release.
- Updated dependencies [21fd3fe]
  - @yolk-sdk/agent@0.1.0-canary.134

## 0.1.0-canary.133

### Patch Changes

- @yolk-sdk/agent@0.1.0-canary.133

## 0.1.0-canary.132

### Patch Changes

- @yolk-sdk/agent@0.1.0-canary.132

## 0.1.0-canary.131

### Patch Changes

- 6e9bd7d: Advance in lockstep with `@yolk-sdk/agent`, whose providers now fail a returned tool call with an empty or padded id or name as a typed `invalid_response` instead of a defect, and `@yolk-sdk/vercel-workflows`, whose `TestWorkflowWorld` now stores step errors through the platform's serializer and records unstorable ones in `inspect(runId).unstorableStepErrors`. These packages have no direct changes in this release.
- Updated dependencies [59c9747]
  - @yolk-sdk/agent@0.1.0-canary.131

## 0.1.0-canary.130

### Patch Changes

- @yolk-sdk/agent@0.1.0-canary.130

## 0.1.0-canary.129

### Patch Changes

- @yolk-sdk/agent@0.1.0-canary.129

## 0.1.0-canary.128

### Patch Changes

- cae5998: Advance in lockstep with `@yolk-sdk/connectors`, which adds Microsoft Teams chats, channels, meeting lookup and transcripts to `@yolk-sdk/connectors/microsoft`. These packages have no direct changes in this release.
- Updated dependencies [cae5998]
  - @yolk-sdk/agent@0.1.0-canary.128

## 0.1.0-canary.127

### Patch Changes

- 5a12835: Advance in lockstep with `@yolk-sdk/connectors`, which adds SharePoint site search, site drive listing and sharing-link resolution to `@yolk-sdk/connectors/microsoft`. These packages have no direct changes in this release.
- Updated dependencies [5a12835]
  - @yolk-sdk/agent@0.1.0-canary.127

## 0.1.0-canary.126

### Patch Changes

- 74c1fe5: Advance in lockstep with `@yolk-sdk/agent`, `@yolk-sdk/codemode`, `@yolk-sdk/mcp` and `@yolk-sdk/connectors`, which adopt typed tool results (ADR 0013); `@yolk-sdk/connectors` also adds the Kie connector. These packages have no direct changes in this release.
- Updated dependencies [bcb26c8]
  - @yolk-sdk/agent@0.1.0-canary.126

## 0.1.0-canary.125

### Patch Changes

- @yolk-sdk/agent@0.1.0-canary.125

## 0.1.0-canary.124

### Patch Changes

- 6a1c1d4: Upgrade the coordinated Effect runtime and platform dependencies to Effect 4.1.2. Hosts must use the matching Effect version, and adopt Effect 4.1's own breaking changes where their code uses the affected APIs (`effect/Crypto`, `HttpClientRequest.method` as `string`, `KeyValueStore`, `FileSystem.make`, `ChildProcess` templates, `McpServer` registrations). `@effect/platform-node` 4.1 requires `ws` ^8.22.1; dedupe `ws` if a Workflow build reports duplicate step ids.

  Tool JSON Schemas generated from Effect schemas are flatter: Effect 4.1 merges a nested `anyOf` into its parent and no longer duplicates a named definition used by both a required and an optional property. What a schema admits is unchanged, and the `yolk:null-means-omitted` marker still tells the codec-added `null` from a `Schema.NullOr` `null`. Hosts that list tools over MCP serve changed tool schemas once, so grants keyed on a tool snapshot digest return to their default for the affected tools.

- Updated dependencies [6a1c1d4]
- Updated dependencies [4f6cd82]
  - @yolk-sdk/agent@0.1.0-canary.124

## 0.1.0-canary.123

### Patch Changes

- Updated dependencies [fc21cd8]
  - @yolk-sdk/agent@0.1.0-canary.123

## 0.1.0-canary.122

### Patch Changes

- 6d9787f: Advance in lockstep with `@yolk-sdk/connectors`, whose action inputs now advertise only finite numbers (integer counts and page sizes of at least 1, some with upper bounds, and finite GitHub issue-field numbers and Fortnox nullable amounts). These packages have no direct changes in this release.
- Updated dependencies [6d9787f]
  - @yolk-sdk/agent@0.1.0-canary.122

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
