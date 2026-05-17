'use server'

import { Data, Effect } from 'effect'
import { revalidatePath } from 'next/cache'
import { cookies } from 'next/headers'
import { AppLayer } from '@/lib/layers'
import { NextEffect } from '@/lib/next-effect'
import { getSession } from '@/lib/services/auth/get-session'
import { reportError } from '@/lib/services/telemetry/report-error'
import { createAgentSkillWithCommand, type AgentSkillInput } from './agent-skill'

class AgentSkillActionError extends Data.TaggedError('AgentSkillActionError')<{
  readonly message: string
  readonly cause?: unknown
}> {}

export const createAgentSkillAction = async (
  input: AgentSkillInput & { readonly createCommand?: boolean; readonly commandName?: string }
) => {
  await cookies()

  return await NextEffect.runPromise(
    Effect.gen(function* () {
      const session = yield* getSession()
      const commandName = input.commandName?.trim()
      yield* Effect.annotateCurrentSpan({
        'user.id': session.user.id,
        'agent_skill.name': input.name,
        'agent_skill.create_command': input.createCommand === true,
        'agent_command.name': commandName === undefined || commandName.length === 0 ? input.name : commandName
      })

      yield* createAgentSkillWithCommand({
        ...input,
        userId: session.user.id,
        commandInput:
          input.createCommand === true
            ? {
                _tag: 'CreateCommand',
                command: {
                  name: commandName === undefined || commandName.length === 0 ? input.name : commandName,
                  description: input.description,
                  template: `Use the ${input.name} skill.\n\n$ARGUMENTS`
                }
              }
            : { _tag: 'SkipCommand' }
      })
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
