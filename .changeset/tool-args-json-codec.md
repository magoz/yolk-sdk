---
'@yolk-sdk/agent': patch
---

Accept `null` for optional tool arguments. `ToolDef.parameters` describes the schema's canonical JSON codec, which advertises every `Schema.optional(X)` field as `X | null`, but `makeTool` decoded calls with the type-side schema and rejected that `null`, so models (especially strict-mode providers) failed validation on unused optional fields.

`makeTool` (`validate` and `execute`, so background calls too), `makeInputTool`/`makeInteractionTool` call parameters, and the loop-owned `question` decode now use `Schema.toCodecJson(parameters)`. `null` on `Schema.optional(X)` decodes as omitted and `Schema.withDecodingDefault` still applies; `Schema.optional(Schema.NullOr(X))` keeps `null`; required non-nullable fields still reject it with a model-visible validation error. Non-finite numbers, which the JSON codec decodes from `"NaN"`/`"Infinity"`/`"-Infinity"`, remain validation errors. Advertised schemas are unchanged.

`resolveTools` also drops `null` where the advertised schema marks a property optional without admitting `null` (`Schema.optionalKey(X)`, the subagent `model`/`reasoning_effort`, raw MCP schemas) before any registration validates, executes, or forwards the call. The new `omitNullOptionalToolArguments` export on `@yolk-sdk/agent/tools` exposes that step for hosts that dispatch registrations themselves. User-submitted input/interaction responses keep strict decoding.
