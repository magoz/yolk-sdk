import { Effect } from 'effect'
import * as Schema from 'effect/Schema'
import { describe, expect, it } from '@effect/vitest'
import {
  BackgroundToolAccepted,
  ToolApprovalPolicy,
  ToolApprovalResponse,
  ToolCall,
  ToolResult
} from '@yolk-sdk/agent/protocol'
import { makeTool, makeToolExecutorLayer, resolveTools } from '@yolk-sdk/agent/tools'
import {
  decideVoiceToolCall,
  executeVoiceToolCall,
  handleVoiceToolCall,
  VoiceSessionConfig,
  VoiceToolBridgeError,
  VoiceToolCall,
  VoiceToolCallRequest,
  voiceApprovalRequestId
} from '@yolk-sdk/agent/voice'
import {
  makeOpenAiRealtimeSessionConfig,
  openAiRealtimeSessionConfigFromVoice,
  toOpenAiRealtimeTool
} from '@yolk-sdk/agent/providers/openai/realtime'

const setup = (manual: boolean, activated = true) =>
  Effect.gen(function* () {
    const counts = { validate: 0, inline: 0, admissions: 0 }
    const tool = makeTool({
      name: 'work',
      description: 'Work',
      access: 'write',
      background: true,
      parameters: Schema.Struct({ value: Schema.String }),
      ...(manual ? { approval: ToolApprovalPolicy.make({ mode: 'manual' }) } : {}),
      execute: ({ call }) =>
        Effect.sync(() => {
          counts.inline++
          return ToolResult.make({ toolCallId: call.id, content: 'done' })
        })
    })
    const set = yield* resolveTools(
      [
        {
          id: 'test',
          tools: [
            {
              ...tool,
              validate: () =>
                Effect.sync(() => {
                  counts.validate++
                })
            }
          ]
        }
      ],
      {},
      activated
        ? {
            backgroundHost: {
              accept: () =>
                Effect.sync(() => {
                  counts.admissions++
                  return BackgroundToolAccepted.make({ version: 1, executionId: 'owner:work' })
                })
            }
          }
        : {}
    )
    return { set, counts, tool }
  })

const call = (execution: string, value: string) =>
  VoiceToolCall.make({
    callId: 'reused',
    name: 'work',
    argumentsJson: JSON.stringify({ execution, arguments: { value } })
  })

describe('activated background tools fail closed in voice', () => {
  it.effect(
    'rejects direct realtime mapping and both config builders rather than silently dropping tools',
    () =>
      Effect.gen(function* () {
        const { set } = yield* setup(false)
        const def = set.tools[0]!
        const config = VoiceSessionConfig.make({ model: 'test', instructions: 'Help' })
        for (const advertise of [
          () => toOpenAiRealtimeTool(def),
          () => makeOpenAiRealtimeSessionConfig({ instructions: 'Help', tools: set.tools }),
          () => openAiRealtimeSessionConfigFromVoice(config, set.tools)
        ]) {
          expect(advertise).toThrow(VoiceToolBridgeError)
          expect(advertise).toThrow('not supported in voice/realtime')
        }
      })
  )

  it.effect(
    'denies automatic/manual activated calls before validation, execution or admission even with reused approval',
    () =>
      Effect.gen(function* () {
        for (const manual of [false, true]) {
          const { set, counts } = yield* setup(manual)
          const original = call('foreground', 'original')
          const approval = ToolApprovalResponse.make({
            requestId: voiceApprovalRequestId(original.callId),
            toolCallId: original.callId,
            decision: 'approved',
            source: 'user'
          })
          for (const request of [
            original,
            call('foreground', 'changed'),
            call('background', 'original'),
            call('background', 'changed')
          ]) {
            expect(decideVoiceToolCall(set.tools, request)._tag).toBe('Deny')
            for (const response of [undefined, approval]) {
              const outcome = yield* handleVoiceToolCall({
                call: request,
                tools: set.tools,
                approval: response
              }).pipe(Effect.provide(makeToolExecutorLayer(set)))
              expect(outcome).toMatchObject({ _tag: 'Denied', callId: original.callId })
              expect(outcome._tag === 'Denied' && outcome.output).toContain(
                'not supported in voice/realtime'
              )
            }
          }
          expect(counts).toEqual({ validate: 0, inline: 0, admissions: 0 })
        }
      })
  )

  it.effect(
    'also fences the direct low-level bridge; its fiber-local marker does not affect ordinary registry dispatch',
    () =>
      Effect.gen(function* () {
        const { set, counts } = yield* setup(false)
        for (const execution of ['foreground', 'background']) {
          const request = call(execution, 'original')
          const outcome = yield* executeVoiceToolCall(
            VoiceToolCallRequest.make({
              callId: request.callId,
              name: request.name,
              arguments: request.argumentsJson
            })
          ).pipe(Effect.provide(makeToolExecutorLayer(set)))
          expect(outcome.output).toContain('not supported in voice/realtime')
        }
        expect(counts).toEqual({ validate: 0, inline: 0, admissions: 0 })
        yield* set.execute(
          ToolCall.make({
            id: 'text',
            name: 'work',
            params: { execution: 'background', arguments: { value: 'ok' } }
          })
        )
        expect(counts).toEqual({ validate: 1, inline: 0, admissions: 1 })
      })
  )

  it.effect(
    'retains no-host voice advertisement and approved dispatch even with the inert capability flag',
    () =>
      Effect.gen(function* () {
        const { set, counts, tool } = yield* setup(true, false)
        expect(set.tools[0]).toBe(tool.def)
        expect(toOpenAiRealtimeTool(tool.def).parameters).toBe(tool.def.parameters)
        expect(
          makeOpenAiRealtimeSessionConfig({ instructions: '', tools: set.tools }).tools
        ).toEqual([toOpenAiRealtimeTool(tool.def)])
        const outcome = yield* handleVoiceToolCall({
          tools: set.tools,
          call: VoiceToolCall.make({
            callId: 'reused',
            name: 'work',
            argumentsJson: '{"value":"original"}'
          }),
          approval: ToolApprovalResponse.make({
            requestId: voiceApprovalRequestId('reused'),
            toolCallId: 'reused',
            decision: 'approved',
            source: 'user'
          })
        }).pipe(Effect.provide(makeToolExecutorLayer(set)))
        expect(outcome).toMatchObject({ _tag: 'Executed', output: '{"result":"done"}' })
        expect(counts).toEqual({ validate: 0, inline: 1, admissions: 0 })
      })
  )
})
