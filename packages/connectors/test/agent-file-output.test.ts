import { Effect, Layer, Option } from 'effect'
import * as Schema from 'effect/Schema'
import { describe, expect, it } from '@effect/vitest'
import {
  FileDescriptor,
  ToolCall,
  ToolFile,
  toolFileJsonSchemaDefinitions
} from '@yolk-sdk/agent/protocol'
import { resolveTools, toolJsonSchemaFromSchema, type FileStoreApi } from '@yolk-sdk/agent/tools'
import {
  ActionResult,
  connectorActionFile,
  defineAction,
  sniffBase64MimeType,
  defineConnector,
  makeIntegration
} from '@yolk-sdk/connectors'
import { makeConnectorToolModule, makeConnectorToolRegistration } from '@yolk-sdk/connectors/agent'
import { EmailGetAttachmentFileOutput, emailGetAttachmentAction } from '@yolk-sdk/connectors/email'
import {
  GmailGetAttachmentFileOutput,
  GmailGetAttachmentOutput,
  gmailGetAttachmentAction
} from '@yolk-sdk/connectors/google'
import {
  OutlookGetAttachmentFileOutput,
  outlookGetAttachmentAction
} from '@yolk-sdk/connectors/microsoft'

const pdfBase64 = globalThis.btoa('%PDF-1.7 invoice')

class DownloadOutput extends Schema.Class<DownloadOutput>('DownloadOutput')({
  name: Schema.String,
  contentBase64: Schema.String
}) {}

class DownloadFileOutput extends Schema.Class<DownloadFileOutput>('DownloadFileOutput')({
  name: Schema.String
}) {}

const downloadAction = defineAction({
  id: 'test.download',
  inputSchema: Schema.Struct({}),
  outputSchema: DownloadOutput,
  fileOutput: {
    schema: DownloadFileOutput,
    split: output => ({
      value: DownloadFileOutput.make({ name: output.name }),
      files: [connectorActionFile({ base64: output.contentBase64, filename: output.name })]
    })
  },
  execute: () =>
    Effect.succeed(
      ActionResult.success(DownloadOutput.make({ name: 'invoice.pdf', contentBase64: pdfBase64 }))
    )
})

const TestConnector = defineConnector({ id: 'test', actions: [downloadAction] })

const options = { integration: makeIntegration({ connectorId: 'test' }), layer: Layer.empty }

const store: FileStoreApi = {
  put: ({ bytes, name, mimeType }) =>
    Effect.succeed(FileDescriptor.make({ fileId: 'file_1', name, mimeType, size: bytes.length })),
  head: () => Effect.succeed(Option.none()),
  read: () => Effect.succeed(new Uint8Array(0)),
  signRead: () => Effect.succeed('https://files.example/file_1')
}

describe('connector actions that yield files', () => {
  it('declares the byte-free value and its files as file fields', () => {
    const registration = makeConnectorToolRegistration(TestConnector, 'test.download', options)

    expect(registration.def.outputSchema).toEqual(
      toolJsonSchemaFromSchema(
        Schema.Struct({ value: DownloadFileOutput, files: Schema.Array(ToolFile) })
      )
    )
    expect(registration.def.outputSchema).toMatchObject({ $defs: toolFileJsonSchemaDefinitions })
  })

  it('declares byte-free outputs for the email attachment actions', () => {
    expect(gmailGetAttachmentAction.fileOutput?.schema).toBe(GmailGetAttachmentFileOutput)
    expect(outlookGetAttachmentAction.fileOutput?.schema).toBe(OutlookGetAttachmentFileOutput)
    expect(emailGetAttachmentAction.fileOutput?.schema).toBe(EmailGetAttachmentFileOutput)
  })

  it.effect('returns the files as file fields, never their bytes', () =>
    Effect.gen(function* () {
      const toolSet = yield* resolveTools([makeConnectorToolModule(TestConnector, options)], {})

      const result = yield* toolSet.execute(
        ToolCall.make({ id: 'call_1', name: 'test.download', params: {} })
      )

      // Without a file store the file is unavailable (fail-closed).
      expect(result.structuredContent).toEqual({
        value: { name: 'invoice.pdf' },
        files: [{ unavailable: 'no file store', name: 'invoice.pdf', mimeType: 'application/pdf' }]
      })
      expect(result.content).toBe(
        '{"value":{"name":"invoice.pdf"},"files":["[file not captured (no file store): invoice.pdf, application/pdf]"]}'
      )
      expect(JSON.stringify(result)).not.toContain(pdfBase64)
    })
  )

  it.effect('captures the file with a store and sniffs its MIME type', () =>
    Effect.gen(function* () {
      const toolSet = yield* resolveTools(
        [makeConnectorToolModule(TestConnector, options)],
        {},
        {
          files: { store }
        }
      )

      const result = yield* toolSet.execute(
        ToolCall.make({ id: 'call_1', name: 'test.download', params: {} })
      )

      const file = { fileId: 'file_1', name: 'invoice.pdf', mimeType: 'application/pdf', size: 16 }

      expect(result.files).toEqual([FileDescriptor.make(file)])
      expect(result.structuredContent).toEqual({ value: { name: 'invoice.pdf' }, files: [file] })
      expect(JSON.stringify(result)).not.toContain(pdfBase64)
    })
  )

  it('tells RIFF containers apart by their format marker', () => {
    const riff = (format: string) => globalThis.btoa(`RIFF\u0000\u0000\u0000\u0000${format}data`)

    expect(sniffBase64MimeType(riff('WEBP'))).toBe('image/webp')
    expect(sniffBase64MimeType(riff('WAVE'))).toBe('audio/wav')
    expect(sniffBase64MimeType(riff('AVI '))).toBeUndefined()
    expect(sniffBase64MimeType('not base64!')).toBeUndefined()
  })

  it('names gmail attachments from the listed filename and type', () => {
    const output = GmailGetAttachmentOutput.make({
      messageId: 'm1',
      attachmentId: 'a1',
      filename: 'Faktura_225.pdf',
      mimeType: 'application/pdf',
      size: 16,
      data: 'JVBERi0',
      contentBase64: pdfBase64
    })

    const split = Option.getOrUndefined(
      gmailGetAttachmentAction.fileOutput?.split(output) ?? Option.none()
    )

    expect(split?.files).toEqual([
      { base64: pdfBase64, mimeType: 'application/pdf', filename: 'Faktura_225.pdf' }
    ])
    expect(JSON.stringify(split?.value)).not.toContain(pdfBase64)
  })

  it('falls back to the declared or octet-stream type', () => {
    expect(connectorActionFile({ base64: 'AAAA', mimeType: 'text/csv' }).mimeType).toBe('text/csv')
    expect(connectorActionFile({ base64: 'AAAA' }).mimeType).toBe('application/octet-stream')
    expect(connectorActionFile({ base64: pdfBase64, mimeType: null })).toEqual({
      base64: pdfBase64,
      mimeType: 'application/pdf'
    })
  })
})
