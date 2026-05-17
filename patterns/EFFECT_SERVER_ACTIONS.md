# Effect Server Actions

Server actions are mutation boundaries. They provide layers, handle auth redirects, report failures, revalidate paths, and return UI-safe results.

## Location

```txt
lib/core/[domain]/*-action.ts
```

One action per file.

## Pipe ordering

```typescript
Effect.gen(function* () { ... }).pipe(
  Effect.withSpan('action.domain.verb'),
  Effect.provide(AppLayer),
  Effect.scoped,
  Effect.catchTag('UnauthenticatedError', () => NextEffect.redirect('/login')),
  Effect.catchTag('ValidationError', error =>
    Effect.succeed({ _tag: 'Error' as const, message: error.message })
  ),
  Effect.catchTag('UnauthorizedError', () => NextEffect.redirect('/')),
  Effect.tapError(error => reportError(error, { operation: 'action.domain.verb' })),
  Effect.tap(() => Effect.sync(() => revalidatePath('/path'))),
  Effect.as({ _tag: 'Success' as const }),
  Effect.catch(() => Effect.succeed({ _tag: 'Error' as const, message: 'Something went wrong' }))
)
```

Order matters:

1. `withSpan` wraps the whole boundary.
2. `provide` is one composed layer, usually `AppLayer`.
3. `scoped` closes scoped resources.
4. `catchTag` handles expected control flow and user-correctable errors.
5. `tapError(reportError)` reports remaining unexpected errors.
6. `tap` / `as Success` happen after expected handlers so handled error ADTs are not remapped to success.
7. Catch-all returns a user-safe error.

## Canonical action

```typescript
'use server'

import { Effect } from 'effect'
import { revalidatePath } from 'next/cache'
import { cookies } from 'next/headers'
import { AppLayer } from '@/lib/layers'
import { NextEffect } from '@/lib/next-effect'
import { getSession } from '@/lib/services/auth/get-session'
import { reportError } from '@/lib/services/telemetry/report-error'
import { updatePost } from './update-post'

export const updatePostAction = async (input: {
  readonly postId: string
  readonly title: string
}) => {
  await cookies()

  return await NextEffect.runPromise(
    Effect.gen(function* () {
      const session = yield* getSession()
      yield* Effect.annotateCurrentSpan({ 'user.id': session.user.id, 'post.id': input.postId })

      yield* updatePost({ postId: input.postId, title: input.title, userId: session.user.id })
    }).pipe(
      Effect.withSpan('action.post.update'),
      Effect.provide(AppLayer),
      Effect.scoped,
      Effect.catchTag('UnauthenticatedError', () => NextEffect.redirect('/login')),
      Effect.catchTag('ValidationError', error =>
        Effect.succeed({ _tag: 'Error' as const, message: error.message })
      ),
      Effect.catchTag('UnauthorizedError', () => NextEffect.redirect('/')),
      Effect.tapError(error => reportError(error, { operation: 'action.post.update' })),
      Effect.tap(() => Effect.sync(() => revalidatePath('/posts'))),
      Effect.as({ _tag: 'Success' as const }),
      Effect.catch(() =>
        Effect.succeed({ _tag: 'Error' as const, message: 'Could not update post' })
      )
    )
  )
}
```

## Return shape

Actions return a discriminated union:

```typescript
{ _tag: 'Success'; ... }
{ _tag: 'Error'; message: string }
```

Client components branch on `_tag`; never parse thrown errors in the client.

## Rules

- `await cookies()` at the top when auth or cookies are involved.
- Auth check is the first `yield*` inside `Effect.gen`.
- Annotate current span after auth with `user.id` plus affected entity ids/names.
- Use `NextEffect.runPromise`, not `Effect.runPromise`, when redirects may happen.
- `revalidatePath` goes in `Effect.sync` after successful mutation.
- Put `Effect.map` / `Effect.as({ _tag: 'Success' })` after expected `catchTag`s; otherwise handled error results can be remapped to success.
- Report unexpected errors after expected `catchTag`s when expected failures are user-correctable and should not alert.
- Never call `redirect`, `notFound`, `revalidatePath`, or `reportError` in domain functions.
- Never use API routes for CRUD mutations.
