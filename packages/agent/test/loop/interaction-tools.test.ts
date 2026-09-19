import { Effect, Layer, Predicate, Stream } from 'effect'
import * as Schema from 'effect/Schema'
import { describe, expect, it } from '@effect/vitest'
import {
  InteractionRequest,
  InteractionResponse,
  ToolCall,
  ToolResult,
  UserMessage,
  interactionRequestId
} from '@yolk-sdk/agent/protocol'
import {
  ContextTransformer,
  LoopConfig,
  ToolError,
  ToolExecutor,
  prepareToolBatch,
  run,
  runToolBatch
} from '../../src/loop/index.ts'
import { runRuntime, makeInMemorySessionEventStoreLayer } from '@yolk-sdk/agent/runtime'
import { RuntimeRequest } from '../../src/runtime/run-runtime.ts'
import { FauxProvider, Reply } from '../../src/loop/testing/index.ts'
import {
  makeInteractionTool,
  makeTool,
  makeToolExecutorLayer,
  resolveTools,
  type ResolvedToolSet,
  type ToolModule
} from '../../src/tools/index.ts'

import { makeFakeInteractionHost as makeFakeHost } from '../tools/interaction-host.ts'

const DocumentDraft = Schema.Struct({
  title: Schema.String,
  body: Schema.String
})

type TestContext = {
  readonly tenant: string
}

const context: TestContext = { tenant: 'acme' }

type ExecutedAction = {
  readonly actionId: string
  readonly data: unknown
}

const editedData = { title: 'Edited title', body: 'Edited body' }

const documentModule = (executed: Array<ExecutedAction>): ToolModule<TestContext> => ({
  id: 'document',
  tools: [
    makeInteractionTool({
      name: 'document',
      description: 'Let the user review and file a document.',
      access: 'write',
      response: DocumentDraft,
      renderer: 'document-editor',
      actions: {
        publish: {
          label: 'Publish',
          execute: ({ data }) =>
            Schema.decodeUnknownEffect(DocumentDraft)(data).pipe(
              Effect.map(decoded => {
                executed.push({ actionId: 'publish', data })

                return { outcome: 'completed' as const, content: `Published ${decoded.title}.` }
              }),
              Effect.mapError(
                error =>
                  new ToolError({
                    tool: 'document',
                    cause: 'validation',
                    message: `Invalid document: ${error.message}`
                  })
              )
            )
        },
        archive: {
          label: 'Archive',
          execute: ({ data }) =>
            Effect.succeed({ outcome: 'completed' as const, content: 'Archived.' }).pipe(
              Effect.tap(() => Effect.sync(() => executed.push({ actionId: 'archive', data })))
            )
        }
      }
    }),
    makeTool({
      name: 'lookup',
      description: 'Look something up.',
      parameters: Schema.Struct({ query: Schema.String }),
      access: 'read',
      execute: ({ call }) =>
        Effect.succeed(ToolResult.make({ toolCallId: call.id, content: 'hit' }))
    })
  ]
})

const BaseLayer = Layer.mergeAll(ContextTransformer.identity, LoopConfig.defaultLayer)

const call = ToolCall.make({ id: 'call_doc', name: 'document', params: {} })

const submittedResponse = (actionId: string, data: Schema.Json) =>
  InteractionResponse.make({
    requestId: interactionRequestId(call),
    toolCallId: call.id,
    outcome: 'submitted',
    source: 'user',
    actionId,
    data
  })

const cancelledResponse = InteractionResponse.make({
  requestId: interactionRequestId(call),
  toolCallId: call.id,
  outcome: 'cancelled',
  source: 'user',
  reason: 'changed mind'
})

const recordingExecutorLayer = (calls: Array<ToolCall>) =>
  Layer.succeed(
    ToolExecutor,
    ToolExecutor.of({
      execute: current => {
        calls.push(current)

        return Effect.fail(
          new ToolError({ tool: current.name, cause: 'execution', message: 'must not run' })
        )
      }
    })
  )

const accept = (
  fake: ReturnType<typeof makeFakeHost>,
  toolSet: ResolvedToolSet,
  response: InteractionResponse,
  currentCall = call
) => {
  const interaction = toolSet.interactions[currentCall.name]

  if (interaction === undefined || interaction.def.interaction === undefined)
    throw new Error('Missing interaction')
  fake.addPending(
    InteractionRequest.make({
      requestId: interactionRequestId(currentCall),
      toolCallId: currentCall.id,
      call: currentCall,
      interaction: interaction.def.interaction
    })
  )

  return fake.accept(response, interaction)
}

describe('action-backed interaction tools in the loop', () => {
  it.effect('raw user responses without host acceptance cannot authorize dispatch', () =>
    Effect.gen(function* () {
      const executed: Array<ExecutedAction> = []
      const fake = makeFakeHost()

      const toolSet = yield* resolveTools([documentModule(executed)], context, {
        interactionHost: fake.host
      })

      const prepared = yield* prepareToolBatch({
        tools: toolSet.tools,
        interactions: toolSet.interactions,
        calls: [call],
        responses: [submittedResponse('publish', editedData)]
      })

      expect(prepared.callsToExecute).toEqual([])
      expect(prepared.pendingRequests).toHaveLength(1)
      expect(prepared.events.map(event => event._tag)).not.toContain('InteractionSubmitted')
      expect(fake.counts().claims).toBe(0)
      expect(executed).toEqual([])
    })
  )

  it.effect('cannot observe acceptance when the loop omits the resolved host', () =>
    Effect.gen(function* () {
      const executed: Array<ExecutedAction> = []
      const fake = makeFakeHost()

      const toolSet = yield* resolveTools([documentModule(executed)], context, {
        interactionHost: fake.host
      })

      const response = submittedResponse('publish', editedData)
      yield* accept(fake, toolSet, response)

      const events = yield* runToolBatch({
        calls: [call],
        tools: toolSet.tools,
        interactions: toolSet.interactions,
        hitlResponses: [response]
      }).pipe(
        Stream.runCollect,
        Effect.provide(Layer.mergeAll(LoopConfig.defaultLayer, makeToolExecutorLayer(toolSet)))
      )

      expect(Array.from(events).map(event => event._tag)).toContain('AgentAwaitingInput')
      expect(Array.from(events).map(event => event._tag)).not.toContain('ToolExecutionStarted')
      expect(fake.counts().claims).toBe(0)
      expect(executed).toEqual([])
    })
  )

  it.effect('pends without responses and dispatches nothing in preflight', () =>
    Effect.gen(function* () {
      const executed: Array<ExecutedAction> = []

      const toolSet = yield* resolveTools([documentModule(executed)], context, {
        interactionHost: makeFakeHost().host
      })

      const prepared = yield* prepareToolBatch({
        tools: toolSet.tools,
        interactions: toolSet.interactions,
        calls: [call],
        responses: []
      })

      expect(prepared.pendingRequests).toHaveLength(1)

      expect(prepared.pendingRequests[0]).toMatchObject({
        _tag: 'InteractionRequest',
        requestId: 'interaction:document:call_doc',
        toolCallId: 'call_doc'
      })

      expect(prepared.callsToExecute).toEqual([])

      expect(prepared.interactionBindings.size).toBe(0)

      expect(prepared.pendingEvents.map(event => event._tag)).toContain('InteractionRequested')
    })
  )

  it.effect('re-pends invalid submissions without accepting or executing', () =>
    Effect.gen(function* () {
      const executed: Array<ExecutedAction> = []
      const fake = makeFakeHost()

      const toolSet = yield* resolveTools([documentModule(executed)], context, {
        interactionHost: fake.host
      })

      const calls: Array<ToolCall> = []

      const prepared = yield* prepareToolBatch({
        tools: toolSet.tools,
        interactions: toolSet.interactions,
        calls: [call],
        responses: [
          submittedResponse('publish', { title: 'Edited title' }),
          submittedResponse('delete', editedData)
        ]
      }).pipe(
        Effect.provide(Layer.mergeAll(LoopConfig.defaultLayer, recordingExecutorLayer(calls)))
      )

      expect(prepared.pendingRequests).toHaveLength(1)

      expect(prepared.callsToExecute).toEqual([])

      expect(calls).toEqual([])

      expect(executed).toEqual([])

      expect(fake.counts().claims).toBe(0)
    })
  )

  it.effect('fences all execution while any sibling request stays pending', () =>
    Effect.gen(function* () {
      const executed: Array<ExecutedAction> = []
      const fake = makeFakeHost()

      const toolSet = yield* resolveTools([documentModule(executed)], context, {
        interactionHost: fake.host
      })

      const sibling = ToolCall.make({ id: 'call_lookup', name: 'lookup', params: { query: 'x' } })

      const events = yield* runToolBatch({
        interactionHost: fake.host,
        calls: [call, sibling],
        tools: toolSet.tools,
        interactions: toolSet.interactions,
        hitlResponses: []
      }).pipe(
        Stream.runCollect,
        Effect.provide(Layer.mergeAll(LoopConfig.defaultLayer, makeToolExecutorLayer(toolSet)))
      )

      const collected = Array.from(events)

      expect(
        collected.filter(event => Predicate.isTagged(event, 'AgentAwaitingInput'))
      ).toHaveLength(1)

      expect(collected.filter(event => Predicate.isTagged(event, 'ToolExecutionStarted'))).toEqual(
        []
      )

      expect(executed).toEqual([])

      expect(fake.counts().claims).toBe(0)
    })
  )

  it.effect('fails closed without interaction preflight', () =>
    Effect.gen(function* () {
      const executed: Array<ExecutedAction> = []
      const toolSet = yield* resolveTools([documentModule(executed)], context)

      const prepared = yield* prepareToolBatch({
        tools: toolSet.tools,
        calls: [call],
        responses: [submittedResponse('publish', editedData)]
      })

      expect(prepared.pendingRequests).toEqual([])

      expect(prepared.callsToExecute).toEqual([])

      expect(prepared.resultMessages[0]?.message).toMatchObject({ isError: true })
    })
  )

  it.effect('replays host-accepted cancellation without claims or business handlers', () =>
    Effect.gen(function* () {
      const executed: Array<ExecutedAction> = []
      const fake = makeFakeHost()

      const toolSet = yield* resolveTools([documentModule(executed)], context, {
        interactionHost: fake.host
      })

      yield* accept(fake, toolSet, cancelledResponse)

      const events = yield* runToolBatch({
        interactionHost: fake.host,
        calls: [call],
        tools: toolSet.tools,
        interactions: toolSet.interactions,
        hitlResponses: [cancelledResponse]
      }).pipe(
        Stream.runCollect,
        Effect.provide(Layer.mergeAll(LoopConfig.defaultLayer, makeToolExecutorLayer(toolSet)))
      )

      const tags = Array.from(events).map(event => event._tag)

      expect(tags).toContain('InteractionCancelled')

      expect(tags).not.toContain('ToolExecutionStarted')

      expect(executed).toEqual([])

      expect(fake.counts().claims).toBe(0)
    })
  )

  it.effect('executes the selected action with edited data and no extra approval', () =>
    Effect.gen(function* () {
      const executed: Array<ExecutedAction> = []
      const fake = makeFakeHost()

      const toolSet = yield* resolveTools([documentModule(executed)], context, {
        interactionHost: fake.host
      })

      yield* accept(fake, toolSet, submittedResponse('publish', editedData))

      const events = yield* runToolBatch({
        interactionHost: fake.host,
        calls: [call],
        tools: toolSet.tools,
        interactions: toolSet.interactions,
        hitlResponses: [
          submittedResponse('archive', { title: 'oops' }),
          submittedResponse('publish', editedData)
        ]
      }).pipe(
        Stream.runCollect,
        Effect.provide(Layer.mergeAll(LoopConfig.defaultLayer, makeToolExecutorLayer(toolSet)))
      )

      const collected = Array.from(events)

      const tags = collected.map(event => event._tag)

      // The invalid first attempt allows correction; the valid one is admitted.
      expect(tags).toContain('InteractionSubmitted')

      expect(tags).toContain('ToolExecutionStarted')

      expect(tags).toContain('ToolExecutionCompleted')

      expect(tags).not.toContain('ToolApprovalRequested')

      expect(tags).not.toContain('AgentAwaitingInput')

      const completed = collected.find(event => Predicate.isTagged(event, 'ToolExecutionCompleted'))

      if (!Predicate.isTagged(completed, 'ToolExecutionCompleted')) {
        throw new Error('Expected ToolExecutionCompleted')
      }

      expect(completed.result.isError).toBeUndefined()

      expect(completed.result.content).toContain('Published Edited title.')

      expect(completed.result.structuredContent).toMatchObject({
        type: 'interaction_outcome',
        outcome: 'completed',
        actionId: 'publish',
        slot: 'interaction:document:call_doc'
      })

      expect(executed).toEqual([{ actionId: 'publish', data: editedData }])

      expect(fake.counts().claims).toBe(1)
    })
  )

  it.effect('fails closed when a wrapper drops the interaction reference', () =>
    Effect.gen(function* () {
      const executed: Array<ExecutedAction> = []
      const fake = makeFakeHost()

      const toolSet = yield* resolveTools([documentModule(executed)], context, {
        interactionHost: fake.host
      })

      const inner = yield* ToolExecutor.pipe(Effect.provide(makeToolExecutorLayer(toolSet)))

      yield* accept(fake, toolSet, submittedResponse('publish', editedData))

      const events = yield* runToolBatch({
        interactionHost: fake.host,
        calls: [call],
        tools: toolSet.tools,
        interactions: toolSet.interactions,
        hitlResponses: [submittedResponse('publish', editedData)]
      }).pipe(
        Stream.runCollect,
        Effect.provide(
          Layer.mergeAll(
            LoopConfig.defaultLayer,
            Layer.succeed(
              ToolExecutor,
              // A decorator that forgets to forward the reference must not execute.
              ToolExecutor.of({ execute: innerCall => inner.execute(innerCall) })
            )
          )
        )
      )

      const collected = Array.from(events)

      const errored = collected.find(event => Predicate.isTagged(event, 'ToolExecutionError'))

      if (!Predicate.isTagged(errored, 'ToolExecutionError')) {
        throw new Error('Expected ToolExecutionError')
      }

      expect(errored.code).toBe('tool_error')

      expect(executed).toEqual([])

      expect(fake.counts().claims).toBe(0)
    })
  )

  it.effect('preserves unknown outcomes without retrying', () =>
    Effect.gen(function* () {
      const unknownModule: ToolModule<TestContext> = {
        id: 'uncertain',
        tools: [
          makeInteractionTool({
            name: 'uncertain',
            description: 'Uncertain.',
            access: 'write',
            response: DocumentDraft,
            actions: {
              fire: {
                label: 'Fire',
                execute: () =>
                  Effect.succeed({
                    outcome: 'unknown' as const,
                    content: 'Fire request timed out.'
                  })
              }
            }
          })
        ]
      }

      const fake = makeFakeHost()

      const toolSet = yield* resolveTools([unknownModule], context, {
        interactionHost: fake.host
      })

      const uncertainCall = ToolCall.make({ id: 'call_uncertain', name: 'uncertain', params: {} })

      yield* accept(
        fake,
        toolSet,
        InteractionResponse.make({
          requestId: interactionRequestId(uncertainCall),
          toolCallId: uncertainCall.id,
          outcome: 'submitted',
          source: 'user',
          actionId: 'fire',
          data: editedData
        }),
        uncertainCall
      )

      const events = yield* runToolBatch({
        interactionHost: fake.host,
        calls: [uncertainCall],
        tools: toolSet.tools,
        interactions: toolSet.interactions,
        hitlResponses: [
          InteractionResponse.make({
            requestId: interactionRequestId(uncertainCall),
            toolCallId: uncertainCall.id,
            outcome: 'submitted',
            source: 'user',
            actionId: 'fire',
            data: editedData
          })
        ]
      }).pipe(
        Stream.runCollect,
        Effect.provide(Layer.mergeAll(LoopConfig.defaultLayer, makeToolExecutorLayer(toolSet)))
      )

      const collected = Array.from(events)

      const completed = collected.find(event => Predicate.isTagged(event, 'ToolExecutionCompleted'))

      if (!Predicate.isTagged(completed, 'ToolExecutionCompleted')) {
        throw new Error('Expected ToolExecutionCompleted')
      }

      expect(completed.result.isError).toBe(true)

      expect(completed.result.content).toContain('may have taken effect')

      expect(completed.result.content).toContain('Do not retry it automatically')

      expect(completed.result.structuredContent).toMatchObject({ outcome: 'unknown' })

      expect(
        collected.filter(event => Predicate.isTagged(event, 'ToolExecutionStarted'))
      ).toHaveLength(1)
    })
  )

  it.effect('pauses and resumes through run with one selected execution', () =>
    Effect.gen(function* () {
      const executed: Array<ExecutedAction> = []
      const fake = makeFakeHost()

      const toolSet = yield* resolveTools([documentModule(executed)], context, {
        interactionHost: fake.host
      })

      const pausedChunk = yield* run({
        interactionHost: fake.host,
        messages: [UserMessage.make({ content: 'file this document' })],
        systemPrompt: 'File documents.',
        tools: toolSet.tools,
        interactions: toolSet.interactions,
        model: 'faux'
      }).pipe(
        Stream.runCollect,
        Effect.provide(
          Layer.mergeAll(
            FauxProvider.layer(Reply.toolCall(call)),
            makeToolExecutorLayer(toolSet)
          ).pipe(Layer.provideMerge(BaseLayer))
        )
      )

      const paused = Array.from(pausedChunk)

      expect(paused.map(event => event._tag)).toContain('InteractionRequested')

      expect(paused.map(event => event._tag)).toContain('AgentAwaitingInput')

      expect(executed).toEqual([])

      yield* accept(fake, toolSet, submittedResponse('publish', editedData))

      const resumedChunk = yield* run({
        interactionHost: fake.host,
        messages: [UserMessage.make({ content: 'file this document' })],
        systemPrompt: 'File documents.',
        tools: toolSet.tools,
        interactions: toolSet.interactions,
        hitlResponses: [submittedResponse('publish', editedData)],
        model: 'faux'
      }).pipe(
        Stream.runCollect,
        Effect.provide(
          Layer.mergeAll(
            FauxProvider.layerWithRequests({
              responses: [Reply.toolCall(call), Reply.text('Filed.')],
              requests: []
            }),
            makeToolExecutorLayer(toolSet)
          ).pipe(Layer.provideMerge(BaseLayer))
        )
      )

      const resumed = Array.from(resumedChunk)

      const tags = resumed.map(event => event._tag)

      expect(tags).toContain('InteractionSubmitted')

      expect(tags).toContain('ToolExecutionCompleted')

      expect(tags).not.toContain('AgentAwaitingInput')

      expect(executed).toEqual([{ actionId: 'publish', data: editedData }])
    })
  )
  it.effect('runtime append/resume ignores raw responses and loads authoritative acceptance', () =>
    Effect.gen(function* () {
      const executed: Array<ExecutedAction> = []
      const fake = makeFakeHost()

      const toolSet = yield* resolveTools([documentModule(executed)], context, {
        interactionHost: fake.host
      })

      const config = {
        systemPrompt: 'File documents',
        model: 'faux',
        tools: toolSet.tools,
        interactions: toolSet.interactions,
        interactionHost: fake.host
      }

      yield* Effect.gen(function* () {
        const pending = yield* runRuntime(
          RuntimeRequest.AppendInput({
            sessionId: 'session',
            runId: 'run-1',
            input: UserMessage.make({ content: 'File this document' })
          }),
          config
        ).pipe(Stream.runCollect, Effect.provide(FauxProvider.layer(Reply.toolCall(call))))

        expect(Array.from(pending).map(event => event._tag)).toContain('AgentAwaitingInput')

        const raw = yield* runRuntime(
          RuntimeRequest.AppendHitlResponse({
            sessionId: 'session',
            runId: 'run-2',
            response: submittedResponse('publish', editedData)
          }),
          config
        ).pipe(
          Stream.runCollect,
          Effect.provide(FauxProvider.layer(Reply.text('must not reach model')))
        )

        expect(Array.from(raw).map(event => event._tag)).toContain('AgentAwaitingInput')
        expect(Array.from(raw).map(event => event._tag)).not.toContain('InteractionSubmitted')
        expect(executed).toEqual([])
        yield* accept(fake, toolSet, submittedResponse('publish', editedData))

        const resumed = yield* runRuntime(
          RuntimeRequest.AppendHitlResponse({
            sessionId: 'session',
            runId: 'run-3',
            response: cancelledResponse
          }),
          config
        ).pipe(Stream.runCollect, Effect.provide(FauxProvider.layer(Reply.text('Filed'))))

        const tags = Array.from(resumed).map(event => event._tag)
        expect(tags).toContain('InteractionSubmitted')
        expect(tags).not.toContain('InteractionCancelled')
        expect(tags).toContain('ToolExecutionCompleted')
        expect(executed).toEqual([{ actionId: 'publish', data: editedData }])
      }).pipe(
        Effect.provide(
          Layer.mergeAll(
            BaseLayer,
            makeToolExecutorLayer(toolSet),
            makeInMemorySessionEventStoreLayer()
          )
        )
      )
    })
  )
})
