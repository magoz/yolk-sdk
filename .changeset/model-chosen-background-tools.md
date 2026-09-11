---
'@yolk-sdk/agent': patch
---

Add explicit opt-in, model-chosen background tool calls. `makeTool`/`ToolRegistration` accept a
`background: true` capability that stays inert until `resolveTools` receives a lifecycle-owning
`BackgroundToolHost`. Activated tools expose a required `{ execution, arguments }` envelope with the
original schema nested unchanged; the registry validates without business effects, strips control
fields, and returns one acknowledgement `ToolResult` with typed `acceptance` metadata. The loop
emits `ToolExecutionAccepted` instead of completion or usage, approval ids bind the exact payload
and mode for activated calls, and client/React projections treat `Accepted` as settled but not
completed and protect acceptance from stale Started/input replay. Activation rejects unsupported
JSON Schema references/resource boundaries with `background_unsupported_schema` while preserving
ordinary document-root `$defs` references and literal default/example data. Activated definitions
fail closed at realtime advertisement and voice dispatch (including replayed approvals and the
low-level bridge); voice toolsets must resolve without a background host. Definitions and behavior
without a host are unchanged.

Preserve entire accepted calls and receipts across active-event replay, terminal/next-turn cleanup,
and hydration without classifying admission as completion. Add typed Effect realtime mapper/config
builders alongside the synchronous APIs, preserving fail-closed voice behavior. Activated makeTool
business-argument failures retain their structured model-visible contract before any effects. Share
receipt-preserving result-to-message conversion and loop-owned tool names. Document intentionally
lossless, potentially long canonical-payload approval IDs and host input/storage responsibilities.
