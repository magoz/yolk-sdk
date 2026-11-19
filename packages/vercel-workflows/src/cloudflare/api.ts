import { HookNotFoundError, WorkflowRunCancelledError } from './errors.ts'
import { runNamespace, type RunOutcome } from './namespace.ts'
import { workflowIdOf } from './registry.ts'
import { deserialize, serialize } from './serialization.ts'
import type { RunStatus } from './store.ts'

// The Cloudflare build of `workflow/api` (hosts alias `workflow/api` to this module): start, read,
// resume and cancel runs that execute in `WorkflowRun` Durable Objects.

export { HookNotFoundError, WorkflowRunCancelledError } from './errors.ts'

export type WorkflowReadableStream<R = Uint8Array> = ReadableStream<R> & {
  getTailIndex(): Promise<number>
}

export type WorkflowReadableStreamOptions = {
  /** First chunk to read; a negative index counts from the end. Default 0. */
  readonly startIndex?: number
}

export type WorkflowRun = {
  readonly runId: string
  readonly getReadable: (options?: WorkflowReadableStreamOptions) => WorkflowReadableStream
  readonly cancel: () => Promise<void>
  readonly status: Promise<RunStatus>
  /** The workflow's result once the run ended; rejects with its error, or when cancelled. */
  readonly returnValue: Promise<unknown>
}

const newRunId = () => `wrun_${crypto.randomUUID().replaceAll('-', '')}`

const settledValue = (runId: string, outcome: RunOutcome): unknown => {
  const value = outcome.outcome === undefined ? undefined : deserialize(outcome.outcome)

  if (outcome.status === 'completed') return value

  if (outcome.status === 'cancelled') throw new WorkflowRunCancelledError(runId)

  throw value instanceof Error ? value : new Error(`Workflow run ${runId} ${outcome.status}`)
}

const makeRun = (runId: string): WorkflowRun => {
  const stub = () => runNamespace().getByName(runId)

  return {
    runId,
    getReadable: options => {
      const { readable, writable } = new TransformStream<Uint8Array, Uint8Array>()

      stub()
        .readable(options?.startIndex)
        .then(source => source.pipeTo(writable))
        .catch((error: unknown) => writable.abort(error).catch(() => undefined))

      return Object.assign(readable, { getTailIndex: () => stub().tailIndex() })
    },
    cancel: () => stub().cancel(),
    get status() {
      return stub()
        .status()
        .then(outcome => outcome.status)
    },
    get returnValue() {
      return stub()
        .settled()
        .then(outcome => settledValue(runId, outcome))
    }
  }
}

/**
 * Starts a run of a `'use workflow'` function (compiled by the `workflowDirectives` Vite plugin)
 * in its own `WorkflowRun` instance. Arguments cross as devalue text. `options` is accepted for
 * `workflow/api` compatibility; attributes are not stored.
 */
export const start = async (
  workflow: object,
  args: ReadonlyArray<unknown> = [],
  _options?: { readonly attributes?: Readonly<Record<string, string>> }
): Promise<WorkflowRun> => {
  const workflowId = workflowIdOf(workflow)

  if (workflowId === undefined) {
    throw new Error('start() needs a function compiled from a "use workflow" directive')
  }

  const runId = newRunId()

  await runNamespace()
    .getByName(runId)
    .start({ runId, workflowId, args: serialize(args) })

  return makeRun(runId)
}

export const getRun = (runId: string): WorkflowRun => makeRun(runId)

/** Delivers `payload` to the run waiting on `token`; `HookNotFoundError` when none waits. */
export const resumeHook = async (token: string, payload: unknown): Promise<void> => {
  const runId = await runNamespace().getByName(`hook:${token}`).hookRun()

  if (runId === undefined) throw new HookNotFoundError(token)

  const delivered = await runNamespace().getByName(runId).resumeHook(token, serialize(payload))

  if (!delivered) throw new HookNotFoundError(token)
}
