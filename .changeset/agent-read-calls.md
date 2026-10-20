---
'@yolk-sdk/agent': minor
'@yolk-sdk/codemode': minor
---

Read-only calls of `write` tools stay retryable under the tool ledger. `makeTool({ isReadCall })` (registration `isReadCall(call)`) marks a non-`read` tool's read-only calls, for example the list operations of a tool that also updates; their effective access (`toolCallAccess`) is `read`. `ToolLedgerPolicyInput.readCall` carries it and `defaultToolLedgerPolicy` no longer ledgers such calls, so a read that crashed before recording its outcome is re-run instead of refused on every retry as possibly applied. Arguments that do not decode, and an `isReadCall` that fails or dies, mean not a read. `NestedToolExecutor.access(call)` exposes a nested call's effective access, and code mode records it on the new optional `NestedToolCallRecord.access` (`NestedToolCallAccess`), so hosts can audit nested writes without parsing arguments. Hosts that build `NestedToolExecutor` objects themselves must add `access`.
