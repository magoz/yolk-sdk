---
'@yolk-sdk/agent': minor
'@yolk-sdk/mcp': patch
---

`ToolDef.parameters` admits a JSON Schema **representation** at construction: boolean schema or plain JSON object (unknown annotation keywords allowed as JSON). This is not meta-schema validation and is not `Schema.Json` for tool call params, results, or HITL — those stay opaque.

Admission is identity-preserving (not a Record snapshot): enumerable data-only own string keys, including own `__proto__`/`constructor`, dense `Array.prototype` arrays, primitives, null-prototype objects, and DAG aliases. Accessors are rejected from property descriptors and are not invoked. Cycles, nonfinite numbers, functions, `undefined` values, Date/Map/class/custom prototypes, and sparse arrays fail before a tool runs. Effect/Result decoding reports `SchemaError`; synchronous `ToolDef.make` and `makeTool`'s generated-document admission throw the installed Effect constructor's `Error` shape with a `SchemaIssue` cause. Proxy traps on `ownKeys`/`getOwnPropertyDescriptor` are not claimed immune.

Background activation wraps boolean `true`/`false` parameter documents as `arguments` schemas (not `{}`). Unsupported `$ref`/resource keywords still fail only at activation.

MCP `tools/list` `inputSchema` admits the object arm at decode (`McpError` `validation`). Boolean MCP input schemas are rejected there. Omitted MCP input schemas still default to `{ type: 'object', additionalProperties: true }`.
