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

export class WorkflowRunForbidden extends Schema.TaggedErrorClass<WorkflowRunForbidden>()(
  'WorkflowRunForbidden',
  {
    message: Schema.String
  }
) {}

const forbidden = () => new WorkflowRunForbidden({ message: 'Workflow run not found' })

export class AgentWorkflowStore extends Context.Service<AgentWorkflowStore>()(
  '@app/AgentWorkflowStore',
  {
    make: Effect.gen(function* () {
      const db = yield* Db
      const owned = (runId: string, userId: string) =>
        and(eq(agentWorkflowRun.runId, runId), eq(agentWorkflowRun.userId, userId))
      return {
        register: (runId: string, userId: string) =>
          Effect.gen(function* () {
            const registry = yield* Schema.encodeEffect(WorkflowRegistry)(emptyWorkflowRegistry())
            yield* db
              .insert(agentWorkflowRun)
              .values({ runId, userId, registry })
              .onConflictDoNothing()
            const [row] = yield* db.select().from(agentWorkflowRun).where(owned(runId, userId))
            if (row === undefined) return yield* Effect.fail(forbidden())
          }).pipe(Effect.withSpan('AgentWorkflowStore.register')),
        read: (runId: string, userId: string) =>
          Effect.gen(function* () {
            const [row] = yield* db.select().from(agentWorkflowRun).where(owned(runId, userId))
            if (row === undefined) return yield* Effect.fail(forbidden())
            return yield* Schema.decodeUnknownEffect(WorkflowRegistry)(row.registry)
          }).pipe(Effect.withSpan('AgentWorkflowStore.read')),
        change: (runId: string, userId: string, command: RegistryCommand) =>
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
