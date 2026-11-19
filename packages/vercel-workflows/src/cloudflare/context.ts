import { AsyncLocalStorage } from 'node:async_hooks'

/** What a workflow body reaches while it runs (`workflow`'s module-level APIs read it). */
export interface WorkflowScope {
  readonly runId: string
  readonly startedAt: Date
  readonly step: (id: string, maxRetries: number, body: () => Promise<unknown>) => Promise<unknown>
  readonly hook: (token: string) => Promise<unknown>
  /** A token for a hook created without one, the same on every replay of the body. */
  readonly hookToken: () => string
  readonly sleep: (durationMs: number) => Promise<void>
}

/** What a step body reaches while it runs. */
export interface StepScope {
  readonly runId: string
  readonly stepId: string
  readonly attempt: number
  readonly stepStartedAt: Date
  readonly workflowStartedAt: Date
  readonly writable: () => WritableStream<Uint8Array>
}

export const workflowStorage = new AsyncLocalStorage<WorkflowScope>()

export const stepStorage = new AsyncLocalStorage<StepScope>()
