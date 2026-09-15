import { Effect, Layer, Predicate } from 'effect'
import { describe, expect, it } from '@effect/vitest'
import { ToolExecutor, ToolError } from '@yolk-sdk/agent/loop'
import { TestToolExecutor } from '@yolk-sdk/agent/loop/testing'
import { TextPart, ToolResult } from '@yolk-sdk/agent/protocol'
import { VoiceToolCallRequest, executeVoiceToolCall } from '../../src/voice'

describe('executeVoiceToolCall', () => {
  it.effect('executes host tools and returns JSON output', () =>
    Effect.gen(function* () {
      const response = yield* executeVoiceToolCall(
        VoiceToolCallRequest.make({
          callId: 'call_1',
          name: 'echo',
          arguments: JSON.stringify({ value: 'hello' })
        })
      ).pipe(
        Effect.provide(
          TestToolExecutor.layer({
            echo: 'hello'
          })
        )
      )

      expect(response).toEqual({
        toolCallId: 'call_1',
        output: JSON.stringify({ result: 'hello' })
      })
    })
  )

  it.effect('returns invalid argument JSON as tool output', () =>
    Effect.gen(function* () {
      const response = yield* executeVoiceToolCall(
        VoiceToolCallRequest.make({
          callId: 'call_1',
          name: 'echo',
          arguments: '{'
        })
      ).pipe(Effect.provide(TestToolExecutor.layer({})))

      expect(response.toolCallId).toBe('call_1')
      expect(response.output).toContain('Invalid tool arguments JSON')
      expect(response.output).toContain('SchemaError(')
      expect(
        response.output.startsWith('{"error":"Invalid tool arguments JSON: SchemaError(')
      ).toBe(true)
    })
  )

  it.effect('accepts non-object JSON arguments without rejecting them', () =>
    Effect.gen(function* () {
      for (const argumentsJson of ['null', 'false', '0', '[]', '"text"', '1e999', '{"n":1e999}']) {
        const response = yield* executeVoiceToolCall(
          VoiceToolCallRequest.make({
            callId: 'call_1',
            name: 'echo',
            arguments: argumentsJson
          })
        ).pipe(
          Effect.provide(
            TestToolExecutor.layer({
              echo: 'hello'
            })
          )
        )

        expect(response).toEqual({
          toolCallId: 'call_1',
          output: JSON.stringify({ result: 'hello' })
        })
      }
    })
  )

  it.effect('returns tool errors as JSON output', () =>
    Effect.gen(function* () {
      const response = yield* executeVoiceToolCall(
        VoiceToolCallRequest.make({
          callId: 'call_1',
          name: 'missing',
          arguments: '{}'
        })
      ).pipe(Effect.provide(TestToolExecutor.layer({})))

      expect(response.toolCallId).toBe('call_1')
      expect(response.output).toContain('No canned result for tool: missing')
    })
  )

  it.effect('truncates large voice tool results', () =>
    Effect.gen(function* () {
      const response = yield* executeVoiceToolCall(
        VoiceToolCallRequest.make({
          callId: 'call_1',
          name: 'big',
          arguments: '{}'
        })
      ).pipe(Effect.provide(TestToolExecutor.layer({ big: 'x'.repeat(7000) })))

      expect(response.toolCallId).toBe('call_1')
      expect(response.output).toContain('[truncated for voice; summarize from available excerpt]')
      expect(response.output.length).toBeLessThan(6200)
    })
  )

  it.effect(
    'serializes opaque content-part own keys through JSON.stringify, not Content schema',
    () =>
      Effect.gen(function* () {
        let hostGetterReads = 0

        const response = yield* executeVoiceToolCall(
          VoiceToolCallRequest.make({
            callId: 'call_1',
            name: 'parts',
            arguments: '{}'
          })
        ).pipe(
          Effect.provide(
            Layer.succeed(
              ToolExecutor,
              ToolExecutor.of({
                execute: call => {
                  const result = ToolResult.make({
                    toolCallId: call.id,
                    content: [TextPart.make({ text: 'hello' })]
                  })

                  const content = result.content

                  if (Predicate.isString(content)) {
                    return Effect.succeed(result)
                  }

                  const part = content.at(0)

                  if (part === undefined) {
                    return Effect.succeed(result)
                  }

                  Object.defineProperty(part, 'extraHostKey', {
                    enumerable: true,
                    value: 'keep'
                  })
                  Object.defineProperty(part, 'hostGetter', {
                    enumerable: true,
                    get: () => {
                      hostGetterReads += 1

                      return 'seen'
                    }
                  })
                  Object.defineProperty(part, 'hiddenHostKey', {
                    enumerable: false,
                    value: 'drop'
                  })
                  Object.defineProperty(part, 'hostInfinity', {
                    enumerable: true,
                    value: Number.POSITIVE_INFINITY
                  })

                  return Effect.succeed(result)
                }
              })
            )
          )
        )

        expect(response.output).toBe(
          '{"result":[{"text":"hello","_tag":"Text","extraHostKey":"keep","hostGetter":"seen","hostInfinity":null}]}'
        )
        expect(hostGetterReads).toBe(1)
      })
  )

  it.effect('does not truncate non-string content parts', () =>
    Effect.gen(function* () {
      const text = 'x'.repeat(7000)

      const response = yield* executeVoiceToolCall(
        VoiceToolCallRequest.make({
          callId: 'call_1',
          name: 'parts',
          arguments: '{}'
        })
      ).pipe(
        Effect.provide(
          Layer.succeed(
            ToolExecutor,
            ToolExecutor.of({
              execute: call =>
                Effect.succeed(
                  ToolResult.make({
                    toolCallId: call.id,
                    content: [TextPart.make({ text })]
                  })
                )
            })
          )
        )
      )

      expect(response.output).toBe(`{"result":[{"text":"${text}","_tag":"Text"}]}`)
    })
  )

  it.effect('projects ToolError as error-message JSON without other error fields', () =>
    Effect.gen(function* () {
      const response = yield* executeVoiceToolCall(
        VoiceToolCallRequest.make({
          callId: 'call_1',
          name: 'missing',
          arguments: '{}'
        })
      ).pipe(Effect.provide(TestToolExecutor.layer({})))

      expect(response.output).toBe('{"error":"No canned result for tool: missing"}')
    })
  )

  it.effect('falls back to literal tool-failed JSON when error output cannot stringify', () =>
    Effect.gen(function* () {
      let messageReads = 0

      const toolError = new ToolError({
        tool: 'boom',
        message: 'unused',
        cause: 'execution'
      })

      Object.defineProperty(toolError, 'message', {
        configurable: true,
        enumerable: true,
        get: () => {
          messageReads += 1
          const cycle = {}

          Object.defineProperty(cycle, 'self', { value: cycle, enumerable: true })

          return cycle
        }
      })

      const response = yield* executeVoiceToolCall(
        VoiceToolCallRequest.make({
          callId: 'call_1',
          name: 'boom',
          arguments: '{}'
        })
      ).pipe(
        Effect.provide(
          Layer.succeed(
            ToolExecutor,
            ToolExecutor.of({
              execute: () => Effect.fail(toolError)
            })
          )
        )
      )

      expect(response).toEqual({
        toolCallId: 'call_1',
        output: '{"error":"Tool failed"}'
      })
      expect(messageReads).toBe(1)
    })
  )
})
