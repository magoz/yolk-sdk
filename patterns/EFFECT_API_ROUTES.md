# Effect API Routes

Use API routes only for webhooks, external APIs, streaming endpoints, and non-browser clients. Use server actions for CRUD.

## Canonical route

```typescript
import { HttpEffect, HttpServerRequest, HttpServerResponse } from 'effect/unstable/http'
import { Data, Effect, Schema } from 'effect'
import { AppLayer } from '@/lib/layers'
import { getSession } from '@/lib/services/auth/get-session'
import { reportError } from '@/lib/services/telemetry/report-error'

export const dynamic = 'force-dynamic'

class RouteError extends Data.TaggedError('RouteError')<{
  readonly message: string
  readonly cause?: unknown
}> {}

class RequestBody extends Schema.Class<RequestBody>('RequestBody')({
  message: Schema.Trimmed.pipe(Schema.check(Schema.isNonEmpty()))
}) {}

const handler = Effect.gen(function* () {
  const session = yield* getSession()
  const input = yield* HttpServerRequest.schemaBodyJson(RequestBody)

  yield* Effect.annotateCurrentSpan({ 'user.id': session.user.id })

  return yield* HttpServerResponse.json({ ok: true, message: input.message })
}).pipe(
  Effect.withSpan('api.example.post'),
  Effect.catchTag('UnauthenticatedError', () =>
    HttpServerResponse.json({ error: 'Unauthorized' }, { status: 401 })
  ),
  Effect.catchTag('HttpServerError', error =>
    reportError(new RouteError({ message: 'Invalid request body', cause: error }), {
      operation: 'api.example.post',
      status: 400
    }).pipe(Effect.andThen(HttpServerResponse.json({ error: 'Invalid request body' }, { status: 400 })))
  ),
  Effect.catchTag('SchemaError', error =>
    reportError(new RouteError({ message: 'Invalid request body', cause: error }), {
      operation: 'api.example.post',
      status: 400
    }).pipe(Effect.andThen(HttpServerResponse.json({ error: 'Invalid request body' }, { status: 400 })))
  ),
  Effect.catch(error =>
    reportError(new RouteError({ message: 'Request failed', cause: error }), {
      operation: 'api.example.post',
      status: 500
    }).pipe(Effect.andThen(HttpServerResponse.json({ error: 'Internal error' }, { status: 500 })))
  )
)

const { handler: effectHandler } = HttpEffect.toWebHandlerLayer(handler, AppLayer)

export const POST = (request: Request) => effectHandler(request)
```

## Streaming/raw responses

If another library returns a Web `Response`, convert it with `HttpServerResponse.raw`.

```typescript
const toHttpResponse = (response: Response) =>
  HttpServerResponse.raw(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers: Object.fromEntries(response.headers.entries())
  })
```

## Rules

- Parse JSON with `HttpServerRequest.schemaBodyJson`.
- Auth first unless the body is needed to decide auth scope.
- Use one composed route layer in `HttpEffect.toWebHandlerLayer`.
- Return HTTP 401/403 for auth errors without Sentry.
- Report catch-all API errors with `reportError`.
- Do not use API routes for ordinary CRUD.

## Better-auth exception

`app/api/auth/[...all]/route.ts` may use better-auth's Next handler directly. Keep it isolated.
