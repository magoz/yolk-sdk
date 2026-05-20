# Effect Pages

Pages with auth, cookies, headers, or request-time data use Suspense + Effect boundaries.

## Required elements

1. `export const dynamic = 'force-dynamic'`
2. `await cookies()` at the start of the async server component doing auth
3. Outer `<Suspense>` with a page-level fallback
4. `NextEffect.runPromise` for pipelines that may redirect/notFound
5. `catchTag` chains + `Effect.catch` catch-all

## Basic dynamic page

```typescript
import { Suspense } from 'react'
import { Effect } from 'effect'
import { cookies } from 'next/headers'
import { AppLayer } from '@/lib/layers'
import { NextEffect } from '@/lib/next-effect'
import { getSession } from '@/lib/services/auth/get-session'
import { reportError } from '@/lib/services/telemetry/report-error'

export const dynamic = 'force-dynamic'

async function Content() {
  await cookies()

  return await NextEffect.runPromise(
    Effect.gen(function* () {
      const session = yield* getSession()
      const posts = yield* getPosts({ userId: session.user.id })

      return <PostList posts={posts} />
    }).pipe(
      Effect.withSpan('page.posts'),
      Effect.provide(AppLayer),
      Effect.scoped,
      Effect.catchTag('UnauthenticatedError', () => NextEffect.redirect('/login')),
      Effect.catchTag('UnauthorizedError', () => NextEffect.redirect('/')),
      Effect.catch(error =>
        NextEffect.isNavigationError(error)
          ? Effect.fail(error)
          : reportError(error, { operation: 'page.posts' }).pipe(
              Effect.as(<ErrorMessage message="Something went wrong" />)
            )
      )
    )
  )
}

export default async function Page() {
  return (
    <Suspense fallback={<PageSkeleton />}>
      <Content />
    </Suspense>
  )
}
```

## Independent streaming sections

Use a fast Shell for auth/chrome, then stream independent data sections in their own Suspense boundaries. Shell verifies auth once; sections use `AppLayer` and report before throwing.

```typescript
async function Shell({ projectId }: { readonly projectId: string }) {
  await cookies()

  return await NextEffect.runPromise(
    Effect.gen(function* () {
      const session = yield* getSession()
      const project = yield* getProject({ projectId, userId: session.user.id })

      return (
        <main>
          <h1>{project.title}</h1>
          <Suspense fallback={<RecentSkeleton />}>
            <RecentSection projectId={project.id} />
          </Suspense>
          <Suspense fallback={<StatsSkeleton />}>
            <StatsSection projectId={project.id} />
          </Suspense>
        </main>
      )
    }).pipe(
      Effect.withSpan('page.project.shell'),
      Effect.provide(AppLayer),
      Effect.scoped,
      Effect.catchTag('UnauthenticatedError', () => NextEffect.redirect('/login')),
      Effect.catch(error =>
        NextEffect.isNavigationError(error)
          ? Effect.fail(error)
          : reportError(error, { operation: 'page.project.shell' }).pipe(
              Effect.as(<ErrorMessage message="Something went wrong" />)
            )
      )
    )
  )
}

async function RecentSection({ projectId }: { readonly projectId: string }) {
  const recent = await Effect.runPromise(
    getRecentItems(projectId).pipe(
      Effect.provide(AppLayer),
      Effect.scoped,
      Effect.tapError(error => reportError(error, { operation: 'page.project.recent' }))
    )
  )

  return <RecentItems items={recent} />
}
```

Rules:

- Shell handles auth and redirects.
- Sections do not redirect; they throw to the nearest error boundary if they fail.
- Each section has its own shape-matched skeleton.
- Avoid waterfalls: sibling Suspense sections load independently.

## URL state and selective loading

For filter-driven pages, pass `searchParams` as a Promise to Shell. Await it inside Shell and key the inner Suspense boundary.

```typescript
export default async function Page({
  searchParams
}: {
  readonly searchParams: Promise<Record<string, string | ReadonlyArray<string> | undefined>>
}) {
  return (
    <Suspense fallback={<PageSkeleton />}>
      <Shell searchParams={searchParams} />
    </Suspense>
  )
}

async function Shell({
  searchParams
}: {
  readonly searchParams: Promise<Record<string, string | ReadonlyArray<string> | undefined>>
}) {
  await cookies()
  const filters = await loadSearchParams(searchParams)
  const filterKey = `${filters.q ?? ''}-${filters.status ?? ''}`

  return await NextEffect.runPromise(
    Effect.gen(function* () {
      yield* getSession()
      return (
        <>
          <Filters />
          <Suspense key={filterKey} fallback={<ListSkeleton />}>
            <FilteredList filters={filters} />
          </Suspense>
        </>
      )
    }).pipe(/* provide + handlers */)
  )
}
```

Client filters use nuqs with `{ shallow: false, history: 'replace' }` so changes trigger server rendering.

## Anti-patterns

| Anti-pattern                                         | Use instead                                                    |
| ---------------------------------------------------- | -------------------------------------------------------------- |
| `Effect.runPromise` in redirecting pages             | `NextEffect.runPromise`                                        |
| Direct `redirect()` inside Effect                    | `NextEffect.redirect()`                                        |
| Catch-all swallowing `NextEffect.redirect()`         | Re-fail `NextEffect.isNavigationError(error)` before reporting |
| Missing `dynamic = 'force-dynamic'`                  | Add it to auth/dynamic pages                                   |
| Reporting auth/not-found page redirects              | Report only catch-all unexpected errors                        |
| Pre-resolving `searchParams` in Page before Suspense | Pass Promise to Shell                                          |

## Checklist

- [ ] `export const dynamic = 'force-dynamic'`
- [ ] Outer Suspense fallback
- [ ] `await cookies()` before auth
- [ ] `Effect.withSpan` on Shell/Content
- [ ] One composed layer via `Effect.provide(AppLayer)` or a request-specific layer
- [ ] Auth errors redirect via `NextEffect.redirect`
- [ ] Catch-all re-fails `NextEffect.isNavigationError(error)`
- [ ] Catch-all reports with `reportError` and renders safe UI
