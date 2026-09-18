// @vitest-environment node
import { Effect, Predicate } from 'effect'
import * as Schema from 'effect/Schema'
import { describe, expect, it } from '@effect/vitest'
import { InputResponse, ToolCall, type HitlResponse } from '@yolk-sdk/agent/protocol'
import { prepareToolBatch } from '@yolk-sdk/agent/loop'
import { resolveAgentToolSet } from './resolve-toolset.ts'
import { nodeTextToolModules, nodeVoiceToolModules } from './registry.ts'
import {
  DraftComposerResponse,
  draftComposerInputKind,
  draftComposerToolName,
  draftComposerToolModule
} from './draft-composer-tool.ts'
import type { AgentToolContext } from './tool-context.ts'

const textContext: AgentToolContext = {
  surface: 'text',
  route: '/agent/next',
  userId: 'user_1'
}

const voiceContext: AgentToolContext = {
  surface: 'voice',
  route: '/agent/voice',
  userId: 'user_1'
}

const subagentContext: AgentToolContext = {
  surface: 'text',
  route: '/agent/next',
  userId: 'user_1',
  subagent: true
}

const draftCall = ToolCall.make({ id: 'call_draft', name: draftComposerToolName, params: {} })

const validData = { to: 'a@example.com', subject: 'Hello', body: 'Draft body.' }

const submitted = (data: Schema.Json, requestId = `input:${draftComposerToolName}:call_draft`) =>
  InputResponse.make({
    requestId,
    toolCallId: draftCall.id,
    outcome: 'submitted',
    source: 'user',
    data
  })

describe('draft composer tool', () => {
  it.effect('accepts a complete draft and rejects blank fields', () =>
    Effect.gen(function* () {
      const decoded = yield* Schema.decodeUnknownEffect(DraftComposerResponse)(validData)

      expect(decoded.to).toBe('a@example.com')

      const blank = yield* Schema.decodeUnknownEffect(DraftComposerResponse)({
        to: '  ',
        subject: 'Hello',
        body: 'Draft body.'
      }).pipe(Effect.result)

      expect(blank._tag).toBe('Failure')
    })
  )

  it.effect('resolves on top-level text toolsets only', () =>
    Effect.gen(function* () {
      const textTools = yield* resolveAgentToolSet({
        modules: nodeTextToolModules,
        context: textContext
      })

      const voiceTools = yield* resolveAgentToolSet({
        modules: nodeVoiceToolModules,
        context: voiceContext
      })

      const subagentTools = yield* resolveAgentToolSet({
        modules: nodeTextToolModules,
        context: subagentContext
      })

      expect(textTools.tools.map(tool => tool.name)).toContain(draftComposerToolName)
      expect(voiceTools.tools.map(tool => tool.name)).not.toContain(draftComposerToolName)
      expect(subagentTools.tools.map(tool => tool.name)).not.toContain(draftComposerToolName)
      expect(textTools.inputs[draftComposerToolName]).toBeDefined()
      expect(subagentTools.inputs[draftComposerToolName]).toBeUndefined()

      const def = textTools.tools.find(tool => tool.name === draftComposerToolName)

      expect(def?.input?.kind).toBe(draftComposerInputKind)
      expect(def?.approval).toBeUndefined()
    })
  )

  it.effect('exposes the module with a text-only gate', () =>
    Effect.gen(function* () {
      expect(draftComposerToolModule.id).toBe('draft-composer')

      const gated = yield* resolveAgentToolSet({
        modules: [draftComposerToolModule],
        context: textContext
      })

      expect(gated.tools.map(tool => tool.name)).toEqual([draftComposerToolName])
    })
  )

  it.effect('pends an input request and completes with a valid draft', () =>
    Effect.gen(function* () {
      const toolSet = yield* resolveAgentToolSet({
        modules: nodeTextToolModules,
        context: textContext
      })

      const pending = yield* prepareToolBatch({
        tools: toolSet.tools,
        inputs: toolSet.inputs,
        calls: [draftCall],
        responses: []
      })

      expect(pending.pendingRequests.map(request => request._tag)).toEqual(['InputRequest'])
      expect(pending.resultMessages).toEqual([])

      const [request] = pending.pendingRequests

      expect(request && 'input' in request ? request.input.kind : undefined).toBe(
        draftComposerInputKind
      )

      const completed = yield* prepareToolBatch({
        tools: toolSet.tools,
        inputs: toolSet.inputs,
        calls: [draftCall],
        responses: [submitted(validData)]
      })

      expect(completed.pendingRequests).toEqual([])
      expect(completed.resultMessages).toHaveLength(1)

      const completedMessage = completed.resultMessages[0]?.message

      expect(
        completedMessage !== undefined && Predicate.isTagged(completedMessage, 'ToolResult')
      ).toBe(true)

      if (completedMessage !== undefined && Predicate.isTagged(completedMessage, 'ToolResult')) {
        expect(completedMessage.content).toContain('a@example.com')
      }
    })
  )

  it.effect('re-pends invalid payloads and completes after correction', () =>
    Effect.gen(function* () {
      const toolSet = yield* resolveAgentToolSet({
        modules: nodeTextToolModules,
        context: textContext
      })

      const invalid = yield* prepareToolBatch({
        tools: toolSet.tools,
        inputs: toolSet.inputs,
        calls: [draftCall],
        responses: [submitted({ to: '', subject: 'Hello', body: 'Draft body.' })]
      })

      expect(invalid.pendingRequests).toHaveLength(1)
      expect(invalid.resultMessages).toEqual([])

      const corrected = yield* prepareToolBatch({
        tools: toolSet.tools,
        inputs: toolSet.inputs,
        calls: [draftCall],
        responses: [
          submitted({ to: '', subject: 'Hello', body: 'Draft body.' }),
          submitted(validData)
        ]
      })

      expect(corrected.pendingRequests).toEqual([])
      expect(corrected.resultMessages).toHaveLength(1)
    })
  )

  it.effect('cancels and rejects mismatched responses without executing', () =>
    Effect.gen(function* () {
      const toolSet = yield* resolveAgentToolSet({
        modules: nodeTextToolModules,
        context: textContext
      })

      const cancelled = yield* prepareToolBatch({
        tools: toolSet.tools,
        inputs: toolSet.inputs,
        calls: [draftCall],
        responses: [
          InputResponse.make({
            requestId: `input:${draftComposerToolName}:call_draft`,
            toolCallId: draftCall.id,
            outcome: 'cancelled',
            source: 'user',
            reason: 'Changed my mind'
          }) satisfies HitlResponse
        ]
      })

      expect(cancelled.pendingRequests).toEqual([])
      expect(cancelled.resultMessages).toHaveLength(1)

      const cancelledMessage = cancelled.resultMessages[0]?.message

      expect(
        cancelledMessage !== undefined && Predicate.isTagged(cancelledMessage, 'ToolResult')
      ).toBe(true)

      if (cancelledMessage !== undefined && Predicate.isTagged(cancelledMessage, 'ToolResult')) {
        expect(cancelledMessage.isError).toBe(true)
      }

      const mismatched = yield* prepareToolBatch({
        tools: toolSet.tools,
        inputs: toolSet.inputs,
        calls: [draftCall],
        responses: [submitted(validData, 'input:other:call_other')]
      })

      expect(mismatched.pendingRequests).toHaveLength(1)
      expect(mismatched.resultMessages).toEqual([])
    })
  )

  it.effect('keeps question behavior unchanged alongside the draft tool', () =>
    Effect.gen(function* () {
      const toolSet = yield* resolveAgentToolSet({
        modules: nodeTextToolModules,
        context: textContext
      })

      expect(toolSet.tools.map(tool => tool.name)).toContain('question')

      const questionCall = ToolCall.make({
        id: 'call_q',
        name: 'question',
        params: { questions: [{ id: 'q1', prompt: 'Pick one?' }] }
      })

      const pending = yield* prepareToolBatch({
        tools: toolSet.tools,
        inputs: toolSet.inputs,
        calls: [questionCall],
        responses: []
      })

      expect(pending.pendingRequests.map(request => request._tag)).toEqual(['QuestionRequest'])
    })
  )
})
