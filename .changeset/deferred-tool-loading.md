---
'@yolk-sdk/agent': minor
'@yolk-sdk/codemode': minor
---

Add deferred tool loading (ADR 0007). `ToolDef.loading: 'deferred'` keeps a model-callable tool out of provider requests until the package `tool_search` tool (added by `resolveTools` when deferred tools resolve; opt out with `toolSearch: false`) activates it; the loop then declares it from the next request on (`declaredToolDefs`). Activation is derived from `tool_search` results in the transcript, never stored, so every step and redelivery declares the same tools. Approval-gated tools may be deferred and keep their approval. `rankToolSearchDocuments` (BM25) is shared by `tool_search` and code mode `searchTools`; code mode treats deferred tools like `search` tools. Activation counts only results answering a `tool_search` call of the assistant message they follow, so reused call ids never activate tools.
