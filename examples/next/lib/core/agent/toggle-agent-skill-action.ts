'use server'

import { Data, Effect } from 'effect'
import { revalidatePath } from 'next/cache'
import { cookies } from 'next/headers'
import { AppLayer } from '@/lib/layers'
import { NextEffect } from '@/lib/next-effect'
import { getSession } from '@/lib/services/auth/get-session'
import { reportError } from '@/lib/services/telemetry/report-error'
import { setAgentSkillEnabled } from './agent-skill'

class AgentSkillActionError extends Data.TaggedError('AgentSkillActionError')<{
  readonly message: string
  readonly cause?: unknown
}> {}

export const toggleAgentSkillAction = async (input: {
  readonly id: string
  readonly enabled: boolean
}) => {
  await cookies()

  return await NextEffect.runPromise(
    Effect.gen(function* () {
      const session = yield* getSession()
      yield* Effect.annotateCurrentSpan({
        'user.id': session.user.id,
        'agent_skill.id': input.id,
        'agent_skill.enabled': input.enabled
      })
      yield* setAgentSkillEnabled({ id: input.id, enabled: input.enabled, userId: session.user.id })
    }).pipe(
      Effect.withSpan('action.agentSkill.toggle'),
      Effect.provide(AppLayer),
      Effect.scoped,
      Effect.catchTag('UnauthenticatedError', () => NextEffect.redirect('/login')),
      Effect.catchTag('NotFoundError', () =>
        Effect.succeed({ _tag: 'Error' as const, message: 'Skill not found' })
      ),
      Effect.tapError(error =>
        reportError(
          new AgentSkillActionError({ message: 'Toggle agent skill failed', cause: error }),
          { operation: 'action.agentSkill.toggle' }
        )
      ),
      Effect.tap(() =>
        Effect.sync(() => {
          revalidatePath('/agent')
          revalidatePath('/agent/skills')
        })
      ),
      Effect.as({ _tag: 'Success' as const }),
      Effect.catch(() =>
        Effect.succeed({ _tag: 'Error' as const, message: 'Could not update skill' })
      )
    )
  )
}
