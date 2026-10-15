import { Effect, Predicate, Result } from 'effect'
import type { Option } from 'effect'
import * as Schema from 'effect/Schema'
import {
  FilePart,
  fileLabel,
  fileNotCapturedLabel,
  normalizeFileMimeType,
  refAttachmentSource,
  TextPart,
  ToolResult,
  type AudioPart,
  type ContentPart,
  type DocumentPart,
  type FileDescriptor,
  type ImagePart
} from '@yolk-sdk/agent/protocol'

/**
 * Store failures. `not_found`: no such file in the store's scope (a foreign `fileId` reads as
 * missing). `too_large`: over the caller's byte bound. `unavailable`: storage could not answer.
 */
export class FileStoreError extends Schema.TaggedError<FileStoreError>()('FileStoreError', {
  reason: Schema.Literals(['not_found', 'too_large', 'unavailable']),
  message: Schema.String
}) {}

/**
 * Host-owned file storage bound to one scope (for example a workspace and session), ADR 0009.
 * The host derives the scope; the model never supplies it, so a `fileId` from another scope does
 * not resolve. `put` is idempotent for the same bytes.
 */
export type FileStoreApi = {
  readonly put: (input: {
    readonly bytes: Uint8Array
    readonly name: string
    readonly mimeType: string
  }) => Effect.Effect<FileDescriptor, FileStoreError>
  readonly head: (fileId: string) => Effect.Effect<Option.Option<FileDescriptor>, FileStoreError>
  readonly read: (input: {
    readonly fileId: string
    readonly maxBytes: number
  }) => Effect.Effect<Uint8Array, FileStoreError>
  readonly signRead: (input: {
    readonly fileId: string
    readonly ttlSeconds: number
  }) => Effect.Effect<string, FileStoreError>
}

/** Default bound of one captured file (100 MiB). */
export const defaultMaxCapturedFileBytes = 100 * 1024 * 1024

/**
 * `resolveTools({ files })`: capture bytes from tool results into `store`. Pass it only on
 * surfaces allowed to capture; without it, inline file parts become "not captured" labels.
 */
export type ToolFileCaptureOptions = {
  readonly store: FileStoreApi
  readonly maxFileBytes?: number
}

type InlineAttachmentPart = ImagePart | DocumentPart | AudioPart

const base64DecodedBytes = (data: string) => {
  const padding = data.endsWith('==') ? 2 : data.endsWith('=') ? 1 : 0

  return Math.floor((data.length * 3) / 4) - padding
}

const decodeBase64 = (data: string) =>
  Effect.try({
    try: () => Uint8Array.from(globalThis.atob(data), character => character.charCodeAt(0)),
    catch: () => 'invalid base64'
  })

const defaultName = (part: FilePart | InlineAttachmentPart) =>
  part.filename ??
  (Predicate.isTagged(part, 'Image')
    ? 'image'
    : Predicate.isTagged(part, 'Audio')
      ? 'audio'
      : 'file')

type Stored = Result.Result<FileDescriptor, string>

const storeInline = (
  data: string,
  name: string,
  mimeType: string,
  options: ToolFileCaptureOptions
): Effect.Effect<Stored> => {
  const maxBytes = options.maxFileBytes ?? defaultMaxCapturedFileBytes

  if (base64DecodedBytes(data) > maxBytes) {
    return Effect.succeed(Result.fail('too large'))
  }

  return decodeBase64(data).pipe(
    Effect.flatMap(bytes =>
      options.store.put({ bytes, name, mimeType: normalizeFileMimeType(mimeType) }).pipe(
        Effect.map((file): Stored => Result.succeed(file)),
        Effect.catchTag('FileStoreError', error =>
          Effect.logWarning('Tool result file was not captured', { reason: error.reason }).pipe(
            Effect.as<Stored>(Result.fail('storage unavailable'))
          )
        )
      )
    ),
    Effect.catch(reason => Effect.succeed<Stored>(Result.fail(reason)))
  )
}

type Captured = {
  readonly parts: ReadonlyArray<ContentPart>
  readonly files: ReadonlyArray<FileDescriptor>
}

const notCaptured = (part: FilePart, reason: string): Captured => ({
  parts: [
    TextPart.make({
      text: fileNotCapturedLabel({ name: defaultName(part), mimeType: part.mimeType, reason })
    })
  ],
  files: []
})

const captureFilePart = (
  part: FilePart,
  options: ToolFileCaptureOptions | undefined,
  uncapturedReason: string
): Effect.Effect<Captured> => {
  if (!Predicate.isTagged(part.source, 'InlineBase64')) {
    return Effect.succeed({ parts: [part], files: [] })
  }

  if (options === undefined) return Effect.succeed(notCaptured(part, uncapturedReason))

  return storeInline(part.source.data, defaultName(part), part.mimeType, options).pipe(
    Effect.map(
      Result.match({
        onFailure: (reason): Captured => notCaptured(part, reason),
        onSuccess: (file): Captured => ({
          parts: [
            FilePart.make({
              source: refAttachmentSource(file.fileId),
              mimeType: file.mimeType,
              filename: file.name,
              size: file.size
            })
          ],
          files: [file]
        })
      })
    )
  )
}

// Viewable parts keep their inline source (the model still sees them); the stored copy is what
// the model can move, named by the label that follows the part.
const captureViewablePart = (
  part: InlineAttachmentPart,
  options: ToolFileCaptureOptions | undefined
): Effect.Effect<Captured> => {
  if (options === undefined || !Predicate.isTagged(part.source, 'InlineBase64')) {
    return Effect.succeed({ parts: [part], files: [] })
  }

  return storeInline(part.source.data, defaultName(part), part.mimeType, options).pipe(
    Effect.map(
      Result.match({
        onFailure: (): Captured => ({ parts: [part], files: [] }),
        onSuccess: (file): Captured => ({
          parts: [part, TextPart.make({ text: fileLabel(file) })],
          files: [file]
        })
      })
    )
  )
}

const capturePart = (
  part: ContentPart,
  options: ToolFileCaptureOptions | undefined,
  uncapturedReason: string
): Effect.Effect<Captured> => {
  if (Predicate.isTagged(part, 'File')) return captureFilePart(part, options, uncapturedReason)

  if (Predicate.isTagged(part, 'Text')) return Effect.succeed({ parts: [part], files: [] })

  return captureViewablePart(part, options)
}

const hasCapturable = (
  parts: ReadonlyArray<ContentPart>,
  options: ToolFileCaptureOptions | undefined
) =>
  parts.some(
    part =>
      !Predicate.isTagged(part, 'Text') &&
      Predicate.isTagged(part.source, 'InlineBase64') &&
      (options !== undefined || Predicate.isTagged(part, 'File'))
  )

type ToolResultFields = {
  toolCallId: string
  content: ToolResult['content']
  isError?: boolean
  structuredContent?: unknown
  acceptance?: ToolResult['acceptance']
  nestedCalls?: ToolResult['nestedCalls']
  usage?: ToolResult['usage']
  files?: ToolResult['files']
}

const withCaptured = (result: ToolResult, captured: ReadonlyArray<Captured>) => {
  const fields: ToolResultFields = {
    toolCallId: result.toolCallId,
    content: captured.flatMap(item => item.parts)
  }

  if (result.isError !== undefined) fields.isError = result.isError

  if (result.structuredContent !== undefined) fields.structuredContent = result.structuredContent

  if (result.acceptance !== undefined) fields.acceptance = result.acceptance

  if (result.nestedCalls !== undefined) fields.nestedCalls = result.nestedCalls

  if (result.usage !== undefined) fields.usage = result.usage

  const files = [...(result.files ?? []), ...captured.flatMap(item => item.files)]

  if (files.length > 0) fields.files = files

  return ToolResult.make(fields)
}

/**
 * Capture the bytes of one tool result (ADR 0009). With `options`, inline `File` parts are stored
 * and rewritten to `Ref { id: fileId }` (the model sees their label), inline image, document and
 * audio parts are stored and followed by their label, and `ToolResult.files` lists every captured
 * file. Without `options`, or when storing fails or the file is over the bound, inline `File`
 * parts become a "not captured" label (`uncapturedReason` names why without a store): base64
 * never reaches the model. Results without inline bytes are returned unchanged. Never fails.
 */
export const captureToolResultFiles = (
  result: ToolResult,
  options: ToolFileCaptureOptions | undefined,
  uncapturedReason = 'no file store'
): Effect.Effect<ToolResult> => {
  const content = result.content

  if (Predicate.isString(content) || !hasCapturable(content, options)) {
    return Effect.succeed(result)
  }

  return Effect.forEach(content, part => capturePart(part, options, uncapturedReason)).pipe(
    Effect.map(captured => withCaptured(result, captured))
  )
}
