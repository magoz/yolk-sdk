import { and, eq } from 'drizzle-orm'
import { Context, Effect, Layer } from 'effect'
import * as Schema from 'effect/Schema'
import { Db } from '@/lib/services/db/live-layer'
import { agentWorkflowRun } from '@/lib/services/db/schema'
import {
  emptyWorkflowRegistry,
  transitionWorkflowRegistry,
  WorkflowRegistry,
  WorkflowRegistryError,
  type RegistryCommand
} from './registry'

export class WorkflowRunForbidden extends Schema.TaggedError<WorkflowRunForbidden>()(
  'WorkflowRunForbidden',
  {
    message: Schema.String
  }
) {}

const forbidden = () => new WorkflowRunForbidden({ message: 'Workflow run not found' })

const NonEmptyTrimmedId = Schema.Trimmed.pipe(Schema.check(Schema.isNonEmpty()))

export const WorkflowRunId = NonEmptyTrimmedId.pipe(Schema.brand('WorkflowRunId'))

export type WorkflowRunId = typeof WorkflowRunId.Type

export const UserId = NonEmptyTrimmedId.pipe(Schema.brand('UserId'))

export type UserId = typeof UserId.Type

export const decodeWorkflowOwnership = (input: {
  readonly runId: string
  readonly userId: string
}) =>
  Effect.gen(function* () {
    const runId = yield* Schema.decodeUnknownEffect(WorkflowRunId)(input.runId)
    const userId = yield* Schema.decodeUnknownEffect(UserId)(input.userId)

    return { runId, userId } as const
  })

export class AgentWorkflowStore extends Context.Service<AgentWorkflowStore>()(
  '@app/AgentWorkflowStore',
  {
    make: Effect.gen(function* () {
      const db = yield* Db

      const owned = (runId: WorkflowRunId, userId: UserId) =>
        and(eq(agentWorkflowRun.runId, runId), eq(agentWorkflowRun.userId, userId))

      return {
        register: (runId: WorkflowRunId, userId: UserId) =>
          Effect.gen(function* () {
            const registry = yield* Schema.encodeEffect(WorkflowRegistry)(emptyWorkflowRegistry())
            yield* db
              .insert(agentWorkflowRun)
              .values({ runId, userId, registry })
              .onConflictDoNothing()
            const [row] = yield* db.select().from(agentWorkflowRun).where(owned(runId, userId))

            if (row === undefined) return yield* Effect.fail(forbidden())
          }).pipe(Effect.withSpan('AgentWorkflowStore.register')),
        read: (runId: WorkflowRunId, userId: UserId) =>
          Effect.gen(function* () {
            const [row] = yield* db.select().from(agentWorkflowRun).where(owned(runId, userId))

            if (row === undefined) return yield* Effect.fail(forbidden())

            return yield* Schema.decodeUnknownEffect(WorkflowRegistry)(row.registry)
          }).pipe(Effect.withSpan('AgentWorkflowStore.read')),
        change: (runId: WorkflowRunId, userId: UserId, command: RegistryCommand) =>
          db
            .transaction(tx =>
              Effect.gen(function* () {
                // Admission, reservation, and Stop serialize on the SAME parent row.
                const [row] = yield* tx
                  .select()
                  .from(agentWorkflowRun)
                  .where(owned(runId, userId))
                  .for('update')

                if (row === undefined) return yield* Effect.fail(forbidden())
                const state = yield* Schema.decodeUnknownEffect(WorkflowRegistry)(row.registry)
                const next = transitionWorkflowRegistry(state, command)
                const registry = yield* Schema.encodeEffect(WorkflowRegistry)(next)

                const updated = yield* tx
                  .update(agentWorkflowRun)
                  .set({ registry })
                  .where(owned(runId, userId))
                  .returning()

                if (updated.length !== 1)
                  return yield* Effect.fail(
                    new WorkflowRegistryError({ message: 'Workflow registry update failed' })
                  )

                return next
              })
            )
            .pipe(Effect.withSpan('AgentWorkflowStore.change'))
      }
    })
  }
) {
  static layer = Layer.effect(this, this.make).pipe(Layer.provide(Db.layer))
}
