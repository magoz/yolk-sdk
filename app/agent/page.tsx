import { Suspense } from 'react'
import { Effect } from 'effect'
import { cookies } from 'next/headers'
import { AppLayer } from '@/lib/layers'
import { NextEffect } from '@/lib/next-effect'
import { hasOpenAiCodexAuth } from '@/lib/core/agent/openai-codex-auth'
import { getSession } from '@/lib/services/auth/get-session'
import { reportError } from '@/lib/services/telemetry/report-error'
import { AgentPlayground } from './playground'

export const dynamic = 'force-dynamic'

function PageSkeleton() {
  return (
    <main className="min-h-screen bg-background p-6">
      <div className="mx-auto grid min-h-[calc(100vh-3rem)] max-w-5xl place-items-center">
        <div className="h-40 w-full max-w-2xl animate-pulse rounded-3xl bg-foreground/[0.03]" />
      </div>
    </main>
  )
}

function ErrorMessage() {
  return (
    <main className="min-h-screen bg-background p-6">
      <div className="mx-auto grid min-h-[calc(100vh-3rem)] max-w-3xl place-items-center">
        <div className="rounded-2xl border border-destructive/20 bg-destructive/5 p-6 text-sm text-destructive">
          Agent page failed to load.
        </div>
      </div>
    </main>
  )
}

async function Content() {
  await cookies()

  return await NextEffect.runPromise(
    Effect.gen(function* () {
      const session = yield* getSession()
      const openAiCodexConnected = yield* hasOpenAiCodexAuth(session.user.id)

      return (
        <AgentPlayground
          sessionId={`agent:${session.user.id}`}
          openAiCodexConnected={openAiCodexConnected}
        />
      )
    }).pipe(
      Effect.withSpan('page.agent'),
      Effect.provide(AppLayer),
      Effect.scoped,
      Effect.catchTag('UnauthenticatedError', () => NextEffect.redirect('/login')),
      Effect.catch(error =>
        reportError(error, { operation: 'page.agent' }).pipe(Effect.as(<ErrorMessage />))
      )
    )
  )
}

export default async function Page() {
  return (
    <Suspense fallback={<PageSkeleton />}>
      <Content />
    </Suspense>
  )
}
