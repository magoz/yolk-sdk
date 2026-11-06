import { Effect, Exit, Option, Schema } from 'effect'
import { describe, expect, it } from '@effect/vitest'
import {
  contentText,
  FileBytes,
  FileDescriptor,
  FilePart,
  filePartFromBytes,
  ImagePart,
  inlineBase64Source,
  refAttachmentSource,
  TextPart,
  ToolCall,
  containsToolFile,
  FileRef,
  ToolFile,
  toolFileJsonSchemaDefinitions,
  toolOutputDecoder,
  ToolDef,
  ToolResult
} from '@yolk-sdk/agent/protocol'
import {
  captureToolResultFiles,
  EmptyToolParams,
  FileStoreError,
  makeInMemoryToolLedgerStore,
  makeTool,
  modelVisibleToolError,
  resolveTools,
  toolJsonSchemaFromSchema,
  toolLedgerResult,
  ToolRegistryError,
  type FileStoreApi,
  type ToolFileCaptureOptions,
  type ToolModule,
  type ToolRegistration
} from '../../src/tools'

type TestContext = Record<never, never>

const context: TestContext = {}

const pdf = new TextEncoder().encode('%PDF invoice')

const png = new TextEncoder().encode('png1')

type MemoryStore = FileStoreApi & { readonly puts: Array<string> }

const memoryStore = (): MemoryStore => {
  const puts: Array<string> = []

  return {
    puts,
    put: ({ bytes, name, mimeType }) => {
      puts.push(name)

      return Effect.succeed(
        FileDescriptor.make({
          fileId: `file_${new TextDecoder().decode(bytes).replace(/[^A-Za-z0-9]/gu, '')}`,
          name,
          mimeType,
          size: bytes.byteLength
        })
      )
    },
    head: () => Effect.succeed(Option.none()),
    read: () => Effect.succeed(pdf),
    signRead: ({ fileId }) => Effect.succeed(`https://files.example/${fileId}`)
  }
}

const moduleOf = (
  tools: ReadonlyArray<ToolRegistration<TestContext>>
): ToolModule<TestContext> => ({
  id: 'test',
  tools
})

const run = (tool: ToolRegistration<TestContext>, files: ToolFileCaptureOptions | undefined) =>
  Effect.gen(function* () {
    const toolSet = yield* resolveTools(
      [moduleOf([tool])],
      context,
      files === undefined ? {} : { files }
    )

    return yield* toolSet.execute(ToolCall.make({ id: 'call_1', name: tool.def.name, params: {} }))
  })

const Download = Schema.Struct({ path: Schema.String, file: ToolFile })

const download = (file: FileBytes) =>
  makeTool({
    name: 'download',
    description: 'Downloads one file',
    parameters: EmptyToolParams,
    output: Download,
    access: 'read',
    execute: () => Effect.succeed({ output: { path: '/a/invoice.pdf', file } })
  })

const invoice = new FileBytes({ bytes: pdf, name: 'invoice.pdf', mimeType: 'application/pdf' })

const invoiceRef = {
  fileId: 'file_PDFinvoice',
  name: 'invoice.pdf',
  mimeType: 'application/pdf',
  size: pdf.byteLength
}

const base64 = (bytes: Uint8Array) => Buffer.from(bytes).toString('base64')

describe('typed tool outputs', () => {
  it.effect('encodes the output and stores file fields as FileRefs', () =>
    Effect.gen(function* () {
      const store = memoryStore()
      const result = yield* run(download(invoice), { store })

      expect(result.structuredContent).toEqual({ path: '/a/invoice.pdf', file: invoiceRef })
      expect(result.files).toEqual([FileDescriptor.make(invoiceRef)])
      expect(result.content).toBe(
        '{"path":"/a/invoice.pdf","file":"[file file_PDFinvoice: invoice.pdf, application/pdf, 12 B]"}'
      )
      expect(store.puts).toEqual(['invoice.pdf'])
      expect(JSON.stringify(result)).not.toContain(base64(pdf))
    })
  )

  it.effect('declares file fields as FileRef or FileUnavailable', () =>
    Effect.gen(function* () {
      const def: ToolDef = download(invoice).def

      expect(def.outputSchema).toEqual({
        type: 'object',
        properties: {
          path: { type: 'string' },
          file: { anyOf: [{ $ref: '#/$defs/FileRef' }, { $ref: '#/$defs/FileUnavailable' }] }
        },
        required: ['path', 'file'],
        additionalProperties: false,
        $defs: toolFileJsonSchemaDefinitions
      })
    })
  )

  it('publishes the file definitions exactly as output schemas lower them', () => {
    const lowered = toolJsonSchemaFromSchema(Schema.Struct({ file: ToolFile }))

    expect(lowered).toMatchObject({ $defs: toolFileJsonSchemaDefinitions })
  })

  it.effect('answers file fields as unavailable without a store, too large, or failing', () =>
    Effect.gen(function* () {
      const none = yield* run(download(invoice), undefined)
      const tooLarge = yield* run(download(invoice), { store: memoryStore(), maxFileBytes: 4 })

      const failing = yield* run(download(invoice), {
        store: {
          ...memoryStore(),
          put: () => Effect.fail(new FileStoreError({ reason: 'unavailable', message: 'down' }))
        }
      })

      const unavailable = (reason: string) => ({
        path: '/a/invoice.pdf',
        file: { unavailable: reason, name: 'invoice.pdf', mimeType: 'application/pdf' }
      })

      expect(none.structuredContent).toEqual(unavailable('no file store'))
      expect(tooLarge.structuredContent).toEqual(unavailable('too large'))
      expect(failing.structuredContent).toEqual(unavailable('storage unavailable'))
      expect(none.files).toBeUndefined()
      expect(contentText(none.content)).toBe(
        '{"path":"/a/invoice.pdf","file":"[file not captured (no file store): invoice.pdf, application/pdf]"}'
      )
    })
  )

  it.effect('shows viewable files to the model once, followed by their File part', () =>
    Effect.gen(function* () {
      const store = memoryStore()

      const image = new FileBytes({
        bytes: png,
        name: 'chart.png',
        mimeType: 'image/png',
        view: true
      })

      const result = yield* run(download(image), { store })

      const ref = refAttachmentSource('file_png1')

      expect(result.content).toEqual([
        TextPart.make({
          text: '{"path":"/a/invoice.pdf","file":"[file file_png1: chart.png, image/png, 4 B]"}'
        }),
        ImagePart.make({
          source: inlineBase64Source(base64(png)),
          mimeType: 'image/png',
          filename: 'chart.png'
        }),
        FilePart.make({ source: ref, mimeType: 'image/png', filename: 'chart.png', size: 4 })
      ])
      // Capture after the tool does not store the viewed image again.
      expect(store.puts).toEqual(['chart.png'])
    })
  )

  it.effect('shows a viewable file without a label when no store exists', () =>
    Effect.gen(function* () {
      const image = new FileBytes({
        bytes: png,
        name: 'chart.png',
        mimeType: 'image/png',
        view: true
      })

      const result = yield* run(download(image), undefined)

      expect(Array.isArray(result.content) ? result.content.map(part => part._tag) : []).toEqual([
        'Text',
        'Image'
      ])
    })
  )

  it.effect('keeps array and primitive outputs', () =>
    Effect.gen(function* () {
      const store = memoryStore()

      const list = makeTool({
        name: 'list',
        description: 'Lists files',
        parameters: EmptyToolParams,
        output: Schema.Array(ToolFile),
        access: 'read',
        execute: () => Effect.succeed({ output: [invoice] })
      })

      const count = makeTool({
        name: 'count',
        description: 'Counts',
        parameters: EmptyToolParams,
        output: Schema.Number,
        access: 'read',
        execute: () => Effect.succeed({ output: 3 })
      })

      const listed = yield* run(list, { store })
      const counted = yield* run(count, { store })

      expect(listed.structuredContent).toEqual([invoiceRef])
      expect(listed.files).toEqual([FileDescriptor.make(invoiceRef)])
      expect(counted.structuredContent).toBe(3)
      expect(counted.content).toBe('3')
    })
  )

  it.effect('leaves an output field named files alone', () =>
    Effect.gen(function* () {
      const tool = makeTool({
        name: 'listing',
        description: 'Lists names',
        parameters: EmptyToolParams,
        output: Schema.Struct({ files: Schema.Array(Schema.String), file: ToolFile }),
        access: 'read',
        execute: () => Effect.succeed({ output: { files: ['a.txt', 'b.txt'], file: invoice } })
      })

      const result = yield* run(tool, { store: memoryStore() })

      expect(result.structuredContent).toEqual({ files: ['a.txt', 'b.txt'], file: invoiceRef })
    })
  )

  it.effect('fails a value that does not encode, without the value in the error', () =>
    Effect.gen(function* () {
      const tool = makeTool({
        name: 'broken',
        description: 'Returns a bad value',
        parameters: EmptyToolParams,
        output: Schema.Struct({ secret: Schema.String.check(Schema.isMaxLength(3)) }),
        access: 'read',
        execute: () => Effect.succeed({ output: { secret: 'secret-value' } })
      })

      const exit = yield* Effect.exit(run(tool, undefined))

      expect(Exit.isFailure(exit)).toBe(true)
      expect(String(exit)).toContain(
        'broken returned a value that does not match its output schema.'
      )
      expect(String(exit)).not.toContain('secret-value')
    })
  )

  it.effect('never serialises bytes that reach a non-file field', () =>
    Effect.gen(function* () {
      const tool = makeTool({
        name: 'leaky',
        description: 'Puts bytes in an unknown field',
        parameters: EmptyToolParams,
        output: Schema.Struct({ value: Schema.Unknown }),
        access: 'read',
        execute: () => Effect.succeed({ output: { value: invoice } })
      })

      const exit = yield* Effect.exit(run(tool, { store: memoryStore() }))

      expect(Exit.isFailure(exit)).toBe(true)
      expect(String(exit)).not.toContain(base64(pdf))
    })
  )

  it.effect('counts only the file fields of the union member that encoded', () =>
    Effect.gen(function* () {
      const store = memoryStore()

      const Output = Schema.Union([
        Schema.Struct({ kind: Schema.Literal('pair'), first: ToolFile, second: ToolFile }),
        Schema.Struct({ kind: Schema.Literal('one'), first: ToolFile })
      ])

      const tool = makeTool({
        name: 'union',
        description: 'Union output',
        parameters: EmptyToolParams,
        output: Output,
        access: 'read',
        execute: () => Effect.succeed({ output: { kind: 'one' as const, first: invoice } })
      })

      const result = yield* run(tool, { store })

      expect(result.structuredContent).toEqual({ kind: 'one', first: invoiceRef })
      expect(result.files).toEqual([FileDescriptor.make(invoiceRef)])
    })
  )

  it.effect('keeps every file that encodes alike, and a file used twice once', () =>
    Effect.gen(function* () {
      const chart = (bytes: Uint8Array) =>
        new FileBytes({ bytes, name: 'chart.png', mimeType: 'image/png', view: true })

      const first = chart(png)
      const second = chart(new TextEncoder().encode('png2'))

      const tool = makeTool({
        name: 'charts',
        description: 'Two charts',
        parameters: EmptyToolParams,
        output: Schema.Array(ToolFile),
        access: 'read',
        execute: () => Effect.succeed({ output: [first, second, first] })
      })

      const none = yield* run(tool, undefined)
      const stored = yield* run(tool, { store: memoryStore() })

      expect(Array.isArray(none.content) ? none.content.map(part => part._tag) : []).toEqual([
        'Text',
        'Image',
        'Image'
      ])
      expect(stored.files?.map(file => file.fileId)).toEqual(['file_png1', 'file_png2'])
    })
  )

  it.effect('fails a render that throws without its value', () =>
    Effect.gen(function* () {
      const tool = makeTool({
        name: 'bad_render',
        description: 'Render throws',
        parameters: EmptyToolParams,
        output: Download,
        render: () => {
          throw new Error('secret-render')
        },
        access: 'read',
        execute: () => Effect.succeed({ output: { path: '/a/invoice.pdf', file: invoice } })
      })

      const exit = yield* Effect.exit(run(tool, undefined))

      expect(String(exit)).toContain('bad_render failed to render its output.')
      expect(String(exit)).not.toContain('secret-render')
    })
  )

  it.effect('renders model content from the value and its captured files', () =>
    Effect.gen(function* () {
      const tool = makeTool({
        name: 'render',
        description: 'Renders',
        parameters: EmptyToolParams,
        output: Download,
        render: (value, files) => `Saved ${value.path} as ${files.label(value.file)}`,
        access: 'read',
        execute: () => Effect.succeed({ output: { path: '/a/invoice.pdf', file: invoice } })
      })

      const result = yield* run(tool, { store: memoryStore() })

      expect(result.content).toBe(
        'Saved /a/invoice.pdf as [file file_PDFinvoice: invoice.pdf, application/pdf, 12 B]'
      )
      expect(result.structuredContent).toEqual({ path: '/a/invoice.pdf', file: invoiceRef })
    })
  )

  it.effect('stores files through the resolution that runs the tool, never an enclosing one', () =>
    Effect.gen(function* () {
      const outer = memoryStore()
      const inner = new Map<string, ToolResult>()

      const host = makeTool({
        name: 'host',
        description: 'Resolves a child tool set without files',
        parameters: EmptyToolParams,
        access: 'read',
        execute: () =>
          Effect.gen(function* () {
            const child = yield* resolveTools([moduleOf([download(invoice)])], context)

            inner.set(
              'child',
              yield* child.execute(ToolCall.make({ id: 'child_1', name: 'download', params: {} }))
            )

            return { content: 'done' }
          }).pipe(Effect.orDie)
      })

      yield* run(host, { store: outer })

      expect(outer.puts).toEqual([])
      expect(inner.get('child')?.structuredContent).toEqual({
        path: '/a/invoice.pdf',
        file: { unavailable: 'no file store', name: 'invoice.pdf', mimeType: 'application/pdf' }
      })
    })
  )

  it.effect('carries a model-visible error code in the error envelope', () =>
    Effect.gen(function* () {
      const tool = makeTool({
        name: 'missing',
        description: 'Fails',
        parameters: EmptyToolParams,
        output: Download,
        access: 'read',
        execute: () =>
          Effect.fail(
            modelVisibleToolError({
              tool: 'missing',
              reason: 'not_found',
              code: 'file_not_found',
              message: 'No such file.'
            })
          )
      })

      const result = yield* run(tool, undefined)

      expect(result.isError).toBe(true)
      expect(result.structuredContent).toEqual({
        type: 'model_visible_tool_error',
        tool: 'missing',
        reason: 'not_found',
        code: 'file_not_found',
        message: 'No such file.'
      })
    })
  )
})

describe('background tools with typed outputs', () => {
  it.effect('captures file fields when an activated tool runs in the foreground', () =>
    Effect.gen(function* () {
      const store = memoryStore()

      const tool = makeTool({
        name: 'export',
        description: 'Exports a file',
        parameters: EmptyToolParams,
        output: Download,
        access: 'write',
        background: true,
        execute: () => Effect.succeed({ output: { path: '/a/invoice.pdf', file: invoice } })
      })

      const toolSet = yield* resolveTools([moduleOf([tool])], context, {
        files: { store },
        backgroundHost: { accept: () => Effect.die(new Error('not accepted in the foreground')) }
      })

      const result = yield* toolSet.execute(
        ToolCall.make({
          id: 'call_1',
          name: 'export',
          params: { execution: 'foreground', arguments: {} }
        })
      )

      expect(result.structuredContent).toEqual({ path: '/a/invoice.pdf', file: invoiceRef })
      expect(store.puts).toEqual(['invoice.pdf'])
    })
  )
})

describe('untyped tool content', () => {
  it.effect('returns content and captures its file parts', () =>
    Effect.gen(function* () {
      const tool = makeTool({
        name: 'attach',
        description: 'Text and a file',
        parameters: EmptyToolParams,
        access: 'read',
        execute: () =>
          Effect.succeed({
            content: [
              TextPart.make({ text: 'attachment' }),
              filePartFromBytes({
                bytes: pdf,
                mimeType: 'application/pdf',
                filename: 'invoice.pdf'
              })
            ]
          })
      })

      const result = yield* run(tool, { store: memoryStore() })

      expect(result.structuredContent).toBeUndefined()
      expect(result.files).toEqual([FileDescriptor.make(invoiceRef)])
      expect(contentText(result.content)).toBe(
        'attachment[file file_PDFinvoice: invoice.pdf, application/pdf, 12 B]'
      )
    })
  )

  it('rejects structured values without an output schema at compile time', () => {
    makeTool({
      name: 'typed_without_schema',
      description: 'Invalid',
      parameters: EmptyToolParams,
      access: 'read',
      // @ts-expect-error a structured value needs an `output` schema.
      execute: () => Effect.succeed({ output: { count: 1 } })
    })

    makeTool({
      name: 'structured_content',
      description: 'Invalid',
      parameters: EmptyToolParams,
      access: 'read',
      // @ts-expect-error content-only tools return no structured value.
      execute: () => Effect.succeed({ content: 'x', structuredContent: { count: 1 } })
    })

    makeTool({
      name: 'wrong_output',
      description: 'Invalid',
      parameters: EmptyToolParams,
      output: Schema.Struct({ count: Schema.Number }),
      access: 'read',
      // @ts-expect-error the output must match the schema's type.
      execute: () => Effect.succeed({ output: { count: 'one' } })
    })
  })

  it('keeps output type checking with explicit context and params type arguments', () => {
    const Count = Schema.Struct({ count: Schema.Number })

    // Two explicit type arguments select no typed overload (it takes three), so a typed
    // `{ output }` never escapes its schema.
    makeTool<TestContext, typeof EmptyToolParams>({
      name: 'explicit_wrong_output',
      description: 'Invalid',
      parameters: EmptyToolParams,
      output: Count,
      access: 'read',
      // @ts-expect-error a wrong output does not compile with two explicit type arguments.
      execute: () => Effect.succeed({ output: { count: 'one' } })
    })

    makeTool<TestContext, typeof EmptyToolParams, typeof Count>({
      name: 'explicit_output_mismatch',
      description: 'Invalid',
      parameters: EmptyToolParams,
      output: Count,
      access: 'read',
      // @ts-expect-error the output must match the explicit output schema's type.
      execute: () => Effect.succeed({ output: { count: 'one' } })
    })

    makeTool<TestContext, typeof EmptyToolParams, typeof Count>({
      name: 'explicit_output',
      description: 'Valid',
      parameters: EmptyToolParams,
      output: Count,
      access: 'read',
      execute: () => Effect.succeed({ output: { count: 1 } })
    })
  })
})

describe('typed result boundary', () => {
  const Count = Schema.Struct({
    count: Schema.Number,
    nested: Schema.Struct({ ok: Schema.Boolean })
  })

  // A raw registration: what reaches the boundary is exactly what `execute` returns.
  const raw = (structuredContent: unknown): ToolRegistration<TestContext> => ({
    def: ToolDef.make({
      name: 'raw',
      description: 'Raw typed tool',
      parameters: { type: 'object', additionalProperties: false },
      outputSchema: toolJsonSchemaFromSchema(Count)
    }),
    access: 'read',
    decodeOutput: toolOutputDecoder(Count),
    execute: ({ call }) =>
      Effect.succeed(ToolResult.make({ toolCallId: call.id, content: 'text', structuredContent }))
  })

  it.effect('passes on the checked value of a matching result', () =>
    Effect.gen(function* () {
      const result = yield* run(raw({ count: 1, nested: { ok: true } }), undefined)

      expect(result.structuredContent).toEqual({ count: 1, nested: { ok: true } })
      expect(result.content).toBe('text')
    })
  )

  it.effect('drops a value with an excess top-level field, even a FileBytes', () =>
    Effect.gen(function* () {
      const result = yield* run(raw({ count: 1, nested: { ok: true }, leak: invoice }), undefined)

      expect(result.structuredContent).toBeUndefined()
      expect(result.content).toBe('text')
    })
  )

  it.effect('drops a value with a nested excess field', () =>
    Effect.gen(function* () {
      const result = yield* run(raw({ count: 1, nested: { ok: true, extra: 'x' } }), undefined)

      expect(result.structuredContent).toBeUndefined()
    })
  )

  it.effect('drops a value that is not JSON', () =>
    Effect.gen(function* () {
      const AnyValue = Schema.Struct({ value: Schema.Any })

      const tool: ToolRegistration<TestContext> = {
        def: ToolDef.make({
          name: 'raw_any',
          description: 'Raw tool with an any field',
          parameters: { type: 'object', additionalProperties: false },
          outputSchema: toolJsonSchemaFromSchema(AnyValue)
        }),
        access: 'read',
        decodeOutput: toolOutputDecoder(AnyValue),
        execute: ({ call }) =>
          Effect.succeed(
            ToolResult.make({
              toolCallId: call.id,
              content: 'text',
              structuredContent: { value: new Uint8Array([1, 2]) }
            })
          )
      }

      const result = yield* run(tool, undefined)

      expect(result.structuredContent).toBeUndefined()
      expect(result.content).toBe('text')
    })
  )

  it.effect('checks a deprecated ToolResult of makeTool and drops its excess fields', () =>
    Effect.gen(function* () {
      const tool = makeTool({
        name: 'legacy_excess',
        description: 'Returns a ToolResult with an extra field',
        parameters: EmptyToolParams,
        output: Count,
        access: 'read',
        execute: ({ call }) =>
          Effect.succeed(
            ToolResult.make({
              toolCallId: call.id,
              content: 'text',
              structuredContent: { count: 1, nested: { ok: true }, file: invoice }
            })
          )
      })

      const result = yield* run(tool, undefined)

      expect(result.structuredContent).toBeUndefined()
    })
  )

  it.effect('fails resolution for an outputSchema without a decoder', () =>
    Effect.gen(function* () {
      const { decodeOutput: _decodeOutput, ...undecoded } = raw({ count: 1 })

      const exit = yield* Effect.exit(resolveTools([moduleOf([undecoded])], context))

      expect(exit).toStrictEqual(
        Exit.fail(
          new ToolRegistryError({
            cause: 'output_validation_required',
            message:
              'Tool raw declares an outputSchema but no decodeOutput: give it an output schema with makeTool, or a decoder (toolOutputDecoder, mcpToolOutputDecoder).'
          })
        )
      )
    })
  )

  it.effect('fails a Schema.Any field holding bytes at encoding, without the bytes', () =>
    Effect.gen(function* () {
      const tool = makeTool({
        name: 'any_bytes',
        description: 'Puts bytes in an any field',
        parameters: EmptyToolParams,
        output: Schema.Struct({ value: Schema.Any }),
        access: 'read',
        execute: () => Effect.succeed({ output: { value: invoice } })
      })

      const exit = yield* Effect.exit(run(tool, { store: memoryStore() }))

      expect(Exit.isFailure(exit)).toBe(true)
      expect(String(exit)).toContain(
        'any_bytes returned a value that does not match its output schema.'
      )
      expect(String(exit)).not.toContain(base64(pdf))
    })
  )

  it.effect('encodes an output that encodes to undefined as null', () =>
    Effect.gen(function* () {
      const tool = makeTool({
        name: 'nothing',
        description: 'Returns nothing',
        parameters: EmptyToolParams,
        output: Schema.Void,
        access: 'write',
        execute: () => Effect.succeed({ output: undefined })
      })

      const result = yield* run(tool, undefined)

      expect(result.structuredContent).toBeNull()
      expect(result.content).toBe('null')
    })
  )

  it('rejects ToolFile in parameters', () => {
    expect(() =>
      makeTool({
        name: 'file_param',
        description: 'Invalid',
        parameters: Schema.Struct({ items: Schema.Array(Schema.Struct({ file: ToolFile })) }),
        access: 'read',
        execute: () => Effect.succeed({ content: 'x' })
      })
    ).toThrow('Tool file_param has a ToolFile in its parameters')

    expect(containsToolFile(Schema.Struct({ ref: FileRef }))).toBe(false)
  })
})

describe('deprecated ToolResult execute', () => {
  const legacy = (structuredContent: unknown) =>
    makeTool({
      name: 'legacy',
      description: 'Returns a ToolResult',
      parameters: EmptyToolParams,
      output: Schema.Struct({ count: Schema.Number }),
      access: 'read',
      execute: ({ call }) =>
        Effect.succeed(ToolResult.make({ toolCallId: call.id, content: 'text', structuredContent }))
    })

  it.effect('keeps structuredContent that matches the output schema', () =>
    Effect.gen(function* () {
      const result = yield* run(legacy({ count: 2 }), undefined)

      expect(result.structuredContent).toEqual({ count: 2 })
      expect(result.content).toBe('text')
    })
  )

  it.effect('drops structuredContent that does not match, keeping the content', () =>
    Effect.gen(function* () {
      const result = yield* run(legacy({ count: 'two' }), undefined)

      expect(result.structuredContent).toBeUndefined()
      expect(result.content).toBe('text')
    })
  )
})

describe('capture idempotency', () => {
  it.effect('capturing a captured result again changes nothing', () =>
    Effect.gen(function* () {
      const store = memoryStore()

      const result = ToolResult.make({
        toolCallId: 'call_1',
        content: [
          ImagePart.make({ source: inlineBase64Source(base64(png)), mimeType: 'image/png' }),
          filePartFromBytes({ bytes: pdf, mimeType: 'application/pdf', filename: 'invoice.pdf' })
        ]
      })

      const once = yield* captureToolResultFiles(result, { store })
      const twice = yield* captureToolResultFiles(once, { store })

      expect(twice).toEqual(once)
      expect(store.puts).toEqual(['image', 'invoice.pdf'])
    })
  )

  it.effect('still captures an inline image followed by an inline file', () =>
    Effect.gen(function* () {
      const store = memoryStore()

      const result = ToolResult.make({
        toolCallId: 'call_1',
        content: [
          ImagePart.make({ source: inlineBase64Source(base64(png)), mimeType: 'application/pdf' }),
          filePartFromBytes({ bytes: pdf, mimeType: 'application/pdf', filename: 'invoice.pdf' })
        ]
      })

      const captured = yield* captureToolResultFiles(result, { store })

      expect(store.puts).toEqual(['image', 'invoice.pdf'])
      expect(captured.files?.length).toBe(2)
    })
  )
})

describe('ledger replay of typed results', () => {
  const typed = (value: unknown, text: string) =>
    ToolResult.make({ toolCallId: 'call_1', content: text, structuredContent: value })

  it('cuts the content and keeps the value when the result is over the bound', () => {
    const value = { items: ['a', 'b'] }
    const stored = toolLedgerResult(typed(value, 'x'.repeat(4000)), 600, { typed: true })

    expect(stored.structuredContent).toEqual(value)
    expect(stored.isError).toBeUndefined()
    expect(contentText(stored.content).length).toBeLessThan(600)
  })

  it('stores a fixed error when the value alone is over the bound', () => {
    const stored = toolLedgerResult(typed({ items: ['y'.repeat(4000)] }, 'short'), 600, {
      typed: true
    })

    expect(stored.isError).toBe(true)
    expect(stored.structuredContent).toBeUndefined()
    expect(stored.content).toContain('too large for the tool ledger')
  })

  it.effect('replays an oversized typed value as that error, never as a broken value', () =>
    Effect.gen(function* () {
      const ledgerStore = makeInMemoryToolLedgerStore({ scope: 'run_1' })

      const big = makeTool({
        name: 'big',
        description: 'Large output',
        parameters: EmptyToolParams,
        output: Schema.Struct({ rows: Schema.Array(Schema.String) }),
        access: 'write',
        execute: () => Effect.succeed({ output: { rows: ['z'.repeat(5000)] } })
      })

      const execute = Effect.gen(function* () {
        const toolSet = yield* resolveTools([moduleOf([big])], context, {
          ledger: { store: ledgerStore, maxResultBytes: 1000 }
        })

        return yield* toolSet.execute(ToolCall.make({ id: 'call_1', name: 'big', params: {} }))
      })

      const first = yield* execute
      const replayed = yield* execute

      expect(first.structuredContent).toEqual({ rows: ['z'.repeat(5000)] })
      expect(replayed.isError).toBe(true)
      expect(replayed.structuredContent).toBeUndefined()
    })
  )
})
