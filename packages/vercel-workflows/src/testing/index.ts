import { AsyncLocalStorage } from 'node:async_hooks'
import fs from 'node:fs'
import { createRequire } from 'node:module'
import { types } from 'node:util'
import path from 'node:path'
import { Predicate } from 'effect'
import type {
  VercelWorkflowsSdkClient,
  VercelWorkflowsSdkRun,
  VercelWorkflowReadableOptions,
  VercelWorkflowReadableStream,
  VercelWorkflowRunStatus
} from '../effect.ts'

// Behavioral emulator of the Vercel Workflow platform for tests: run lifecycle,
// append-only durable streams with close-once -> 409 write conflicts, a step
// executor honoring `fn.maxRetries` + `getStepMetadata().attempt`, hooks/resume,
// and cancellation. Host code under test runs unmodified against it; tests mock
// only the `workflow` module's ambient APIs, delegating to the active world
// (see `testWorkflowModule`).
//
// Step errors cross the platform boundary the way they do in a deployment: each one is stored with
// the installed `workflow` runtime's own step-error serializer, and the workflow body sees only the
// value read back (error tags, prototypes and custom fields are gone; a `cause` survives). A thrown
// value the serializer cannot store (a class instance anywhere in its `cause` chain) never reaches
// the body: the platform's queue handler fails and redelivers the step, which runs again until its
// retries run out and it fails with "exceeded max retries" (see `unstorableStepErrors`).
//
// The single most important semantic: writing to (or re-closing) a closed
// durable stream fails with the platform's HTTP 409 "already completed"
// conflict shape. Any code path that performs a terminal stream effect from a
// retryable step attempt poisons every subsequent platform retry — exactly the
// #252 production bug. The emulator enforces that invariant permanently.

export type TestWorkflowRunStatus = VercelWorkflowRunStatus

// Matches the platform's conflict contract: `EntityConflictError.is(value)`
// checks `value.name === 'EntityConflictError'`, and the Vercel world maps
// HTTP 409 responses to that class.
export class TestWorkflowStreamConflictError extends Error {
  override readonly name = 'EntityConflictError'
  readonly status = 409

  constructor(runId: string) {
    super(`Workflow run "${runId}" stream already completed`)
  }
}

export class TestWorkflowRunConflictError extends Error {
  override readonly name = 'EntityConflictError'
  readonly status = 409

  constructor(message: string) {
    super(message)
  }
}

export class TestWorkflowHookNotFoundError extends Error {
  override readonly name = 'HookNotFoundError'

  constructor(token: string) {
    super(`Workflow hook "${token}" was not found`)
  }
}

export class TestWorkflowHookConflictError extends Error {
  override readonly name = 'HookConflictError'

  constructor(token: string) {
    super(`Workflow hook "${token}" was already resumed`)
  }
}

export class TestWorkflowRunNotFoundError extends Error {
  override readonly name = 'WorkflowRunNotFoundError'

  constructor(runId: string) {
    super(`Workflow run "${runId}" was not found`)
  }
}

export class TestWorkflowRunCancelledError extends Error {
  override readonly name = 'WorkflowRunCancelledError'

  constructor(runId: string) {
    super(`Workflow run "${runId}" was cancelled`)
  }
}

export type TestWorkflowMetadata = { readonly workflowRunId: string }

export type TestWorkflowStepMetadata = {
  readonly attempt: number
  readonly stepId: string
  readonly stepName: string
}

/** A thrown step value the platform could not store; the step was redelivered instead. */
export type TestWorkflowUnstorableStepError = {
  readonly stepName: string
  readonly attempt: number
  readonly error: unknown
}

export type TestWorkflowStepFunction<TArgs extends ReadonlyArray<unknown>, TResult> = ((
  ...args: TArgs
) => Promise<TResult>) & { readonly maxRetries?: number }

// The platform default: retries after the first attempt; total attempts = maxRetries + 1.
export const defaultTestWorkflowStepMaxRetries = 3

type HookRecord = {
  readonly resolve: (payload: unknown) => void
  readonly reject: (error: TestWorkflowRunCancelledError) => void
}

type TestWorkflowRunRecord = {
  readonly runId: string
  status: TestWorkflowRunStatus
  returnValue: unknown
  runError: unknown
  settled: Promise<void>
  readonly chunks: Array<unknown>
  streamClosed: boolean
  streamCloseCount: number
  writeAfterCloseAttempts: number
  readonly changeListeners: Set<() => void>
  readonly hooks: Map<string, HookRecord>
  readonly resumedHookTokens: Set<string>
  stepSequence: number
  readonly stepAttempts: Map<string, number>
  readonly unstorableStepErrors: Array<TestWorkflowUnstorableStepError>
}

type AmbientContext = {
  readonly world: TestWorkflowWorld
  readonly run: TestWorkflowRunRecord
  readonly stepMetadata: TestWorkflowStepMetadata | undefined
}

const ambientStorage = new AsyncLocalStorage<AmbientContext>()

const requireAmbient = (): AmbientContext => {
  const ambient = ambientStorage.getStore()

  if (ambient === undefined) {
    throw new Error('Workflow ambient API called outside a TestWorkflowWorld run context')
  }

  return ambient
}

type StepErrorSerializer = {
  /** Undefined when the platform cannot store the value (its `SerializationError`). */
  readonly dehydrate: (error: unknown, runId: string) => Promise<Uint8Array | undefined>
  readonly hydrate: (bytes: Uint8Array, runId: string) => Promise<unknown>
}

let stepErrorSerializer: Promise<StepErrorSerializer> | undefined

const workflowPackageDir = (require: NodeJS.Require) => {
  let dir = path.dirname(require.resolve('workflow'))

  while (!fs.existsSync(path.join(dir, 'package.json'))) {
    const parent = path.dirname(dir)

    if (parent === dir) throw new Error('Cannot locate the installed workflow package')

    dir = parent
  }

  return dir
}

// The installed `workflow` runtime's own step-error serializer (`@workflow/core`, resolved
// through `workflow`'s package so its version matches the host's), loaded natively: a
// `vi.mock('workflow')` of the ambient module never replaces it.
const loadStepErrorSerializer = (): Promise<StepErrorSerializer> =>
  (stepErrorSerializer ??= (async () => {
    const require = createRequire(import.meta.url)

    const serialization: unknown = await import(
      require.resolve('@workflow/core/serialization', { paths: [workflowPackageDir(require)] })
    ).catch((cause: unknown) => {
      // Workflow 5 captures Node `URL` intrinsics when its serializer loads; jsdom's fail.
      throw new Error(
        'TestWorkflowWorld cannot load the workflow step-error serializer; step execution needs the Node test environment, not jsdom',
        { cause }
      )
    })

    if (
      !Predicate.hasProperty(serialization, 'dehydrateStepError') ||
      !Predicate.hasProperty(serialization, 'hydrateStepError') ||
      !Predicate.isFunction(serialization.dehydrateStepError) ||
      !Predicate.isFunction(serialization.hydrateStepError)
    ) {
      throw new Error('The installed workflow runtime has no step-error serializer')
    }

    const { dehydrateStepError, hydrateStepError } = serialization

    return {
      dehydrate: async (error, runId) => {
        let bytes: unknown

        try {
          bytes = await dehydrateStepError(error, runId, undefined)
        } catch (failure) {
          // The platform reframes every failure to store a value as `SerializationError`; any
          // other failure is this emulator's integration breaking, never the host's error.
          if (Predicate.hasProperty(failure, 'name') && failure.name === 'SerializationError') {
            return undefined
          }

          throw failure
        }

        if (!(bytes instanceof Uint8Array)) {
          throw new Error('The workflow step-error serializer returned no bytes')
        }

        return bytes
      },
      hydrate: async (bytes, runId) => {
        const error: unknown = await hydrateStepError(bytes, runId, undefined)

        return error
      }
    }
  })())

// The platform's error shape check (`@workflow/errors`): duck-typed, so it holds across realms.
const isPlatformError = (value: unknown) =>
  Predicate.hasProperty(value, 'name') && Predicate.hasProperty(value, 'message')

// `FatalError.is`: named `FatalError`, or carrying `fatal: true`.
const isFatalStepError = (value: unknown) =>
  isPlatformError(value) &&
  ((Predicate.hasProperty(value, 'name') && value.name === 'FatalError') ||
    (Predicate.hasProperty(value, 'fatal') && value.fatal === true))

// The platform turns an abort into a FatalError before classifying a step error
// (`promoteAbortErrorToFatal`), so an aborted step is never retried.
const promoteAbortError = (value: unknown) => {
  if (
    !Predicate.hasProperty(value, 'name') ||
    value.name !== 'AbortError' ||
    !Predicate.hasProperty(value, 'message') ||
    !Predicate.isString(value.message) ||
    isFatalStepError(value)
  ) {
    return value
  }

  const fatal = platformFatalError(`Aborted: ${value.message}`, undefined)

  if (Predicate.hasProperty(value, 'stack') && Predicate.isString(value.stack)) {
    fatal.stack = value.stack
  }

  return fatal
}

// Stored and read back, an error named `FatalError` is the platform's FatalError.
const platformFatalError = (message: string, cause: unknown) => {
  const error = cause === undefined ? new Error(message) : new Error(message, { cause })

  error.name = 'FatalError'

  return error
}

// The platform's `normalizeUnknownError` message: an error's message, a string as is, anything
// else as JSON (else `String`), and an awaited thenable prefixed `Promise rejection: `.
const platformErrorMessage = async (value: unknown): Promise<string> => {
  if (Predicate.hasProperty(value, 'then') && Predicate.isFunction(value.then)) {
    try {
      return `Promise rejection: ${await platformErrorMessage(await value)}`
    } catch (rejection) {
      return `Promise rejection: ${await platformErrorMessage(rejection)}`
    }
  }

  if (types.isNativeError(value)) return value.message

  if (Predicate.isString(value)) return value

  try {
    return JSON.stringify(value) ?? String(value)
  } catch {
    return String(value)
  }
}

const retriesLabel = (count: number) => (count === 1 ? 'retry' : 'retries')

export type TestWorkflowRunInspection = {
  readonly runId: string
  readonly status: TestWorkflowRunStatus
  readonly chunks: ReadonlyArray<unknown>
  readonly streamClosed: boolean
  readonly streamCloseCount: number
  readonly writeAfterCloseAttempts: number
  readonly stepAttempts: ReadonlyMap<string, number>
  readonly runError: unknown
  /** Every thrown step value the platform could not store, in order. */
  readonly unstorableStepErrors: ReadonlyArray<TestWorkflowUnstorableStepError>
}

export type TestWorkflowHook<T> = Promise<T> & { readonly [Symbol.dispose]: () => void }

type TestWorkflowWorldStartResult = { readonly runId: string }

export class TestWorkflowWorld {
  private readonly runs = new Map<string, TestWorkflowRunRecord>()
  private runSequence = 0

  start<TArgs extends ReadonlyArray<unknown>, TResult>(
    workflowFn: (...args: TArgs) => Promise<TResult>,
    args: TArgs
  ): TestWorkflowWorldStartResult {
    this.runSequence += 1
    const runId = `twr_${this.runSequence}`

    const run: TestWorkflowRunRecord = {
      runId,
      status: 'pending',
      returnValue: undefined,
      runError: undefined,
      settled: Promise.resolve(),
      chunks: [],
      streamClosed: false,
      streamCloseCount: 0,
      writeAfterCloseAttempts: 0,
      changeListeners: new Set(),
      hooks: new Map(),
      resumedHookTokens: new Set(),
      stepSequence: 0,
      stepAttempts: new Map(),
      unstorableStepErrors: []
    }

    this.runs.set(runId, run)

    run.settled = ambientStorage.run(
      { world: this, run, stepMetadata: undefined },
      async (): Promise<void> => {
        // Yield once so callers observe `pending` before execution begins,
        // mirroring the platform's enqueue-then-run lifecycle.
        await Promise.resolve()

        if (run.status === 'cancelled') return

        run.status = 'running'

        try {
          run.returnValue = await workflowFn(...args)

          if (run.status === 'running') run.status = 'completed'
        } catch (error) {
          run.runError = error

          if (run.status === 'running') run.status = 'failed'
        } finally {
          this.notifyChange(run)
        }
      }
    )

    return { runId }
  }

  async settled(runId: string): Promise<void> {
    await this.requireRun(runId).settled
  }

  inspect(runId: string): TestWorkflowRunInspection {
    const run = this.requireRun(runId)

    return {
      runId: run.runId,
      status: run.status,
      chunks: [...run.chunks],
      streamClosed: run.streamClosed,
      streamCloseCount: run.streamCloseCount,
      writeAfterCloseAttempts: run.writeAfterCloseAttempts,
      stepAttempts: new Map(run.stepAttempts),
      runError: run.runError,
      unstorableStepErrors: [...run.unstorableStepErrors]
    }
  }

  status(runId: string): TestWorkflowRunStatus {
    return this.requireRun(runId).status
  }

  async cancel(runId: string): Promise<void> {
    const run = this.requireRun(runId)

    if (run.status === 'completed' || run.status === 'failed' || run.status === 'cancelled') {
      throw new TestWorkflowRunConflictError(
        `Workflow run "${runId}" is already ${run.status} and cannot be cancelled`
      )
    }

    run.status = 'cancelled'

    for (const [token, hook] of run.hooks) {
      run.hooks.delete(token)
      hook.reject(new TestWorkflowRunCancelledError(runId))
    }

    this.notifyChange(run)
  }

  async resumeHook(token: string, payload: unknown): Promise<void> {
    for (const run of this.runs.values()) {
      const hook = run.hooks.get(token)

      if (hook !== undefined) {
        run.hooks.delete(token)
        run.resumedHookTokens.add(token)
        hook.resolve(payload)

        return
      }

      if (run.resumedHookTokens.has(token)) {
        throw new TestWorkflowHookConflictError(token)
      }
    }

    throw new TestWorkflowHookNotFoundError(token)
  }

  hasResumedHook(token: string): boolean {
    for (const run of this.runs.values()) {
      if (run.resumedHookTokens.has(token)) return true
    }

    return false
  }

  // --- Step executor (platform retry semantics) ---

  // Runs a step body with the platform's retry contract: `fn.maxRetries`
  // retries after the first attempt (total attempts = maxRetries + 1) and
  // 1-based `getStepMetadata().attempt` visible to the body. A FatalError
  // (by `name`, or `fatal: true`; an AbortError is promoted to one) is never
  // retried; an exhausted step fails with the platform's FatalError whose
  // `cause` is the last thrown value. The caller sees errors only as the
  // platform stores and reads them back.
  async runStep<TArgs extends ReadonlyArray<unknown>, TResult>(
    stepFn: TestWorkflowStepFunction<TArgs, TResult>,
    args: TArgs,
    stepName = stepFn.name === '' ? 'step' : stepFn.name
  ): Promise<TResult> {
    const ambient = requireAmbient()
    const run = ambient.run
    run.stepSequence += 1
    const stepId = `${run.runId}:step:${run.stepSequence}:${stepName}`
    const maxRetries = stepFn.maxRetries ?? defaultTestWorkflowStepMaxRetries
    const maxAttempts = maxRetries + 1
    const serializer = await loadStepErrorSerializer()

    let attempt = 1

    for (;;) {
      run.stepAttempts.set(stepName, (run.stepAttempts.get(stepName) ?? 0) + 1)

      let thrown: unknown

      try {
        return await ambientStorage.run(
          { world: this, run, stepMetadata: { attempt, stepId, stepName } },
          () => stepFn(...args)
        )
      } catch (error) {
        thrown = error
      }

      const effective = promoteAbortError(thrown)
      const fatal = isFatalStepError(effective)
      const exhausted = !fatal && attempt >= maxAttempts

      // A fatal error is stored as is (abort promoted); an exhausted step's error becomes the
      // cause of the platform's FatalError; a retried attempt stores the thrown value.
      const recorded = fatal
        ? effective
        : exhausted
          ? platformFatalError(
              `Step "${stepName}" failed after ${maxRetries} ${retriesLabel(maxRetries)}: ${await platformErrorMessage(effective)}`,
              thrown
            )
          : thrown

      const bytes = await serializer.dehydrate(recorded, run.runId)

      if (bytes === undefined) {
        // The platform cannot record this attempt: its queue handler fails and the
        // redelivered message runs the step again as the next attempt.
        run.unstorableStepErrors.push({ stepName, attempt, error: thrown })

        if (attempt >= maxAttempts) {
          // The redelivery past the budget fails the step before running it again.
          const exceeded = await serializer.dehydrate(
            platformFatalError(
              `Step "${stepName}" exceeded max retries (${maxRetries} ${retriesLabel(maxRetries)})`,
              undefined
            ),
            run.runId
          )

          if (exceeded === undefined)
            throw new Error('The workflow runtime cannot store a FatalError')

          throw await serializer.hydrate(exceeded, run.runId)
        }

        attempt += 1
        continue
      }

      if (fatal || exhausted) throw await serializer.hydrate(bytes, run.runId)

      attempt += 1
    }
  }

  // Wraps a step function so orchestration code can invoke it exactly the way
  // the platform invokes `use step` functions: through the retry executor.
  step<TArgs extends ReadonlyArray<unknown>, TResult>(
    stepFn: TestWorkflowStepFunction<TArgs, TResult>,
    stepName?: string
  ): (...args: TArgs) => Promise<TResult> {
    return (...args: TArgs) => this.runStep(stepFn, args, stepName)
  }

  // --- Ambient platform APIs (exposed through `testWorkflowModule`) ---

  static getWorkflowMetadata(): TestWorkflowMetadata {
    return { workflowRunId: requireAmbient().run.runId }
  }

  static getStepMetadata(): TestWorkflowStepMetadata {
    const ambient = requireAmbient()

    if (ambient.stepMetadata === undefined) {
      throw new Error('getStepMetadata called outside a step context')
    }

    return ambient.stepMetadata
  }

  static getWritable<T>(): WritableStream<T> {
    const ambient = requireAmbient()

    return ambient.world.makeWritable(ambient.run)
  }

  static createHook<T>(input: { readonly token: string }): TestWorkflowHook<T> {
    const ambient = requireAmbient()

    return ambient.world.makeHook<T>(ambient.run, input.token)
  }

  // --- Durable streams ---

  private makeWritable<T>(run: TestWorkflowRunRecord): WritableStream<T> {
    return new WritableStream<T>({
      write: chunk => {
        if (run.streamClosed || run.status === 'cancelled') {
          run.writeAfterCloseAttempts += 1
          throw new TestWorkflowStreamConflictError(run.runId)
        }

        run.chunks.push(chunk)
        this.notifyChange(run)
      },
      close: () => {
        if (run.streamClosed) {
          run.streamCloseCount += 1
          throw new TestWorkflowStreamConflictError(run.runId)
        }

        run.streamClosed = true
        run.streamCloseCount += 1
        this.notifyChange(run)
      }
    })
  }

  private makeHook<T>(run: TestWorkflowRunRecord, token: string): TestWorkflowHook<T> {
    let resolveHook: (payload: unknown) => void = () => {}

    let rejectHook: (error: TestWorkflowRunCancelledError) => void = () => {}

    const promise = new Promise<T>((resolve, reject) => {
      // SAFETY: Hook payloads are caller-typed on the platform (`createHook<T>`).
      // eslint-disable-next-line @typescript-eslint/consistent-type-assertions
      resolveHook = payload => resolve(payload as T)
      rejectHook = reject
    })

    run.hooks.set(token, { resolve: resolveHook, reject: rejectHook })

    return Object.assign(promise, {
      [Symbol.dispose]: () => {
        run.hooks.delete(token)
      }
    })
  }

  getReadable<T>(
    runId: string,
    options?: VercelWorkflowReadableOptions
  ): VercelWorkflowReadableStream<T> {
    const run = this.requireRun(runId)
    const requestedStart = options?.startIndex ?? 0

    let index =
      requestedStart < 0 ? Math.max(0, run.chunks.length + requestedStart) : requestedStart

    const stream = new ReadableStream<T>({
      pull: async controller => {
        while (index >= run.chunks.length && !this.streamEnded(run)) {
          await this.nextChange(run)
        }

        if (index < run.chunks.length) {
          // SAFETY: The platform readable is caller-typed (`WorkflowReadableStream<R = any>`);
          // the durable log stores opaque chunks, so this coercion mirrors the
          // platform contract exactly.
          // eslint-disable-next-line @typescript-eslint/consistent-type-assertions
          controller.enqueue(run.chunks[index] as T)
          index += 1

          return
        }

        controller.close()
      }
    })

    return Object.assign(stream, {
      getTailIndex: () => Promise.resolve(run.chunks.length - 1)
    })
  }

  private streamEnded(run: TestWorkflowRunRecord): boolean {
    return run.streamClosed || run.status === 'cancelled'
  }

  private notifyChange(run: TestWorkflowRunRecord): void {
    const listeners = [...run.changeListeners]
    run.changeListeners.clear()

    for (const listener of listeners) listener()
  }

  private nextChange(run: TestWorkflowRunRecord): Promise<void> {
    return new Promise(resolve => {
      run.changeListeners.add(resolve)
    })
  }

  private requireRun(runId: string): TestWorkflowRunRecord {
    const run = this.runs.get(runId)

    if (run === undefined) throw new TestWorkflowRunNotFoundError(runId)

    return run
  }

  // --- SDK adapter for `VercelWorkflows.layerFromSdk` ---

  private sdkRun<TResult>(run: TestWorkflowRunRecord): VercelWorkflowsSdkRun<TResult> {
    const getReadable = <Chunk>(options?: VercelWorkflowReadableOptions) =>
      this.getReadable<Chunk>(run.runId, options)

    const cancel = () => this.cancel(run.runId)

    return {
      runId: run.runId,
      getReadable,
      cancel,
      get status() {
        return Promise.resolve(run.status)
      },
      get returnValue() {
        return run.settled.then(() => {
          if (run.status === 'completed') {
            // SAFETY: Return values are caller-typed on the platform SDK as well.
            // eslint-disable-next-line @typescript-eslint/consistent-type-assertions
            return run.returnValue as TResult
          }

          throw run.runError ?? new TestWorkflowRunCancelledError(run.runId)
        })
      }
    }
  }

  readonly sdk: VercelWorkflowsSdkClient = {
    start: async (workflowFn, args) => {
      const { runId } = this.start(workflowFn, args)

      return this.sdkRun(this.requireRun(runId))
    },
    getRun: <TResult>(runId: string) => this.sdkRun<TResult>(this.requireRun(runId)),
    resumeHook: (token, payload) => this.resumeHook(token, payload)
  }
}

// Factory for `vi.mock('workflow', () => testWorkflowModule)`: the mocked
// module surface delegates every ambient platform API to the active world's
// AsyncLocalStorage context, so production code under test runs unmodified.
export const testWorkflowModule = {
  getWorkflowMetadata: () => TestWorkflowWorld.getWorkflowMetadata(),
  getStepMetadata: () => TestWorkflowWorld.getStepMetadata(),
  getWritable: <T>() => TestWorkflowWorld.getWritable<T>(),
  createHook: <T>(input: { readonly token: string }) => TestWorkflowWorld.createHook<T>(input)
}
