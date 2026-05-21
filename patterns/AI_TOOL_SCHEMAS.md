# AI Tool Schemas

Provider-facing JSON Schema conventions for agent/tool definitions.

## OpenAI-compatible function parameters

- Tool parameter JSON Schema sent to OpenAI-compatible providers must have root `{ "type": "object" }`.
- Do not send top-level `$ref` as the function `parameters` schema. Some providers reject it even when `$defs` contains the target definition.
- When deriving from Effect Schema, dereference/inline a local root `$ref` before sending the schema to providers.
- Preserve nested `$defs` for referenced child schemas after root inlining.

## Tests

- Add regression coverage at the tool registry boundary, not each provider adapter.
- Assert provider-facing `ToolDef.parameters` for object tools match `{ type: "object" }` at the root.
