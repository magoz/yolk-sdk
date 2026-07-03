'use client'

import { useState, useTransition } from 'react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { searchUserKnowledgeAction } from '@/lib/core/knowledge/search-user-knowledge-action'
import type { KnowledgeSearchActionResult } from '@/lib/core/knowledge/search-user-knowledge-action-result'

type SearchResult = Extract<
  KnowledgeSearchActionResult,
  { readonly _tag: 'Success' }
>['results'][number]

const formatScore = (score: number) => score.toFixed(3)

export function SearchKnowledgeForm() {
  const [query, setQuery] = useState('')
  const [message, setMessage] = useState<string | undefined>()
  const [results, setResults] = useState<ReadonlyArray<SearchResult>>([])
  const [isPending, startTransition] = useTransition()

  return (
    <section className="space-y-4 rounded-xl border bg-card p-5 text-card-foreground shadow-xs">
      <div>
        <h2 className="font-medium">Search knowledge</h2>
        <p className="text-sm text-muted-foreground">
          Query search chunks before asking the agent.
        </p>
      </div>
      <form
        className="flex flex-col gap-3 sm:flex-row sm:items-end"
        onSubmit={event => {
          event.preventDefault()
          const trimmed = query.trim()
          if (trimmed.length === 0) {
            setMessage('Enter a query')
            return
          }

          startTransition(async () => {
            const result = await searchUserKnowledgeAction({ query: trimmed, limit: 6 })
            if (result._tag === 'Success') {
              setResults(result.results)
              setMessage(
                result.results.length === 0 ? 'No matches' : `${result.results.length} matches`
              )
            } else {
              setResults([])
              setMessage(result.message)
            }
          })
        }}
      >
        <div className="grid flex-1 gap-2">
          <Label htmlFor="knowledge-search">Query</Label>
          <Input
            id="knowledge-search"
            value={query}
            onChange={event => setQuery(event.currentTarget.value)}
            placeholder="Search decisions, notes, uploaded files…"
          />
        </div>
        <Button type="submit" disabled={isPending || query.trim().length === 0}>
          {isPending ? 'Searching…' : 'Search'}
        </Button>
      </form>
      {message ? (
        <p className="text-sm text-muted-foreground" aria-live="polite">
          {message}
        </p>
      ) : null}
      {results.length > 0 ? (
        <ol className="space-y-3">
          {results.map(result => (
            <li
              key={`${result.documentId}-${result.chunkId}`}
              className="rounded-lg border bg-muted/20 p-4"
            >
              <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                <span className="font-medium text-foreground">{result.title}</span>
                <span>{result.purpose}</span>
                <span>{result.origin}</span>
                <span>{result.availability}</span>
                <span>score {formatScore(result.score)}</span>
                {result.vectorScore === undefined ? null : (
                  <span>vector {formatScore(result.vectorScore)}</span>
                )}
                {result.textScore === undefined ? null : (
                  <span>text {formatScore(result.textScore)}</span>
                )}
              </div>
              <p className="mt-2 line-clamp-4 whitespace-pre-wrap text-sm leading-6 text-muted-foreground">
                {result.text}
              </p>
            </li>
          ))}
        </ol>
      ) : null}
    </section>
  )
}
