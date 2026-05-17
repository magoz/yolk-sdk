import Link from 'next/link'
import { Suspense } from 'react'
import { Effect } from 'effect'
import { cookies } from 'next/headers'
import { AppLayer } from '@/lib/layers'
import { listAgentSkills } from '@/lib/core/agent/agent-skill'
import { NextEffect } from '@/lib/next-effect'
import { getSession } from '@/lib/services/auth/get-session'
import { reportError } from '@/lib/services/telemetry/report-error'
import { CreateSkillForm, SkillList } from './skill-forms'

export const dynamic = 'force-dynamic'

function SkillsSkeleton() {
  return <main className="mx-auto max-w-3xl p-6">Loading skills…</main>
}

async function Content() {
  await cookies()

  return await NextEffect.runPromise(
    Effect.gen(function* () {
      const session = yield* getSession()
      const skills = yield* listAgentSkills({ userId: session.user.id })

      return (
        <main className="mx-auto max-w-3xl space-y-6 p-6">
          <div className="flex items-start justify-between gap-4">
            <div className="space-y-2">
              <h1 className="text-2xl font-semibold tracking-tight">Agent skills</h1>
              <p className="text-sm text-muted-foreground">
                Create reusable instructions for agent runs.
              </p>
            </div>
            <Link
              href="/agent"
              className="inline-flex h-9 items-center justify-center rounded-md border px-2.5 text-sm font-medium shadow-xs transition-[background-color,color] hover:bg-muted focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50"
            >
              Agent
            </Link>
          </div>
          <CreateSkillForm />
          <section className="space-y-3">
            <h2 className="text-lg font-medium">Skills</h2>
            <SkillList skills={skills} />
          </section>
        </main>
      )
    }).pipe(
      Effect.withSpan('page.agent.skills'),
      Effect.provide(AppLayer),
      Effect.scoped,
      Effect.catchTag('UnauthenticatedError', () => NextEffect.redirect('/login')),
      Effect.catch(error =>
        NextEffect.isNavigationError(error)
          ? Effect.fail(error)
          : reportError(error, { operation: 'page.agent.skills' }).pipe(
              Effect.as(<main className="mx-auto max-w-3xl p-6">Could not load skills.</main>)
            )
      )
    )
  )
}

export default async function AgentSkillsPage() {
  return (
    <Suspense fallback={<SkillsSkeleton />}>
      <Content />
    </Suspense>
  )
}
