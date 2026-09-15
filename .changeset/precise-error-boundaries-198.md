---
'@yolk-sdk/agent': patch
'@yolk-sdk/vercel-workflows': patch
---

Tighten `makeTool({ invalidParamsMessage })` on `@yolk-sdk/agent/tools` to
`(error: Schema.SchemaError) => string`. Default remains
`Invalid ${name} arguments: ${String(error)}`, including the `SchemaError(...)` wrapper.
`SchemaError` does not extend `Error`; do not default to `.message`. Existing
`(error: unknown) => string` callbacks remain assignable. No new export subpath.

Tighten `commitThenWriteTerminalEvent({ writeCommitError })` on `@yolk-sdk/vercel-workflows` to
the existing `CommitError` generic from `commit`. Result `commitError` / `error` fields stay
`unknown`. Existing `(error: unknown) => …` callbacks remain assignable. No generic expansion.
