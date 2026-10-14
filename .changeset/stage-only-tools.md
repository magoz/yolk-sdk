---
'@yolk-sdk/agent': minor
'@yolk-sdk/codemode': minor
---

Add stage-only tools (ADR 0007): a stageable approval-gated tool may be `callableBy: 'codemode'` (usually with `discovery: 'search'`), so it is never declared to providers and costs no model context. Code mode scripts find it with `searchTools()` (hits marked `stageOnly: true`), read it with `describeTool()` (rendered as the `stage()` call), and can only `stage()` it for `review_plan`; direct calls stay fail-closed and plan review and apply are unchanged. `stage()` accepts the raw name or the catalog identifier, and an unknown name suggests at most five close stageable tools. The code mode description never names stage-only `search` tools, so they leave it byte-identical once any stageable tool exists. `resolveTools` warns when a stage-only tool resolves without staged tool plans. A direct `tools.<name>()` call of a stage-only tool rejects with a hint to `stage()` it (`CodeModeExecuteOptions.unbound`), and `pinned` stage-only tools are always named in the Stageable section.
