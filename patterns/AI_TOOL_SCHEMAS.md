# AI Tool Schemas

Provider-facing JSON Schema conventions for agent/tool definitions.

## OpenAI-compatible function parameters

- Tool parameter JSON Schema sent to OpenAI-compatible providers must have root `{ "type": "object" }`.
- Do not send top-level `$ref` as the function `parameters` schema. Some providers reject it even when `$defs` contains the target definition.
- When deriving from Effect Schema, dereference/inline a local root `$ref` before sending the schema to providers.
- Preserve nested `$defs` for referenced child schemas after root inlining.

## Anthropic tool input schemas

- Anthropic `input_schema` must have root `{ "type": "object" }`.
- Do not send top-level `anyOf`, `oneOf`, or `allOf`; Anthropic rejects root combinators.
- Flatten root combinators into one object schema with merged `properties`, `required`, and `$defs`.
- Nested combinators inside properties may remain when needed to preserve field semantics.

## Tests

- Add regression coverage at the tool registry boundary, not each provider adapter.
- Assert provider-facing `ToolDef.parameters` for object tools match `{ type: "object" }` at the root.
- Add property coverage for schema families used by tools: empty params, empty structs, required/optional fields, nested structs, arrays, literals, records, unions, and optional nested fields.
- Property invariants: root is always object, root `$ref` is never provider-facing, empty structs never leak `anyOf`, valid params decode before execution, and invalid params fail before execution.
- Provider request-body tests should pass registry-derived `ToolDef`s through each adapter and assert the final provider field stays safe (`function.parameters`, Codex `parameters`, Anthropic `input_schema`).
- When nested schemas emit local `$ref`s, provider-facing payloads must preserve matching `$defs`.
