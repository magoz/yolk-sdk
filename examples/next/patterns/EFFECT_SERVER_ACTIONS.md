# Effect Server Actions

Server actions are mutation boundaries. They provide layers, handle auth redirects, report failures, revalidate paths, and return UI-safe results.

## Location

```txt
examples/next/lib/core/[domain]/*-action.ts
```

One action per file.

## Pipe ordering

```typescript
Effect.gen(function* () { ... }).pipe(
  Effect.withSpan('action.domain.verb'),
  Effect.provide(AppLayer),
  Effect.scoped,
    Effect.tap(() => Effect.sync(() => revalidatePath('/path'))),
    Effect.as({ _tag: 'Success' as const }),
    Effect.catchTag('UnauthenticatedError', () => NextEffect.redirect('/login')),
    Effect.catchTag('ValidationError', error =>
      Effect.succeed({ _tag: 'Error' as const, message: error.message })
    ),
    Effect.catchTag('UnauthorizedError', () => NextEffect.redirect('/')),
    Effect.tapError(error => reportError(error, { operation: 'action.domain.verb' })),
    Effect.catch(() => Effect.succeed({ _tag: 'Error' as const, message: 'Something went wrong' }))
  )
```

Order matters:

1. `withSpan` wraps the whole boundary.
2. `provide` is one composed layer, usually `AppLayer`.
3. `scoped` closes scoped resources.
4. `tap` / `as Success` happen only on true mutation success.
5. `catchTag` handles expected control flow and user-correctable errors after success mapping, so handled error ADTs are not remapped to success.
6. `tapError(reportError)` reports remaining unexpected errors.
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
      Effect.tap(() => Effect.sync(() => revalidatePath('/posts'))),
      Effect.as({ _tag: 'Success' as const }),
      Effect.catchTag('UnauthenticatedError', () => NextEffect.redirect('/login')),
      Effect.catchTag('ValidationError', error =>
        Effect.succeed({ _tag: 'Error' as const, message: error.message })
      ),
      Effect.catchTag('UnauthorizedError', () => NextEffect.redirect('/')),
      Effect.tapError(error => reportError(error, { operation: 'action.post.update' })),
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
- `revalidatePath` goes in `Effect.sync` on the success path only.
- Put `Effect.map` / `Effect.as({ _tag: 'Success' })` before expected `catchTag`s; otherwise handled error results can be remapped to success.
- Report unexpected errors after expected `catchTag`s when expected failures are user-correctable and should not alert.
- Never call `redirect`, `notFound`, `revalidatePath`, or `reportError` in domain functions.
- Never use API routes for CRUD mutations.

## Client invocation

Prefer calling server actions directly from client event handlers (`onSubmit`, `onClick`) inside `startTransition(async () => ...)`. Do not pass result-returning server actions to React form `action` / `formAction`; form actions type toward `void | Promise<void>` and hide typed recovery paths.

```tsx
'use client'

import { useState, useTransition } from 'react'
import { updatePostAction } from '@/lib/core/post/update-post-action'

export function RenamePostButton({ postId }: { readonly postId: string }) {
  const [message, setMessage] = useState<string | undefined>()
  const [isPending, startTransition] = useTransition()

  return (
    <button
      type="button"
      disabled={isPending}
      onClick={() => {
        startTransition(async () => {
          const result = await updatePostAction({ postId, title: 'New title' })
          if (result._tag === 'Error') {
            setMessage(result.message)
            return
          }

          setMessage(undefined)
        })
      }}
    >
      {message ?? (isPending ? 'Saving…' : 'Save')}
    </button>
  )
}
```

For removal/toggle UI, use local optimistic state or `useOptimistic` so the UI updates immediately; `revalidatePath` in the action reconciles server truth. Apply the optimistic update before `startTransition`; only the async server action belongs inside the transition.
