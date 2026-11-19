import { DurableObject } from 'cloudflare:workers'
import { WorkflowExecution, type ExecutionHost } from './execution.ts'
import { runNamespace, type RunOutcome, type StartRunInput } from './namespace.ts'
import { makeHookIndex, makeSqliteRunStore } from './sqlite-store.ts'
import type { RunStore } from './store.ts'

type Reader = {
  readonly controller: ReadableStreamDefaultController<Uint8Array>
}

/**
 * The Durable Object class behind the `WORKFLOW_RUNS` binding (SQLite-backed). One workflow run
 * per instance (named by its run id), or one hook index per instance (named `hook:<token>`). The
 * run executes in this object (`./execution.ts`); its stream lives here too, so readers follow it
 * live. Export it from the Worker entry and declare it as a SQLite class in the Worker's
 * migrations.
 */
export class WorkflowRun extends DurableObject {
  private storeInstance: RunStore | undefined
  private executionInstance: WorkflowExecution | undefined
  private readonly readers = new Set<Reader>()
  private readonly settledWaiters = new Set<() => void>()

  private get store(): RunStore {
    this.storeInstance ??= makeSqliteRunStore(this.ctx.storage.sql)

    return this.storeInstance
  }

  private get execution(): WorkflowExecution {
    if (this.executionInstance !== undefined) return this.executionInstance

    const host: ExecutionHost = {
      store: this.store,
      wakeAt: time => {
        this.ctx.waitUntil(this.armAlarm(time))
      },
      registerHook: async token => {
        const runId = this.store.readRun()?.runId

        if (runId === undefined) return

        await runNamespace().getByName(`hook:${token}`).hookRegister(runId)
      },
      chunkAppended: (_index, chunk) => {
        for (const reader of this.readers) reader.controller.enqueue(new Uint8Array(chunk))
      },
      streamClosed: () => {
        for (const reader of this.readers) reader.controller.close()

        this.readers.clear()
      },
      runSettled: () => {
        for (const resolve of this.settledWaiters) resolve()

        this.settledWaiters.clear()
      },
      log: (message, error) => {
        console.error(message, error)
      }
    }

    this.executionInstance = new WorkflowExecution(host)

    return this.executionInstance
  }

  private async armAlarm(time: number) {
    const current = await this.ctx.storage.getAlarm()

    if (current === null || current > time) await this.ctx.storage.setAlarm(time)
  }

  async start(input: StartRunInput): Promise<void> {
    if (this.store.readRun() === undefined) {
      this.store.createRun({
        runId: input.runId,
        workflowId: input.workflowId,
        args: input.args,
        status: 'pending',
        outcome: undefined,
        createdAt: Date.now(),
        completedAt: undefined
      })
    }

    this.execution.kick()
  }

  async status(): Promise<RunOutcome> {
    const run = this.store.readRun()

    if (run === undefined) throw new Error('Workflow run not found')

    return { status: run.status, outcome: run.outcome }
  }

  /** Resolves once the run ended (or immediately when it already has). */
  async settled(): Promise<RunOutcome> {
    const run = this.store.readRun()

    if (run === undefined) throw new Error('Workflow run not found')

    if (run.status === 'pending' || run.status === 'running') {
      this.execution.kick()
      await new Promise<void>(resolve => this.settledWaiters.add(resolve))
    }

    return this.status()
  }

  async cancel(): Promise<void> {
    this.execution.cancel()
  }

  /** Delivers a hook payload (devalue text); false when this run does not wait on `token`. */
  async resumeHook(token: string, payload: string): Promise<boolean> {
    if (this.store.readPendingHook(token) === undefined) return false

    this.execution.deliverHook(token, payload)

    return true
  }

  async tailIndex(): Promise<number> {
    return this.store.chunkCount() - 1
  }

  async readable(startIndex?: number): Promise<ReadableStream<Uint8Array>> {
    const count = this.store.chunkCount()

    const from =
      startIndex === undefined ? 0 : startIndex < 0 ? Math.max(0, count + startIndex) : startIndex

    const store = this.store
    const readers = this.readers
    let reader: Reader | undefined

    return new ReadableStream<Uint8Array>({
      start: controller => {
        for (const chunk of store.readChunks(from)) controller.enqueue(chunk)

        if (store.isStreamClosed()) {
          controller.close()

          return
        }

        reader = { controller }
        readers.add(reader)
      },
      cancel: () => {
        if (reader !== undefined) readers.delete(reader)
      }
    })
  }

  async hookRegister(runId: string): Promise<void> {
    makeHookIndex(this.ctx.storage.sql).write(runId)
  }

  async hookRun(): Promise<string | undefined> {
    return makeHookIndex(this.ctx.storage.sql).read()
  }

  async alarm(): Promise<void> {
    const run = this.store.readRun()

    if (run === undefined) return

    this.execution.wake()

    const sleep = this.store.earliestPendingSleep()

    if (sleep !== undefined && (run.status === 'running' || run.status === 'pending')) {
      await this.armAlarm(sleep)
    }
  }
}
