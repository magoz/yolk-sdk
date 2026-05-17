'use server'

import { Data, Effect } from 'effect'
import { revalidatePath } from 'next/cache'
import { cookies } from 'next/headers'
import { AppLayer } from '@/lib/layers'
import { NextEffect } from '@/lib/next-effect'
import { getSession } from '@/lib/services/auth/get-session'
import { reportError } from '@/lib/services/telemetry/report-error'
import { createAgentCommand, type AgentCommandInput } from './agent-command'

class AgentCommandActionError extends Data.TaggedError('AgentCommandActionError')<{
  readonly message: string
  readonly cause?: unknown
}> {}

export const createAgentCommandAction = async (input: AgentCommandInput) => {
  await cookies()

  return await NextEffect.runPromise(
    Effect.gen(function* () {
      const session = yield* getSession()
      yield* Effect.annotateCurrentSpan({
        'user.id': session.user.id,
        'agent_command.name': input.name
      })
      yield* createAgentCommand({ ...input, userId: session.user.id })
    }).pipe(
      Effect.withSpan('action.agentCommand.create'),
      Effect.provide(AppLayer),
      Effect.scoped,
      Effect.catchTag('UnauthenticatedError', () => NextEffect.redirect('/login')),
      Effect.catchTag('ValidationError', error =>
        Effect.succeed({ _tag: 'Error' as const, message: error.message })
      ),
      Effect.tapError(error =>
        reportError(
          new AgentCommandActionError({ message: 'Create agent command failed', cause: error }),
          { operation: 'action.agentCommand.create' }
        )
      ),
      Effect.tap(() =>
        Effect.sync(() => {
          revalidatePath('/agent')
          revalidatePath('/agent/skills')
        })
      ),
      Effect.as({ _tag: 'Success' as const }),
      Effect.catch(() => Effect.succeed({ _tag: 'Error' as const, message: 'Could not create command' }))
    )
  )
}
