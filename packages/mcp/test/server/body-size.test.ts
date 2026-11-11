import { Effect, Option } from 'effect'
import * as Schema from 'effect/Schema'
import { describe, expect, it } from '@effect/vitest'
import { ToolDef, ToolResult } from '@yolk-sdk/agent/protocol'
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

const legacyCall = () =>
  new Request('https://example.com/mcp', {
    method: 'POST',
    headers: {
      accept: 'application/json, text/event-stream',
      'content-type': 'application/json',
      'mcp-protocol-version': '2025-06-18'
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

  it.effect('answers an error naming an unusable `maxRequestBodySize`, running nothing', () =>
    Effect.gen(function* () {
      for (const bound of [0, -1, Number.NaN, Infinity]) {
        const { status, body } = yield* answer(server(bound), modernCall())

        expect(status).toBe(500)
        expect(body).toContain('maxRequestBodySize must be a positive number of bytes')
      }
    })
  )
})
