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
  ToolFile,
  toolFileJsonSchemaDefinitions,
  ToolResult,
  type ToolDef
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
