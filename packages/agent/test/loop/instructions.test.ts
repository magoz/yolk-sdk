import { Effect, Layer, Predicate, Stream } from 'effect'
import type * as Schema from 'effect/Schema'
import { describe, expect, it } from '@effect/vitest'
import {
  isInstructionMessage,
  latestInstructionState,
  ToolResult,
  UserMessage,
  type AgentEvent,
  type AgentMessage
} from '@yolk-sdk/agent/protocol'
import {
  ContextTransformer,
  instructionMessages,
  LoopConfig,
  run,
  runModelTurn,
  ToolExecutor,
  type LLMRequest,
  type RunInstruction
} from '../../src/loop'
import { compactWindowMessages } from '../../src/compaction'
import { FauxProvider, Reply } from '../../src/loop/testing'
import { appendProtocolMessage, buildAgentChatMessages, toAgentMessages } from '../../src/react'

const BaseLayer = Layer.mergeAll(ContextTransformer.identity, LoopConfig.defaultLayer)

const echoExecutor = Layer.succeed(
  ToolExecutor,
  ToolExecutor.of({
    execute: call => Effect.succeed(ToolResult.make({ toolCallId: call.id, content: 'done' }))
  })
)

/** An instruction that renders its state, or a delta when there was a previous one. */
const catalog = (state: Schema.Json | undefined): RunInstruction => ({
  key: 'catalog',
  state,
  render: ({ previous, current }) =>
    current === undefined
      ? 'catalog removed'
      : previous === undefined
        ? `catalog: ${JSON.stringify(current)}`
        : `catalog changed: ${JSON.stringify(current)}`
})

const user = UserMessage.make({ content: 'hello' })

const contentOf = (messages: ReadonlyArray<AgentMessage>) =>
  messages.map(message => (Predicate.isTagged(message, 'User') ? message.content : message._tag))

describe('instruction messages', () => {
  it('renders an instruction once, then only when its state changes', () => {
    const first = instructionMessages([user], [catalog({ tools: 2 })])

    expect(contentOf(first)).toEqual(['catalog: {"tools":2}'])
    expect(first.every(isInstructionMessage)).toBe(true)

    // The same state appends nothing.
    expect(instructionMessages([user, ...first], [catalog({ tools: 2 })])).toEqual([])

    const changed = instructionMessages([user, ...first], [catalog({ tools: 3 })])

    expect(contentOf(changed)).toEqual(['catalog changed: {"tools":3}'])
    expect(latestInstructionState([user, ...first, ...changed], 'catalog')).toEqual({ tools: 3 })
  })

  it('records a removal once, and renders the next state as a first render', () => {
    const first = instructionMessages([user], [catalog({ tools: 1 })])
    const removed = instructionMessages([user, ...first], [catalog(undefined)])

    expect(contentOf(removed)).toEqual(['catalog removed'])
    expect(instructionMessages([user, ...first, ...removed], [catalog(undefined)])).toEqual([])
    expect(instructionMessages([user], [catalog(undefined)])).toEqual([])
    expect(
      contentOf(instructionMessages([user, ...first, ...removed], [catalog({ tools: 1 })]))
    ).toEqual(['catalog: {"tools":1}'])
  })

  it('treats a null state as a state, never as a removal', () => {
    const first = instructionMessages([user], [catalog(null)])

    expect(contentOf(first)).toEqual(['catalog: null'])
    expect(instructionMessages([user, ...first], [catalog(null)])).toEqual([])
  })

  it('compares states independently of object key order', () => {
    const first = instructionMessages([user], [catalog({ a: 1, b: { c: 2, d: 3 } })])

    expect(instructionMessages([user, ...first], [catalog({ b: { d: 3, c: 2 }, a: 1 })])).toEqual(
      []
    )
  })
})

const requestMessages = (request: LLMRequest | undefined) => contentOf(request?.messages ?? [])

describe('instructions in the loop', () => {
  it.effect('appends a changed instruction before the request, as a created message', () =>
    Effect.gen(function* () {
      const requests: Array<LLMRequest> = []

      const events = yield* run({
        messages: [user],
        systemPrompt: 'Be brief.',
        tools: [],
        instructions: [catalog({ tools: 2 })],
        model: 'faux'
      }).pipe(
        Stream.runCollect,
        Effect.provide(
          Layer.mergeAll(
            FauxProvider.layerWithRequests({ responses: [Reply.text('ok')], requests }),
            echoExecutor
          ).pipe(Layer.provideMerge(BaseLayer))
        )
      )

      const end = Array.from(events).find(
        (event): event is Extract<AgentEvent, { _tag: 'AgentEnd' }> =>
          Predicate.isTagged(event, 'AgentEnd')
      )

      expect(requestMessages(requests[0])).toEqual(['hello', 'catalog: {"tools":2}'])
      expect(contentOf(end?.messages ?? [])).toEqual(['catalog: {"tools":2}', 'Assistant'])
      // Never a user message event: instructions are not user input.
      expect(Array.from(events).some(event => Predicate.isTagged(event, 'UserMessage'))).toBe(false)
    })
  )

  it.effect('applies instructions to single model turns too, idempotently for durable hosts', () =>
    Effect.gen(function* () {
      const requests: Array<LLMRequest> = []
      const recorded = instructionMessages([user], [catalog({ tools: 2 })])

      yield* runModelTurn({
        messages: [user, ...recorded],
        systemPrompt: 'Be brief.',
        tools: [],
        instructions: [catalog({ tools: 2 })],
        model: 'faux',
        turn: 1
      }).pipe(
        Stream.runDrain,
        Effect.provide(
          FauxProvider.layerWithRequests({ responses: [Reply.text('ok')], requests }).pipe(
            Layer.provideMerge(BaseLayer)
          )
        )
      )

      expect(requestMessages(requests[0])).toEqual(['hello', 'catalog: {"tools":2}'])
    })
  )

  it.effect('keeps the instruction for later turns of the same run', () =>
    Effect.gen(function* () {
      const requests: Array<LLMRequest> = []

      yield* run({
        messages: [user],
        systemPrompt: 'Be brief.',
        tools: [],
        instructions: [catalog({ tools: 2 })],
        model: 'faux'
      }).pipe(
        Stream.runDrain,
        Effect.provide(
          Layer.mergeAll(
            FauxProvider.layerWithRequests({
              responses: [
                Reply.toolCall({ id: 'call_1', name: 'echo', params: {} }),
                Reply.text('ok')
              ],
              requests
            }),
            echoExecutor
          ).pipe(Layer.provideMerge(BaseLayer))
        )
      )

      expect(requests).toHaveLength(2)
      // The second request reuses the first one's prefix: one instruction message, never two.
      expect(
        requestMessages(requests[1]).filter(text => text === 'catalog: {"tools":2}')
      ).toHaveLength(1)
      expect(requestMessages(requests[1]).slice(0, 2)).toEqual(requestMessages(requests[0]))
    })
  )
})

describe('instruction messages in chat projections', () => {
  it('are never shown as user messages', () => {
    const [instruction] = instructionMessages([user], [catalog({ tools: 2 })])

    if (instruction === undefined) throw new Error('Missing instruction message')

    const items = buildAgentChatMessages({
      messages: [user, instruction],
      userDraft: '',
      assistantDraft: '',
      reasoningDraft: '',
      toolRuns: [],
      error: null
    })

    expect(items.map(item => item.role)).toEqual(['user'])
    // Hidden, never dropped: a transcript rebuilt from chat messages keeps them in place.
    expect(toAgentMessages(items)).toEqual([user, instruction])

    const appended = appendProtocolMessage(
      buildAgentChatMessages({
        messages: [user],
        userDraft: '',
        assistantDraft: '',
        reasoningDraft: '',
        toolRuns: [],
        error: null
      }),
      instruction
    )

    expect(appended.map(item => item.role)).toEqual(['user'])
    expect(toAgentMessages(appended)).toEqual([user, instruction])
  })
})

describe('instruction messages through compaction', () => {
  it('keep the latest instruction of each key verbatim after the summary', () => {
    const old = instructionMessages([user], [catalog({ tools: 1 })])
    const current = instructionMessages([user, ...old], [catalog({ tools: 2 })])

    const transcript: ReadonlyArray<AgentMessage> = [
      user,
      ...old,
      UserMessage.make({ content: 'filler '.repeat(400) }),
      ...current,
      UserMessage.make({ content: 'filler '.repeat(400) }),
      UserMessage.make({ content: 'latest' })
    ]

    const result = compactWindowMessages(transcript, {
      strategy: 'test',
      thresholdTokens: 10,
      tailMessageCount: 1,
      makeSummaryMessage: () => UserMessage.make({ content: 'summary' })
    })

    expect(contentOf(result.messages)).toEqual([
      'summary',
      'catalog changed: {"tools":2}',
      'latest'
    ])
    // The loop compares with the uncompacted transcript: nothing to re-append.
    expect(instructionMessages(transcript, [catalog({ tools: 2 })])).toEqual([])
  })
})
