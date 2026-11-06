import { Effect, Exit, Option } from 'effect'
import { describe, expect, it } from '@effect/vitest'
import {
  contentText,
  FileDescriptor,
  FilePart,
  ImagePart,
  inlineBase64Source,
  refAttachmentSource,
  ToolFileCapture,
  toolFileJsonSchema,
  toolFileJsonSchemaDefinitions
} from '@yolk-sdk/agent/protocol'
import { makeToolFileCapture, type FileStoreApi } from '@yolk-sdk/agent/tools'
import {
  mcpToolOutputDecoder,
  mcpToolOutputSchema,
  mcpToolResult,
  toolCallResultToToolResult,
  type ToolCallResult
} from '../../src/client'

const pdf = new TextEncoder().encode('%PDF invoice')

const png = new TextEncoder().encode('png1')

const base64 = (bytes: Uint8Array) => Buffer.from(bytes).toString('base64')

const store: FileStoreApi = {
  put: ({ bytes, name, mimeType }) =>
    Effect.succeed(
      FileDescriptor.make({
        fileId: `file_${new TextDecoder().decode(bytes).replace(/[^A-Za-z0-9]/gu, '')}`,
        name,
        mimeType,
        size: bytes.byteLength
      })
    ),
  head: () => Effect.succeed(Option.none()),
  read: () => Effect.succeed(pdf),
  signRead: ({ fileId }) => Effect.succeed(`https://files.example/${fileId}`)
}

const convert = (result: ToolCallResult, withStore = true) =>
  mcpToolResult({ toolCallId: 'call_1', result }).pipe(
    Effect.provideService(ToolFileCapture, makeToolFileCapture(withStore ? { store } : undefined))
  )

describe('MCP typed results', () => {
  it('declares { value, files } with the server output schema hoisted', () => {
    const outputSchema = {
      $schema: 'https://json-schema.org/draft/2020-12/schema',
      type: 'object',
      properties: { rows: { type: 'array', items: { $ref: '#/$defs/Row' } } },
      $defs: { Row: { type: 'object', properties: { id: { type: 'string' } } } }
    }

    expect(mcpToolOutputSchema(outputSchema)).toEqual({
      type: 'object',
      properties: {
        value: {
          type: 'object',
          properties: { rows: { type: 'array', items: { $ref: '#/$defs/Row' } } }
        },
        files: { type: 'array', items: toolFileJsonSchema }
      },
      required: ['value', 'files'],
      additionalProperties: false,
      $defs: { Row: outputSchema.$defs.Row, ...toolFileJsonSchemaDefinitions }
    })
    expect(mcpToolOutputSchema(undefined)).toMatchObject({ properties: { value: {} } })

    const recursive = {
      type: 'object',
      properties: { children: { type: 'array', items: { $ref: '#' } } }
    }

    expect(mcpToolOutputSchema(recursive)).toMatchObject({ properties: { value: {} } })
  })

  it.effect('takes structuredContent as the value', () =>
    Effect.gen(function* () {
      const result = yield* convert({
        content: [{ type: 'text', text: '{"total":3}' }],
        structuredContent: { total: 3 }
      })

      expect(result.structuredContent).toEqual({ value: { total: 3 }, files: [] })
      expect(result.content).toBe('{"total":3}')
    })
  )

  it.effect('parses text once when it is one JSON object or array, otherwise keeps the text', () =>
    Effect.gen(function* () {
      const value = (text: ReadonlyArray<string>) =>
        convert({ content: text.map(item => ({ type: 'text', text: item })) }).pipe(
          Effect.map(result => result.structuredContent)
        )

      expect(yield* value(['{"a":1}'])).toEqual({ value: { a: 1 }, files: [] })
      expect(yield* value(['[1,', '2]'])).toEqual({ value: [1, 2], files: [] })
      expect(yield* value(['Found 2 items: {"a":1}'])).toEqual({
        value: 'Found 2 items: {"a":1}',
        files: []
      })
      expect(yield* value(['{"a":1} trailing'])).toEqual({ value: '{"a":1} trailing', files: [] })
      expect(yield* value(['plain'])).toEqual({ value: 'plain', files: [] })
      expect(yield* value(['42'])).toEqual({ value: '42', files: [] })
      expect(yield* value([])).toEqual({ value: null, files: [] })
    })
  )

  it.effect('returns blobs, images and audio as file fields and keeps the model view', () =>
    Effect.gen(function* () {
      const result = yield* convert({
        content: [
          { type: 'text', text: 'Invoice' },
          {
            type: 'resource',
            resource: {
              uri: 'file:///docs/invoice.pdf',
              mimeType: 'application/pdf',
              blob: base64(pdf)
            }
          },
          { type: 'image', data: base64(png), mimeType: 'image/png' }
        ]
      })

      const invoice = {
        fileId: 'file_PDFinvoice',
        name: 'invoice.pdf',
        mimeType: 'application/pdf',
        size: 12
      }

      const image = { fileId: 'file_png1', name: 'image', mimeType: 'image/png', size: 4 }

      expect(result.structuredContent).toEqual({ value: 'Invoice', files: [invoice, image] })
      expect(result.files).toEqual([FileDescriptor.make(invoice), FileDescriptor.make(image)])
      expect(result.content).toEqual([
        expect.objectContaining({ _tag: 'Text', text: 'Invoice' }),
        FilePart.make({
          source: refAttachmentSource('file_PDFinvoice'),
          mimeType: 'application/pdf',
          filename: 'invoice.pdf',
          size: 12
        }),
        // The server's image block as before: no file name, its own MIME type.
        ImagePart.make({ source: inlineBase64Source(base64(png)), mimeType: 'image/png' }),
        FilePart.make({
          source: refAttachmentSource('file_png1'),
          mimeType: 'image/png',
          filename: 'image',
          size: 4
        })
      ])
      expect(contentText(result.content)).toBe(
        'Invoice[file file_PDFinvoice: invoice.pdf, application/pdf, 12 B][file file_png1: image, image/png, 4 B]'
      )
    })
  )

  it.effect('answers FileUnavailable without a store, never base64', () =>
    Effect.gen(function* () {
      const result = yield* convert(
        {
          content: [
            {
              type: 'resource',
              resource: {
                uri: 'file:///invoice.pdf',
                mimeType: 'application/pdf',
                blob: base64(pdf)
              }
            }
          ]
        },
        false
      )

      expect(result.structuredContent).toEqual({
        value: null,
        files: [{ unavailable: 'no file store', name: 'invoice.pdf', mimeType: 'application/pdf' }]
      })
      expect(contentText(result.content)).toBe(
        '[file not captured (no file store): invoice.pdf, application/pdf]'
      )
      expect(JSON.stringify(result)).not.toContain(base64(pdf))
    })
  )

  it.effect('takes the text of embedded text resources into the value, in order', () =>
    Effect.gen(function* () {
      const resource = (text: string) => ({
        type: 'resource',
        resource: { uri: 'file:///rows.json', mimeType: 'application/json', text }
      })

      const value = (content: NonNullable<ToolCallResult['content']>) =>
        convert({ content }).pipe(Effect.map(result => result.structuredContent))

      expect(yield* value([resource('{"rows":[1,2]}')])).toEqual({
        value: { rows: [1, 2] },
        files: []
      })
      expect(yield* value([{ type: 'text', text: '[1,' }, resource('2]')])).toEqual({
        value: [1, 2],
        files: []
      })
      expect(yield* value([resource('first'), { type: 'text', text: 'second' }])).toEqual({
        value: 'first\nsecond',
        files: []
      })
      // Resource links are references, never value text.
      expect(
        yield* value([
          { type: 'text', text: '{"a":1}' },
          { type: 'resource_link', uri: 'file:///b.txt', name: 'b.txt' }
        ])
      ).toEqual({ value: { a: 1 }, files: [] })
      expect(
        yield* value([{ type: 'resource_link', uri: 'file:///b.txt', name: 'b.txt' }])
      ).toEqual({ value: null, files: [] })
    })
  )

  it.effect('keeps the model view of results without file blocks exactly', () =>
    Effect.gen(function* () {
      const results: ReadonlyArray<ToolCallResult> = [
        {
          content: [
            { type: 'text', text: 'a' },
            { type: 'text', text: 'b' }
          ]
        },
        {
          content: [
            { type: 'text', text: 'a' },
            { type: 'resource_link', uri: 'file:///b.txt', name: 'b.txt' },
            { type: 'resource', resource: { uri: 'file:///c.txt', text: 'c' } }
          ]
        },
        { content: [], structuredContent: { ok: true } }
      ]

      for (const result of results) {
        const typed = yield* convert(result)

        expect(typed.content).toEqual(
          toolCallResultToToolResult({ toolCallId: 'call_1', result }).content
        )
      }
    })
  )

  it.effect('stores files through an explicit capture, over the ambient one', () =>
    Effect.gen(function* () {
      const result = yield* mcpToolResult({
        toolCallId: 'call_1',
        result: {
          content: [
            {
              type: 'resource',
              resource: {
                uri: 'file:///invoice.pdf',
                mimeType: 'application/pdf',
                blob: base64(pdf)
              }
            }
          ]
        },
        fileCapture: makeToolFileCapture({ store })
      })

      expect(result.structuredContent).toEqual({
        value: null,
        files: [
          { fileId: 'file_PDFinvoice', name: 'invoice.pdf', mimeType: 'application/pdf', size: 12 }
        ]
      })
    })
  )

  it.effect('checks the { value, files } envelope with mcpToolOutputDecoder', () =>
    Effect.gen(function* () {
      const decode = (value: unknown) => Effect.exit(mcpToolOutputDecoder(value))

      expect(yield* decode({ value: { a: 1 }, files: [] })).toEqual(
        Exit.succeed({ value: { a: 1 }, files: [] })
      )
      expect(Exit.isFailure(yield* decode({ value: 1, files: [], extra: true }))).toBe(true)
      expect(
        Exit.isFailure(
          yield* decode({ value: 1, files: [{ fileId: 'file_a', name: 'a', mimeType: 'x' }] })
        )
      ).toBe(true)
      expect(Exit.isFailure(yield* decode({ value: new Uint8Array([1]), files: [] }))).toBe(true)
    })
  )

  it.effect('keeps error results as they are', () =>
    Effect.gen(function* () {
      const result = yield* convert({ content: [{ type: 'text', text: 'Nope' }], isError: true })

      expect(result.isError).toBe(true)
      expect(result.content).toBe('Nope')
      expect(result.structuredContent).toBeUndefined()
    })
  )
})
