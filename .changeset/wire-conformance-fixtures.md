---
'@yolk-sdk/agent': patch
'@yolk-sdk/connectors': patch
'@yolk-sdk/conformance': patch
---

Add the experimental `@yolk-sdk/conformance` package: Effect-only wire fixtures (`./fixture`) with schema decode, staleness helpers, and a secret scan; an offline, fail-closed replay `HttpClient` with a request ledger and wire faults for status-on-attempt, mid-stream failure, truncation, and held chunks (`./replay`); and a recorder that wraps a host-provided `HttpClient` to capture exchanges losslessly (text or base64 bodies and per-chunk stream bytes with original boundaries) with allowlisted headers (`./record`). The package performs no network I/O itself.

`@yolk-sdk/agent` subscription-usage fetchers for Claude, Codex, Grok, and OpenCode Go accept an optional `url` endpoint override (default unchanged); only point it at a trusted proxy or local emulator because the credential is sent there. The new `@yolk-sdk/agent/providers/vercel/conformance` subpath exports synthetic Vercel AI Gateway wire fixtures (plain text, DeepSeek-style reasoning, split tool-call deltas, and an error envelope) for replay tests. `@yolk-sdk/agent` now depends on `@yolk-sdk/conformance`, which only its conformance subpaths import.

`@yolk-sdk/connectors` Fortnox archive and invoice-preview downloads now build their URL from the shared `fortnoxApiBaseUrl` instead of a duplicated literal; requests are unchanged.
