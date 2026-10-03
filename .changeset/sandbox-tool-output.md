---
'@yolk-sdk/sandbox': minor
---

The `sandbox` agent tool declares its output (`SandboxToolOutput`, exported from `@yolk-sdk/sandbox/agent`) and adds the bounded `stdout` and `stderr` slices (the same ones shown in the text) to `structuredContent`; `SandboxToolStructuredContent` gains both fields. The sandbox tool module now has a `description`. Text content and `isError` semantics are unchanged.
