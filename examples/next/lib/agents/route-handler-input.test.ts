// @vitest-environment node
import { Effect, Layer, Predicate } from 'effect'
import * as Schema from 'effect/Schema'
import { describe, expect, it } from '@effect/vitest'
import { AgentEvent, InputResponse, UserMessage } from '@yolk-sdk/agent/protocol'
import { ContextTransformer, LoopConfig } from '@yolk-sdk/agent/loop'
import { FauxProvider, Reply, TestToolExecutor } from '@yolk-sdk/agent/loop/testing'
import { AgentRouteRequest, makeAgentPostResponse } from './route-handler.ts'
import { resolveAgentToolSet } from './tools/resolve-toolset.ts'
import { nodeTextToolModules } from './tools/registry.ts'
import { draftComposerToolName } from './tools/draft-composer-tool.ts'

const decodeEvent = Schema.decodeUnknownEffect(Schema.fromJsonString(AgentEvent))

const decodeEvents = (body: string) =>
  Effect.forEach(
    body
      .trim()
      .split('\n')
      .filter(line => line.length > 0),
    line => decodeEvent(line)
  )

const awaitingInput = (events: ReadonlyArray<AgentEvent>) =>
  events.find(event => Predicate.isTagged(event, 'AgentAwaitingInput'))

describe('text HTTP host input path', () => {
  it.effect('pauses for the draft composer and resumes with the submitted draft', () =>
    Effect.gen(function* () {
      const toolSet = yield* resolveAgentToolSet({
        modules: nodeTextToolModules,
        context: { surface: 'text', route: '/agent/next', userId: 'user_1' }
      })

      const config = {
        model: 'faux',
        systemPrompt: 'Be brief.',
        tools: toolSet.tools,
        inputs: toolSet.inputs
      }

      const request = AgentRouteRequest.make({
        sessionId: 'session_input_1',
        messages: [UserMessage.make({ content: 'help me draft a note' })]
      })

      const pendLayer = Layer.mergeAll(
        ContextTransformer.identity,
        LoopConfig.defaultLayer,
        FauxProvider.layer(
          Reply.toolCall({ id: 'call_draft', name: draftComposerToolName, params: {} }),
          Reply.text('unused after pend')
        ),
        TestToolExecutor.layer({})
      )

      const pendResponse = yield* makeAgentPostResponse(request, config).pipe(
        Effect.provide(pendLayer)
      )

      const pendEvents = yield* Effect.promise(() => pendResponse.text()).pipe(
        Effect.flatMap(decodeEvents)
      )

      const awaiting = awaitingInput(pendEvents)

      expect(Predicate.isTagged(awaiting, 'AgentAwaitingInput')).toBe(true)

      if (!Predicate.isTagged(awaiting, 'AgentAwaitingInput')) {
        return expect.fail('Expected AgentAwaitingInput')
      }

      const pendingRequest = awaiting.requests[0]

      expect(
        pendingRequest !== undefined && Predicate.isTagged(pendingRequest, 'InputRequest')
      ).toBe(true)

      if (pendingRequest !== undefined && Predicate.isTagged(pendingRequest, 'InputRequest')) {
        expect(pendingRequest.input.kind).toBe('draft-composer')
      }

      // The executor must never run for input tools; failure would surface as a tool result.
      expect(
        pendEvents.filter(event => Predicate.isTagged(event, 'ToolExecutionCompleted'))
      ).toEqual([])

      const resumeLayer = Layer.mergeAll(
        ContextTransformer.identity,
        LoopConfig.defaultLayer,
        FauxProvider.layer(Reply.text('Draft noted.')),
        TestToolExecutor.layer({})
      )

      const resumeResponse = yield* makeAgentPostResponse(
        AgentRouteRequest.make({
          sessionId: 'session_input_1',
          messages: [...request.messages, ...awaiting.messages],
          hitlResponses: [
            InputResponse.make({
              requestId: `input:${draftComposerToolName}:call_draft`,
              toolCallId: 'call_draft',
              outcome: 'submitted',
              source: 'user',
              data: { to: 'a@example.com', subject: 'Hello', body: 'Draft body.' }
            })
          ]
        }),
        config
      ).pipe(Effect.provide(resumeLayer))

      const resumeEvents = yield* Effect.promise(() => resumeResponse.text()).pipe(
        Effect.flatMap(decodeEvents)
      )

      expect(resumeEvents.at(-1)?._tag).toBe('AgentEnd')
      expect(resumeEvents.map(event => event._tag)).toContain('InputSubmitted')

      const end = resumeEvents.at(-1)

      expect(Predicate.isTagged(end, 'AgentEnd')).toBe(true)

      if (!Predicate.isTagged(end, 'AgentEnd')) {
        return expect.fail('Expected AgentEnd')
      }

      const toolResults = end.messages.filter(message => Predicate.isTagged(message, 'ToolResult'))

      expect(toolResults.map(message => message.toolCallId)).toContain('call_draft')
      expect(
        toolResults.find(message => message.toolCallId === 'call_draft')?.structuredContent
      ).toMatchObject({ type: 'input_response', name: draftComposerToolName })
    })
  )

  it.effect('re-pends the same draft request after an invalid submission', () =>
    Effect.gen(function* () {
      const toolSet = yield* resolveAgentToolSet({
        modules: nodeTextToolModules,
        context: { surface: 'text', route: '/agent/next', userId: 'user_1' }
      })

      const config = {
        model: 'faux',
        systemPrompt: 'Be brief.',
        tools: toolSet.tools,
        inputs: toolSet.inputs
      }

      const layer = Layer.mergeAll(
        ContextTransformer.identity,
        LoopConfig.defaultLayer,
        FauxProvider.layer(Reply.text('unused while resuming')),
        TestToolExecutor.layer({})
      )

      const request = AgentRouteRequest.make({
        sessionId: 'session_input_2',
        messages: [UserMessage.make({ content: 'help me draft a note' })]
      })

      // Seed the transcript the way the pend run left it: assistant tool call first.
      const pendLayer = Layer.mergeAll(
        ContextTransformer.identity,
        LoopConfig.defaultLayer,
        FauxProvider.layer(
          Reply.toolCall({ id: 'call_draft', name: draftComposerToolName, params: {} }),
          Reply.text('unused after pend')
        ),
        TestToolExecutor.layer({})
      )

      const pendResponse = yield* makeAgentPostResponse(request, config).pipe(
        Effect.provide(pendLayer)
      )

      const pendEvents = yield* Effect.promise(() => pendResponse.text()).pipe(
        Effect.flatMap(decodeEvents)
      )

      const firstAwaiting = awaitingInput(pendEvents)

      if (!Predicate.isTagged(firstAwaiting, 'AgentAwaitingInput')) {
        return expect.fail('Expected initial AgentAwaitingInput')
      }

      const invalidResume = yield* makeAgentPostResponse(
        AgentRouteRequest.make({
          sessionId: 'session_input_2',
          messages: [...request.messages, ...firstAwaiting.messages],
          hitlResponses: [
            InputResponse.make({
              requestId: `input:${draftComposerToolName}:call_draft`,
              toolCallId: 'call_draft',
              outcome: 'submitted',
              source: 'user',
              data: { to: '', subject: 'Hello', body: 'Draft body.' }
            })
          ]
        }),
        config
      ).pipe(Effect.provide(layer))

      const invalidEvents = yield* Effect.promise(() => invalidResume.text()).pipe(
        Effect.flatMap(decodeEvents)
      )

      const reAwaiting = awaitingInput(invalidEvents)

      expect(Predicate.isTagged(reAwaiting, 'AgentAwaitingInput')).toBe(true)

      if (
        Predicate.isTagged(reAwaiting, 'AgentAwaitingInput') &&
        Predicate.isTagged(firstAwaiting, 'AgentAwaitingInput')
      ) {
        const firstRequest = firstAwaiting.requests[0]
        const retriedRequest = reAwaiting.requests[0]

        expect(retriedRequest).toMatchObject({
          requestId:
            firstRequest !== undefined && Predicate.isTagged(firstRequest, 'InputRequest')
              ? firstRequest.requestId
              : undefined
        })
      }
    })
  )
})
