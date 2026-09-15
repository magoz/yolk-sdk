# AI Tool Schemas

Provider-facing JSON Schema conventions for agent/tool definitions.

## Representation admission

`ToolDef.parameters` uses protocol `ToolJsonSchema`: boolean or plain JSON object, with finite
JSON values, dense ordinary arrays, and enumerable own data keys. Decode/construction preserve
identity; accessors are rejected unread, as are exotic prototypes, hidden/symbol keys and cycles.
Null-prototype objects and DAG aliases are legal. This is not meta-schema validation and does not
change opaque tool arguments/results or HITL contracts. Provider requirements below are stricter
than this shared representation. MCP tools/list accepts the object arm only and maps decode failure
to typed validation errors. Background envelopes preserve boolean schemas as their arguments schema.

## OpenAI-compatible function parameters

- Tool parameter JSON Schema sent to OpenAI-compatible providers must have root `{ "type": "object" }`.
- Do not send top-level `$ref` as the function `parameters` schema. Some providers reject it even when `$defs` contains the target definition.
- When deriving from Effect Schema, dereference/inline a local root `$ref` before sending the schema to providers.
- Preserve nested `$defs` for referenced child schemas after root inlining.

## Anthropic tool input schemas

- Anthropic `input_schema` must have root `{ "type": "object" }`.
- Do not send `anyOf`, `oneOf`, `allOf`, or tuple-only `prefixItems`; Anthropic rejects schemas containing these constructs on Claude subscription OAuth requests.
- Flatten root and nested combinators into object/property schemas with merged `properties`, `required`, and `$defs`.
- Merge repeated `allOf` object fields structurally. Preserve combined `properties`, `required`, and `$defs`; keep other keywords valid with right-biased replacement instead of manufacturing object-valued combinators for scalar keywords.
- Provider-facing normalization may widen constraints that cannot be represented without combinators. Tool execution still validates calls against the original Effect Schema.

## Tests

- Add regression coverage at the tool registry boundary, not each provider adapter.
- Assert provider-facing `ToolDef.parameters` for object tools match `{ type: "object" }` at the root.
- Add property coverage for schema families used by tools: empty params, empty structs, required/optional fields, nested structs, arrays, literals, records, unions, and optional nested fields.
- Property invariants: root is always object, root `$ref` is never provider-facing, empty structs never leak `anyOf`, valid params decode before execution, and invalid params return model-visible errors before execution.
- Provider request-body tests should pass registry-derived `ToolDef`s through each adapter and assert the final provider field stays safe (`function.parameters`, Codex `parameters`, Anthropic `input_schema`).
- When nested schemas emit local `$ref`s, provider-facing payloads must preserve matching `$defs`.
