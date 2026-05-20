import { Effect, type Layer } from 'effect'
import * as Schema from 'effect/Schema'
import {
  FetchHttpClient,
  HttpClient,
  HttpClientRequest,
  HttpClientResponse
} from 'effect/unstable/http'
import type { AgentCommandSummary } from './slash-command-model'

type CommandClientOptions = {
  readonly httpClientLayer?: Layer.Layer<HttpClient.HttpClient>
}

const AgentCommandSummarySchema = Schema.Struct({
  name: Schema.String,
  description: Schema.optional(Schema.String),
  hints: Schema.Array(Schema.String),
  arguments: Schema.optional(
    Schema.Array(
      Schema.Struct({
        name: Schema.String,
        required: Schema.Boolean,
        description: Schema.optional(Schema.String)
      })
    )
  ),
  access: Schema.optional(
    Schema.Union([Schema.Literal('read'), Schema.Literal('write'), Schema.Literal('destructive')])
  ),
  fileRefs: Schema.optional(Schema.Boolean)
})

const AgentCommandListResponse = Schema.Struct({
  commands: Schema.Array(AgentCommandSummarySchema)
})

const AgentCommandRenderResponse = Schema.Struct({
  content: Schema.String
})

const encodeJsonString = (value: unknown) =>
  Schema.encodeUnknownEffect(Schema.UnknownFromJsonString)(value)

export const loadAgentCommands = (
  options: CommandClientOptions = {}
): Effect.Effect<ReadonlyArray<AgentCommandSummary>, unknown> =>
  Effect.gen(function* () {
    const client = (yield* HttpClient.HttpClient).pipe(HttpClient.filterStatusOk)
    const response = yield* client.get('/api/agent/commands', {
      headers: { accept: 'application/json' }
    })
    const body = yield* HttpClientResponse.schemaBodyJson(AgentCommandListResponse)(response)

    return body.commands
  }).pipe(Effect.provide(options.httpClientLayer ?? FetchHttpClient.layer))

export const renderAgentCommand = (
  command: string,
  argumentsText: string,
  options: CommandClientOptions = {}
) =>
  Effect.gen(function* () {
    const client = (yield* HttpClient.HttpClient).pipe(HttpClient.filterStatusOk)
    const body = yield* encodeJsonString({ command, arguments: argumentsText })
    const request = HttpClientRequest.post('/api/agent/commands').pipe(
      HttpClientRequest.setHeaders({ accept: 'application/json' }),
      HttpClientRequest.bodyText(body, 'application/json')
    )
    const response = yield* client.execute(request)
    const rendered = yield* HttpClientResponse.schemaBodyJson(AgentCommandRenderResponse)(response)

    return rendered.content
  }).pipe(Effect.provide(options.httpClientLayer ?? FetchHttpClient.layer))
