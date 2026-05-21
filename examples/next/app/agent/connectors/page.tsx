import Link from 'next/link'
import { Suspense } from 'react'
import { Effect } from 'effect'
import { cookies } from 'next/headers'
import { AppLayer } from '@/lib/layers'
import { getTelegramConnectorStatus } from '@/lib/core/agent/telegram-connector'
import { NextEffect } from '@/lib/next-effect'
import { getSession } from '@/lib/services/auth/get-session'
import { reportError } from '@/lib/services/telemetry/report-error'
import { TelegramConnectorForm } from './telegram-connector-form'

export const dynamic = 'force-dynamic'

function ConnectorsSkeleton() {
  return <main className="mx-auto max-w-3xl p-6">Loading connectors…</main>
}

async function Content() {
  await cookies()

  return await NextEffect.runPromise(
    Effect.gen(function* () {
      const session = yield* getSession()
      const telegramStatus = yield* getTelegramConnectorStatus(session.user.id)

      return (
        <main className="mx-auto max-w-3xl space-y-6 p-6">
          <div className="flex items-start justify-between gap-4">
            <div className="space-y-2">
              <h1 className="text-2xl font-semibold tracking-tight">Agent connectors</h1>
              <p className="text-sm text-muted-foreground">
                Configure external tools available to the agent.
              </p>
            </div>
            <Link
              href="/agent"
              className="inline-flex h-9 items-center justify-center rounded-md border px-2.5 text-sm font-medium shadow-xs transition-[background-color,color] hover:bg-muted focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50"
            >
              Agent
            </Link>
          </div>

          <TelegramConnectorForm
            initialConnected={telegramStatus._tag === 'Connected'}
            initialChatId={telegramStatus._tag === 'Connected' ? telegramStatus.chatId : undefined}
          />
        </main>
      )
    }).pipe(
      Effect.withSpan('page.agent.connectors'),
      Effect.provide(AppLayer),
      Effect.scoped,
      Effect.catchTag('UnauthenticatedError', () => NextEffect.redirect('/login')),
      Effect.catch(error =>
        NextEffect.isNavigationError(error)
          ? Effect.fail(error)
          : reportError(error, { operation: 'page.agent.connectors' }).pipe(
              Effect.as(<main className="mx-auto max-w-3xl p-6">Could not load connectors.</main>)
            )
      )
    )
  )
}

export default async function AgentConnectorsPage() {
  return (
    <Suspense fallback={<ConnectorsSkeleton />}>
      <Content />
    </Suspense>
  )
}
