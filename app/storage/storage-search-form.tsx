'use client'

import { useState, useTransition } from 'react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { searchUserStorageAction } from '@/lib/core/storage/search-user-storage-action'
import type { UserStorageSearchOutput } from '@/lib/core/storage/search-user-storage'

const scoreText = (label: string, value: number | undefined) =>
  value === undefined ? undefined : `${label} ${value.toFixed(3)}`

export function StorageSearchForm() {
  const [result, setResult] = useState<UserStorageSearchOutput | undefined>()
  const [message, setMessage] = useState<string | undefined>()
  const [isPending, startTransition] = useTransition()

  return (
    <form
      className="space-y-4 rounded-xl border bg-card p-4 text-card-foreground shadow-xs"
      action={formData => {
        const query = String(formData.get('query') ?? '')
        setMessage(undefined)

        startTransition(() => {
          void searchUserStorageAction({ query }).then(actionResult => {
            if (actionResult._tag === 'Success') {
              setResult(actionResult.result)
              setMessage(undefined)
            } else {
              setResult(undefined)
              setMessage(actionResult.message)
            }
          })
        })
      }}
    >
      <div className="space-y-1.5">
        <Label htmlFor="storage-search-query">Test retrieval</Label>
        <div className="flex flex-col gap-2 sm:flex-row">
          <Input
            id="storage-search-query"
            name="query"
            placeholder="Ask what storage knows"
            required
          />
          <Button type="submit" disabled={isPending} className="min-h-11 sm:min-h-9">
            {isPending ? 'Searching…' : 'Search'}
          </Button>
        </div>
        <p className="text-sm text-muted-foreground">
          Same hybrid retrieval used by the agent: semantic + exact keyword matches.
        </p>
      </div>

      {message ? (
        <p className="text-sm text-destructive" aria-live="polite">
          {message}
        </p>
      ) : null}

      {result ? (
        <div className="space-y-3" aria-live="polite">
          <div className="flex items-center justify-between gap-3 text-sm">
            <p className="font-medium">Results for “{result.query}”</p>
            <p className="text-muted-foreground tabular-nums">{result.results.length} matches</p>
          </div>
          {result.results.length === 0 ? (
            <p className="rounded-lg border border-dashed p-4 text-sm text-muted-foreground">
              No matching chunks.
            </p>
          ) : (
            <ol className="space-y-3">
              {result.results.map(item => (
                <li key={item.chunkId} className="rounded-lg border p-3">
                  <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                    <span className="font-medium text-foreground">Citation [{item.citation}]</span>
                    <span>{item.source}</span>
                    {[scoreText('score', item.score), scoreText('vector', item.vectorScore), scoreText('text', item.textScore), scoreText('fused', item.fusedScore)]
                      .filter(value => value !== undefined)
                      .map(value => (
                        <span key={value} className="rounded-full bg-muted px-2 py-0.5 tabular-nums">
                          {value}
                        </span>
                      ))}
                  </div>
                  <p className="mt-2 line-clamp-6 whitespace-pre-wrap text-sm leading-6">{item.text}</p>
                </li>
              ))}
            </ol>
          )}
        </div>
      ) : null}
    </form>
  )
}
