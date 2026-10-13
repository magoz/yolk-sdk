/**
 * Recorded answers are bound to the batch they answer. A fresh model turn never settles a gated
 * call from an earlier approval (a provider may reuse call ids); answers consumed by a resumed
 * batch never reach a later model turn of the same run; `run({ resume })` overrides the implicit
 * transcript-resume detection; a call is settled only by a result in its own result window.
 */
import { Effect, Layer, Predicate, Stream } from 'effect'
import { describe, expect, it } from '@effect/vitest'
import {
  AssistantAgentMessage,
  AssistantTextPart,
  HostToolCallPart,
  QuestionAnswer,
  QuestionResponse,
  ToolApprovalPolicy,
  ToolApprovalResponse,
  ToolCall,
  ToolDef,
  ToolResultMessage,
  UserMessage,
  validateNoDanglingHostToolCalls,
  type AgentEvent,
  type AgentMessage
} from '@yolk-sdk/agent/protocol'
import { ContextTransformer, LoopConfig, run, runToolBatch, type LLMRequest } from '../../src/loop'
import { FauxProvider, Reply, TestToolExecutor, type FauxResponse } from '../../src/loop/testing'

const gated = ToolDef.make({
  name: 'delete_file',
  description: 'Delete a file.',
  parameters: {},
  approval: ToolApprovalPolicy.make({ mode: 'manual' })
})

const auto = ToolDef.make({ name: 'read_file', description: 'Read a file.', parameters: {} })

const questionTool = ToolDef.make({ name: 'question', description: 'Ask.', parameters: {} })

const deleteCall = (id: string) => ToolCall.make({ id, name: 'delete_file', params: {} })

const readCall = (id: string) => ToolCall.make({ id, name: 'read_file', params: {} })

const questionCall = ToolCall.make({
  id: 'q_1',
  name: 'question',
  params: { questions: [{ id: 'choice', prompt: 'Pick one', options: [{ id: 'a', label: 'A' }] }] }
})

const approve = (id: string) =>
  ToolApprovalResponse.make({
    requestId: `approval:${id}`,
    toolCallId: id,
    decision: 'approved',
    source: 'user'
  })

const answered = QuestionResponse.make({
  requestId: 'question:q_1',
  toolCallId: 'q_1',
  outcome: 'answered',
  source: 'user',
  answers: [QuestionAnswer.make({ questionId: 'choice', optionIds: ['a'] })]
})

const user = UserMessage.make({ content: 'go' })

const assistantCalls = (...calls: ReadonlyArray<ToolCall>) =>
  AssistantAgentMessage.make({ parts: calls.map(call => HostToolCallPart.make({ call })) })

const result = (toolCallId: string) => ToolResultMessage.make({ toolCallId, content: 'done' })

const tags = (events: ReadonlyArray<AgentEvent>) => events.map(event => event._tag)

const started = (events: ReadonlyArray<AgentEvent>) =>
  events.flatMap(event =>
    Predicate.isTagged(event, 'ToolExecutionStarted') ? [event.call.id] : []
  )

const awaitingOf = (events: ReadonlyArray<AgentEvent>) =>
  events.flatMap(event =>
    Predicate.isTagged(event, 'AgentAwaitingInput')
      ? event.requests.map(request => request.requestId)
      : []
  )

const runWith = (
  config: Omit<Parameters<typeof run>[0], 'systemPrompt' | 'model'>,
  replies: ReadonlyArray<FauxResponse>,
  requests: Array<LLMRequest> = []
) =>
  run({ systemPrompt: 'Use tools.', model: 'faux', ...config }).pipe(
    Stream.runCollect,
    Effect.map(chunk => Array.from(chunk)),
    Effect.provide(
      Layer.mergeAll(
        FauxProvider.layerWithRequests({ responses: replies, requests }),
        TestToolExecutor.layer({ delete_file: 'deleted', read_file: 'read', question: 'n/a' })
      ).pipe(
        Layer.provideMerge(Layer.mergeAll(ContextTransformer.identity, LoopConfig.defaultLayer))
      )
    )
  )

describe('answers bind the batch they answer', () => {
  it.effect('a fresh model turn never settles a gated call from an earlier approval', () =>
    Effect.gen(function* () {
      // The provider reuses call_1, which an earlier batch approved.
      const events = yield* runWith(
        { messages: [user], tools: [gated], hitlResponses: [approve('call_1')] },
        [Reply.toolCall(deleteCall('call_1'))]
      )

      expect(started(events)).toEqual([])
      expect(tags(events)).not.toContain('ToolApprovalGranted')
      expect(awaitingOf(events)).toEqual(['approval:call_1'])

      // The same for a host's fresh tool batch.
      const batch = Array.from(
        yield* runToolBatch({
          calls: [deleteCall('call_1')],
          tools: [gated],
          hitlResponses: [approve('call_1')],
          resume: false
        }).pipe(
          Stream.runCollect,
          Effect.provide(TestToolExecutor.layer({ delete_file: 'deleted' })),
          Effect.provide(LoopConfig.defaultLayer)
        )
      )

      expect(started(batch)).toEqual([])
      expect(awaitingOf(batch)).toEqual(['approval:call_1'])
    })
  )

  it.effect('answers consumed by the resumed batch never reach a later turn of the run', () =>
    Effect.gen(function* () {
      // The resumed batch executes call_1; the next turn reuses call_1 for a new gated call.
      const approvals = yield* runWith(
        {
          messages: [user, assistantCalls(deleteCall('call_1'))],
          tools: [gated],
          hitlResponses: [approve('call_1')]
        },
        [Reply.toolCall(deleteCall('call_1'))]
      )

      expect(started(approvals)).toEqual(['call_1'])
      expect(awaitingOf(approvals)).toEqual(['approval:call_1'])

      // A question answered on resume is asked again when a later turn reuses its id.
      const questions = yield* runWith(
        {
          messages: [user, assistantCalls(questionCall)],
          tools: [questionTool],
          hitlResponses: [answered]
        },
        [Reply.toolCall(questionCall)]
      )

      expect(tags(questions).filter(tag => tag === 'QuestionAnswered')).toHaveLength(1)
      expect(awaitingOf(questions)).toEqual(['question:q_1'])
    })
  )

  it.effect('run({ resume }) overrides the transcript-resume detection', () =>
    Effect.gen(function* () {
      // resume: false prepares the pending call as a fresh batch: the approval is not consulted.
      const fresh = yield* runWith(
        {
          messages: [user, assistantCalls(deleteCall('call_1'))],
          tools: [gated],
          hitlResponses: [approve('call_1')],
          resume: false
        },
        []
      )

      expect(started(fresh)).toEqual([])
      expect(tags(fresh)).not.toContain('ToolApprovalGranted')
      expect(awaitingOf(fresh)).toEqual(['approval:call_1'])

      // resume: true resumes the pending call without responses (no model turn first).
      const requests: Array<LLMRequest> = []

      const resumed = yield* runWith(
        { messages: [user, assistantCalls(readCall('call_1'))], tools: [auto], resume: true },
        [Reply.text('done')],
        requests
      )

      expect(started(resumed)).toEqual(['call_1'])
      expect(requests[0]?.messages.at(-1)).toMatchObject({
        _tag: 'ToolResult',
        toolCallId: 'call_1'
      })

      // The default without responses: no resume; the model turn runs and nothing executes.
      const defaulted = yield* runWith(
        { messages: [user, assistantCalls(readCall('call_1'))], tools: [auto] },
        [Reply.text('done')]
      )

      expect(started(defaulted)).toEqual([])
    })
  )

  it.effect('a call is settled only by a result in its own result window', () =>
    Effect.gen(function* () {
      // Several tool-result messages after one assistant message: only call_3 is pending.
      const window: ReadonlyArray<AgentMessage> = [
        user,
        assistantCalls(readCall('call_1'), readCall('call_2'), readCall('call_3')),
        result('call_1'),
        result('call_2')
      ]

      const pending = yield* runWith({ messages: window, tools: [auto], resume: true }, [
        Reply.text('done')
      ])

      expect(started(pending)).toEqual(['call_3'])

      // A reused id: call_1's earlier result is in another window and does not settle it.
      const settledEarlier: ReadonlyArray<AgentMessage> = [
        user,
        assistantCalls(readCall('call_1')),
        result('call_1'),
        AssistantAgentMessage.make({ parts: [AssistantTextPart.make({ content: 'ok' })] }),
        UserMessage.make({ content: 'again' }),
        assistantCalls(readCall('call_1'), readCall('call_2')),
        result('call_2')
      ]

      expect(validateNoDanglingHostToolCalls(settledEarlier.slice(0, 5))._tag).toBe('Valid')

      const reused = yield* runWith({ messages: settledEarlier, tools: [auto], resume: true }, [
        Reply.text('done')
      ])

      expect(started(reused)).toEqual(['call_1'])

      const end = reused.find(event => Predicate.isTagged(event, 'AgentEnd'))
      const created = Predicate.isTagged(end, 'AgentEnd') ? end.messages : []

      expect(validateNoDanglingHostToolCalls([...settledEarlier, ...created])._tag).toBe('Valid')
    })
  )
})
