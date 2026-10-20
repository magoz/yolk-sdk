---
'@yolk-sdk/agent': patch
---

Advertise `Schema.optional(X)` tool params to Claude (compatibility mode) as `X` instead of an unconstrained `{}`. `makeTool`/`toolJsonSchemaFromSchema` now mark the `{ type: 'null' }` member that the JSON codec adds for `Schema.optional(X)` with `$comment: toolJsonSchemaOmittedNullComment` (new `@yolk-sdk/agent/protocol` export; a standard annotation that validators and other providers ignore; a schema's own `$comment` annotations are now emitted too). On non-required properties, Claude drops only these marked nulls (they decode as "not sent"), and root union properties that are required in one variant and optional in another now merge to their type. Meaningful nulls keep today's widened `{}`: `Schema.optionalKey(Schema.NullOr(X))`, `Schema.optional(Schema.NullOr(X))`, required `Schema.NullOr(X)`, array items, and raw/MCP `anyOf [X, null]` schemas. Describe what a meaningful `null` does in the tool description.
