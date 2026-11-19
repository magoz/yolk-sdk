import { env } from 'cloudflare:workers'
import { Predicate } from 'effect'
import type { HookClaim } from './execution.ts'
import type { RunStatus } from './store.ts'

/** The `WorkflowRun` Durable Object binding every Worker that starts or reads runs declares. */
export const workflowRunsBinding = 'WORKFLOW_RUNS'

export type StartRunInput = {
  readonly runId: string
  /** The workflow's registered id, `<module path>#<function name>`. */
  readonly workflowId: string
  /** devalue text of the argument list. */
  readonly args: string
}

export type RunOutcome = {
  readonly status: RunStatus
  /** devalue text of the result or error once the run ended. */
  readonly outcome: string | undefined
}

/** The RPC surface of a `WorkflowRun` instance (a run, or a hook index named `hook:<token>`). */
export interface WorkflowRunStub {
  start(input: StartRunInput): Promise<void>
  status(): Promise<RunOutcome>
  settled(): Promise<RunOutcome>
  cancel(): Promise<void>
  /** False when no live hook of the run holds `token` (any more). */
  resumeHook(token: string, payload: string): Promise<boolean>
  tailIndex(): Promise<number>
  readable(startIndex?: number): Promise<ReadableStream<Uint8Array>>
  /** Whether a live hook of the run holds `token`. */
  hookHeld(token: string): Promise<boolean>
  /** On a hook index: route `token` to `runId`, unless another run's live hook holds it. */
  hookClaim(token: string, runId: string): Promise<HookClaim>
  /** On a hook index: the run that took the token last (its hook may since have freed it). */
  hookRun(): Promise<string | undefined>
}

export interface WorkflowRunNamespace {
  getByName(name: string): WorkflowRunStub
}

const isNamespace = (value: unknown): value is WorkflowRunNamespace =>
  Predicate.hasProperty(value, 'getByName') && Predicate.isFunction(value.getByName)

/** The Worker's `WORKFLOW_RUNS` binding, read from `cloudflare:workers` `env` when first needed. */
export const runNamespace = (): WorkflowRunNamespace => {
  const binding = Predicate.hasProperty(env, workflowRunsBinding)
    ? env[workflowRunsBinding]
    : undefined

  if (!isNamespace(binding)) {
    throw new Error(`The ${workflowRunsBinding} Durable Object binding is missing from this Worker`)
  }

  return binding
}
