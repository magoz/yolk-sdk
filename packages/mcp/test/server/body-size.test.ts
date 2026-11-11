import { Context, Effect, Layer, Option } from 'effect'
import * as Schema from 'effect/Schema'
import { describe, expect, it } from '@effect/vitest'
import { type ToolCall, ToolDef, ToolResult } from '@yolk-sdk/agent/protocol'
import { makeMcpToolServer, type McpServerTool } from '../../src/server'
import { jsonObject, modernRequest } from './mcp-requests'

const decodeText = Schema.decodeUnknownOption(Schema.Struct({ text: Schema.String }))

const echo: McpServerTool = {
  def: ToolDef.make({
    name: 'echo',
    description: 'Echo the text length',
    parameters: { type: 'object', properties: { text: { type: 'string' } } }
  }),
  execute: call =>
    Effect.succeed(
      ToolResult.make({
        toolCallId: call.id,
        content: Option.match(decodeText(call.params), {
          onNone: () => 'no text',
          onSome: ({ text }) => String(text.length)
        })
      })
    )
}

class Resource extends Context.Service<Resource, { readonly isOpen: () => boolean }>()(
  'test/BodySizeResource'
) {}

// Closed when the caller's scope closes, as a host's request layer is.
const ResourceLive = Layer.effect(
  Resource,
  Effect.gen(function* () {
    const state = { open: true }

    yield* Effect.addFinalizer(() =>
      Effect.sync(() => {
        state.open = false
      })
    )

    return Resource.of({ isOpen: () => state.open })
  })
)

const scopedEcho = {
  def: ToolDef.make({
    name: 'echo',
    description: 'Echo the text length once its resource is read',
    parameters: { type: 'object', properties: { text: { type: 'string' } } }
  }),
  execute: (call: ToolCall) =>
    Effect.gen(function* () {
      const resource = yield* Resource

      // Real async work, so the tool is still running when the HTTP response is produced.
      yield* Effect.sleep('10 millis')

      const length = Option.match(decodeText(call.params), {
        onNone: () => 'no text',
        onSome: ({ text: value }) => String(value.length)
      })

      return ToolResult.make({
        toolCallId: call.id,
        content: `${resource.isOpen() ? 'open' : 'closed'} ${length}`
      })
    })
}

// Over the SDK's default 4 MiB, under 5 MiB.
const text = 'x'.repeat(4.5 * 1024 * 1024)

const server = (maxRequestBodySize?: number) =>
  maxRequestBodySize === undefined
    ? makeMcpToolServer({ name: 'body-server', version: '0', tools: [echo] })
    : makeMcpToolServer({ name: 'body-server', version: '0', tools: [echo], maxRequestBodySize })

const modernCall = () =>
  modernRequest({
    method: 'tools/call',
    toolName: 'echo',
    params: jsonObject({ name: 'echo', arguments: { text } })
  })

const legacyCall = (headers: Readonly<Record<string, string>> = {}) =>
  new Request('https://example.com/mcp', {
    method: 'POST',
    headers: {
      accept: 'application/json, text/event-stream',
      'content-type': 'application/json',
      'mcp-protocol-version': '2025-06-18',
      ...headers
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: { name: 'echo', arguments: { text } }
    })
  })

const answer = (tools: ReturnType<typeof server>, request: Request) =>
  Effect.gen(function* () {
    const response = yield* tools.handleHttpRequest(request)

    return { status: response.status, body: yield* Effect.promise(() => response.text()) }
  })

describe('MCP server request body bound', () => {
  it.effect('refuses a body over the SDK default of 4 MiB in both eras', () =>
    Effect.gen(function* () {
      for (const request of [modernCall(), legacyCall()]) {
        expect((yield* answer(server(), request)).status).toBe(413)
      }
    })
  )

  it.effect('serves a body under a raised `maxRequestBodySize` in both eras', () =>
    Effect.gen(function* () {
      for (const request of [modernCall(), legacyCall()]) {
        const { status, body } = yield* answer(server(5 * 1024 * 1024), request)

        expect(status).toBe(200)
        expect(body).toContain(`"text":"${text.length}"`)
      }
    })
  )

  // A 2025-era call may carry any `Mcp-Method`; era routing must read it under the same bound, or
  // an oversized call would count as listen and its tool would run after the scope closed.
  it.live('routes a 2025-era call claiming listen by the raised bound, running it in scope', () =>
    Effect.gen(function* () {
      const response = yield* makeMcpToolServer({
        name: 'body-server',
        version: '0',
        tools: [scopedEcho],
        maxRequestBodySize: 5 * 1024 * 1024
      })
        .handleHttpRequest(legacyCall({ 'mcp-method': 'subscriptions/listen' }))
        .pipe(Effect.provide(ResourceLive), Effect.scoped)

      expect(response.status).toBe(200)
      expect(yield* Effect.promise(() => response.text())).toContain(`"text":"open ${text.length}"`)
    })
  )

  it.effect('answers an error naming an unusable `maxRequestBodySize`, running nothing', () =>
    Effect.gen(function* () {
      for (const [bound, request] of [0, -1, Number.NaN, Infinity].flatMap(value => [
        [value, modernCall()] as const,
        [value, legacyCall()] as const
      ])) {
        const { status, body } = yield* answer(server(bound), request)

        expect(status).toBe(500)
        expect(JSON.parse(body)).toMatchObject({
          error: {
            code: -32603,
            message: expect.stringContaining(
              'maxRequestBodySize must be a positive number of bytes'
            )
          }
        })
        // The echo never ran: its answer would carry the text length.
        expect(body).not.toContain(String(text.length))
      }
    })
  )
})
