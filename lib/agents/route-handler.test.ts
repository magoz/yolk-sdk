import { Effect, Layer, Option, Stream } from 'effect'
import * as Schema from 'effect/Schema'
import { describe, expect, it } from '@effect/vitest'
import { AgentEvent } from '@yolk/protocol'
import {
  ContextTransformer,
  FauxProvider,
  LLMError,
  LLMProvider,
  LLMTextDelta,
  LoopConfig,
  Reply,
  TestToolExecutor
} from '@yolk/agent-loop'
import type { LLMRequest } from '@yolk/agent-loop'
import { StatelessSessionStoreLayer } from './stateless-session-store-layer'
import { AgentRouteRequest, makeAgentPostResponse } from './route-handler'

const config = {
  model: 'faux',
  systemPrompt: 'Be brief.'
}

const parseJson = (line: string): unknown => JSON.parse(line)
const decodeEvent = (value: unknown) => Schema.decodeUnknownEffect(AgentEvent)(value)

const decodeEvents = (body: string) =>
  Effect.forEach(
    body
      .trim()
      .split('\n')
      .filter(line => line.length > 0)
      .map(parseJson),
    decodeEvent
  )

const makeLayer = () =>
  Layer.mergeAll(
    ContextTransformer.identity,
    LoopConfig.defaultLayer,
    FauxProvider.layer(Reply.text('ok')),
    TestToolExecutor.layer({}),
    StatelessSessionStoreLayer
  )

const makeNeverCompletingLayer = () =>
  Layer.mergeAll(
    ContextTransformer.identity,
    LoopConfig.defaultLayer,
    Layer.succeed(
      LLMProvider,
      LLMProvider.of({
        stream: () => Stream.never
      })
    ),
    TestToolExecutor.layer({}),
    StatelessSessionStoreLayer
  )

const makeFailingLayer = () =>
  Layer.mergeAll(
    ContextTransformer.identity,
    LoopConfig.defaultLayer,
    Layer.succeed(
      LLMProvider,
      LLMProvider.of({
        stream: () =>
          Stream.make(LLMTextDelta.make({ text: 'partial' })).pipe(
            Stream.concat(
              Stream.fail(
                new LLMError({
                  cause: 'provider_error',
                  message: 'Provider failed',
                  retryable: true
                })
              )
            )
          )
      })
    ),
    TestToolExecutor.layer({}),
    StatelessSessionStoreLayer
  )

describe('makeAgentPostResponse', () => {
  it.effect('returns ndjson agent events for a text-only turn', () =>
    Effect.gen(function* () {
      const response = yield* makeAgentPostResponse(
        AgentRouteRequest.make({ sessionId: 'session_1', content: 'hello' }),
        config
      ).pipe(Effect.provide(makeLayer()))
      const body = yield* Effect.promise(() => response.text())
      const events = yield* decodeEvents(body)

      expect(response.status).toBe(200)
      expect(response.headers.get('content-type')).toBe('application/x-ndjson; charset=utf-8')
      expect(events.map(event => event._tag)).toEqual([
        'AgentStart',
        'TurnStart',
        'LLMStreamStart',
        'LLMTextDelta',
        'LLMTextDelta',
        'LLMStreamEnd',
        'AssistantMessage',
        'TurnEnd',
        'AgentEnd'
      ])
    }))

  it.effect('returns a readable response before the agent stream completes', () =>
    Effect.gen(function* () {
      const responseOption = yield* makeAgentPostResponse(
        AgentRouteRequest.make({ sessionId: 'session_1', content: 'hello' }),
        config
      ).pipe(Effect.provide(makeNeverCompletingLayer()), Effect.timeoutOption('1 second'))

      if (Option.isNone(responseOption)) {
        expect.fail('Expected response before agent stream completion')
      }

      const body = responseOption.value.body

      if (body === null) {
        expect.fail('Expected response body')
      }

      const reader = body.getReader()
      const read = yield* Effect.promise(() => reader.read())
      yield* Effect.promise(() => reader.cancel())
      reader.releaseLock()

      if (read.done) {
        expect.fail('Expected first streamed chunk')
      }

      const text = new TextDecoder().decode(read.value)
      const firstLine = text.split('\n')[0] ?? ''
      const event = yield* decodeEvent(parseJson(firstLine))

      expect(event._tag).toBe('AgentStart')
    }))

  it.effect('encodes stream failures as in-band agent errors', () =>
    Effect.gen(function* () {
      const response = yield* makeAgentPostResponse(
        AgentRouteRequest.make({ sessionId: 'session_1', content: 'hello' }),
        config
      ).pipe(Effect.provide(makeFailingLayer()))
      const body = yield* Effect.promise(() => response.text())
      const events = yield* decodeEvents(body)

      expect(events.map(event => event._tag)).toEqual([
        'AgentStart',
        'TurnStart',
        'LLMStreamStart',
        'LLMTextDelta',
        'AgentError'
      ])
      expect(events[4]).toMatchObject({
        code: 'provider_error',
        message: 'Provider failed',
        retryable: true
      })
    }))

  it.effect('does not carry transcript across turns', () =>
    Effect.gen(function* () {
      const requests: Array<LLMRequest> = []
      const layer = Layer.mergeAll(
        ContextTransformer.identity,
        LoopConfig.defaultLayer,
        FauxProvider.layerWithRequests({
          responses: [Reply.text('ok'), Reply.text('next')],
          requests
        }),
        TestToolExecutor.layer({}),
        StatelessSessionStoreLayer
      )

      const firstResponse = yield* makeAgentPostResponse(
        AgentRouteRequest.make({ sessionId: 'session_1', content: 'hello' }),
        config
      ).pipe(Effect.provide(layer))
      yield* Effect.promise(() => firstResponse.text())

      const secondResponse = yield* makeAgentPostResponse(
        AgentRouteRequest.make({ sessionId: 'session_1', content: 'again' }),
        config
      ).pipe(Effect.provide(layer))
      yield* Effect.promise(() => secondResponse.text())

      expect(requests.map(request => request.messages.map(message => message.content))).toEqual([
        ['hello'],
        ['again']
      ])
    }))

  it.effect('rejects blank content at request boundary', () =>
    Effect.gen(function* () {
      const result = yield* Schema.decodeUnknownEffect(AgentRouteRequest)({
        sessionId: 'session_1',
        content: ' '
      }).pipe(Effect.result)

      expect(result).toMatchObject({
        _tag: 'Failure',
        failure: { _tag: 'SchemaError' }
      })
    }))
})
