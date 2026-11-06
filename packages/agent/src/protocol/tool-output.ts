import { Context, Data, Effect, Option, Predicate, Schema, SchemaGetter } from 'effect'
import {
  AudioPart,
  bytesToBase64,
  DocumentPart,
  FilePart,
  ImagePart,
  inlineBase64AttachmentSource,
  omittedFilePart,
  refAttachmentSource,
  TextPart,
  type ContentPart
} from './content.ts'
import { FileDescriptor, fileLabel, fileNotCapturedLabel, normalizeFileMimeType } from './file.ts'
import { ToolResult } from './tool.ts'

/**
 * Typed tool results (ADR 0013). A tool with an output schema returns a typed value; Yolk encodes
 * it with the schema's JSON codec, and that encoding is the single contract for code mode scripts.
 * Files are typed fields of the value: the tool returns `FileBytes` in a `ToolFile` field, capture
 * stores the bytes, and the encoded value holds a `FileRef` (or a `FileUnavailable`) in its place.
 */

/** A stored file as scripts see it: the `FileDescriptor` fields. */
export const FileRef = Schema.Struct(FileDescriptor.fields).annotate({ identifier: 'FileRef' })

export type FileRef = typeof FileRef.Type

/** A file field whose bytes were not stored: no file store, over the size bound, or storage failed. */
export const FileUnavailable = Schema.Struct({
  unavailable: Schema.String,
  name: Schema.String,
  mimeType: Schema.String
}).annotate({ identifier: 'FileUnavailable' })

export type FileUnavailable = typeof FileUnavailable.Type

/** The encoded value of a file field. */
export const ToolFileValue = Schema.Union([FileRef, FileUnavailable])

export type ToolFileValue = typeof ToolFileValue.Type

export const isFileRef = (value: ToolFileValue): value is FileRef =>
  Predicate.hasProperty(value, 'fileId')

/** The `unavailable` reason of a file field captured where the host configured no file store. */
export const noFileStoreReason = 'no file store'

/**
 * Bytes a tool returns in a `ToolFile` field of its output. With `view: true` the model also sees
 * the file: an image (`image/*`), audio (`audio/*`), or otherwise a document named `name` (only
 * formats the provider reads, such as PDF and text). Belongs only in tool output values: encoding
 * a `ToolFile` field stores the bytes.
 */
export class FileBytes extends Data.TaggedClass('FileBytes')<{
  readonly bytes: Uint8Array
  readonly name: string
  readonly mimeType: string
  readonly view?: boolean
}> {}

const FileBytesSchema = Schema.declare(
  (input: unknown): input is FileBytes => input instanceof FileBytes,
  { title: 'FileBytes' }
)

/**
 * Stores the bytes of file fields while a tool output is encoded. `resolveTools` provides it to
 * every registration it runs (a store-less one when the host passes no `files`), so a nested
 * resolution never inherits another's store. Without it, file fields encode as unavailable.
 */
export class ToolFileCapture extends Context.Service<
  ToolFileCapture,
  {
    readonly capture: (file: FileBytes) => Effect.Effect<ToolFileValue>
  }
>()('@yolk-sdk/agent/protocol/ToolFileCapture') {}

export const fileUnavailable = (file: FileBytes, reason: string): FileUnavailable => ({
  unavailable: reason,
  name: file.name,
  mimeType: normalizeFileMimeType(file.mimeType)
})

const captureWith =
  (capture: Option.Option<ToolFileCapture['Service']>) =>
  (file: FileBytes): Effect.Effect<ToolFileValue> =>
    Option.isNone(capture)
      ? Effect.succeed(fileUnavailable(file, noFileStoreReason))
      : capture.value.capture(file)

/** The value of one file field: stored through the ambient `ToolFileCapture`, never failing. */
export const captureToolFileValue = (file: FileBytes): Effect.Effect<ToolFileValue> =>
  Effect.flatMap(Effect.serviceOption(ToolFileCapture), capture => captureWith(capture)(file))

/**
 * A file field of an output schema. A tool returns `FileBytes` in it; the encoded value (what the
 * model, scripts and the ledger see) is a `FileRef` or a `FileUnavailable`. Values never decode
 * back to bytes, and anything other than `FileBytes` fails encoding.
 */
export const ToolFile = ToolFileValue.pipe(
  Schema.decodeTo(FileBytesSchema, {
    decode: SchemaGetter.forbidden(() => 'A file field does not decode to bytes'),
    encode: SchemaGetter.transformEffect((file: FileBytes) => captureToolFileValue(file))
  })
)

/**
 * JSON Schema definitions of `FileRef` and `FileUnavailable` exactly as tool output schemas lower
 * them (`$defs` of `ToolDef.outputSchema`), for adapters that build output schemas by hand (MCP).
 */
export const toolFileJsonSchemaDefinitions = {
  FileRef: {
    type: 'object',
    properties: {
      fileId: {
        type: 'string',
        pattern: '^file_[A-Za-z0-9_-]{1,128}$',
        description: 'A file id (`file_…`) returned by a tool that yielded a file.'
      },
      name: { type: 'string' },
      mimeType: { type: 'string' },
      size: { type: 'integer', minimum: 0, maximum: 9007199254740991 }
    },
    required: ['fileId', 'name', 'mimeType', 'size'],
    additionalProperties: false
  },
  FileUnavailable: {
    type: 'object',
    properties: {
      unavailable: { type: 'string' },
      name: { type: 'string' },
      mimeType: { type: 'string' }
    },
    required: ['unavailable', 'name', 'mimeType'],
    additionalProperties: false
  }
} as const

/** JSON Schema of one file field value (`FileRef | FileUnavailable`) against those definitions. */
export const toolFileJsonSchema = {
  anyOf: [{ $ref: '#/$defs/FileRef' }, { $ref: '#/$defs/FileUnavailable' }]
} as const

/** The model-visible label of an encoded file field. */
export const toolFileLabel = (value: ToolFileValue) =>
  isFileRef(value)
    ? fileLabel(value)
    : fileNotCapturedLabel({
        name: value.name,
        mimeType: value.mimeType,
        reason: value.unavailable
      })

const viewPart = (file: FileBytes, mimeType: string): ContentPart => {
  const source = inlineBase64AttachmentSource(bytesToBase64(file.bytes))

  if (mimeType.startsWith('image/'))
    return ImagePart.make({ source, mimeType, filename: file.name })

  if (mimeType.startsWith('audio/'))
    return AudioPart.make({ source, mimeType, filename: file.name })

  return DocumentPart.make({ source, mimeType, filename: file.name })
}

const valueFilePart = (value: ToolFileValue) =>
  isFileRef(value)
    ? FilePart.make({
        source: refAttachmentSource(value.fileId),
        mimeType: value.mimeType,
        filename: value.name,
        size: value.size
      })
    : omittedFilePart({ name: value.name, mimeType: value.mimeType, reason: value.unavailable })

/**
 * Content parts of one captured file. A file the model views is its media part followed by its
 * `File` part (`Ref` or `Omitted`), or the media part alone when no file store exists; any other
 * file is its `File` part. Providers lower the `File` part to its label.
 */
export const capturedFileParts = (
  file: FileBytes,
  value: ToolFileValue
): ReadonlyArray<ContentPart> => {
  if (file.view !== true) return [valueFilePart(value)]

  const media = viewPart(file, normalizeFileMimeType(file.mimeType))

  return !isFileRef(value) && value.unavailable === noFileStoreReason
    ? [media]
    : [media, valueFilePart(value)]
}

/** One file field captured while encoding a tool output. */
export type CapturedToolFile = {
  readonly file: FileBytes
  readonly value: ToolFileValue
}

/** A tool output encoded through its schema's JSON codec, with the files it captured. */
export type EncodedToolOutput = {
  /** The JSON encoding; file fields hold their `FileRef` or `FileUnavailable`. */
  readonly value: unknown
  /** The file fields of `value`, in order of appearance, each file once. */
  readonly captured: ReadonlyArray<CapturedToolFile>
}

/** A schema usable as a tool output: its encoding needs no services. */
export type ToolOutputSchema = Schema.Top & {
  readonly EncodingServices: never
}

const isFileRefValue = Schema.is(FileRef)

const isFileUnavailableValue = Schema.is(FileUnavailable)

// Identifies a file value of an encoded output: a `FileRef` by its `fileId`, a `FileUnavailable`
// by all its fields. Objects with other keys are never file values.
const fileValueKey = (value: unknown): string | undefined => {
  if (!Predicate.isObject(value) || Array.isArray(value)) return undefined

  const keys = Object.keys(value).length

  if (isFileRefValue(value) && keys === 4) return `ref:${value.fileId}`

  return isFileUnavailableValue(value) && keys === 3
    ? `unavailable:${JSON.stringify([value.unavailable, value.name, value.mimeType])}`
    : undefined
}

// Keys of the file values an encoded value holds, in order of appearance.
const fileValueKeys = (value: unknown, keys: Array<string>): Array<string> => {
  const key = fileValueKey(value)

  if (key !== undefined) {
    keys.push(key)

    return keys
  }

  if (Array.isArray(value)) {
    for (const item of value) fileValueKeys(item, keys)
  } else if (Predicate.isObject(value)) {
    for (const item of Object.values(value)) fileValueKeys(item, keys)
  }

  return keys
}

/**
 * Encodes a tool output with `Schema.toCodecJson(schema)`, storing every `ToolFile` field through
 * the ambient `ToolFileCapture`. The captured files are the file values the encoding holds (a
 * union member that failed after capturing a file does not count), each `FileBytes` once.
 */
export const encodeToolOutput = <S extends ToolOutputSchema>(
  schema: S,
  value: unknown
): Effect.Effect<EncodedToolOutput, Schema.SchemaError> =>
  Effect.gen(function* () {
    const recorded = new Map<FileBytes, ToolFileValue>()
    const capture = captureWith(yield* Effect.serviceOption(ToolFileCapture))

    const recording = ToolFileCapture.of({
      capture: file =>
        capture(file).pipe(
          Effect.tap(captured =>
            Effect.sync(() => {
              recorded.set(file, captured)
            })
          )
        )
    })

    const encoded: unknown = yield* Schema.encodeUnknownEffect(Schema.toCodecJson(schema))(
      value
    ).pipe(Effect.provideService(ToolFileCapture, recording))

    const present = fileValueKeys(encoded, [])

    const byKey = new Map<string, CapturedToolFile>()

    for (const [file, captured] of recorded) {
      const key = fileValueKey(captured)

      if (key !== undefined && !byKey.has(key)) byKey.set(key, { file, value: captured })
    }

    const captured = [...new Set(present)].flatMap(key => {
      const entry = byKey.get(key)

      return entry === undefined ? [] : [entry]
    })

    return { value: encoded, captured }
  })

/**
 * Compact JSON of an encoded tool output with every file field lowered to its label: the default
 * model content of a typed tool.
 */
export const toolOutputText = (encoded: EncodedToolOutput): string => {
  const labels = new Map(
    encoded.captured.flatMap(({ value }) => {
      const key = fileValueKey(value)

      return key === undefined ? [] : [[key, toolFileLabel(value)] as const]
    })
  )

  return (
    JSON.stringify(encoded.value, (_key, item: unknown) => {
      const key = fileValueKey(item)
      const label = key === undefined ? undefined : labels.get(key)

      return label === undefined ? item : label
    }) ?? 'null'
  )
}

/** Descriptors of the stored files of an encoded output (`ToolResult.files`). */
export const toolOutputFiles = (
  captured: ReadonlyArray<CapturedToolFile>
): ReadonlyArray<FileDescriptor> =>
  captured.flatMap(({ value }) =>
    isFileRef(value)
      ? [
          FileDescriptor.make({
            fileId: value.fileId,
            name: value.name,
            mimeType: value.mimeType,
            size: value.size
          })
        ]
      : []
  )

/** A typed tool returned a value its output schema does not encode. Value-free. */
export class ToolOutputEncodingError extends Schema.TaggedError<ToolOutputEncodingError>()(
  'ToolOutputEncodingError',
  { message: Schema.String }
) {}

/**
 * The captured value of each file field, for `render`: `value(file)` is the `FileRef` or
 * `FileUnavailable` that replaced a `FileBytes` of the output, `label(file)` its model-visible label.
 */
export type ToolOutputRenderFiles = {
  readonly value: (file: FileBytes) => ToolFileValue
  readonly label: (file: FileBytes) => string
}

/** Renders a typed tool's model content from its output, after capture. */
export type ToolOutputRender<A> = (value: A, files: ToolOutputRenderFiles) => string

const renderFiles = (captured: ReadonlyArray<CapturedToolFile>): ToolOutputRenderFiles => {
  const byFile = new Map(captured.map(({ file, value }) => [file, value]))

  const value = (file: FileBytes) => byFile.get(file) ?? fileUnavailable(file, 'not captured')

  return { value, label: file => toolFileLabel(value(file)) }
}

/**
 * The result of a typed tool: `structuredContent` is the JSON encoding of `value` (file fields
 * captured), `files` lists the stored files, and the content is `render(value, files)` (default:
 * compact JSON of the encoding with file fields lowered to their labels) followed by the files the
 * model views.
 */
export const typedToolResult = <S extends ToolOutputSchema>(input: {
  readonly toolCallId: string
  readonly tool: string
  readonly output: S
  readonly value: S['Type']
  readonly render?: ToolOutputRender<S['Type']> | undefined
}): Effect.Effect<ToolResult, ToolOutputEncodingError> =>
  encodeToolOutput(input.output, input.value).pipe(
    Effect.mapError(
      () =>
        new ToolOutputEncodingError({
          message: `${input.tool} returned a value that does not match its output schema.`
        })
    ),
    Effect.flatMap(encoded =>
      Effect.sync(() => {
        const render = input.render

        const text =
          render === undefined
            ? toolOutputText(encoded)
            : render(input.value, renderFiles(encoded.captured))

        const views = encoded.captured.flatMap(({ file, value }) =>
          file.view === true ? capturedFileParts(file, value) : []
        )

        const files = toolOutputFiles(encoded.captured)

        const content = views.length === 0 ? text : [TextPart.make({ text }), ...views]

        return files.length === 0
          ? ToolResult.make({
              toolCallId: input.toolCallId,
              content,
              structuredContent: encoded.value
            })
          : ToolResult.make({
              toolCallId: input.toolCallId,
              content,
              structuredContent: encoded.value,
              files
            })
      })
    )
  )
