import { Array as Arr, Effect, Option, Predicate } from 'effect'
import * as Schema from 'effect/Schema'
import {
  AudioPart,
  base64ToBytes,
  captureToolFileValue,
  capturedFileParts,
  FileBytes,
  FileDescriptor,
  FilePart,
  ImagePart,
  isFileRef,
  normalizeFileMimeType,
  omittedFilePart,
  TextPart,
  ToolDef,
  toolFileJsonSchema,
  toolFileJsonSchemaDefinitions,
  ToolJsonSchemaObject,
  ToolResult,
  decodeToolJsonSchemaObject,
  inlineBase64Source
} from '@yolk-sdk/agent/protocol'
import type { Content, ContentPart, ToolExposure, ToolFileValue } from '@yolk-sdk/agent/protocol'
import { McpError } from './errors.ts'

export const latestMcpProtocolVersion = '2026-07-28'

export const legacyMcpProtocolVersion = '2024-11-05'

export const JsonRpcErrorObject = Schema.Struct({
  code: Schema.Number,
  message: Schema.String,
  data: Schema.optional(Schema.Unknown)
})

export type JsonRpcErrorObject = typeof JsonRpcErrorObject.Type

export const JsonRpcSuccessResponse = Schema.Struct({
  jsonrpc: Schema.Literal('2.0'),
  id: Schema.Union([Schema.String, Schema.Number, Schema.Null]),
  result: Schema.Unknown
})

export type JsonRpcSuccessResponse = typeof JsonRpcSuccessResponse.Type

export const JsonRpcErrorResponse = Schema.Struct({
  jsonrpc: Schema.Literal('2.0'),
  id: Schema.Union([Schema.String, Schema.Number, Schema.Null]),
  error: JsonRpcErrorObject
})

export type JsonRpcErrorResponse = typeof JsonRpcErrorResponse.Type

export const JsonRpcResponse = Schema.Union([JsonRpcSuccessResponse, JsonRpcErrorResponse])

export type JsonRpcResponse = typeof JsonRpcResponse.Type

export const JsonRpcRequest = Schema.Struct({
  jsonrpc: Schema.Literal('2.0'),
  id: Schema.Union([Schema.String, Schema.Number]),
  method: Schema.String,
  params: Schema.optional(Schema.Unknown)
})

export type JsonRpcRequest = typeof JsonRpcRequest.Type

export const JsonRpcNotification = Schema.Struct({
  jsonrpc: Schema.Literal('2.0'),
  method: Schema.String,
  params: Schema.optional(Schema.Unknown)
})

export type JsonRpcNotification = typeof JsonRpcNotification.Type

export const JsonRpcMessage = Schema.Union([JsonRpcRequest, JsonRpcNotification])

export type JsonRpcMessage = typeof JsonRpcMessage.Type

export const McpToolAnnotations = Schema.Record(Schema.String, Schema.Unknown)

export type McpToolAnnotations = typeof McpToolAnnotations.Type

export const McpTool = Schema.Struct({
  name: Schema.String,
  title: Schema.optional(Schema.String),
  description: Schema.optional(Schema.String),
  inputSchema: Schema.optional(ToolJsonSchemaObject),
  outputSchema: Schema.optional(Schema.Unknown),
  annotations: Schema.optional(McpToolAnnotations)
})

export type McpTool = typeof McpTool.Type

export const ToolsListResult = Schema.Struct({
  tools: Schema.Array(McpTool)
})

export type ToolsListResult = typeof ToolsListResult.Type

export const TextContentBlock = Schema.Struct({
  type: Schema.Literal('text'),
  text: Schema.String
})

export type TextContentBlock = typeof TextContentBlock.Type

export const GenericContentBlock = Schema.Record(Schema.String, Schema.Unknown)

export type GenericContentBlock = typeof GenericContentBlock.Type

const EmbeddedResourceContentBlock = Schema.Struct({
  type: Schema.Literal('resource'),
  resource: Schema.Struct({
    uri: Schema.optional(Schema.String),
    text: Schema.optional(Schema.String),
    blob: Schema.optional(Schema.String),
    mimeType: Schema.optional(Schema.String)
  })
})

const ResourceLinkContentBlock = Schema.Struct({
  type: Schema.Literal('resource_link'),
  uri: Schema.String,
  name: Schema.optional(Schema.String),
  mimeType: Schema.optional(Schema.String)
})

export const ToolCallResult = Schema.Struct({
  content: Schema.optional(Schema.Array(GenericContentBlock)),
  isError: Schema.optional(Schema.Boolean),
  structuredContent: Schema.optional(Schema.Unknown)
})

export type ToolCallResult = typeof ToolCallResult.Type

export const InitializeClientInfo = Schema.Struct({
  name: Schema.String,
  version: Schema.String
})

export type InitializeClientInfo = typeof InitializeClientInfo.Type

export const InitializeParams = Schema.Struct({
  protocolVersion: Schema.String,
  capabilities: Schema.Record(Schema.String, Schema.Unknown),
  clientInfo: InitializeClientInfo
})

export type InitializeParams = typeof InitializeParams.Type

export const InitializedNotification = Schema.Struct({
  jsonrpc: Schema.Literal('2.0'),
  method: Schema.Literal('notifications/initialized')
})

export type InitializedNotification = typeof InitializedNotification.Type

export const ToolsCallParams = Schema.Struct({
  name: Schema.String,
  arguments: Schema.optional(Schema.Unknown)
})

export type ToolsCallParams = typeof ToolsCallParams.Type

export const makeJsonRpcRequest = (input: {
  readonly id: string | number
  readonly method: string
  readonly params?: unknown
}): JsonRpcRequest => {
  const id = input.id
  const method = input.method

  if (input.params !== undefined) {
    return JsonRpcRequest.make({
      jsonrpc: '2.0',
      id,
      method,
      params: input.params
    })
  }

  return JsonRpcRequest.make({
    jsonrpc: '2.0',
    id,
    method
  })
}

export const makeInitializedNotification = (): JsonRpcNotification =>
  InitializedNotification.make({
    jsonrpc: '2.0',
    method: 'notifications/initialized'
  })

export const makeInitializeParams = (input: {
  readonly name: string
  readonly version: string
}): InitializeParams =>
  InitializeParams.make({
    protocolVersion: legacyMcpProtocolVersion,
    capabilities: {},
    clientInfo: InitializeClientInfo.make({
      name: input.name,
      version: input.version
    })
  })

export const jsonRpcErrorToMcpError = (server: string, error: JsonRpcErrorObject) =>
  new McpError({
    server,
    message: `MCP JSON-RPC error ${error.code}: ${error.message}`,
    cause: 'protocol'
  })

/** Tool exposure (`callableBy`/`discovery`/`loading`) for adapted MCP tools: one value for every
 * tool, or per listed tool.
 * Omitted: the agent defaults (`callableBy: 'all'`). `resolveTools` still rejects invalid
 * combinations (for example `discovery` without `callableBy: 'codemode'`).
 */
export type McpToolExposureResolver =
  | ToolExposure
  | ((tool: McpTool, serverName: string) => ToolExposure)

type McpToolDefFields = {
  name: string
  description: string
  parameters: ToolDef['parameters']
  outputSchema?: ToolDef['outputSchema']
  callableBy?: ToolDef['callableBy']
  discovery?: ToolDef['discovery']
  loading?: ToolDef['loading']
}

type JsonSchemaObject = typeof ToolJsonSchemaObject.Type

const fileDefinitionNames: ReadonlySet<string> = new Set(Object.keys(toolFileJsonSchemaDefinitions))

const jsonObjectField = (schema: JsonSchemaObject, key: string): JsonSchemaObject | undefined =>
  Object.hasOwn(schema, key)
    ? Option.getOrUndefined(decodeToolJsonSchemaObject(schema[key]))
    : undefined

// The server's `outputSchema` as the `value` property: its root-relative `$defs` (and draft-07
// `definitions`) move to the wrapper's root, where its `$ref`s still resolve. A schema whose
// definitions collide with the file definitions, or that sets `$id`, is not declared (unknown).
const valueSchema = (outputSchema: JsonSchemaObject | undefined) => {
  if (outputSchema === undefined) return { value: {}, defs: {}, definitions: undefined }

  const defs = jsonObjectField(outputSchema, '$defs') ?? {}
  const definitions = jsonObjectField(outputSchema, 'definitions')

  if (
    Object.hasOwn(outputSchema, '$id') ||
    Object.keys(defs).some(name => fileDefinitionNames.has(name))
  ) {
    return { value: {}, defs: {}, definitions: undefined }
  }

  const value = Object.fromEntries(
    Object.entries(outputSchema).filter(
      ([key]) => key !== '$defs' && key !== 'definitions' && key !== '$schema'
    )
  )

  return { value, defs, definitions }
}

/**
 * The declared output of an adapted MCP tool (ADR 0013): `{ value, files }`. `value` is the
 * server's `outputSchema` when it lists one, otherwise unknown (parsed JSON or text, see
 * `mcpToolResult`); `files` are the call's blobs, images and audio as file fields.
 */
export const mcpToolOutputSchema = (outputSchema: unknown): JsonSchemaObject => {
  const { value, defs, definitions } = valueSchema(
    Option.getOrUndefined(decodeToolJsonSchemaObject(outputSchema))
  )

  const schema: JsonSchemaObject = {
    type: 'object',
    properties: {
      value,
      files: { type: 'array', items: toolFileJsonSchema }
    },
    required: ['value', 'files'],
    additionalProperties: false,
    $defs: { ...defs, ...toolFileJsonSchemaDefinitions }
  }

  return definitions === undefined ? schema : { ...schema, definitions }
}

/** Adapts one listed MCP tool. Its `ToolDef.outputSchema` is `mcpToolOutputSchema`: a present
 * `outputSchema` that is a plain JSON Schema object declares `value`; any other value leaves it
 * unknown. `exposure` (host policy) sets `callableBy`/`discovery`/`loading`; without it none is set.
 */
export const mcpToolToToolDef = (input: {
  readonly serverName: string
  readonly tool: McpTool
  readonly exposure?: McpToolExposureResolver
}) => {
  const fields: McpToolDefFields = {
    name: `${sanitizeMcpName(input.serverName)}_${sanitizeMcpName(input.tool.name)}`,
    description: input.tool.description ?? `MCP tool ${input.serverName}/${input.tool.name}`,
    parameters: input.tool.inputSchema ?? { type: 'object', additionalProperties: true },
    outputSchema: mcpToolOutputSchema(input.tool.outputSchema)
  }

  const exposure = Predicate.isFunction(input.exposure)
    ? input.exposure(input.tool, input.serverName)
    : input.exposure

  if (exposure?.callableBy !== undefined) fields.callableBy = exposure.callableBy

  if (exposure?.discovery !== undefined) fields.discovery = exposure.discovery

  if (exposure?.loading !== undefined) fields.loading = exposure.loading

  return ToolDef.make(fields)
}

export const sanitizeMcpName = (name: string) => {
  const sanitized = name.replace(/[^a-zA-Z0-9_-]/g, '_')

  return sanitized.length === 0 ? 'mcp' : sanitized
}

const stringProperty = (block: GenericContentBlock, key: string) =>
  Schema.decodeUnknownOption(Schema.String)(block[key])

const contentBlockText = (block: GenericContentBlock): Option.Option<string> => {
  const type = block['type']
  const text = stringProperty(block, 'text')

  if (type === 'text') {
    return text
  }

  return Option.none()
}

const fallbackTextForContentBlock = (block: GenericContentBlock) => {
  const type = stringProperty(block, 'type').pipe(Option.getOrElse(() => 'unknown'))
  const name = stringProperty(block, 'name')
  const uri = stringProperty(block, 'uri')
  const url = stringProperty(block, 'url')
  const label = Option.getOrElse(Option.firstSomeOf([name, uri, url]), () => type)

  switch (type) {
    case 'resource':
      return `MCP resource: ${label}`
    case 'resource_link':
      return `MCP resource link: ${label}`
    case 'image':
      return `MCP image: ${label}`
    case 'audio':
      return `MCP audio: ${label}`
    default:
      return `Unsupported MCP ${type} content.`
  }
}

const resourceFilename = (uri: string) => {
  const segments = (uri.split(/[?#]/u, 1)[0] ?? '').split('/').filter(part => part.length > 0)
  const segment = segments[segments.length - 1]

  if (segment === undefined || segment.endsWith(':')) return undefined

  try {
    return decodeURIComponent(segment)
  } catch {
    return segment
  }
}

// Embedded text stays text; a blob becomes a file part that tool resolution captures (ADR 0009),
// so its base64 never reaches the model.
const embeddedResourcePart = (block: GenericContentBlock): Option.Option<ContentPart> =>
  Schema.decodeUnknownOption(EmbeddedResourceContentBlock)(block).pipe(
    Option.flatMap(({ resource }): Option.Option<ContentPart> => {
      if (resource.text !== undefined) return Option.some(TextPart.make({ text: resource.text }))

      if (resource.blob === undefined) return Option.none()

      const mimeType = resource.mimeType ?? 'application/octet-stream'
      const filename = resource.uri === undefined ? undefined : resourceFilename(resource.uri)

      return Option.some(
        filename === undefined
          ? FilePart.make({ source: inlineBase64Source(resource.blob), mimeType })
          : FilePart.make({ source: inlineBase64Source(resource.blob), mimeType, filename })
      )
    })
  )

const resourceLinkText = (block: GenericContentBlock): Option.Option<string> =>
  Schema.decodeUnknownOption(ResourceLinkContentBlock)(block).pipe(
    Option.map(({ name, uri }) => {
      const label = name ?? uri

      return `MCP resource link: ${label} (${uri})`
    })
  )

const imagePartFromBlock = (block: GenericContentBlock): Option.Option<ContentPart> =>
  Option.all({
    data: stringProperty(block, 'data'),
    mimeType: stringProperty(block, 'mimeType')
  }).pipe(
    Option.map(({ data, mimeType }) =>
      ImagePart.make({ source: inlineBase64Source(data), mimeType })
    )
  )

const audioPartFromBlock = (block: GenericContentBlock): Option.Option<ContentPart> =>
  Option.all({
    data: stringProperty(block, 'data'),
    mimeType: stringProperty(block, 'mimeType')
  }).pipe(
    Option.map(({ data, mimeType }) =>
      AudioPart.make({ source: inlineBase64Source(data), mimeType })
    )
  )

const contentPartFromBlock = (block: GenericContentBlock): ContentPart => {
  const type = block['type']

  if (type === 'text') {
    return TextPart.make({ text: Option.getOrElse(contentBlockText(block), () => '') })
  }

  if (type === 'image') {
    return Option.getOrElse(imagePartFromBlock(block), () =>
      TextPart.make({ text: fallbackTextForContentBlock(block) })
    )
  }

  if (type === 'audio') {
    return Option.getOrElse(audioPartFromBlock(block), () =>
      TextPart.make({ text: fallbackTextForContentBlock(block) })
    )
  }

  if (type === 'resource') {
    return Option.getOrElse(embeddedResourcePart(block), () =>
      TextPart.make({ text: fallbackTextForContentBlock(block) })
    )
  }

  if (type === 'resource_link') {
    return TextPart.make({
      text: resourceLinkText(block).pipe(Option.getOrElse(() => fallbackTextForContentBlock(block)))
    })
  }

  return TextPart.make({ text: fallbackTextForContentBlock(block) })
}

const contentFromBlocks = (blocks: ReadonlyArray<GenericContentBlock>): Content => {
  const textBlocks = Arr.getSomes(Arr.map(blocks, contentBlockText))

  if (textBlocks.length === blocks.length) {
    return textBlocks.join('\n')
  }

  return Arr.map(blocks, contentPartFromBlock)
}

export const toolCallResultToToolResult = (input: {
  readonly toolCallId: string
  readonly result: ToolCallResult
}) => {
  const content = input.result.content ?? []

  const resultContent =
    content.length > 0
      ? contentFromBlocks(content)
      : input.result.structuredContent === undefined
        ? 'Unsupported MCP tool content.'
        : 'Structured MCP tool result.'

  return ToolResult.make({
    toolCallId: input.toolCallId,
    content: resultContent,
    isError: input.result.isError,
    structuredContent: input.result.structuredContent
  })
}

type McpFileBlock = {
  readonly data: string
  readonly name: string
  readonly mimeType: string
  readonly view: boolean
}

// The bytes of a blob, image or audio block, or `None` for any other block.
const fileBlock = (block: GenericContentBlock): Option.Option<McpFileBlock> => {
  const type = block['type']

  if (type === 'image' || type === 'audio') {
    return Option.all({
      data: stringProperty(block, 'data'),
      mimeType: stringProperty(block, 'mimeType')
    }).pipe(Option.map(({ data, mimeType }) => ({ data, mimeType, name: type, view: true })))
  }

  if (type !== 'resource') return Option.none()

  return Schema.decodeUnknownOption(EmbeddedResourceContentBlock)(block).pipe(
    Option.flatMap(({ resource }) =>
      resource.text !== undefined || resource.blob === undefined
        ? Option.none()
        : Option.some({
            data: resource.blob,
            mimeType: resource.mimeType ?? 'application/octet-stream',
            name:
              (resource.uri === undefined ? undefined : resourceFilename(resource.uri)) ?? 'file',
            view: false
          })
    )
  )
}

type CapturedBlock = {
  readonly parts: ReadonlyArray<ContentPart>
  readonly file?: ToolFileValue
}

// Bytes that are not base64 never reach a store or the model.
const invalidFile = (file: McpFileBlock): CapturedBlock => {
  const value: ToolFileValue = {
    unavailable: 'invalid base64',
    name: file.name,
    mimeType: normalizeFileMimeType(file.mimeType)
  }

  return {
    parts: [
      omittedFilePart({ name: file.name, mimeType: file.mimeType, reason: 'invalid base64' })
    ],
    file: value
  }
}

const captureBlock = (block: GenericContentBlock): Effect.Effect<CapturedBlock> =>
  Option.match(fileBlock(block), {
    onNone: () => Effect.succeed({ parts: [contentPartFromBlock(block)] }),
    onSome: file =>
      Effect.try(() => base64ToBytes(file.data)).pipe(
        Effect.map(
          bytes =>
            new FileBytes({ bytes, name: file.name, mimeType: file.mimeType, view: file.view })
        ),
        Effect.flatMap(bytes =>
          captureToolFileValue(bytes).pipe(
            Effect.map((value): CapturedBlock => ({
              parts: capturedFileParts(bytes, value),
              file: value
            }))
          )
        ),
        Effect.orElseSucceed(() => invalidFile(file))
      )
  })

const decodeJsonText = Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Json))

/**
 * The value of an MCP result without `structuredContent`: the text blocks parsed once when they
 * form one JSON object or array, otherwise the text, or `null` without text (ADR 0013).
 */
export const mcpTextValue = (blocks: ReadonlyArray<GenericContentBlock>): Schema.Json => {
  const texts = Arr.getSomes(Arr.map(blocks, contentBlockText))

  if (texts.length === 0) return null

  const text = texts.join('\n')
  const trimmed = text.trim()

  if (!trimmed.startsWith('{') && !trimmed.startsWith('[')) return text

  return Option.match(decodeJsonText(trimmed), {
    onNone: () => text,
    onSome: value => (Predicate.isObjectOrArray(value) ? value : text)
  })
}

/**
 * The typed result of an MCP tool call (ADR 0013). A successful result's `structuredContent` is
 * `{ value, files }` (`mcpToolOutputSchema`): `value` is the server's `structuredContent`, or the
 * text (`mcpTextValue`); `files` are its blobs, images and audio, stored through the ambient
 * `ToolFileCapture` (`FileRef`, or `FileUnavailable` without a store). The model sees the server's
 * content: text, viewable images and audio followed by their file label, and blob labels. Error
 * results keep `toolCallResultToToolResult`.
 */
export const mcpToolResult = (input: {
  readonly toolCallId: string
  readonly result: ToolCallResult
}): Effect.Effect<ToolResult> => {
  if (input.result.isError === true) return Effect.succeed(toolCallResultToToolResult(input))

  const blocks = input.result.content ?? []

  return Effect.forEach(blocks, captureBlock).pipe(
    Effect.map(captured => {
      const files = captured.flatMap(block => (block.file === undefined ? [] : [block.file]))
      const parts = captured.flatMap(block => block.parts)

      const content: Content =
        blocks.length === 0
          ? input.result.structuredContent === undefined
            ? 'Unsupported MCP tool content.'
            : 'Structured MCP tool result.'
          : parts.every(part => Predicate.isTagged(part, 'Text'))
            ? parts
                .flatMap(part => (Predicate.isTagged(part, 'Text') ? [part.text] : []))
                .join('\n')
            : parts

      const value =
        input.result.structuredContent === undefined
          ? mcpTextValue(blocks)
          : input.result.structuredContent

      const descriptors = files.flatMap(file =>
        isFileRef(file)
          ? [
              FileDescriptor.make({
                fileId: file.fileId,
                name: file.name,
                mimeType: file.mimeType,
                size: file.size
              })
            ]
          : []
      )

      return descriptors.length === 0
        ? ToolResult.make({
            toolCallId: input.toolCallId,
            content,
            structuredContent: { value, files }
          })
        : ToolResult.make({
            toolCallId: input.toolCallId,
            content,
            structuredContent: { value, files },
            files: descriptors
          })
    })
  )
}

export const decodeJsonRpcResponse = Schema.decodeUnknownEffect(JsonRpcResponse)

export const decodeToolsListResult = Schema.decodeUnknownEffect(ToolsListResult)

export const decodeToolCallResult = Schema.decodeUnknownEffect(ToolCallResult)

export const encodeJsonRpcMessage = (
  server: string,
  message: JsonRpcRequest | JsonRpcNotification
) =>
  Schema.encodeUnknownEffect(Schema.fromJsonString(Schema.Unknown))(message).pipe(
    Effect.mapError(
      error =>
        new McpError({
          server,
          message: `Could not encode MCP JSON-RPC message: ${String(error)}`,
          cause: 'encoding'
        })
    )
  )

const decodeJsonString = (server: string, text: string) =>
  Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Unknown))(text).pipe(
    Effect.mapError(
      error =>
        new McpError({
          server,
          message: `Malformed MCP JSON: ${String(error)}`,
          cause: 'parse'
        })
    )
  )

export const decodeJsonRpcResponseFromJson = (server: string, text: string) =>
  decodeJsonString(server, text).pipe(
    Effect.flatMap(decodeJsonRpcResponse),
    Effect.mapError(error =>
      error instanceof McpError
        ? error
        : new McpError({
            server,
            message: `Invalid MCP JSON-RPC response: ${String(error)}`,
            cause: 'validation'
          })
    )
  )

export const decodeJsonRpcMessageFromJson = (server: string, text: string) =>
  decodeJsonString(server, text).pipe(
    Effect.flatMap(Schema.decodeUnknownEffect(JsonRpcMessage)),
    Effect.mapError(error =>
      error instanceof McpError
        ? error
        : new McpError({
            server,
            message: `Invalid MCP JSON-RPC message: ${String(error)}`,
            cause: 'validation'
          })
    )
  )
