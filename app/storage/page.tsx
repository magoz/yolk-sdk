import { Suspense } from 'react'
import { Effect } from 'effect'
import { cookies } from 'next/headers'
import { AppLayer } from '@/lib/layers'
import { NextEffect } from '@/lib/next-effect'
import {
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle
} from '@/components/ui/card'
import { getUserStorage } from '@/lib/core/storage/get-user-storage'
import { getSession } from '@/lib/services/auth/get-session'
import { reportError } from '@/lib/services/telemetry/report-error'
import { CreateTextStorageForm } from './create-text-storage-form'
import { DeleteStorageSourceButton } from './delete-storage-source-button'
import { StorageSearchForm } from './storage-search-form'

export const dynamic = 'force-dynamic'

function StorageSkeleton() {
  return <main className="mx-auto max-w-5xl p-6">Loading storage…</main>
}

const formatBytes = (bytes: number | null) => {
  if (bytes === null) {
    return undefined
  }

  if (bytes < 1024) {
    return `${bytes} B`
  }

  if (bytes < 1024 * 1024) {
    return `${(bytes / 1024).toFixed(1)} KB`
  }

  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

const formatDate = (date: Date) =>
  new Intl.DateTimeFormat('en', { dateStyle: 'medium', timeStyle: 'short' }).format(date)

type StorageListItem = {
  readonly object: {
    readonly id: string
    readonly sourceType: string
    readonly filename: string | null
    readonly mediaType: string | null
    readonly byteSize: number | null
    readonly textContent: string | null
    readonly contentHash: string | null
    readonly createdAt: Date
  }
  readonly document: {
    readonly title: string | null
    readonly summary: string | null
    readonly errorMessage: string | null
    readonly status: string
    readonly chunkCount: number
    readonly tokenCount: number
    readonly processedAt: Date | null
  } | null
}

const statusClassName = (status: string) => {
  switch (status) {
    case 'ready':
      return 'border-emerald-200 bg-emerald-50 text-emerald-700 dark:border-emerald-900/60 dark:bg-emerald-950/40 dark:text-emerald-300'
    case 'processing':
      return 'border-sky-200 bg-sky-50 text-sky-700 dark:border-sky-900/60 dark:bg-sky-950/40 dark:text-sky-300'
    case 'pending':
      return 'border-amber-200 bg-amber-50 text-amber-700 dark:border-amber-900/60 dark:bg-amber-950/40 dark:text-amber-300'
    case 'error':
      return 'border-destructive/30 bg-destructive/10 text-destructive'
    default:
      return 'border-border bg-muted text-muted-foreground'
  }
}

const displayTitle = (item: StorageListItem) =>
  item.document?.title ?? item.object.filename ?? 'Untitled'

const nonEmptyString = (value: string | undefined | null): value is string =>
  value !== undefined && value !== null && value.length > 0

const metadataLine = (item: StorageListItem) =>
  [item.object.sourceType, item.object.mediaType, formatBytes(item.object.byteSize)]
    .filter(nonEmptyString)
    .join(' · ')

const previewText = (text: string | null) => {
  if (text === null) {
    return undefined
  }

  const trimmed = text.trim()
  if (trimmed.length === 0) {
    return undefined
  }

  if (trimmed.length <= 900) {
    return trimmed
  }

  return `${trimmed.slice(0, 900)}…`
}

const storageStats = (items: ReadonlyArray<StorageListItem>) => {
  const ready = items.filter(item => item.document?.status === 'ready').length
  const errors = items.filter(item => item.document?.status === 'error').length
  const chunks = items.reduce((sum, item) => sum + (item.document?.chunkCount ?? 0), 0)
  const tokens = items.reduce((sum, item) => sum + (item.document?.tokenCount ?? 0), 0)

  return { ready, errors, chunks, tokens }
}

async function Content() {
  await cookies()

  return await NextEffect.runPromise(
    Effect.gen(function* () {
      const session = yield* getSession()
      const items = yield* getUserStorage({ userId: session.user.id })
      const stats = storageStats(items)

      return (
        <main className="mx-auto max-w-5xl space-y-6 p-6">
          <div className="space-y-2">
            <p className="text-sm font-medium text-muted-foreground">Knowledge cockpit</p>
            <h1 className="text-3xl font-semibold tracking-tight">Storage</h1>
            <p className="max-w-2xl text-sm leading-6 text-muted-foreground">
              Add sources, inspect indexing, and test what the agent can retrieve.
            </p>
          </div>
          <dl className="grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
            <div className="rounded-xl border bg-card p-4 shadow-xs">
              <dt className="text-sm text-muted-foreground">Sources</dt>
              <dd className="mt-1 text-2xl font-semibold tabular-nums">{items.length}</dd>
            </div>
            <div className="rounded-xl border bg-card p-4 shadow-xs">
              <dt className="text-sm text-muted-foreground">Ready</dt>
              <dd className="mt-1 text-2xl font-semibold tabular-nums">{stats.ready}</dd>
            </div>
            <div className="rounded-xl border bg-card p-4 shadow-xs">
              <dt className="text-sm text-muted-foreground">Chunks</dt>
              <dd className="mt-1 text-2xl font-semibold tabular-nums">{stats.chunks}</dd>
            </div>
            <div className="rounded-xl border bg-card p-4 shadow-xs">
              <dt className="text-sm text-muted-foreground">Tokens</dt>
              <dd className="mt-1 text-2xl font-semibold tabular-nums">{stats.tokens}</dd>
            </div>
            <div className="rounded-xl border bg-card p-4 shadow-xs">
              <dt className="text-sm text-muted-foreground">Errors</dt>
              <dd className="mt-1 text-2xl font-semibold tabular-nums">{stats.errors}</dd>
            </div>
          </dl>
          <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(320px,420px)]">
            <CreateTextStorageForm />
            <StorageSearchForm readyCount={stats.ready} />
          </div>
          <section className="space-y-3">
            <div className="flex items-end justify-between gap-3">
              <div>
                <h2 className="text-lg font-medium">Sources</h2>
                <p className="text-sm text-muted-foreground">Indexed files and pasted text.</p>
              </div>
              <p className="text-sm text-muted-foreground tabular-nums">{items.length} total</p>
            </div>
            {items.length === 0 ? (
              <p className="rounded-lg border border-dashed p-6 text-sm text-muted-foreground">
                No sources yet.
              </p>
            ) : (
              <ul className="grid gap-3">
                {items.map(item => (
                  <li key={item.object.id} id={`source-${item.object.id}`} className="scroll-mt-6">
                    <Card size="sm">
                      <CardHeader>
                        <CardTitle>{displayTitle(item)}</CardTitle>
                        <CardDescription>{metadataLine(item)}</CardDescription>
                        <CardAction className="flex items-center gap-2">
                          <div
                            className={`rounded-full border px-2.5 py-1 text-xs font-medium ${statusClassName(item.document?.status ?? 'not indexed')}`}
                          >
                            {item.document?.status ?? 'not indexed'}
                          </div>
                          <DeleteStorageSourceButton id={item.object.id} label={displayTitle(item)} />
                        </CardAction>
                      </CardHeader>
                      <CardContent className="space-y-3">
                        {item.document?.summary ? (
                          <p className="text-sm leading-6 text-muted-foreground">
                            {item.document.summary}
                          </p>
                        ) : null}
                        {item.document?.errorMessage ? (
                          <p className="rounded-lg border border-destructive/30 bg-destructive/10 p-3 text-sm text-destructive">
                            {item.document.errorMessage}
                          </p>
                        ) : null}
                        {previewText(item.object.textContent) ? (
                          <details className="rounded-lg border bg-muted/30 p-3">
                            <summary className="cursor-pointer text-sm font-medium">Source preview</summary>
                            <p className="mt-3 whitespace-pre-wrap text-sm leading-6 text-muted-foreground">
                              {previewText(item.object.textContent)}
                            </p>
                          </details>
                        ) : null}
                        <dl className="grid gap-2 text-sm sm:grid-cols-2 lg:grid-cols-4">
                          <div>
                            <dt className="text-muted-foreground">Chunks</dt>
                            <dd className="font-medium tabular-nums">
                              {item.document?.chunkCount ?? 0}
                            </dd>
                          </div>
                          <div>
                            <dt className="text-muted-foreground">Tokens</dt>
                            <dd className="font-medium tabular-nums">
                              {item.document?.tokenCount ?? 0}
                            </dd>
                          </div>
                          <div>
                            <dt className="text-muted-foreground">Created</dt>
                            <dd className="font-medium">{formatDate(item.object.createdAt)}</dd>
                          </div>
                          <div>
                            <dt className="text-muted-foreground">Processed</dt>
                            <dd className="font-medium">
                              {item.document?.processedAt ? formatDate(item.document.processedAt) : '—'}
                            </dd>
                          </div>
                        </dl>
                        {item.object.contentHash ? (
                          <p className="truncate text-xs text-muted-foreground">
                            Hash <span className="font-mono">{item.object.contentHash}</span>
                          </p>
                        ) : null}
                      </CardContent>
                    </Card>
                  </li>
                ))}
              </ul>
            )}
          </section>
        </main>
      )
    }).pipe(
      Effect.withSpan('page.storage'),
      Effect.provide(AppLayer),
      Effect.scoped,
      Effect.catchTag('UnauthenticatedError', () => NextEffect.redirect('/login')),
      Effect.catch(error =>
        NextEffect.isNavigationError(error)
          ? Effect.fail(error)
          : reportError(error, { operation: 'page.storage' }).pipe(
              Effect.as(<main className="mx-auto max-w-5xl p-6">Could not load storage.</main>)
            )
      )
    )
  )
}

export default async function StoragePage() {
  return (
    <Suspense fallback={<StorageSkeleton />}>
      <Content />
    </Suspense>
  )
}
