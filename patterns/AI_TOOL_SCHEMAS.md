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

## Output schemas and exposure

- `ToolDef.outputSchema` (from `makeTool({ output })`, connector action `outputSchema`, or MCP
  `outputSchema`) uses the same `ToolJsonSchema` representation and the same lowering as
  `parameters`. It is declaration-only guidance for code mode: provider adapters never send it and
  results are never validated against it, so provider rules below do not apply to it.
- `callableBy: 'codemode'` definitions are not provider-facing at all; the loop and realtime
  builders filter them with `providerToolDefs` before any adapter lowers schemas.

## Effect Schema checks

- Write `Schema.isPattern` regexes with the `u` flag. Effect 4 exports `pattern` to JSON Schema only
  when the regex flags are `u`, optionally with `d`, `g` or `y`; it silently omits every other
  pattern from the tool schema, including `v`-mode regexes and `u` combined with `i`, `m` or `s`.
  Adding `u` can change what a negated class or surrogate range accepts; keep runtime acceptance
  identical.
- Effect 4 exports string `Schema.isMinLength(n)` and the minimum of `Schema.isBetweenLength` as
  `minLength: ceil(n / 2)` code points (`n >= 2`). Runtime checks are unchanged; do not rely on
  exact advertised string minimums.

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
- Provider-facing normalization may widen constraints that cannot be represented without combinators. Tool execution still validates calls against the original Effect Schema, decoded through its JSON codec (see Tool arguments).

## Tool arguments

Policy: accept exactly what the model was shown. Normalize what is unambiguous (`null` means "not sent"); reject what would otherwise be silently lost (an unknown key the model believes it set) with a precise, model-visible validation error the model can correct.

- `ToolDef.parameters` from `makeTool`/`toolJsonSchemaFromSchema` describes the schema's canonical JSON codec (`Schema.toJsonSchemaDocument`), which encodes `undefined` as `null`: every `Schema.optional(X)` is advertised as `X | null`. Models, especially strict-mode providers, send that `null` for unused optional fields.
- Model-produced call arguments therefore decode with `Schema.toCodecJson(parameters)`, never the type-side schema: `makeTool` `validate`/`execute`, `makeInteractionTool`/`makeInputTool` call params, and the loop-owned `question` decode. `null` on `Schema.optional(X)` means absent (and `withDecodingDefault` applies); `Schema.optional(Schema.NullOr(X))` keeps a meaningful `null`; required non-nullable fields still reject `null`.
- Objects are advertised closed (`additionalProperties: false`), so argument decoding uses `onExcessProperty: 'error'`: unknown keys at any depth are validation errors, never silently stripped (which would let a model believe it set, say, a filter or a start time that was ignored). This also selects the union member that declares every sent key, and it reaches through declarations whose JSON codec link bypasses their own parser. Interaction/input call params already decoded this way. Decoding uses `errors: 'all'`, so one error reports every unknown key and invalid field. A root `Schema.Struct({})` is checked as "no arguments" first, because Effect parses an empty struct as any object; nested empty structs are not, so use `EmptyToolParams` or a declared struct instead.
- Validation errors must be actionable for the model. The default `makeTool` message, the loop's interaction/input/`question` errors, and Yolk's own `invalidParamsMessage` overrides append one line per object (path and allowed-key set) naming its unknown keys and listing the keys allowed there (`withToolArgumentsErrorHint`); custom `invalidParamsMessage` callbacks should do the same.
- `undefined`-valued keys (in-process callers building params from optional values; never model JSON) count as absent, as JSON serialization would drop them.
- The JSON codec also decodes `"NaN"`/`"Infinity"`/`"-Infinity"` for bare `Schema.Number`. JSON arguments never carried non-finite numbers, so any non-finite number in the decoded arguments (including inside decoded `Map`/`Set` values, and ones produced by decoding defaults or transforms) is a validation error.
- Properties advertised as optional without `null` (`Schema.optionalKey(X)`, raw/MCP JSON Schemas) get one registry-level step: `resolveTools` drops a `null` there before any registration validates, executes, or forwards the call (`omitNullOptionalToolArguments`), guided by the advertised `def.parameters` (local `$ref`/`$defs`, `allOf`, discriminated `anyOf`/`oneOf`, arrays). It drops only a `null` the property's own declaration (in `properties` of the object, an `allOf` part, or the single union member that can still match) rejects; every applicable schema must accept a value, so one rejecting declaration means the dropped value could never have been accepted and no meaning is lost. OpenAPI-style `nullable: true` (common in MCP servers) counts as admitting `null`. Undeclared keys (including keys governed only by `patternProperties`/`additionalProperties`), properties required by the declaring schema, properties whose schema admits `null`, and ambiguous unions are untouched. A union member is eliminated only on certain grounds (type, primitive literal, missing required key), never by guessing about closed property sets. Unmodelled features fail closed: local `$ref`s resolve against the root `$defs` only (one JSON Pointer token, `~1`/`~0` unescaped; multi-segment or percent-encoded refs stay unresolved), so a document with any `$id` below its root is left unchanged; arrays with `prefixItems` are normalized only under 2020-12 (or no `$schema`, or the OpenAPI 3.1 dialect) and left unchanged otherwise; `nullable` on any `$ref` hop counts; a `$ref` that does not resolve to a root `$defs` entry (for example draft-07 `#/definitions/...`) is treated as unknown and never justifies a drop; total work per call is bounded, and once the budget is spent the rest of the arguments are left unchanged. A `null` on a key another union member declares (provider-flattened unions, e.g. Anthropic, show every member's fields) is rejected as unknown with a hint naming the matched member's keys; guessing "not sent" from composed JSON Schemas proved unsafe. Hosts dispatching registrations outside `resolveTools` call the exported helper themselves.
- Only argument boundaries use this: user-submitted input/interaction responses, tool results, and persisted data keep their own decoders.
- Prefer `Schema.optional(X)` for optional tool params; use `Schema.optional(Schema.NullOr(X))` only when `null` means something different from omission.

## Tests

- Add regression coverage at the tool registry boundary, not each provider adapter.
- Assert provider-facing `ToolDef.parameters` for object tools match `{ type: "object" }` at the root.
- Add property coverage for schema families used by tools: empty params, empty structs, required/optional fields, nested structs, arrays, literals, records, unions, and optional nested fields.
- Property invariants: root is always object, root `$ref` is never provider-facing, empty structs never leak `anyOf`, valid params decode before execution, invalid params return model-visible errors before execution, `null` for every absent optional (and optional nested) field decodes exactly like omission per root union branch, and an unknown key is rejected, with a value or `null`, with a hint naming it.
- Provider request-body tests should pass registry-derived `ToolDef`s through each adapter and assert the final provider field stays safe (`function.parameters`, Codex `parameters`, Anthropic `input_schema`).
- When nested schemas emit local `$ref`s, provider-facing payloads must preserve matching `$defs`.
