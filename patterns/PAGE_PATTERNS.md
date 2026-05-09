# Page Patterns for Dynamic Routes

This document defines patterns for building pages that require authentication or other dynamic server features in Next.js 16 with Effect-TS.

## The Problem

Next.js attempts to statically prerender pages at build time. Pages that use `cookies()`, `headers()`, or authentication fail during this prerendering phase with errors like:

```
Error: Dynamic server usage: Route /dashboard couldn't be rendered statically
because it used `cookies`. See more info here: https://nextjs.org/docs/messages/dynamic-server-error
```

## Solution: Suspense + Content Pattern

Wrap data-fetching code in a `Content` component inside `Suspense`, and explicitly mark pages as dynamic.

### Required Elements

1. **`export const dynamic = 'force-dynamic'`** - Opt out of static generation
2. **`await cookies()`** - Called at start of Content to ensure dynamic rendering
3. **`<Suspense>` wrapper** - Provides loading state during server render
4. **`catchTag` chains + `catch` catch-all** - Typed error handling with redirects

## Pattern: Basic Dynamic Page

```typescript
// app/(dashboard)/posts/page.tsx
import { Suspense } from 'react'
import { Effect, Layer } from 'effect'
import { cookies } from 'next/headers'
import { NextEffect } from '@/lib/next-effect'
import { AppLayer } from '@/lib/layers'
import { getSession } from '@/lib/services/auth/get-session'
import { getPosts } from '@/lib/core/post/get-posts'

export const dynamic = 'force-dynamic'

async function Content() {
  await cookies()

  return await NextEffect.runPromise(
    Effect.gen(function* () {
      const session = yield* getSession()
      const posts = yield* getPosts({ userId: session.user.id })

      return (
        <div className="p-6">
          <h1 className="text-2xl font-bold">Posts</h1>
          <PostList posts={posts} />
        </div>
      )
    }).pipe(
      Effect.provide(AppLayer),
      Effect.scoped,
      Effect.catchTag('UnauthenticatedError', () => NextEffect.redirect('/login')),
      Effect.catch(error =>
        Effect.succeed(
          <div className="p-6">
            <p>Something went wrong.</p>
            <p className="text-red-500">
              Error: {error instanceof Error ? error.message : 'Unknown error'}
            </p>
          </div>
        )
      )
    )
  )
}

export default async function PostsPage() {
  return (
    <Suspense fallback={<p className="p-6">Loading...</p>}>
      <Content />
    </Suspense>
  )
}
```

## Pattern: Page with URL State (nuqs)

When using nuqs for filters/search, pass searchParams to Content:

```typescript
// app/(dashboard)/posts/page.tsx
import { Suspense } from 'react'
import { Effect, Layer } from 'effect'
import { cookies } from 'next/headers'
import type { SearchParams } from 'nuqs/server'
import { NextEffect } from '@/lib/next-effect'
import { AppLayer } from '@/lib/layers'
import { getSession } from '@/lib/services/auth/get-session'
import { getPosts } from '@/lib/core/post/get-posts'
import { loadSearchParams } from './search-params'
import { PostFilters } from './post-filters'

export const dynamic = 'force-dynamic'

interface Props {
  searchParams: Promise<SearchParams>
}

async function Content({ searchParams }: { searchParams: Promise<SearchParams> }) {
  await cookies()

  const { q, status, sortBy } = await loadSearchParams(searchParams)

  return await NextEffect.runPromise(
    Effect.gen(function* () {
      const session = yield* getSession()
      const posts = yield* getPosts({
        userId: session.user.id,
        query: q,
        status,
        sortBy
      })

      return (
        <div className="p-6">
          <h1 className="text-2xl font-bold">Posts</h1>
          <PostFilters />
          <PostList posts={posts} />
        </div>
      )
    }).pipe(
      Effect.provide(AppLayer),
      Effect.scoped,
      Effect.catchTag('UnauthenticatedError', () => NextEffect.redirect('/login')),
      Effect.catch(error =>
        Effect.succeed(
          <div className="p-6">
            <p>Something went wrong.</p>
            <p className="text-red-500">
              Error: {error instanceof Error ? error.message : 'Unknown error'}
            </p>
          </div>
        )
      )
    )
  )
}

export default async function PostsPage({ searchParams }: Props) {
  return (
    <Suspense fallback={<p className="p-6">Loading...</p>}>
      <Content searchParams={searchParams} />
    </Suspense>
  )
}
```

## Pattern: Admin-Only Page with Role Check

Redirect non-admins inside the Effect pipeline using `NextEffect.redirect()`:

```typescript
async function Content() {
  await cookies()

  return await NextEffect.runPromise(
    Effect.gen(function* () {
      const session = yield* getSession()

      // Role check inside Effect - redirects cleanly
      if (session.user.role !== 'ADMIN') {
        return yield* NextEffect.redirect('/dashboard')
      }

      const users = yield* getUsers()

      return (
        <div className="p-6">
          <h1 className="text-2xl font-bold">Admin Panel</h1>
          <UserList users={users} />
        </div>
      )
    }).pipe(
      Effect.provide(AppLayer),
      Effect.scoped,
      Effect.catchTag('UnauthenticatedError', () => NextEffect.redirect('/login')),
      Effect.catch(error =>
        Effect.succeed(
          <div className="p-6">
            <p>Something went wrong.</p>
            <p className="text-red-500">
              Error: {error instanceof Error ? error.message : 'Unknown error'}
            </p>
          </div>
        )
      )
    )
  )
}
```

## Pattern: Conditional Data Loading

Load different data based on user role without nested async components:

```typescript
async function Content() {
  await cookies()

  return await NextEffect.runPromise(
    Effect.gen(function* () {
      const session = yield* getSession()
      const isAdmin = session.user.role === 'ADMIN'

      // User data - always loaded
      const userPosts = yield* getPosts({ userId: session.user.id })

      // Non-admin: return early with just user data
      if (!isAdmin) {
        return (
          <div className="p-6">
            <h1 className="text-2xl font-bold">My Posts</h1>
            <PostList posts={userPosts} />
          </div>
        )
      }

      // Admin: load additional data
      const allPosts = yield* getAllPosts()
      const analytics = yield* getAnalytics()

      return (
        <div className="p-6">
          <h1 className="text-2xl font-bold">Admin Dashboard</h1>
          <Analytics data={analytics} />
          <h2 className="text-xl font-semibold mt-8">All Posts</h2>
          <PostList posts={allPosts} />
          <h2 className="text-xl font-semibold mt-8">My Posts</h2>
          <PostList posts={userPosts} />
        </div>
      )
    }).pipe(
      Effect.provide(AppLayer),
      Effect.scoped,
      Effect.catchTag('UnauthenticatedError', () => NextEffect.redirect('/login')),
      Effect.catch(error =>
        Effect.succeed(
          <div className="p-6">
            <p>Something went wrong.</p>
            <p className="text-red-500">
              Error: {error instanceof Error ? error.message : 'Unknown error'}
            </p>
          </div>
        )
      )
    )
  )
}
```

## Anti-Patterns

### NEVER: Nested Suspense with Async Server Components

Nested async server components inside Suspense boundaries cause prerendering failures:

```typescript
// BAD - Will fail during build
async function Content() {
  await cookies()

  return await NextEffect.runPromise(
    Effect.gen(function* () {
      const session = yield* getSession()

      return (
        <div>
          {/* This nested async component causes issues */}
          <Suspense fallback={<Loading />}>
            <AdminData />  {/* Another async server component */}
          </Suspense>
        </div>
      )
    })
  )
}

async function AdminData() {
  // Even with await cookies() here, this causes problems
  await cookies()
  const data = await fetchData()
  return <div>{data}</div>
}
```

**Solution:** Fetch all data in a single Content component and pass to client components:

```typescript
// GOOD - All data fetched in one place
async function Content() {
  await cookies()

  return await NextEffect.runPromise(
    Effect.gen(function* () {
      const session = yield* getSession()
      const adminData = yield* getAdminData()

      return (
        <div>
          <AdminPanel data={adminData} />  {/* Client component */}
        </div>
      )
    })
  )
}
```

### NEVER: Missing `export const dynamic`

Without explicit dynamic marking, Next.js attempts static prerendering:

```typescript
// BAD - No dynamic export
async function Content() {
  await cookies() // This alone is not enough!
  // ...
}
```

**Solution:** Always add at the top of the file:

```typescript
export const dynamic = 'force-dynamic'
```

### NEVER: Auth Outside Effect Pipeline

Don't call `redirect()` directly outside the Effect context:

```typescript
// BAD - redirect() outside Effect
async function Content() {
  await cookies()
  const session = await getSessionSomehow()

  if (!session) {
    redirect('/login') // This won't work correctly with Effect
  }
}
```

**Solution:** Use `NextEffect.redirect()` inside the Effect pipeline:

```typescript
// GOOD - redirect inside Effect
return await NextEffect.runPromise(
  Effect.gen(function* () {
    const session = yield* getSession()
    if (!session.user.isAdmin) {
      return yield* NextEffect.redirect('/dashboard')
    }
    // ...
  })
)
```

## Error Handling Pattern

Use `catchTag` chains with a `catch` catch-all:

```typescript
// Error handling: catchTag for specific errors, catch for everything else
.pipe(
  Effect.provide(AppLayer),
  Effect.scoped,
  // Auth errors -> redirect to login
  Effect.catchTag('UnauthenticatedError', () => NextEffect.redirect('/login')),
  // Permission errors -> redirect to home
  Effect.catchTag('UnauthorizedError', () => NextEffect.redirect('/')),
  // All other errors -> show error UI
  Effect.catch(error =>
    Effect.succeed(
      <div className="p-6">
        <p>Something went wrong.</p>
        <p className="text-red-500">
          Error: {error instanceof Error ? error.message : 'Unknown error'}
        </p>
      </div>
    )
  )
)
```

## Checklist for New Pages

- [ ] Add `export const dynamic = 'force-dynamic'` at top of file
- [ ] Create `Content` async function with `await cookies()` as first line
- [ ] Wrap Content in `<Suspense>` with appropriate fallback
- [ ] Use `catchTag` chains + `catch` catch-all for error handling
- [ ] Handle `UnauthenticatedError` with redirect to `/login`
- [ ] Fetch all data in single Effect pipeline (no nested async components)
- [ ] Pass data to client components as props

## Summary

| Element                   | Purpose                                    |
| ------------------------- | ------------------------------------------ |
| `export const dynamic`    | Opt out of static prerendering             |
| `await cookies()`         | Signal dynamic rendering to Next.js        |
| `<Suspense>` wrapper      | Provide loading state                      |
| `NextEffect.runPromise()` | Handle redirects outside Effect context    |
| `catchTag` + `catch`      | Typed error handling with clean redirects  |
| Single Content component  | Avoid nested async server component issues |
