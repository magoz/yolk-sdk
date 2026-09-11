import { Cause, Effect } from 'effect'
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
  makeOpenAiRealtimeSessionConfigEffect,
  openAiRealtimeSessionConfigFromVoiceEffect,
  toOpenAiRealtimeToolEffect,
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

it.effect(
  'catches activated advertisement with catchTag in actual Effect config composition before host effects',
  () =>
    Effect.gen(function* () {
      const { set, counts } = yield* setup(false)
      const def = set.tools[0]
      expect(def).toBeDefined()
      if (def === undefined) return
      const config = VoiceSessionConfig.make({ model: 'test', instructions: 'Help' })
      let hostEffects = 0
      for (const build of [
        () => toOpenAiRealtimeToolEffect(def),
        () => makeOpenAiRealtimeSessionConfigEffect({ instructions: 'Help', tools: set.tools }),
        () => openAiRealtimeSessionConfigFromVoiceEffect(config, set.tools)
      ]) {
        const caught = yield* Effect.gen(function* () {
          yield* build()
          hostEffects++ // represents SDP exchange or callback transport, not just validation
          return 'unexpected'
        }).pipe(Effect.catchTag('VoiceToolBridgeError', error => Effect.succeed(error.message)))
        expect(caught).toContain('not supported in voice/realtime')
      }
      expect(hostEffects).toBe(0)
      expect(counts).toEqual({ validate: 0, inline: 0, admissions: 0 })
      const plain = yield* setup(false, false)
      const input = { instructions: 'Help', tools: plain.set.tools }
      expect(yield* makeOpenAiRealtimeSessionConfigEffect(input)).toEqual(
        makeOpenAiRealtimeSessionConfig(input)
      )
      expect(yield* openAiRealtimeSessionConfigFromVoiceEffect(config, plain.set.tools)).toEqual(
        openAiRealtimeSessionConfigFromVoice(config, plain.set.tools)
      )
    })
)

it.effect('does not disguise unexpected mapper defects as VoiceToolBridgeError', () =>
  Effect.gen(function* () {
    const { tool } = yield* setup(false, false)
    const defect = new Error('unexpected schema getter defect')
    Object.defineProperty(tool.def, 'parameters', {
      get: () => {
        throw defect
      }
    })
    let caught = false
    const exit = yield* makeOpenAiRealtimeSessionConfigEffect({
      instructions: '',
      tools: [tool.def]
    }).pipe(
      Effect.catchTag('VoiceToolBridgeError', () => {
        caught = true
        return Effect.void
      }),
      Effect.exit
    )
    expect(caught).toBe(false)
    expect(exit._tag).toBe('Failure')
    if (exit._tag === 'Failure')
      expect(Cause.findDefect(exit.cause)).toMatchObject({ _tag: 'Success', success: defect })
  })
)
