import { Array as Arr, Effect, Option } from 'effect'
import * as Schema from 'effect/Schema'
import {
  AudioPart,
  ImagePart,
  TextPart,
  ToolDef,
  ToolResult,
  inlineBase64Source
} from '@yolk-sdk/agent/protocol'
import type { Content, ContentPart } from '@yolk-sdk/agent/protocol'
import { McpError } from './errors.ts'

export const latestMcpProtocolVersion = '2024-11-05'

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

export const McpTool = Schema.Struct({
  name: Schema.String,
  description: Schema.optional(Schema.String),
  inputSchema: Schema.optional(Schema.Unknown)
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

export const makeJsonRpcRequest = (input: {
  readonly id: string | number
  readonly method: string
  readonly params?: unknown
}): JsonRpcRequest => ({
  jsonrpc: '2.0',
  id: input.id,
  method: input.method,
  ...(input.params === undefined ? {} : { params: input.params })
})

export const makeInitializedNotification = (): JsonRpcNotification => ({
  jsonrpc: '2.0',
  method: 'notifications/initialized'
})

export const makeInitializeParams = (input: {
  readonly name: string
  readonly version: string
}) => ({
  protocolVersion: latestMcpProtocolVersion,
  capabilities: {},
  clientInfo: {
    name: input.name,
    version: input.version
  }
})

export const jsonRpcErrorToMcpError = (server: string, error: JsonRpcErrorObject) =>
  new McpError({
    server,
    message: `MCP JSON-RPC error ${error.code}: ${error.message}`,
    cause: 'protocol'
  })

export const mcpToolToToolDef = (input: { readonly serverName: string; readonly tool: McpTool }) =>
  ToolDef.make({
    name: `${sanitizeMcpName(input.serverName)}_${sanitizeMcpName(input.tool.name)}`,
    description: input.tool.description ?? `MCP tool ${input.serverName}/${input.tool.name}`,
    parameters: input.tool.inputSchema ?? { type: 'object', additionalProperties: true }
  })

export const sanitizeMcpName = (name: string) => {
  const sanitized = name.replace(/[^a-zA-Z0-9_-]/g, '_')
  return sanitized.length === 0 ? 'mcp' : sanitized
}

const stringProperty = (block: GenericContentBlock, key: string) => {
  const value = block[key]

  return typeof value === 'string' ? Option.some(value) : Option.none<string>()
}

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

const embeddedResourceText = (block: GenericContentBlock): Option.Option<string> =>
  Schema.decodeUnknownOption(EmbeddedResourceContentBlock)(block).pipe(
    Option.flatMap(({ resource }) => {
      if (resource.text !== undefined) {
        return Option.some(resource.text)
      }

      return Option.all({
        uri: Option.fromNullishOr(resource.uri),
        blob: Option.fromNullishOr(resource.blob)
      }).pipe(Option.map(({ uri, blob }) => `MCP resource: ${uri}\n${blob}`))
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
    return TextPart.make({
      text: embeddedResourceText(block).pipe(
        Option.getOrElse(() => fallbackTextForContentBlock(block))
      )
    })
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

export const decodeJsonRpcResponse = Schema.decodeUnknownEffect(JsonRpcResponse)
export const decodeToolsListResult = Schema.decodeUnknownEffect(ToolsListResult)
export const decodeToolCallResult = Schema.decodeUnknownEffect(ToolCallResult)

export const encodeJsonRpcMessage = (
  server: string,
  message: JsonRpcRequest | JsonRpcNotification
) =>
  Schema.encodeUnknownEffect(Schema.UnknownFromJsonString)(message).pipe(
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
  Schema.decodeUnknownEffect(Schema.UnknownFromJsonString)(text).pipe(
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
