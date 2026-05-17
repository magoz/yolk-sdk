'use server'

import { Data, Effect } from 'effect'
import { revalidatePath } from 'next/cache'
import { cookies } from 'next/headers'
import { AppLayer } from '@/lib/layers'
import { NextEffect } from '@/lib/next-effect'
import { getSession } from '@/lib/services/auth/get-session'
import { reportError } from '@/lib/services/telemetry/report-error'
import { updateAgentCommand, type AgentCommandUpdateInput } from './agent-command'

class AgentCommandActionError extends Data.TaggedError('AgentCommandActionError')<{
  readonly message: string
  readonly cause?: unknown
}> {}

export const updateAgentCommandAction = async (input: AgentCommandUpdateInput) => {
  await cookies()

  return await NextEffect.runPromise(
    Effect.gen(function* () {
      const session = yield* getSession()
      yield* updateAgentCommand({ ...input, userId: session.user.id })
    }).pipe(
      Effect.withSpan('action.agentCommand.update'),
      Effect.provide(AppLayer),
      Effect.scoped,
      Effect.catchTag('UnauthenticatedError', () => NextEffect.redirect('/login')),
      Effect.catchTag('ValidationError', error =>
        Effect.succeed({ _tag: 'Error' as const, message: error.message })
      ),
      Effect.catchTag('NotFoundError', () =>
        Effect.succeed({ _tag: 'Error' as const, message: 'Command not found' })
      ),
      Effect.tapError(error =>
        reportError(
          new AgentCommandActionError({ message: 'Update agent command failed', cause: error }),
          { operation: 'action.agentCommand.update' }
        )
      ),
      Effect.tap(() =>
        Effect.sync(() => {
          revalidatePath('/agent')
          revalidatePath('/agent/skills')
        })
      ),
      Effect.as({ _tag: 'Success' as const }),
      Effect.catch(() => Effect.succeed({ _tag: 'Error' as const, message: 'Could not update command' }))
    )
  )
}
