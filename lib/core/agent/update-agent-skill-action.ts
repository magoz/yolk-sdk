'use server'

import { Data, Effect } from 'effect'
import { revalidatePath } from 'next/cache'
import { cookies } from 'next/headers'
import { AppLayer } from '@/lib/layers'
import { NextEffect } from '@/lib/next-effect'
import { getSession } from '@/lib/services/auth/get-session'
import { reportError } from '@/lib/services/telemetry/report-error'
import { upsertAgentCommand } from './agent-command'
import { updateAgentSkill, type AgentSkillUpdateInput } from './agent-skill'

class AgentSkillActionError extends Data.TaggedError('AgentSkillActionError')<{
  readonly message: string
  readonly cause?: unknown
}> {}

export const updateAgentSkillAction = async (
  input: AgentSkillUpdateInput & { readonly createCommand?: boolean; readonly commandName?: string }
) => {
  await cookies()

  return await NextEffect.runPromise(
    Effect.gen(function* () {
      const session = yield* getSession()
      const skill = yield* updateAgentSkill({ ...input, userId: session.user.id })

      if (input.createCommand === true) {
        const commandName = input.commandName?.trim()

        yield* upsertAgentCommand({
          userId: session.user.id,
          name: commandName === undefined || commandName.length === 0 ? skill.name : commandName,
          description: skill.description,
          template: `Use the ${skill.name} skill.\n\n$ARGUMENTS`
        })
      }
    }).pipe(
      Effect.withSpan('action.agentSkill.update'),
      Effect.provide(AppLayer),
      Effect.scoped,
      Effect.catchTag('UnauthenticatedError', () => NextEffect.redirect('/login')),
      Effect.catchTag('ValidationError', error =>
        Effect.succeed({ _tag: 'Error' as const, message: error.message })
      ),
      Effect.catchTag('NotFoundError', () =>
        Effect.succeed({ _tag: 'Error' as const, message: 'Skill not found' })
      ),
      Effect.tapError(error =>
        reportError(
          new AgentSkillActionError({ message: 'Update agent skill failed', cause: error }),
          { operation: 'action.agentSkill.update' }
        )
      ),
      Effect.tap(() =>
        Effect.sync(() => {
          revalidatePath('/agent')
          revalidatePath('/agent/skills')
        })
      ),
      Effect.as({ _tag: 'Success' as const }),
      Effect.catch(() => Effect.succeed({ _tag: 'Error' as const, message: 'Could not update skill' }))
    )
  )
}
