import { Suspense } from 'react'
import { Effect } from 'effect'
import { cookies } from 'next/headers'
import { AppLayer } from '@/lib/layers'
import { getUserKnowledge } from '@/lib/core/knowledge/get-user-knowledge'
import { NextEffect } from '@/lib/next-effect'
import { getSession } from '@/lib/services/auth/get-session'
import { reportError } from '@/lib/services/telemetry/report-error'
import { CreateFileKnowledgeForm } from './create-file-knowledge-form'
import { CreateTextKnowledgeForm } from './create-text-knowledge-form'
import { KnowledgeDocumentList } from './knowledge-document-list'
import { SearchKnowledgeForm } from './search-knowledge-form'

export const dynamic = 'force-dynamic'

function KnowledgeSkeleton() {
  return <main className="mx-auto max-w-5xl p-6">Loading knowledge…</main>
}

async function Content() {
  await cookies()

  return await NextEffect.runPromise(
    Effect.gen(function* () {
      const session = yield* getSession()
      const items = yield* getUserKnowledge({ userId: session.user.id })

      return (
        <main className="mx-auto max-w-6xl space-y-6 p-6">
          <div className="flex flex-col gap-2 sm:flex-row sm:items-end sm:justify-between">
            <div className="space-y-1">
              <h1 className="text-2xl font-semibold tracking-tight">Knowledge</h1>
              <p className="max-w-2xl text-sm leading-6 text-muted-foreground">
                Durable agent context: vision, decisions, notes, and source-backed knowledge.
              </p>
            </div>
            <p className="text-sm text-muted-foreground tabular-nums">{items.length} documents</p>
          </div>
          <div className="grid gap-4 lg:grid-cols-2">
            <CreateTextKnowledgeForm />
            <CreateFileKnowledgeForm />
          </div>
          <SearchKnowledgeForm />
          <section className="space-y-3">
            <div className="flex items-end justify-between gap-3">
              <div>
                <h2 className="text-lg font-medium">Knowledge documents</h2>
                <p className="text-sm text-muted-foreground">
                  Pinned documents load into agent context.
                </p>
              </div>
              <p className="text-sm text-muted-foreground tabular-nums">{items.length} total</p>
            </div>
            <KnowledgeDocumentList items={items} />
          </section>
        </main>
      )
    }).pipe(
      Effect.withSpan('page.knowledge'),
      Effect.provide(AppLayer),
      Effect.scoped,
      Effect.catchTag('UnauthenticatedError', () => NextEffect.redirect('/login')),
      Effect.catch(error =>
        NextEffect.isNavigationError(error)
          ? Effect.fail(error)
          : reportError(error, { operation: 'page.knowledge' }).pipe(
              Effect.as(<main className="mx-auto max-w-6xl p-6">Could not load knowledge.</main>)
            )
      )
    )
  )
}

export default async function KnowledgePage() {
  return (
    <Suspense fallback={<KnowledgeSkeleton />}>
      <Content />
    </Suspense>
  )
}
