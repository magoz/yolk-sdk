---
'@yolk-sdk/agent': minor
'@yolk-sdk/connectors': minor
'@yolk-sdk/harness': minor
'@yolk-sdk/knowledge': minor
'@yolk-sdk/mcp': minor
'@yolk-sdk/sandbox': minor
'@yolk-sdk/vercel-workflows': minor
---

Upgrade the coordinated Effect runtime and platform dependencies to 4.0.0-rc.115. Hosts must use the matching Effect version.

Adopt rc.115 schema-order construction, including `_tag` first: JSON field values and optional presence remain unchanged, but serialized property order can change. Schema errors now use the rc.115 native Error/SchemaIssue representation. Preserve strict Calendar boundary validation, closed empty tool schemas, portable custom JSON Schema output, and explicit WebSocket close semantics.

Contributor property tests use native Effect arbitraries and Vitest 5. See the migration guide for API replacements and JSON Schema definition-name changes.
