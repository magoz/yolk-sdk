import { Effect, Option } from 'effect'
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
import { mcpToolOutputSchema, mcpToolResult, type ToolCallResult } from '../../src/client'

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
        ImagePart.make({
          source: inlineBase64Source(base64(png)),
          mimeType: 'image/png',
          filename: 'image'
        }),
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

  it.effect('keeps error results as they are', () =>
    Effect.gen(function* () {
      const result = yield* convert({ content: [{ type: 'text', text: 'Nope' }], isError: true })

      expect(result.isError).toBe(true)
      expect(result.content).toBe('Nope')
      expect(result.structuredContent).toBeUndefined()
    })
  )
})
