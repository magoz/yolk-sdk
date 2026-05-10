import { Effect, Layer } from 'effect'
import * as Schema from 'effect/Schema'
import { describe, expect, it } from '@effect/vitest'
import { AgentEvent } from '@yolk/protocol'
import {
  ContextTransformer,
  FauxProvider,
  LoopConfig,
  Reply,
  TestToolExecutor
} from '@yolk/agent-loop'
import { makeVolatileSessionStoreLayer, type VolatileSessionStorage } from './volatile-session-store-layer'
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

const makeLayer = (storage: VolatileSessionStorage) =>
  Layer.mergeAll(
    ContextTransformer.identity,
    LoopConfig.defaultLayer,
    FauxProvider.layer(Reply.text('ok')),
    TestToolExecutor.layer({}),
    makeVolatileSessionStoreLayer(storage)
  )

describe('makeAgentPostResponse', () => {
  it.effect('returns ndjson agent events and saves the session transcript', () =>
    Effect.gen(function* () {
      const storage: VolatileSessionStorage = new Map()
      const response = yield* makeAgentPostResponse(
        AgentRouteRequest.make({ sessionId: 'session_1', content: 'hello' }),
        config
      ).pipe(Effect.provide(makeLayer(storage)))
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
      expect(storage.get('session_1')?.messages.map(message => message.content)).toEqual([
        'hello',
        'ok'
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
