'use client'

import { useOptimistic } from 'react'
import { DeleteKnowledgeRecordButton } from './delete-knowledge-record-button'
import { UpdateKnowledgeContextPolicyButton } from './update-knowledge-context-policy-button'

type KnowledgeContextPolicy = 'pinned' | 'routable' | 'searchable' | 'archival'

type KnowledgeRecordListItem = {
  readonly object: {
    readonly id: string
    readonly title: string
    readonly role: string
    readonly summary: string | null
    readonly contextPolicy: KnowledgeContextPolicy
    readonly createdAt: Date
    readonly updatedAt: Date
  }
  readonly artifact: {
    readonly id: string
    readonly kind: string
    readonly mediaType: string | null
    readonly byteSize: number | null
    readonly storageKey: string
  } | null
  readonly representation: {
    readonly contentText: string | null
    readonly status: string
    readonly errorMessage: string | null
  } | null
}

const formatDate = (date: Date) =>
  new Intl.DateTimeFormat('en', { dateStyle: 'medium', timeStyle: 'short' }).format(date)

const previewText = (item: KnowledgeRecordListItem) => {
  const text = item.representation?.contentText ?? item.object.summary
  if (text === null || text === undefined) return undefined

  const trimmed = text.trim()
  if (trimmed.length === 0) return undefined

  return trimmed.length <= 500 ? trimmed : `${trimmed.slice(0, 500)}…`
}

const policyClassName = (policy: string) => {
  switch (policy) {
    case 'pinned':
      return 'border-emerald-200 bg-emerald-50 text-emerald-700 dark:border-emerald-900/60 dark:bg-emerald-950/40 dark:text-emerald-300'
    case 'routable':
      return 'border-sky-200 bg-sky-50 text-sky-700 dark:border-sky-900/60 dark:bg-sky-950/40 dark:text-sky-300'
    case 'archival':
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
    case 'pending':
      return 'border-amber-200 bg-amber-50 text-amber-700 dark:border-amber-900/60 dark:bg-amber-950/40 dark:text-amber-300'
    case 'error':
      return 'border-destructive/30 bg-destructive/10 text-destructive'
    default:
      return 'border-border bg-muted text-muted-foreground'
  }
}

const artifactDownloadHref = (input: { readonly recordId: string; readonly artifactId: string }) =>
  `/api/knowledge/artifacts?recordId=${encodeURIComponent(input.recordId)}&artifactId=${encodeURIComponent(input.artifactId)}`

export function KnowledgeRecordList({ items }: { readonly items: ReadonlyArray<KnowledgeRecordListItem> }) {
  const [optimisticItems, removeOptimisticItem] = useOptimistic(
    items,
    (state, deletedId: string) => state.filter(item => item.object.id !== deletedId)
  )

  if (optimisticItems.length === 0) {
    return <p className="rounded-lg border border-dashed p-6 text-sm text-muted-foreground">No knowledge yet.</p>
  }

  return (
    <ul className="overflow-hidden rounded-xl border bg-card shadow-xs">
      {optimisticItems.map(item => (
        <li key={item.object.id} className="border-b last:border-b-0">
          <div className="p-4">
            <div className="grid gap-3 md:grid-cols-[minmax(0,1fr)_120px_170px_auto] md:items-center">
              <div className="min-w-0 space-y-1">
                <p className="truncate font-medium">{item.object.title}</p>
                <p className="text-sm text-muted-foreground">
                  {[item.object.role, item.artifact?.kind, item.artifact?.mediaType, formatBytes(item.artifact?.byteSize)].filter(Boolean).join(' · ')}
                </p>
                {previewText(item) ? <p className="line-clamp-3 text-sm leading-6 text-muted-foreground">{previewText(item)}</p> : null}
              </div>
              <div className={`w-fit rounded-full border px-2.5 py-1 text-xs font-medium ${policyClassName(item.object.contextPolicy)}`}>
                {item.object.contextPolicy}
              </div>
              <p className="text-sm text-muted-foreground">{formatDate(item.object.updatedAt)}</p>
              <div className="flex flex-wrap items-center gap-2">
                <UpdateKnowledgeContextPolicyButton id={item.object.id} label={item.object.title} contextPolicy={item.object.contextPolicy} />
                <DeleteKnowledgeRecordButton id={item.object.id} label={item.object.title} onDeleteOptimistic={removeOptimisticItem} />
              </div>
            </div>
          </div>
          <details className="border-t bg-muted/20 px-4 py-3">
            <summary className="cursor-pointer text-sm font-medium">Details</summary>
            <div className="mt-3 grid gap-3 text-sm text-muted-foreground md:grid-cols-2">
              <div className="space-y-1">
                <p>ID <span className="font-mono">{item.object.id}</span></p>
                <p>Created {formatDate(item.object.createdAt)}</p>
                <p>Updated {formatDate(item.object.updatedAt)}</p>
                <p>
                  Index{' '}
                  <span className={`rounded-full border px-2 py-0.5 text-xs ${statusClassName(item.representation?.status)}`}>
                    {item.representation?.status ?? 'none'}
                  </span>
                </p>
                {item.representation?.errorMessage ? <p className="text-destructive">{item.representation.errorMessage}</p> : null}
              </div>
              <div className="space-y-1">
                {item.artifact ? (
                  <>
                    <p>Artifact <span className="font-mono">{item.artifact.id}</span></p>
                    <p>Storage key <span className="font-mono">{item.artifact.storageKey}</span></p>
                    <p>{[item.artifact.kind, item.artifact.mediaType, formatBytes(item.artifact.byteSize)].filter(Boolean).join(' · ')}</p>
                    <p>
                      <a className="font-medium text-foreground underline underline-offset-4 hover:text-muted-foreground" href={artifactDownloadHref({ recordId: item.object.id, artifactId: item.artifact.id })}>
                        Download artifact
                      </a>
                    </p>
                  </>
                ) : <p>No artifact</p>}
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
