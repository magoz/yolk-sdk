import { Suspense } from 'react'
import { Effect } from 'effect'
import { cookies } from 'next/headers'
import { AppLayer } from '@/lib/layers'
import { NextEffect } from '@/lib/next-effect'
import { getUserStorage } from '@/lib/core/storage/get-user-storage'
import { getSession } from '@/lib/services/auth/get-session'
import { reportError } from '@/lib/services/telemetry/report-error'
import { CreateFileStorageForm } from './create-file-storage-form'
import { DeleteStorageSourceButton } from './delete-storage-source-button'

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
  [item.object.sourceType, formatBytes(item.object.byteSize)]
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

async function Content() {
  await cookies()

  return await NextEffect.runPromise(
    Effect.gen(function* () {
      const session = yield* getSession()
      const items = yield* getUserStorage({ userId: session.user.id })

      return (
        <main className="mx-auto max-w-6xl space-y-6 p-6">
          <div className="flex flex-col gap-2 sm:flex-row sm:items-end sm:justify-between">
            <div className="space-y-1">
              <h1 className="text-2xl font-semibold tracking-tight">Storage</h1>
              <p className="max-w-2xl text-sm leading-6 text-muted-foreground">
                Add files and manage the sources the agent can search.
              </p>
            </div>
            <p className="text-sm text-muted-foreground tabular-nums">{items.length} sources</p>
          </div>
          <CreateFileStorageForm />
          <section className="space-y-3">
            <div className="flex items-end justify-between gap-3">
              <div>
                <h2 className="text-lg font-medium">Ingested sources</h2>
                <p className="text-sm text-muted-foreground">All files currently in storage.</p>
              </div>
              <p className="text-sm text-muted-foreground tabular-nums">{items.length} total</p>
            </div>
            {items.length === 0 ? (
              <p className="rounded-lg border border-dashed p-6 text-sm text-muted-foreground">
                No sources yet.
              </p>
            ) : (
              <ul className="overflow-hidden rounded-xl border bg-card shadow-xs">
                {items.map(item => (
                  <li
                    key={item.object.id}
                    id={`source-${item.object.id}`}
                    className="scroll-mt-6 border-b last:border-b-0"
                  >
                    <div className="grid gap-3 p-4 md:grid-cols-[minmax(0,1fr)_120px_120px_170px_auto] md:items-center">
                      <div className="min-w-0 space-y-1">
                        <p className="truncate font-medium">{displayTitle(item)}</p>
                        <p className="truncate text-sm text-muted-foreground">{metadataLine(item)}</p>
                        {item.document?.summary ? (
                          <p className="line-clamp-2 text-sm leading-6 text-muted-foreground">
                            {item.document.summary}
                          </p>
                        ) : null}
                        {item.document?.errorMessage ? (
                          <p className="text-sm text-destructive">{item.document.errorMessage}</p>
                        ) : null}
                      </div>
                      <div
                        className={`w-fit rounded-full border px-2.5 py-1 text-xs font-medium ${statusClassName(item.document?.status ?? 'not indexed')}`}
                      >
                        {item.document?.status ?? 'not indexed'}
                      </div>
                      <p className="text-sm text-muted-foreground tabular-nums">
                        {item.document?.chunkCount ?? 0} chunks
                      </p>
                      <div className="text-sm text-muted-foreground">
                        <p>{formatDate(item.object.createdAt)}</p>
                        {item.document?.processedAt ? <p>Processed {formatDate(item.document.processedAt)}</p> : null}
                      </div>
                      <DeleteStorageSourceButton id={item.object.id} label={displayTitle(item)} />
                    </div>
                    {previewText(item.object.textContent) || item.object.contentHash ? (
                      <details className="border-t bg-muted/20 px-4 py-3">
                        <summary className="cursor-pointer text-sm font-medium">Details</summary>
                        {previewText(item.object.textContent) ? (
                          <p className="mt-3 whitespace-pre-wrap text-sm leading-6 text-muted-foreground">
                            {previewText(item.object.textContent)}
                          </p>
                        ) : null}
                        {item.object.contentHash ? (
                          <p className="mt-3 truncate text-xs text-muted-foreground">
                            Hash <span className="font-mono">{item.object.contentHash}</span>
                          </p>
                        ) : null}
                      </details>
                    ) : null}
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
              Effect.as(<main className="mx-auto max-w-6xl p-6">Could not load storage.</main>)
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
