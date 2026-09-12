import { Effect, Option } from 'effect'
import * as Schema from 'effect/Schema'
import { describe, expect, it } from '@effect/vitest'
import { AudioPart, ImagePart, TextPart, inlineBase64Source } from '@yolk-sdk/agent/protocol'
import {
  JsonRpcMessage,
  decodeJsonRpcMessageFromJson,
  makeJsonRpcRequest,
  toolCallResultToToolResult
} from '../../src/client'

const decodeJsonRpcPacket = Schema.decodeUnknownEffect(Schema.UnknownFromJsonString)

const decodeJsonRpcMessage = Schema.decodeUnknownOption(JsonRpcMessage)

describe('MCP anti-slop preview regressions', () => {
  it('omits params and preserves own-key order plus getter evaluation', () => {
    const presentSequence: string[] = []

    const presentInput = {
      get id() {
        presentSequence.push('id')

        return 1
      },
      get method() {
        presentSequence.push('method')

        return 'tools/call'
      },
      get params() {
        presentSequence.push('params')

        return { name: 'echo' }
      }
    }

    const withParams = makeJsonRpcRequest(presentInput)

    expect(presentSequence).toEqual(['id', 'method', 'params', 'params'])
    expect(Object.keys(withParams)).toEqual(['jsonrpc', 'id', 'method', 'params'])
    expect(withParams).toEqual({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: { name: 'echo' }
    })

    const absentSequence: string[] = []

    const absentInput = {
      get id() {
        absentSequence.push('id')

        return 2
      },
      get method() {
        absentSequence.push('method')

        return 'tools/list'
      },
      get params() {
        absentSequence.push('params')

        return undefined
      }
    }

    const withoutParams = makeJsonRpcRequest(absentInput)

    expect(absentSequence).toEqual(['id', 'method', 'params'])
    expect(Object.keys(withoutParams)).toEqual(['jsonrpc', 'id', 'method'])
    expect('params' in withoutParams).toBe(false)
    expect(JSON.stringify(withoutParams)).toBe('{"jsonrpc":"2.0","id":2,"method":"tools/list"}')
  })

  it.effect('parses raw JSON-RPC packets with the protocol schema decoder', () =>
    Effect.gen(function* () {
      const requestPacket = yield* decodeJsonRpcPacket(
        '{"jsonrpc":"2.0","id":3,"method":"tools/list"}'
      )

      const request = decodeJsonRpcMessage(requestPacket)

      expect(Option.isSome(request)).toBe(true)

      if (Option.isSome(request) && 'id' in request.value) {
        expect(request.value.id).toBe(3)
        expect(request.value.method).toBe('tools/list')
      }

      const notificationPacket = yield* decodeJsonRpcPacket(
        '{"jsonrpc":"2.0","method":"notifications/initialized"}'
      )

      const notification = decodeJsonRpcMessage(notificationPacket)

      expect(Option.isSome(notification)).toBe(true)

      if (Option.isSome(notification)) {
        expect('id' in notification.value).toBe(false)
        expect(notification.value.method).toBe('notifications/initialized')
      }

      const invalid = decodeJsonRpcMessage(yield* decodeJsonRpcPacket('{"foo":1}'))

      expect(Option.isNone(invalid)).toBe(true)

      const fromJson = yield* decodeJsonRpcMessageFromJson(
        'remote',
        '{"jsonrpc":"2.0","id":"abc","method":"initialize","params":{"protocolVersion":"2024-11-05"}}'
      )

      expect('id' in fromJson).toBe(true)

      if ('id' in fromJson) {
        expect(fromJson.id).toBe('abc')
        expect(fromJson.method).toBe('initialize')
      }
    })
  )

  it('keeps Vitest toEqual/toMatchObject contracts for owned content constructors', () => {
    const result = toolCallResultToToolResult({
      toolCallId: 'call_1',
      result: {
        isError: true,
        structuredContent: { answer: 42 },
        content: [
          { type: 'text', text: 'hello' },
          { type: 'image', data: 'abc', mimeType: 'image/png' },
          { type: 'audio', data: 'def', mimeType: 'audio/mpeg' }
        ]
      }
    })

    const constructed = [
      TextPart.make({ text: 'hello' }),
      ImagePart.make({ source: inlineBase64Source('abc'), mimeType: 'image/png' }),
      AudioPart.make({ source: inlineBase64Source('def'), mimeType: 'audio/mpeg' })
    ]

    expect(result.content).toEqual(constructed)
    expect(result).toMatchObject({
      toolCallId: 'call_1',
      isError: true,
      structuredContent: { answer: 42 },
      content: constructed
    })
  })

  it('decodes content-block string fields through Schema.String', () => {
    const result = toolCallResultToToolResult({
      toolCallId: 'call_2',
      result: {
        content: [
          { type: 'text', text: 'ok' },
          { type: 'text', text: 1 },
          { type: 'image', data: 2, mimeType: 'image/png' }
        ]
      }
    })

    expect(result.content).toEqual([
      TextPart.make({ text: 'ok' }),
      TextPart.make({ text: '' }),
      TextPart.make({ text: 'MCP image: image' })
    ])
  })
})
