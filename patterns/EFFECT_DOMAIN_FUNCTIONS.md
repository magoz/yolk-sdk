# Effect Domain Functions

Domain functions are exported functions that return Effect programs. They own business logic and data access, but not request concerns.

## Location

```txt
lib/core/[domain]/
├── get-thing.ts
├── create-thing.ts
├── update-thing.ts
├── delete-thing.ts
└── errors.ts
```

## Canonical query

```typescript
import { Effect } from 'effect'
import { eq } from 'drizzle-orm'
import { Db } from '@/lib/services/db/live-layer'
import * as schema from '@/lib/services/db/schema'
import { NotFoundError } from '@/lib/core/errors'

export const getPost = (postId: string) =>
  Effect.gen(function* () {
    const db = yield* Db

    const [post] = yield* db
      .select({ id: schema.post.id, title: schema.post.title })
      .from(schema.post)
      .where(eq(schema.post.id, postId))
      .limit(1)

    if (post === undefined) {
      return yield* Effect.fail(
        new NotFoundError({ message: 'Post not found', entity: 'post', id: postId })
      )
    }

    return post
  }).pipe(Effect.withSpan('post.get'))
```

## Canonical write

```typescript
import { createId } from '@paralleldrive/cuid2'

export const createPost = (input: { readonly title: string; readonly userId: string }) =>
  Effect.gen(function* () {
    const db = yield* Db

    const [post] = yield* db
      .insert(schema.post)
      .values({ id: createId(), title: input.title, userId: input.userId })
      .returning({ id: schema.post.id, title: schema.post.title })

    if (post === undefined) {
      return yield* Effect.fail(new PersistenceError({ message: 'Post create failed' }))
    }

    return post
  }).pipe(Effect.withSpan('post.create'))
```

## Rules

- No `Effect.provide` in domain functions. Provide layers at page/action/API boundaries.
- No `revalidatePath`, `redirect`, `notFound`, `Response`, or toasts.
- No catch-all recovery. Propagate typed errors to the boundary.
- `yield* Db`; Drizzle queries are Effects.
- Destructure Drizzle arrays and check `undefined`.
- End every function with `Effect.withSpan('domain.operation')`.
- Parse unknown input at boundaries with Schema; domain functions receive typed input.

## Error definitions

Use one `errors.ts` per domain when shared errors are not enough.

```typescript
import { Data } from 'effect'

export class PersistenceError extends Data.TaggedError('PersistenceError')<{
  readonly message: string
  readonly cause?: unknown
}> {}
```

Use `Schema.TaggedErrorClass` instead when you need `Schema.is()` guards or serialization.

## Type extraction

```typescript
import type { Effect } from 'effect'

type Success<T> = T extends Effect.Effect<infer A, infer _E, infer _R> ? A : never
export type Post = Success<ReturnType<typeof getPost>>
```
