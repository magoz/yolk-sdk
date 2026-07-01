'use client'

import { useOptimistic } from 'react'
import { DeleteKnowledgeDocumentButton } from './delete-knowledge-document-button'
import { UpdateKnowledgeAvailabilityButton } from './update-knowledge-availability-button'
import type { KnowledgeAvailability } from '@/lib/core/knowledge/availability'

type KnowledgeDocumentListItem = {
  readonly document: {
    readonly id: string
    readonly title: string
    readonly purpose: string
    readonly origin: string
    readonly content: string
    readonly summary: string | null
    readonly availability: KnowledgeAvailability
    readonly status: string
    readonly errorMessage: string | null
    readonly createdAt: Date
    readonly updatedAt: Date
  }
  readonly file: {
    readonly id: string
    readonly mediaType: string | null
    readonly byteSize: number | null
    readonly storageKey: string
  } | null
}

const formatDate = (date: Date) =>
  new Intl.DateTimeFormat('en', { dateStyle: 'medium', timeStyle: 'short' }).format(date)

const previewText = (item: KnowledgeDocumentListItem) => {
  const text = item.document.content ?? item.document.summary
  if (text === null || text === undefined) return undefined

  const trimmed = text.trim()
  if (trimmed.length === 0) return undefined

  return trimmed.length <= 500 ? trimmed : `${trimmed.slice(0, 500)}…`
}

const availabilityClassName = (availability: KnowledgeAvailability) => {
  switch (availability) {
    case 'pinned':
      return 'border-emerald-200 bg-emerald-50 text-emerald-700 dark:border-emerald-900/60 dark:bg-emerald-950/40 dark:text-emerald-300'
    case 'archived':
      return 'border-muted bg-muted text-muted-foreground'
    default:
      return 'border-border bg-background text-muted-foreground'
  }
}

const formatBytes = (bytes: number | null | undefined) => {
  if (bytes === null || bytes === undefined) return undefined
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

const statusClassName = (status: string | undefined) => {
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

const fileDownloadHref = (input: { readonly documentId: string; readonly fileId: string }) =>
  `/api/knowledge/files?documentId=${encodeURIComponent(input.documentId)}&fileId=${encodeURIComponent(input.fileId)}`

export function KnowledgeDocumentList({ items }: { readonly items: ReadonlyArray<KnowledgeDocumentListItem> }) {
  const [optimisticItems, removeOptimisticItem] = useOptimistic(
    items,
    (state, deletedId: string) => state.filter(item => item.document.id !== deletedId)
  )

  if (optimisticItems.length === 0) {
    return <p className="rounded-lg border border-dashed p-6 text-sm text-muted-foreground">No knowledge yet.</p>
  }

  return (
    <ul className="overflow-hidden rounded-xl border bg-card shadow-xs">
      {optimisticItems.map(item => (
        <li key={item.document.id} className="border-b last:border-b-0">
          <div className="p-4">
            <div className="grid gap-3 md:grid-cols-[minmax(0,1fr)_120px_170px_auto] md:items-center">
              <div className="min-w-0 space-y-1">
                <p className="truncate font-medium">{item.document.title}</p>
                <p className="text-sm text-muted-foreground">
                  {[item.document.purpose, item.document.origin, item.file?.mediaType, formatBytes(item.file?.byteSize)].filter(Boolean).join(' · ')}
                </p>
                {previewText(item) ? <p className="line-clamp-3 text-sm leading-6 text-muted-foreground">{previewText(item)}</p> : null}
              </div>
              <div className={`w-fit rounded-full border px-2.5 py-1 text-xs font-medium ${availabilityClassName(item.document.availability)}`}>
                {item.document.availability}
              </div>
              <p className="text-sm text-muted-foreground">{formatDate(item.document.updatedAt)}</p>
              <div className="flex flex-wrap items-center gap-2">
                <UpdateKnowledgeAvailabilityButton id={item.document.id} label={item.document.title} availability={item.document.availability} />
                <DeleteKnowledgeDocumentButton id={item.document.id} label={item.document.title} onDeleteOptimistic={removeOptimisticItem} />
              </div>
            </div>
          </div>
          <details className="border-t bg-muted/20 px-4 py-3">
            <summary className="cursor-pointer text-sm font-medium">Details</summary>
            <div className="mt-3 grid gap-3 text-sm text-muted-foreground md:grid-cols-2">
              <div className="space-y-1">
                <p>ID <span className="font-mono">{item.document.id}</span></p>
                <p>Created {formatDate(item.document.createdAt)}</p>
                <p>Updated {formatDate(item.document.updatedAt)}</p>
                <p>
                  Index{' '}
                  <span className={`rounded-full border px-2 py-0.5 text-xs ${statusClassName(item.document.status)}`}>
                    {item.document.status}
                  </span>
                </p>
                {item.document.errorMessage ? <p className="text-destructive">{item.document.errorMessage}</p> : null}
              </div>
              <div className="space-y-1">
                {item.file ? (
                  <>
                    <p>File <span className="font-mono">{item.file.id}</span></p>
                    <p>Storage key <span className="font-mono">{item.file.storageKey}</span></p>
                    <p>{[item.file.mediaType, formatBytes(item.file.byteSize)].filter(Boolean).join(' · ')}</p>
                    <p>
                      <a className="font-medium text-foreground underline underline-offset-4 hover:text-muted-foreground" href={fileDownloadHref({ documentId: item.document.id, fileId: item.file.id })}>
                        Download file
                      </a>
                    </p>
                  </>
                ) : <p>No file</p>}
              </div>
            </div>
            {previewText(item) ? (
              <p className="mt-3 max-h-80 overflow-auto whitespace-pre-wrap rounded-lg border bg-background p-3 text-sm leading-6 text-muted-foreground">
                {previewText(item)}
              </p>
            ) : null}
          </details>
        </li>
      ))}
    </ul>
  )
}
