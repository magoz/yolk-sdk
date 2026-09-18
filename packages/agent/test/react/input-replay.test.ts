import { Effect, Layer, Predicate, Stream } from 'effect'
import * as Schema from 'effect/Schema'
import { describe, expect, it } from '@effect/vitest'
import {
  AssistantAgentMessage,
  HostToolCallPart,
  InputResponse,
  ToolCall,
  ToolDef,
  UserMessage,
  validateNoDanglingHostToolCalls,
  type AgentEvent,
  type AgentMessage
} from '@yolk-sdk/agent/protocol'
import {
  ContextTransformer,
  LoopConfig,
  LLMDone,
  LLMToolCall,
  ToolError,
  ToolExecutor,
  run
} from '../../src/loop/index.ts'
import { FauxProvider, Reply } from '../../src/loop/testing/index.ts'
import {
  applyAgentEventToChatMessages,
  buildAgentChatMessages,
  toAgentMessages,
  type AgentChatMessage
} from '../../src/react/index.ts'
import { makeInputTool, resolveTools } from '../../src/tools/index.ts'

const user = UserMessage.make({ content: 'Collect a word.' })

const call = ToolCall.make({ id: 'replay_word', name: 'word', params: {} })

const sibling = ToolCall.make({ id: 'replay_sibling', name: 'word', params: {} })

const normalCall = ToolCall.make({ id: 'replay_normal', name: 'normal', params: {} })

const submitted = InputResponse.make({
  requestId: 'input:word:replay_word',
  toolCallId: call.id,
  outcome: 'submitted',
  source: 'user',
  data: 'kind'
})

const cancelled = InputResponse.make({
  requestId: submitted.requestId,
  toolCallId: call.id,
  outcome: 'cancelled',
  source: 'user',
  reason: 'Not now'
})

const registration = makeInputTool({
  name: 'word',
  description: 'Collect a word.',
  response: Schema.String,
  formatContent: ({ data }) => `CUSTOM: ${JSON.stringify(data)}`
})

const project = (messages: ReadonlyArray<AgentMessage>, events: ReadonlyArray<AgentEvent>) =>
  events.reduce<ReadonlyArray<AgentChatMessage>>(
    (current, event) => applyAgentEventToChatMessages(current, event),
    buildAgentChatMessages({
      messages,
      userDraft: '',
      assistantDraft: '',
      reasoningDraft: '',
      toolRuns: [],
      error: null
    })
  )

// Cover both initial model-produced calls and pre-existing calls resumed from a
// browser transcript. Full run must publish canonical results, not only terminal
// transcript snapshots or response markers that lose server formatting.
for (const mode of ['fresh', 'resume']) {
  describe(`input replay from ${mode} full run`, () => {
    for (const outcome of ['malformed', 'unavailable', 'submitted', 'cancelled']) {
      it.effect(`preserves the canonical ${outcome} result on the next browser turn`, () =>
        Effect.gen(function* () {
          const toolSet = yield* resolveTools([{ id: 'inputs', tools: [registration] }], {})

          const currentCall =
            outcome === 'malformed'
              ? ToolCall.make({ ...call, params: { unexpected: true } })
              : call

          const messages: ReadonlyArray<AgentMessage> =
            mode === 'fresh'
              ? [user]
              : [
                  user,
                  AssistantAgentMessage.make({
                    parts: [HostToolCallPart.make({ call: currentCall })]
                  })
                ]

          const dispatched: Array<ToolCall> = []

          const events = yield* run({
            messages,
            systemPrompt: 'Collect a word.',
            tools: toolSet.tools,
            inputs: outcome === 'unavailable' ? {} : toolSet.inputs,
            hitlResponses: [outcome === 'cancelled' ? cancelled : submitted],
            model: 'faux'
          }).pipe(
            Stream.runCollect,
            Effect.provide(
              Layer.mergeAll(
                ContextTransformer.identity,
                LoopConfig.defaultLayer,
                FauxProvider.layer(
                  ...(mode === 'fresh' ? [Reply.toolCall(currentCall)] : []),
                  Reply.text('Done')
                ),
                Layer.succeed(ToolExecutor, {
                  execute: toolCall => {
                    dispatched.push(toolCall)

                    return Effect.fail(
                      new ToolError({
                        tool: toolCall.name,
                        cause: 'execution',
                        message: 'must not dispatch'
                      })
                    )
                  }
                })
              )
            )
          )

          const completion = events.find(event =>
            Predicate.isTagged(event, 'ToolExecutionCompleted')
          )

          expect(completion).toBeDefined()

          if (!Predicate.isTagged(completion, 'ToolExecutionCompleted')) {
            return
          }

          const replay = toAgentMessages(project(messages, events))
          const result = replay.find(message => Predicate.isTagged(message, 'ToolResult'))
          expect(result).toMatchObject({
            toolCallId: call.id,
            content: completion.result.content
          })
          expect(
            validateNoDanglingHostToolCalls([...replay, UserMessage.make({ content: 'Continue' })])
              ._tag
          ).toBe('Valid')
          expect(dispatched).toEqual([])

          if (outcome === 'submitted') {
            expect(result).toMatchObject({
              content: 'CUSTOM: "kind"',
              structuredContent: {
                type: 'input_response',
                name: 'word',
                data: 'kind',
                outcome: 'submitted'
              }
            })
          } else {
            expect(result).toMatchObject({ isError: true })
          }
        })
      )
    }

    it.effect('publishes a settled result beside pending siblings without dispatching', () =>
      Effect.gen(function* () {
        const toolSet = yield* resolveTools([{ id: 'inputs', tools: [registration] }], {})
        const calls = [call, sibling, normalCall]

        const messages: ReadonlyArray<AgentMessage> =
          mode === 'fresh'
            ? [user]
            : [
                user,
                AssistantAgentMessage.make({
                  parts: calls.map(toolCall => HostToolCallPart.make({ call: toolCall }))
                })
              ]

        const dispatched: Array<ToolCall> = []

        const events = yield* run({
          messages,
          systemPrompt: 'Collect words.',
          tools: [
            ...toolSet.tools,
            ToolDef.make({ name: 'normal', description: 'Normal tool.', parameters: {} })
          ],
          inputs: toolSet.inputs,
          hitlResponses: [submitted],
          model: 'faux'
        }).pipe(
          Stream.runCollect,
          Effect.provide(
            Layer.mergeAll(
              ContextTransformer.identity,
              LoopConfig.defaultLayer,
              FauxProvider.layer({
                events: [
                  ...calls.map(toolCall => LLMToolCall.make({ call: toolCall })),
                  LLMDone.make({ stopReason: 'tool_use' })
                ]
              }),
              Layer.succeed(ToolExecutor, {
                execute: toolCall => {
                  dispatched.push(toolCall)

                  return Effect.fail(
                    new ToolError({
                      tool: toolCall.name,
                      cause: 'execution',
                      message: 'must not dispatch'
                    })
                  )
                }
              })
            )
          )
        )

        const replay = toAgentMessages(project(messages, events))
        expect(replay.filter(message => Predicate.isTagged(message, 'ToolResult'))).toMatchObject([
          { toolCallId: call.id, content: 'CUSTOM: "kind"' }
        ])
        expect(
          events.filter(event => Predicate.isTagged(event, 'ToolExecutionCompleted'))
        ).toHaveLength(1)
        expect(events.at(-1)).toMatchObject({
          _tag: 'AgentAwaitingInput',
          requests: [{ toolCallId: sibling.id }]
        })
        expect(dispatched).toEqual([])
      })
    )
  })
}
