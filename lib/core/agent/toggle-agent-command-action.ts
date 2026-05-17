'use server'

import { Data, Effect } from 'effect'
import { revalidatePath } from 'next/cache'
import { cookies } from 'next/headers'
import { AppLayer } from '@/lib/layers'
import { NextEffect } from '@/lib/next-effect'
import { getSession } from '@/lib/services/auth/get-session'
import { reportError } from '@/lib/services/telemetry/report-error'
import { setAgentCommandEnabled } from './agent-command'

class AgentCommandActionError extends Data.TaggedError('AgentCommandActionError')<{
  readonly message: string
  readonly cause?: unknown
}> {}

export const toggleAgentCommandAction = async (input: {
  readonly id: string
  readonly enabled: boolean
}) => {
  await cookies()

  return await NextEffect.runPromise(
    Effect.gen(function* () {
      const session = yield* getSession()
      yield* setAgentCommandEnabled({ id: input.id, enabled: input.enabled, userId: session.user.id })
    }).pipe(
      Effect.withSpan('action.agentCommand.toggle'),
      Effect.provide(AppLayer),
      Effect.scoped,
      Effect.catchTag('UnauthenticatedError', () => NextEffect.redirect('/login')),
      Effect.catchTag('NotFoundError', () =>
        Effect.succeed({ _tag: 'Error' as const, message: 'Command not found' })
      ),
      Effect.tapError(error =>
        reportError(
          new AgentCommandActionError({ message: 'Toggle agent command failed', cause: error }),
          { operation: 'action.agentCommand.toggle' }
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
