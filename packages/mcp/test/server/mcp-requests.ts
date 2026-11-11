/** Shared 2026-07-28 request builders and answer decoders for the MCP server tests. */
import { Effect, Option, Predicate } from 'effect'
import * as Schema from 'effect/Schema'
import type { makeMcpToolServer } from '../../src/server'

export const decodeJson = Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Unknown))

export const key = 'k'.repeat(32)

const isJsonObject = (value: Schema.Json): value is Schema.JsonObject =>
  Predicate.isObjectOrArray(value) && !Array.isArray(value)

export const jsonObject = (value: unknown) =>
  Option.getOrThrowWith(
    Option.filter(Schema.decodeUnknownOption(Schema.Json)(value), isJsonObject),
    () => new Error('Expected a JSON object fixture')
  )

export const formCapabilities = { elicitation: { form: {} } }

export const modernRequest = (input: {
  readonly method: string
  readonly id?: number
  readonly toolName?: string
  readonly params?: Schema.JsonObject
  readonly capabilities?: Schema.JsonObject
}) => {
  const headers = new Headers({
    accept: 'application/json, text/event-stream',
    'content-type': 'application/json',
    'mcp-method': input.method,
    'mcp-protocol-version': '2026-07-28'
  })

  if (input.toolName !== undefined) headers.set('mcp-name', input.toolName)

  return new Request('https://example.com/mcp', {
    method: 'POST',
    headers,
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: input.id ?? 1,
      method: input.method,
      params: {
        ...input.params,
        _meta: {
          'io.modelcontextprotocol/protocolVersion': '2026-07-28',
          'io.modelcontextprotocol/clientCapabilities': input.capabilities ?? formCapabilities,
          'io.modelcontextprotocol/clientInfo': { name: 'test-client', version: '1.0.0' }
        }
      }
    })
  })
}

export const InputRequired = Schema.Struct({
  result: Schema.Struct({
    resultType: Schema.Literal('input_required'),
    requestState: Schema.String,
    inputRequests: Schema.Record(
      Schema.String,
      Schema.Struct({
        method: Schema.Literal('elicitation/create'),
        params: Schema.Struct({
          mode: Schema.optional(Schema.String),
          message: Schema.String,
          requestedSchema: Schema.Unknown
        })
      })
    )
  })
})

export const CallResult = Schema.Struct({
  result: Schema.Struct({
    content: Schema.Array(Schema.Struct({ type: Schema.String, text: Schema.String })),
    isError: Schema.optional(Schema.Boolean)
  })
})

export type ToolServer = ReturnType<typeof makeMcpToolServer<never>>

export const respond = (server: ToolServer, request: Request) =>
  Effect.gen(function* () {
    const response = yield* server.handleHttpRequest(request)
    const body = yield* Effect.promise(() => response.text())

    return yield* decodeJson(body)
  })
