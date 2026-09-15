import { Effect, Predicate } from 'effect'
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

    const expectedDecisionFields = {
      request: {
        requestId: voiceApprovalRequestId('call_1'),
        toolCallId: 'call_1',
        call: { id: 'call_1', name: 'sandbox', params: { command: 'ls' } },
        policy: { mode: 'manual' }
      }
    }

    expect(decision._tag).toBe('RequireApproval')
    expect(decision).toMatchObject(expectedDecisionFields)
  })

  it('keeps raw arguments when approval display params are not valid JSON', () => {
    const decision = decideVoiceToolCall(
      [sandboxTool],
      VoiceToolCall.make({ callId: 'call_1', name: 'sandbox', argumentsJson: '{broken' })
    )

    expect(decision._tag).toBe('RequireApproval')
    expect(decision).toMatchObject({ request: { call: { params: { argumentsJson: '{broken' } } } })
  })

  it('admits actual JSON null/false/0 as approval display params', () => {
    const nullDecision = decideVoiceToolCall(
      [sandboxTool],
      VoiceToolCall.make({ callId: 'call_1', name: 'sandbox', argumentsJson: 'null' })
    )

    const falseDecision = decideVoiceToolCall(
      [sandboxTool],
      VoiceToolCall.make({ callId: 'call_2', name: 'sandbox', argumentsJson: 'false' })
    )

    const zeroDecision = decideVoiceToolCall(
      [sandboxTool],
      VoiceToolCall.make({ callId: 'call_3', name: 'sandbox', argumentsJson: '0' })
    )

    const objectDecision = decideVoiceToolCall(
      [sandboxTool],
      VoiceToolCall.make({
        callId: 'call_4',
        name: 'sandbox',
        argumentsJson: '{"n":0,"ok":false,"x":null}'
      })
    )

    expect(nullDecision).toMatchObject({ request: { call: { params: null } } })
    expect(falseDecision).toMatchObject({ request: { call: { params: false } } })
    expect(zeroDecision).toMatchObject({ request: { call: { params: 0 } } })
    expect(objectDecision).toMatchObject({
      request: { call: { params: { n: 0, ok: false, x: null } } }
    })
  })

  it('keeps finite overflow as the existing approval display object, not Infinity', () => {
    // Raw JSON 1e999 parses to Infinity. Schema.Json requires finite numbers, so
    // display params become { argumentsJson: '1e999' } instead of Infinity.
    // Do not JSON.stringify(Infinity) (that is null).
    const decision = decideVoiceToolCall(
      [sandboxTool],
      VoiceToolCall.make({ callId: 'call_1', name: 'sandbox', argumentsJson: '1e999' })
    )

    expect(decision._tag).toBe('RequireApproval')
    expect(decision).toMatchObject({ request: { call: { params: { argumentsJson: '1e999' } } } })
  })

  it('uses the whole raw nested-overflow document for approval display without changing the gate', () => {
    const raw = '{"n":1e999,"ok":false}'

    const decision = decideVoiceToolCall(
      [sandboxTool],
      VoiceToolCall.make({ callId: 'nested-overflow', name: 'sandbox', argumentsJson: raw })
    )

    expect(decision._tag).toBe('RequireApproval')
    expect(decision).toMatchObject({ request: { call: { params: { argumentsJson: raw } } } })
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

      const expectedOutcomeFields = {
        callId: 'call_1',
        output: JSON.stringify({ result: 'hello' })
      }

      expect(outcome._tag).toBe('Executed')
      expect(outcome).toMatchObject(expectedOutcomeFields)
    })
  )

  it.effect('returns approval-required without executing gated tools', () =>
    Effect.gen(function* () {
      const outcome = yield* handleVoiceToolCall({
        call: VoiceToolCall.make({ callId: 'call_1', name: 'sandbox', argumentsJson: '{}' }),
        tools: [sandboxTool]
      }).pipe(Effect.provide(TestToolExecutor.layer({})))

      const expectedOutcomeFields = {
        request: { requestId: voiceApprovalRequestId('call_1'), toolCallId: 'call_1' }
      }

      expect(outcome._tag).toBe('ApprovalRequired')
      expect(outcome).toMatchObject(expectedOutcomeFields)
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

      const expectedOutcomeFields = {
        callId: 'call_1',
        output: JSON.stringify({ result: 'ran' })
      }

      expect(outcome._tag).toBe('Executed')
      expect(outcome).toMatchObject(expectedOutcomeFields)
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

      expect(outcome._tag).toBe('Denied')
      expect(outcome).toMatchObject({ callId: 'call_1', reason: 'not allowed' })
      expect(Predicate.isTagged(outcome, 'Denied') && outcome.output).toContain('denied')
      expect(Predicate.isTagged(outcome, 'Denied') && outcome.output).toContain('Do not retry')
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

      const expectedOutcomeFields = {
        request: { requestId: voiceApprovalRequestId('call_1') }
      }

      expect(outcome._tag).toBe('ApprovalRequired')
      expect(outcome).toMatchObject(expectedOutcomeFields)
    })
  )
})
