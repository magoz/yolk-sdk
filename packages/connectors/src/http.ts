import { Context, Effect } from 'effect'
import * as Schema from 'effect/Schema'
import { ConnectorError } from './error.ts'

export const HttpMethod = Schema.Literals(['GET', 'POST', 'PATCH', 'PUT', 'DELETE'])
export type HttpMethod = typeof HttpMethod.Type

export class ConnectorHttpRequest extends Schema.Class<ConnectorHttpRequest>('ConnectorHttpRequest')({
  method: HttpMethod,
  url: Schema.String,
  headers: Schema.optional(Schema.Record(Schema.String, Schema.String)),
  body: Schema.optional(Schema.String)
}) {}

export class ConnectorHttpResponse extends Schema.Class<ConnectorHttpResponse>('ConnectorHttpResponse')({
  status: Schema.Number,
  headers: Schema.Record(Schema.String, Schema.String),
  body: Schema.String
}) {}

export type ConnectorHttpClientApi = {
  readonly request: (request: ConnectorHttpRequest) => Effect.Effect<ConnectorHttpResponse, ConnectorError>
}

export class ConnectorHttpClient extends Context.Service<ConnectorHttpClient, ConnectorHttpClientApi>()(
  '@yolk-sdk/connectors/ConnectorHttpClient'
) {}

export const decodeJsonResponse = <A>(schema: Schema.Schema<A>, response: ConnectorHttpResponse) =>
  Schema.decodeUnknownEffect(Schema.UnknownFromJsonString)(response.body).pipe(
    Effect.mapError(error =>
      new ConnectorError({
        cause: 'validation_failed',
        message: 'Invalid JSON response',
        underlying: error
      })
    ),
    Effect.flatMap(value =>
      Schema.decodeUnknownEffect(schema)(value).pipe(
        Effect.mapError(error =>
          new ConnectorError({
            cause: 'validation_failed',
            message: 'Invalid response shape',
            underlying: error
          })
        )
      )
    )
  )
