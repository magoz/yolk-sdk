# Typed tool results

Status: accepted.

Supersedes [ADR 0009](0009-file-claim-check.md) §3 ("Scripts") and its summary-table "Scripts" row,
and the "Output schemas" section of [ADR 0002](0002-code-mode.md).

A tool's typed output is the single contract for code mode scripts. Files are typed fields of that
output. Script values never contain file labels.

## Evidence

Scripts written by models in 10x deployments (QuickJS, about 80 reader scripts) showed that the
previous contract (`structuredContent` for tools with `output`, else text; captured files merged
in as `files` or returned as `{ text, files }`) did not work as a contract:

1. `JSON.parse(o.text)` on `dropbox_read_file`'s `{ text, files }` failed at `<input>:2:1`: the
   file label line was appended to the JSON text.
2. `String(r)` on `onedrive_read_file` gave `[object Object]`: the signature said `Promise<string>`
   but the value was `{ text, files }`.
3. About half of the reader scripts defensively did `typeof r === 'string' ? JSON.parse(r) : r` or
   sliced between `{` and `}`.
4. About 30 failures of `JSON.parse` on text tools whose text was prose plus JSON, and on values
   that were already objects.

Also: an array or primitive `structuredContent` with captured files was dropped (`{ text, files }`
was returned instead), and merging `files` into an object output collided with an output field
named `files`.

Reference: OpenCode's tool runtime (`packages/core/src/tool/runtime.ts`: `execute` returns
`{ output?, content? }`, output encoded through the declared schema, a wrong value is a tool error,
output without a schema is a defect, content defaults to the JSON of the output) and code mode
(`packages/core/src/codemode/tool.ts`: scripts get typed output; untyped tools get their text, and
files never enter script text). Yolk goes further: scripts need file handles (ADR 0009).

## Decision summary

| Area               | Decision                                                                                                                                      |
| ------------------ | --------------------------------------------------------------------------------------------------------------------------------------------- |
| `makeTool`         | Three overloads: `output` + `{ output }`, no `output` + `{ content }`, deprecated raw `ToolResult`                                            |
| Encoding           | `Schema.toCodecJson(output)`; a value that does not encode is a value-free `execution` `ToolError`                                            |
| Model content      | `render(value, files)`, default: compact JSON of the encoding with file fields lowered to labels (a string output as it is)                   |
| File fields        | `ToolFile` in output schemas; tools return `FileBytes`; the encoding holds `FileRef` or `FileUnavailable`                                     |
| `ToolResult.files` | Derived from the value's file fields, never supplied by tools                                                                                 |
| Capture            | Encoding a `ToolFile` stores through `ToolFileCapture`, which `resolveTools` provides to every registration it runs                           |
| Labels             | Never plain `TextPart`s: viewable parts get a following `File` part (`Ref`), unstored files a `File` part with an `Omitted { reason }` source |
| Scripts            | See [Rules for scripts](#rules-for-scripts)                                                                                                   |
| Catalog            | `FileRef` and `FileUnavailable` declared once in the intro; file fields render by name; untyped tools `Promise<string>`                       |
| MCP                | Every adapted tool declares `{ value, files }`                                                                                                |
| Connectors         | `fileOutput` actions declare `{ value, files }` with file fields                                                                              |
| Ledger             | Typed values are never cut: content is trimmed first; a value over the bound by itself is stored as a fixed error result                      |
| Errors             | `ModelVisibleToolError.code`; scripts get `error.code`                                                                                        |
| Not in scope       | An MCP response byte cap                                                                                                                      |

## Rules for scripts

A nested call resolves (or rejects) by these rules; `<label>` is the call label (`tools.<id>`).

| Tool and result                                   | Script sees                                                                                                                               |
| ------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| Typed (declares an output schema), success, value | The value as declared (`structuredContent`): file fields are `FileRef \| FileUnavailable`; arrays and primitives included; nothing merged |
| Typed, success, value missing or invalid          | Rejects `Error("<label>: returned an invalid result")`; a warning is logged; never falls back to text                                     |
| Untyped, success                                  | The `Text` parts joined with `\n` (advertised `string`); `File`, `Image`, `Document` and `Audio` parts contribute nothing                 |
| Any failure or `isError`                          | Rejects `Error("<label>: <message>")` (the text parts, no file labels), with `.code` when the structured error has a string `code`        |

Files of untyped tools still reach the model (as labels) but not the script. A typed tool's value
is "invalid" when the result has no `structuredContent`. Code mode only has the JSON Schema, so it
cannot validate further; the sources of typed results guarantee the shape: `makeTool` encodes it,
the deprecated `ToolResult` path drops `structuredContent` that does not decode against the encoded
side of the schema (`Schema.toEncoded(Schema.toCodecJson(output))`, logged), the MCP client
validates against the server's schema, and the connector bridge encodes. Raw registrations that
declare `outputSchema` are trusted.

## Tool contract

```ts
// Typed: the encoding is structuredContent and what scripts receive.
makeTool({
  name: 'download_invoice',
  parameters: Schema.Struct({ id: Schema.String }),
  output: Schema.Struct({ number: Schema.String, pdf: ToolFile }),
  render: (value, files) => `Invoice ${value.number}: ${files.label(value.pdf)}`, // optional
  access: 'read',
  execute: ({ params }) =>
    fetchInvoice(params.id).pipe(
      Effect.map(invoice => ({
        output: {
          number: invoice.number,
          pdf: new FileBytes({ bytes: invoice.bytes, name: `${invoice.number}.pdf`, mimeType: 'application/pdf' })
        }
      }))
    )
})

// Untyped: content only (text and file parts); scripts get the text.
makeTool({ ..., execute: () => Effect.succeed({ content: 'Done.' }) })
```

- The overloads make illegal states unrepresentable: a structured value without `output` and
  `{ content, structuredContent }` do not compile; `ToolContent` forbids `output`,
  `structuredContent` and `toolCallId`. Failures stay `ToolError` or `ModelVisibleToolError`.
- `output` schemas must encode without services (`ToolOutputSchema`); this also applies to the
  deprecated form's `output`.
- The deprecated form (`execute` returns a `ToolResult`) keeps working in this release, marked
  `@deprecated` on its overload. Hosts move to the two forms above.
- `typedToolResult` (protocol) builds the same result for raw registrations and adapters.

### `render`

The brief proposed `render(value)` receiving the encoded value. Its static type would be a lie for
schemas whose JSON encoding differs from their `Encoded` type (a `Schema.Date` field is a `Date`
there, a string in the encoding), and building a typed captured value needs an AST rewrite.
Decision: `render(value, files)` receives the typed output (`Output['Type']`) and
`files: { value(file), label(file) }`, which map each `FileBytes` of the value to its captured
`FileRef | FileUnavailable` and its label. It runs after capture, so labels carry `fileId`s, and it
needs no type assertion.

## File fields

```ts
type FileRef = { fileId: string; name: string; mimeType: string; size: number } // FileDescriptor's fields
type FileUnavailable = { unavailable: string; name: string; mimeType: string }
```

- `ToolFile` is a field schema: `FileRef | FileUnavailable` on the encoded side, `FileBytes` on the
  type side. Encoding stores the bytes (`FileUnavailable` with `no file store`, `too large` or
  `storage unavailable` when it cannot); decoding is forbidden (values never turn back into bytes);
  anything other than `FileBytes` fails encoding.
- `FileBytes { bytes, name, mimeType, view? }`. With `view: true` the model also sees the file: an
  image (`image/*`), audio (`audio/*`), or otherwise a document. The model content then has the
  media part followed by its `File` part (`Ref`, or `Omitted` when storing failed); without a store
  the media part stands alone (a label after every image, on surfaces that cannot move files, is
  noise).
- Bytes never reach the JSON encoder outside a `ToolFile`: a `FileBytes` in a `Schema.Unknown`
  field fails encoding (fail-closed).
- `ToolFile` belongs only in tool output schemas: encoding it has a side effect (a store `put`).
- JSON Schema: `$defs.FileRef` and `$defs.FileUnavailable` exactly as `toolFileJsonSchemaDefinitions`
  (protocol) states; adapters building output schemas by hand (MCP) use the same definitions.

### Capture

`ToolFileCapture` is a protocol service (`capture(file: FileBytes) => Effect<FileRef | FileUnavailable>`).
Encoding reads it with `Effect.serviceOption`, so no schema needs services; absent, every file is
`FileUnavailable('no file store')`. `resolveTools` provides it around every registration's
`execute` (built from `files`, a store-less one without `files`), so a nested resolution never
inherits an enclosing resolution's store. The FileStore-backed implementation is
`makeToolFileCapture` in `@yolk-sdk/agent/tools`.

Rejected: passing `files` through `ToolExecutionInput` (every wrapper must forward it, and the MCP
client cannot reach it: `@yolk-sdk/mcp` only imports `@yolk-sdk/agent/protocol`).

`encodeToolOutput` records captures while encoding. A union member that captured files and then
failed can leave stray captures (stores are idempotent), so only file values present in the final
encoding count, in order of appearance: each takes the first unused capture with the same value,
so two files that encode alike both count and a `FileBytes` used twice counts once.

### Labels are structure

Legacy capture (raw content with inline parts) changes so no label is a plain `TextPart`:

- a captured `Image`, `Document` or `Audio` part is followed by a `File` part with the `Ref` source;
- an inline `File` that is not stored becomes a `File` part with the new `Omitted { reason }` source.

`Omitted` belongs to `FileSource` (`InlineBase64 | Url | Ref | Omitted`), used by `FilePart` only;
image, document and audio parts keep `AttachmentSource`. Providers lower `File` parts with
`filePartText`, so the model view is byte-identical. Readers older than this release cannot decode
a stored transcript holding an `Omitted` source.

Capture is idempotent: a viewable part followed by a `File` part (`Ref` or `Omitted`) with the same
MIME type is already captured and left alone. That is how the registry's capture pass leaves typed
results (which already hold such pairs) unchanged. A marker field on `ToolResult` was rejected (a
wire change for bookkeeping).

## Code mode

- Resolution follows [Rules for scripts](#rules-for-scripts). The pi executor forwards only a
  rejection's message into QuickJS, so its tool bridge sends every rejection as a fixed prefix
  plus the JSON of `{ message, code? }`, and Yolk's tools guard in the VM (built-ins captured
  before the script runs) rebuilds the `Error` with its `code`. The executor contract stays an
  `Error` with an optional `code`; calls through the unguarded `globalThis.tools` see the encoded
  message.
- The description declares `FileRef` and `FileUnavailable` once (replacing the `{ text, files }`
  sentence) and says: "`string` results are text to read; parse JSON only when the tool says it
  returns JSON."
- Signatures and declarations render file fields as `FileRef | FileUnavailable` (when the output
  schema's `$defs` hold the canonical definitions); untyped tools render `Promise<string>`. Result
  types keep the 60-character short-type budget of search signatures; `describeTool` shows the
  whole declaration.

## MCP

`mcpToolToToolDef` declares `{ value: T, files: Array<FileRef | FileUnavailable> }`: `T` is the
server's `outputSchema` (its `$defs`/`definitions` hoisted to the root; a schema whose definitions
collide, that sets `$id`, or that refers to other parts of itself, such as a recursive `#`, is left
unknown), unknown without one. `callRemoteMcpServerTool` (and the resumable calls)
return `mcpToolResult`: `value` is the validated `structuredContent`, else the text blocks parsed
once when they form one JSON object or array (as OpenCode `tool/mcp.ts`), else the text, `null`
without text; blobs, images and audio are captured as file fields (images and audio viewable). The
model content keeps the server's blocks (labels as `File` parts). Error results are unchanged
(`toolCallResultToToolResult`).

## Connectors

`fileOutput` actions declare `{ value, files }` (`value` the byte-free output, `files` file
fields) instead of returning trailing `FilePart`s. Other actions encode their `outputSchema` as
before. Provider failures keep their `structuredContent` (the encoded `ProviderFailure`); its
`code` becomes the script error's `code`.

## Ledger

`toolLedgerResult(result, maxBytes, { typed })`: for a successful typed result the value is never
cut or dropped. Over the bound, media becomes placeholders, `nestedCalls` is dropped, then the
content is cut (it only renders the value). When the value alone exceeds the bound, the stored
copy is a fixed `isError` result ("too large for the tool ledger … not run again; verify"). The
decision is made when the outcome is recorded (`executeLedgered({ typed })` from the
registration's `outputSchema`), so a replay never depends on the tool's current definition.

## Migration for hosts

1. A tool that returns `[TextPart(JSON.stringify(value)), filePartFromBytes(...)]`:
   - declare `output: Schema.Struct({ ...fields, file: ToolFile })` (or `Schema.Array(ToolFile)`);
   - return `{ output: { ...value, file: new FileBytes({ bytes, name, mimeType }) } }`;
   - drop the hand-written JSON text; add `render` only when prose reads better than JSON.
2. A tool with `output` that returns `ToolResult.make({ content, structuredContent })`: return
   `{ output: value }` (the encoding is done for you; `Chunk`/`DateTime` become JSON).
3. A tool without `output`: return `{ content }`. A structured value now needs `output`.
4. Errors: fail with `modelVisibleToolError({ ..., code })` to give scripts `error.code`.
5. Hosts that wrap registrations need no change: capture is provided by `resolveTools`.
6. Scripts: typed tools resolve to their declared value; `files` is no longer merged in (read the
   tool's file fields); untyped tools resolve to plain text without labels; MCP tools resolve to
   `{ value, files }`; Gmail/Outlook/email `get_attachment` resolve to `{ value, files }`. Remove
   `JSON.parse` of typed results and defensive `typeof r === 'string'` checks.

## Not done

- Removing the deprecated `ToolResult`-returning `execute` (next releases).
- Moving SDK-internal tools that still return `ToolResult` (code mode, subagent, question,
  classifier, sandbox, knowledge and files tools) to the new forms. The connector bridge also stays
  on the deprecated form for now: its provider failures are error results with their own
  `structuredContent` (the encoded `ProviderFailure`), which the typed form cannot express without
  moving them into the `ModelVisibleToolError` envelope (a breaking change for hosts reading it).
- Validating local stdio MCP results: `callLocalMcpServerTool` does not list the tool before the
  call, so its `value` is not checked against the server's `outputSchema` (as before this ADR).
- An MCP response byte cap (decided against).
