import { Effect, Stream } from 'effect'
import * as Schema from 'effect/Schema'
import { UserMessage, type AgentEvent } from '@yolk/protocol'
import { runRuntime } from '@yolk/agent-runtime'

export class AgentResponseEncodingError extends Schema.TaggedErrorClass<AgentResponseEncodingError>()(
  'AgentResponseEncodingError',
  {
    message: Schema.String
  }
) {}

const NonEmptyTrimmedString = Schema.Trimmed.pipe(Schema.check(Schema.isNonEmpty()))

export class AgentRouteRequest extends Schema.Class<AgentRouteRequest>('AgentRouteRequest')({
  sessionId: NonEmptyTrimmedString,
  content: NonEmptyTrimmedString
}) {}

export type AgentRouteConfig = {
  readonly model: string
  readonly systemPrompt: string
}

const ndjsonHeaders = {
  'cache-control': 'no-cache, no-transform',
  'content-type': 'application/x-ndjson; charset=utf-8',
  'x-content-type-options': 'nosniff'
}

const encodeNdjson = (events: ReadonlyArray<AgentEvent>) =>
  Effect.try({
    try: () => events.map(event => `${JSON.stringify(event)}\n`).join(''),
    catch: error =>
      new AgentResponseEncodingError({
        message: error instanceof Error ? error.message : String(error)
      })
  })

export const makeAgentPostResponse = (input: AgentRouteRequest, config: AgentRouteConfig) =>
  Effect.gen(function* () {
    const eventsChunk = yield* runRuntime<void>({
      sessionId: input.sessionId,
      input: UserMessage.make({ content: input.content }),
      context: undefined,
      systemPrompt: config.systemPrompt,
      tools: [],
      model: config.model
    }).pipe(Stream.runCollect)
    const events = Array.from(eventsChunk)
    const body = yield* encodeNdjson(events)

    return new Response(body, { status: 200, headers: ndjsonHeaders })
  }).pipe(Effect.withSpan('AgentRoute.post'))
