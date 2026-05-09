# URL State with nuqs

This document defines patterns for lifting component state to the URL using nuqs. Use this for filters, search, pagination, and any user-controlled state that should be shareable and bookmarkable.

## Critical Import Rule

**NEVER mix `nuqs` and `nuqs/server` imports in server-side code.**

```typescript
// BAD - Will cause build failure
import { createLoader } from 'nuqs/server'
import { parseAsStringLiteral } from 'nuqs' // Client-only!

// GOOD - All from nuqs/server for server files
import { createLoader, parseAsStringLiteral } from 'nuqs/server'
```

| Context                                 | Import From   | Why                                          |
| --------------------------------------- | ------------- | -------------------------------------------- |
| `search-params.ts` (shared definitions) | `nuqs/server` | Used by server components via `createLoader` |
| Server Components                       | `nuqs/server` | `loadSearchParams()` runs on server          |
| Client Components                       | `nuqs`        | `useQueryState()` runs on client             |

Build will fail with this error if you import from `nuqs` in server context:

```
Error: Attempted to call parseAsStringLiteral() from the server but
parseAsStringLiteral is on the client.
```

## When to Use URL State

```
User can share/bookmark the current view?
  └─> Use URL state

State should persist across page refreshes?
  └─> Use URL state

State affects server-side data fetching?
  └─> Use URL state

Temporary UI state (modals, dropdowns)?
  └─> Use local state (useState)
```

### Good Candidates for URL State

- Search queries (`?q=hello`)
- Filters (`?status=active&type=post`)
- Pagination (`?page=2`)
- Sorting (`?sort=date&order=desc`)
- View modes (`?view=grid`)
- Selected tabs (`?tab=settings`)

### Keep as Local State

- Modal open/close
- Form input before submission
- Hover/focus states
- Animation states

## Project Setup

The `NuqsAdapter` is already configured in `app/layout.tsx`:

```typescript
import { NuqsAdapter } from 'nuqs/adapters/next/app'

export default function RootLayout({ children }) {
  return (
    <html>
      <body>
        <NuqsAdapter>{children}</NuqsAdapter>
      </body>
    </html>
  )
}
```

## File Structure

Each feature with URL state gets a `search-params.ts` file:

```
app/
├── (dashboard)/
│   └── posts/
│       ├── page.tsx              # Server component consuming params
│       ├── search-params.ts      # Shared param definitions
│       ├── post-status-filter.tsx  # Client filter component
│       └── post-search.tsx       # Client search component
```

## Pattern 1: Define Search Params

Create a `search-params.ts` file with:

1. Allowed values as const arrays (for enums)
2. TypeScript types derived from values
3. Parser configuration object
4. `createLoader` for server-side consumption

```typescript
// app/(dashboard)/posts/search-params.ts
import { createLoader, parseAsInteger, parseAsString, parseAsStringLiteral } from 'nuqs/server'

// 1. Define allowed values
export const statusFilterValues = ['all', 'draft', 'published', 'archived'] as const
export type StatusFilter = (typeof statusFilterValues)[number]

export const sortByValues = ['date', 'title', 'views'] as const
export type SortBy = (typeof sortByValues)[number]

// 2. Define parsers with defaults
export const searchParams = {
  q: parseAsString, // Optional search query
  status: parseAsStringLiteral(statusFilterValues).withDefault('all'),
  sortBy: parseAsStringLiteral(sortByValues).withDefault('date'),
  page: parseAsInteger.withDefault(1)
}

// 3. Create loader for server components
export const loadSearchParams = createLoader(searchParams)
```

### Available Parsers

| Parser                          | URL Value       | Parsed Value      |
| ------------------------------- | --------------- | ----------------- |
| `parseAsString`                 | `?q=hello`      | `'hello'`         |
| `parseAsInteger`                | `?page=2`       | `2`               |
| `parseAsBoolean`                | `?active=true`  | `true`            |
| `parseAsStringLiteral(values)`  | `?status=draft` | `'draft'` (typed) |
| `parseAsArrayOf(parseAsString)` | `?tags=a,b`     | `['a', 'b']`      |
| `parseAsJson<T>()`              | `?data={...}`   | `T`               |

## Pattern 2: Server Component Consumption

Use `loadSearchParams` in server components to get typed, parsed values:

```typescript
// app/(dashboard)/posts/page.tsx
import { Suspense } from 'react'
import type { SearchParams } from 'nuqs/server'
import { loadSearchParams } from './searchParams'
import { PostList } from './post-list'
import { PostFilters } from './post-filters'

type Props = {
  searchParams: Promise<SearchParams>
}

export default async function PostsPage({ searchParams }: Props) {
  const { q, status, sortBy, page } = await loadSearchParams(searchParams)

  return (
    <div>
      <PostFilters />
      {/* Key forces re-render when params change */}
      <Suspense key={`${q}-${status}-${sortBy}-${page}`} fallback={<Loading />}>
        <PostList query={q} status={status} sortBy={sortBy} page={page} />
      </Suspense>
    </div>
  )
}
```

### Important: Suspense Key Pattern

When search params change, use them as a Suspense key to:

1. Show loading state during server re-render
2. Abort stale requests automatically
3. Provide smooth UX for filter changes

```typescript
<Suspense key={`${q}-${status}`} fallback={<Loading />}>
  <Results query={q} status={status} />
</Suspense>
```

## Pattern 3: Client Filter Components

Client components use `useQueryState` hook with the same parsers:

```typescript
// app/(dashboard)/posts/post-status-filter.tsx
'use client'

import { useQueryState, parseAsStringLiteral } from 'nuqs'
import { Select, SelectTrigger, SelectContent, SelectItem } from '@/components/ui/select'
import { statusFilterValues, type StatusFilter } from './searchParams'

export function PostStatusFilter() {
  const [status, setStatus] = useQueryState(
    'status',
    parseAsStringLiteral(statusFilterValues)
      .withDefault('all')
      .withOptions({
        shallow: false,  // Trigger server re-render
        history: 'push'  // Enable back/forward navigation
      })
  )

  return (
    <Select
      value={status}
      onValueChange={value => setStatus(value as StatusFilter)}
    >
      <SelectTrigger>
        <span>{status === 'all' ? 'All statuses' : status}</span>
      </SelectTrigger>
      <SelectContent>
        <SelectItem value="all">All statuses</SelectItem>
        <SelectItem value="draft">Draft</SelectItem>
        <SelectItem value="published">Published</SelectItem>
        <SelectItem value="archived">Archived</SelectItem>
      </SelectContent>
    </Select>
  )
}
```

### Required Options

Always use these options for filters that affect server data:

```typescript
.withOptions({
  shallow: false,  // Re-runs server components on change
  history: 'push'  // Enables browser back/forward navigation
})
```

| Option       | Value       | Effect                                         |
| ------------ | ----------- | ---------------------------------------------- |
| `shallow`    | `false`     | Triggers server component re-render            |
| `shallow`    | `true`      | Client-only update (default)                   |
| `history`    | `'push'`    | Adds entry to browser history                  |
| `history`    | `'replace'` | Replaces current history entry                 |
| `scroll`     | `false`     | Prevents scroll to top on change               |
| `throttleMs` | `500`       | Debounce URL updates (useful for search input) |

## Pattern 4: Search Input with Debounce

For search inputs, debounce the URL update to avoid excessive server requests:

```typescript
// app/(dashboard)/posts/post-search.tsx
'use client'

import { useQueryState, parseAsString } from 'nuqs'
import { Input } from '@/components/ui/input'

export function PostSearch() {
  const [query, setQuery] = useQueryState(
    'q',
    parseAsString.withDefault('').withOptions({
      shallow: false,
      history: 'push',
      throttleMs: 300  // Debounce 300ms
    })
  )

  return (
    <Input
      type="search"
      placeholder="Search posts..."
      value={query}
      onChange={e => setQuery(e.target.value || null)}  // null removes param
    />
  )
}
```

### Alternative: Submit on Enter

For explicit search submission (no debounce):

```typescript
'use client'

import { useState } from 'react'
import { useQueryState, parseAsString } from 'nuqs'
import { Input } from '@/components/ui/input'

export function PostSearch() {
  const [query, setQuery] = useQueryState(
    'q',
    parseAsString.withDefault('').withOptions({
      shallow: false,
      history: 'push'
    })
  )
  const [inputValue, setInputValue] = useState(query)

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault()
    setQuery(inputValue || null)
  }

  return (
    <form onSubmit={handleSubmit}>
      <Input
        type="search"
        placeholder="Search posts..."
        value={inputValue}
        onChange={e => setInputValue(e.target.value)}
      />
    </form>
  )
}
```

## Pattern 5: Clear Filters

Reset multiple filters to their defaults:

```typescript
// app/(dashboard)/posts/clear-filters-button.tsx
'use client'

import { useQueryState, parseAsString, parseAsStringLiteral } from 'nuqs'
import { Button } from '@/components/ui/button'
import { statusFilterValues, sortByValues } from './searchParams'

export function ClearFiltersButton() {
  const [query, setQuery] = useQueryState('q', parseAsString)
  const [status, setStatus] = useQueryState(
    'status',
    parseAsStringLiteral(statusFilterValues).withDefault('all')
  )
  const [sortBy, setSortBy] = useQueryState(
    'sortBy',
    parseAsStringLiteral(sortByValues).withDefault('date')
  )

  const hasFilters = query || status !== 'all' || sortBy !== 'date'

  const handleClear = () => {
    setQuery(null)      // Remove from URL
    setStatus('all')    // Reset to default
    setSortBy('date')   // Reset to default
  }

  if (!hasFilters) return null

  return (
    <Button variant="ghost" onClick={handleClear}>
      Clear filters
    </Button>
  )
}
```

## Pattern 6: Boolean Filters with Null State

For three-state filters (all/yes/no):

```typescript
'use client'

import { useQueryState, parseAsBoolean } from 'nuqs'
import { Select, SelectTrigger, SelectContent, SelectItem } from '@/components/ui/select'

export function PublishedFilter() {
  const [published, setPublished] = useQueryState(
    'published',
    parseAsBoolean.withOptions({
      shallow: false,
      history: 'push'
    })
  )

  // Convert boolean | null to string for Select
  const value = published === null ? 'all' : published ? 'true' : 'false'

  const handleChange = (newValue: string) => {
    if (newValue === 'all') {
      setPublished(null)  // Remove param from URL
    } else {
      setPublished(newValue === 'true')
    }
  }

  return (
    <Select value={value} onValueChange={handleChange}>
      <SelectTrigger>
        <span>{value === 'all' ? 'All' : value === 'true' ? 'Published' : 'Unpublished'}</span>
      </SelectTrigger>
      <SelectContent>
        <SelectItem value="all">All</SelectItem>
        <SelectItem value="true">Published</SelectItem>
        <SelectItem value="false">Unpublished</SelectItem>
      </SelectContent>
    </Select>
  )
}
```

## Pattern 7: Pagination

```typescript
// searchParams.ts
export const searchParams = {
  page: parseAsInteger.withDefault(1),
  perPage: parseAsInteger.withDefault(20)
}

// pagination.tsx
'use client'

import { useQueryState, parseAsInteger } from 'nuqs'
import { Button } from '@/components/ui/button'

type Props = {
  totalPages: number
}

export function Pagination({ totalPages }: Props) {
  const [page, setPage] = useQueryState(
    'page',
    parseAsInteger.withDefault(1).withOptions({
      shallow: false,
      history: 'push',
      scroll: true  // Scroll to top on page change
    })
  )

  return (
    <div className="flex gap-2">
      <Button
        disabled={page <= 1}
        onClick={() => setPage(page - 1)}
      >
        Previous
      </Button>
      <span>Page {page} of {totalPages}</span>
      <Button
        disabled={page >= totalPages}
        onClick={() => setPage(page + 1)}
      >
        Next
      </Button>
    </div>
  )
}
```

## Summary

| Task                        | Import From   | Function/Hook              |
| --------------------------- | ------------- | -------------------------- |
| Define shared parsers       | `nuqs/server` | `parseAs*`, `createLoader` |
| Server component read       | `nuqs/server` | `loadSearchParams()`       |
| Client component read/write | `nuqs`        | `useQueryState()`          |
| Multiple params at once     | `nuqs`        | `useQueryStates()`         |

**Important:** The `search-params.ts` file must import ALL parsers from `nuqs/server`, even though they're also available from `nuqs`. This is because `createLoader` runs on the server.

## Key Principles

1. **Define params once** - Share definitions between server and client via `search-params.ts`
2. **Always use `shallow: false`** - For filters that affect server data
3. **Always use `history: 'push'`** - Enable back/forward navigation
4. **Use Suspense keys** - Derived from search params for smooth loading states
5. **Debounce search inputs** - Use `throttleMs` to avoid excessive requests
6. **Set `null` to remove** - Setting a param to `null` removes it from the URL
