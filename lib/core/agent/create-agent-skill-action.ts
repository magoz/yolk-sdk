'use server'

import { Data, Effect } from 'effect'
import { revalidatePath } from 'next/cache'
import { cookies } from 'next/headers'
import { AppLayer } from '@/lib/layers'
import { NextEffect } from '@/lib/next-effect'
import { getSession } from '@/lib/services/auth/get-session'
import { reportError } from '@/lib/services/telemetry/report-error'
import { createAgentSkill, type AgentSkillInput } from './agent-skill'

class AgentSkillActionError extends Data.TaggedError('AgentSkillActionError')<{
  readonly message: string
  readonly cause?: unknown
}> {}

export const createAgentSkillAction = async (input: AgentSkillInput) => {
  await cookies()

  return await NextEffect.runPromise(
    Effect.gen(function* () {
      const session = yield* getSession()
      yield* createAgentSkill({ ...input, userId: session.user.id })
    }).pipe(
      Effect.withSpan('action.agentSkill.create'),
      Effect.provide(AppLayer),
      Effect.scoped,
      Effect.catchTag('UnauthenticatedError', () => NextEffect.redirect('/login')),
      Effect.catchTag('ValidationError', error =>
        Effect.succeed({ _tag: 'Error' as const, message: error.message })
      ),
      Effect.tapError(error =>
        reportError(
          new AgentSkillActionError({ message: 'Create agent skill failed', cause: error }),
          { operation: 'action.agentSkill.create' }
        )
      ),
      Effect.tap(() =>
        Effect.sync(() => {
          revalidatePath('/agent')
          revalidatePath('/agent/skills')
        })
      ),
      Effect.as({ _tag: 'Success' as const }),
      Effect.catch(() => Effect.succeed({ _tag: 'Error' as const, message: 'Could not create skill' }))
    )
  )
}
