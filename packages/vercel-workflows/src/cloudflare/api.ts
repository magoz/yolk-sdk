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

/**
 * Not in Vercel's `workflow/api` (Cloudflare-only, like `startWithRunId` and `prepareRun`): a new
 * run id, `wrun_` and 32 hex digits, the shape `start` gives its runs.
 */
export const createRunId = (): string => `wrun_${crypto.randomUUID().replaceAll('-', '')}`

/** Whether `value` has the shape of a run id (`createRunId`); hook index names never do. */
export const isRunId = (value: string): boolean => /^wrun_[0-9a-f]{32}$/.test(value)

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

const requireWorkflowId = (name: string, workflow: object): string => {
  const workflowId = workflowIdOf(workflow)

  if (workflowId === undefined) {
    throw new Error(`${name}() needs a function compiled from a "use workflow" directive`)
  }

  return workflowId
}

const requireRunId = (name: string, runId: string) => {
  if (!isRunId(runId)) throw new Error(`${name}() needs a run id made by createRunId(): ${runId}`)
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
  const workflowId = requireWorkflowId('start', workflow)
  const runId = createRunId()

  await runNamespace()
    .getByName(runId)
    .start({ runId, workflowId, args: serialize(args) })

  return makeRun(runId)
}

/**
 * What `startWithRunId` did:
 * - `created`: it created and started the run.
 * - `alreadyStarted`: a run of the same workflow with the same arguments already lives under the
 *   id. Most likely your own earlier call, whose answer was lost after it created the run: treat it
 *   as yours rather than starting the same input again.
 * - `taken`: a different run lives under the id. It is not yours (no handle): start under a new id.
 */
export type StartWithRunIdResult =
  | { readonly status: 'created'; readonly run: WorkflowRun }
  | { readonly status: 'alreadyStarted'; readonly run: WorkflowRun }
  | { readonly status: 'taken' }

/**
 * Not in Vercel's `workflow/api`: starts a run under a run id the caller chose (`createRunId`),
 * for example one an earlier `prepareRun` warmed. It starts the run only when no run lives under
 * that id yet, and otherwise changes nothing (see `StartWithRunIdResult`), so two callers never
 * share one run. Use a chosen id for one start (retries of it included).
 */
export const startWithRunId = async (
  workflow: object,
  args: ReadonlyArray<unknown>,
  options: { readonly runId: string }
): Promise<StartWithRunIdResult> => {
  const workflowId = requireWorkflowId('startWithRunId', workflow)

  requireRunId('startWithRunId', options.runId)

  const outcome = await runNamespace()
    .getByName(options.runId)
    .startNew({ runId: options.runId, workflowId, args: serialize(args) })

  return outcome === 'taken'
    ? { status: 'taken' }
    : { status: outcome, run: makeRun(options.runId) }
}

/**
 * Not in Vercel's `workflow/api`: warms the `WorkflowRun` object a later `startWithRunId` will use
 * under `runId`. Creating the object and evaluating the workflow's module (and the
 * `registerRunPreloads` modules) in its fresh isolate then happen before the start, not in it. A
 * prepared object stores nothing: one never started costs its preparation and is evicted. Calling
 * it again on a warm object is cheap and keeps it resident.
 */
export const prepareRun = async (workflow: object, runId: string): Promise<void> => {
  const workflowId = requireWorkflowId('prepareRun', workflow)

  requireRunId('prepareRun', runId)

  await runNamespace().getByName(runId).prepare(workflowId)
}

export const getRun = (runId: string): WorkflowRun => makeRun(runId)

/** Delivers `payload` to the run waiting on `token`; `HookNotFoundError` when none waits. */
export const resumeHook = async (token: string, payload: unknown): Promise<void> => {
  const runId = await runNamespace().getByName(`hook:${token}`).hookRun()

  if (runId === undefined) throw new HookNotFoundError(token)

  const delivered = await runNamespace().getByName(runId).resumeHook(token, serialize(payload))

  if (!delivered) throw new HookNotFoundError(token)
}
