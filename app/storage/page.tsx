import { Suspense } from 'react'
import { Effect } from 'effect'
import { cookies } from 'next/headers'
import { AppLayer } from '@/lib/layers'
import { NextEffect } from '@/lib/next-effect'
import { getUserStorage } from '@/lib/core/storage/get-user-storage'
import { getSession } from '@/lib/services/auth/get-session'
import { reportError } from '@/lib/services/telemetry/report-error'
import { CreateTextStorageForm } from './create-text-storage-form'

export const dynamic = 'force-dynamic'

function StorageSkeleton() {
  return <main className="mx-auto max-w-3xl p-6">Loading storage…</main>
}

async function Content() {
  await cookies()

  return await NextEffect.runPromise(
    Effect.gen(function* () {
      const session = yield* getSession()
      const items = yield* getUserStorage({ userId: session.user.id })

      return (
        <main className="mx-auto max-w-3xl space-y-6 p-6">
          <div className="space-y-2">
            <h1 className="text-2xl font-semibold tracking-tight">Storage</h1>
            <p className="text-sm text-muted-foreground">
              Add text sources and index them for retrieval.
            </p>
          </div>
          <CreateTextStorageForm />
          <section className="space-y-3">
            <h2 className="text-lg font-medium">Sources</h2>
            {items.length === 0 ? (
              <p className="rounded-lg border border-dashed p-6 text-sm text-muted-foreground">
                No sources yet.
              </p>
            ) : (
              <ul className="divide-y rounded-lg border">
                {items.map(item => (
                  <li key={item.object.id} className="flex items-center justify-between gap-4 p-4">
                    <div>
                      <p className="font-medium">{item.object.filename ?? 'Untitled'}</p>
                      <p className="text-sm text-muted-foreground">{item.object.sourceType}</p>
                    </div>
                    <span className="text-sm text-muted-foreground">
                      {item.document?.status ?? 'not indexed'}
                    </span>
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
              Effect.as(<main className="mx-auto max-w-3xl p-6">Could not load storage.</main>)
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
