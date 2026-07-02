import { Effect } from 'effect'
import { describe, expect, it } from '@effect/vitest'
import { ToolApprovalPolicy, ToolApprovalResponse, ToolDef } from '@yolk-sdk/agent/protocol'
import { TestToolExecutor } from '@yolk-sdk/agent/loop/testing'
import {
  decideVoiceToolCall,
  handleVoiceToolCall,
  VoiceToolCall,
  voiceApprovalRequestId
} from '../../src/voice/index.ts'

const searchTool = ToolDef.make({
  name: 'web_search',
  description: 'Search',
  parameters: {}
})

const sandboxTool = ToolDef.make({
  name: 'sandbox',
  description: 'Run commands',
  parameters: {},
  approval: ToolApprovalPolicy.make({ mode: 'manual' })
})

describe('decideVoiceToolCall', () => {
  it('executes tools without approval policy', () => {
    const decision = decideVoiceToolCall(
      [searchTool, sandboxTool],
      VoiceToolCall.make({ callId: 'call_1', name: 'web_search', argumentsJson: '{"q":"x"}' })
    )

    expect(decision._tag).toBe('Execute')
  })

  it('requires approval for manual-approval tools with parsed display params', () => {
    const decision = decideVoiceToolCall(
      [searchTool, sandboxTool],
      VoiceToolCall.make({ callId: 'call_1', name: 'sandbox', argumentsJson: '{"command":"ls"}' })
    )

    expect(decision).toMatchObject({
      _tag: 'RequireApproval',
      request: {
        requestId: voiceApprovalRequestId('call_1'),
        toolCallId: 'call_1',
        call: { id: 'call_1', name: 'sandbox', params: { command: 'ls' } },
        policy: { mode: 'manual' }
      }
    })
  })

  it('keeps raw arguments when approval display params are not valid JSON', () => {
    const decision = decideVoiceToolCall(
      [sandboxTool],
      VoiceToolCall.make({ callId: 'call_1', name: 'sandbox', argumentsJson: '{broken' })
    )

    expect(decision).toMatchObject({
      _tag: 'RequireApproval',
      request: { call: { params: { argumentsJson: '{broken' } } }
    })
  })

  it('executes unknown tools so the executor can return a model-visible failure', () => {
    const decision = decideVoiceToolCall(
      [sandboxTool],
      VoiceToolCall.make({ callId: 'call_1', name: 'missing', argumentsJson: '{}' })
    )

    expect(decision._tag).toBe('Execute')
  })
})

describe('handleVoiceToolCall', () => {
  it.effect('executes approved tools through the executor', () =>
    Effect.gen(function* () {
      const outcome = yield* handleVoiceToolCall({
        call: VoiceToolCall.make({ callId: 'call_1', name: 'echo', argumentsJson: '{"v":1}' }),
        tools: [searchTool]
      }).pipe(Effect.provide(TestToolExecutor.layer({ echo: 'hello' })))

      expect(outcome).toMatchObject({
        _tag: 'Executed',
        callId: 'call_1',
        output: JSON.stringify({ result: 'hello' })
      })
    })
  )

  it.effect('returns approval-required without executing gated tools', () =>
    Effect.gen(function* () {
      const outcome = yield* handleVoiceToolCall({
        call: VoiceToolCall.make({ callId: 'call_1', name: 'sandbox', argumentsJson: '{}' }),
        tools: [sandboxTool]
      }).pipe(Effect.provide(TestToolExecutor.layer({})))

      expect(outcome).toMatchObject({
        _tag: 'ApprovalRequired',
        request: { requestId: voiceApprovalRequestId('call_1'), toolCallId: 'call_1' }
      })
    })
  )

  it.effect('executes gated tools with a matching approved response', () =>
    Effect.gen(function* () {
      const outcome = yield* handleVoiceToolCall({
        call: VoiceToolCall.make({ callId: 'call_1', name: 'sandbox', argumentsJson: '{}' }),
        tools: [sandboxTool],
        approval: ToolApprovalResponse.make({
          requestId: voiceApprovalRequestId('call_1'),
          toolCallId: 'call_1',
          decision: 'approved',
          source: 'user'
        })
      }).pipe(Effect.provide(TestToolExecutor.layer({ sandbox: 'ran' })))

      expect(outcome).toMatchObject({
        _tag: 'Executed',
        callId: 'call_1',
        output: JSON.stringify({ result: 'ran' })
      })
    })
  )

  it.effect('returns denied with model-visible output for denied responses', () =>
    Effect.gen(function* () {
      const outcome = yield* handleVoiceToolCall({
        call: VoiceToolCall.make({ callId: 'call_1', name: 'sandbox', argumentsJson: '{}' }),
        tools: [sandboxTool],
        approval: ToolApprovalResponse.make({
          requestId: voiceApprovalRequestId('call_1'),
          toolCallId: 'call_1',
          decision: 'denied',
          source: 'user',
          reason: 'not allowed'
        })
      }).pipe(Effect.provide(TestToolExecutor.layer({ sandbox: 'ran' })))

      expect(outcome).toMatchObject({
        _tag: 'Denied',
        callId: 'call_1',
        reason: 'not allowed'
      })
      expect(outcome._tag === 'Denied' && outcome.output).toContain('denied')
      expect(outcome._tag === 'Denied' && outcome.output).toContain('Do not retry')
    })
  )

  it.effect('rejects mismatched approvals and never executes the tool', () =>
    Effect.gen(function* () {
      const outcome = yield* handleVoiceToolCall({
        call: VoiceToolCall.make({ callId: 'call_1', name: 'sandbox', argumentsJson: '{}' }),
        tools: [sandboxTool],
        approval: ToolApprovalResponse.make({
          requestId: voiceApprovalRequestId('other_call'),
          toolCallId: 'other_call',
          decision: 'approved',
          source: 'user'
        })
      }).pipe(Effect.provide(TestToolExecutor.layer({ sandbox: 'ran' })))

      expect(outcome).toMatchObject({
        _tag: 'ApprovalRequired',
        request: { requestId: voiceApprovalRequestId('call_1') }
      })
    })
  )
})
