import { Predicate } from 'effect'
import { stepStorage, workflowStorage, type StepScope, type WorkflowScope } from './context.ts'
import { FatalError, HookNotFoundError, RetryableError } from './errors.ts'
import { workflowById } from './registry.ts'
import { deserialize, serialize } from './serialization.ts'
import type { JournalEntry, RunRecord, RunStore } from './store.ts'

/**
 * Runs one workflow run with Vercel Workflow's semantics on a single-writer host (a Durable
 * Object): the workflow body runs in memory; each step's outcome, each hook payload and each fired
 * sleep is journaled under a key made of its id and its call count, so a body that runs again (the
 * object was evicted or restarted) replays to where it was without re-running finished steps.
 * Steps are at least once: a step cut off by an eviction runs again on replay.
 */

export interface ExecutionHost {
  readonly store: RunStore
  /** Arm a wake-up (an alarm) no later than `time`. */
  readonly wakeAt: (time: number) => void
  /** Make `token` resolvable to this run from outside (`resumeHook`). */
  readonly registerHook: (token: string) => Promise<void>
  readonly chunkAppended: (index: number, chunk: Uint8Array) => void
  readonly streamClosed: () => void
  readonly runSettled: () => void
  readonly log: (message: string, error?: unknown) => void
}

/** Platform default when a step function sets no `maxRetries`. */
export const defaultStepMaxRetries = 3

/** How often a run with a step in flight re-arms its recovery alarm. */
export const stepGuardIntervalMs = 30_000

const retryDelayMs = (attempt: number, error: unknown) => {
  if (RetryableError.is(error)) {
    const retryAfter = Predicate.hasProperty(error, 'retryAfter') ? error.retryAfter : undefined

    if (Predicate.isDate(retryAfter)) return Math.max(0, retryAfter.getTime() - Date.now())
  }

  return Math.min(30_000, 1000 * 2 ** (attempt - 1))
}

const delay = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms))

/** A promise that never settles: a cancelled run's body stops where it waits. */
const halted = <A>(): Promise<A> => new Promise<A>(() => undefined)

const isTerminal = (run: RunRecord) =>
  run.status === 'completed' || run.status === 'failed' || run.status === 'cancelled'

const replayEntry = (entry: JournalEntry): unknown => {
  const value = deserialize(entry.value)

  if (entry.ok) return value

  throw value
}

const encodeChunk = (chunk: unknown): Uint8Array => {
  if (chunk instanceof Uint8Array) return new Uint8Array(chunk)

  if (Predicate.isString(chunk)) return new TextEncoder().encode(chunk)

  if (chunk instanceof ArrayBuffer) return new Uint8Array(chunk.slice(0))

  throw new TypeError('Workflow streams take Uint8Array, ArrayBuffer or string chunks')
}

class LiveRun {
  stepsInFlight = 0
  private halted = false
  private readonly counters = new Map<string, number>()
  private readonly hookWaiters = new Map<string, (payload: unknown) => void>()
  private readonly sleepTimers = new Set<ReturnType<typeof setTimeout>>()

  private readonly run: RunRecord
  private readonly host: ExecutionHost

  constructor(run: RunRecord, host: ExecutionHost) {
    this.run = run
    this.host = host
  }

  halt() {
    this.halted = true

    for (const timer of this.sleepTimers) clearTimeout(timer)

    this.sleepTimers.clear()
    this.hookWaiters.clear()
  }

  resolveHook(key: string, payload: unknown): boolean {
    const resolve = this.hookWaiters.get(key)

    if (resolve === undefined) return false

    this.hookWaiters.delete(key)
    resolve(payload)

    return true
  }

  async execute(): Promise<void> {
    const store = this.host.store
    const workflow = await workflowById(this.run.workflowId)

    if (workflow === undefined) {
      store.finishRun(
        'failed',
        serialize(new FatalError(`No workflow is registered as ${this.run.workflowId}`))
      )
      this.host.runSettled()

      return
    }

    store.setStatus('running')

    const decoded = deserialize(this.run.args)
    const args = Array.isArray(decoded) ? decoded : [decoded]

    const scope: WorkflowScope = {
      runId: this.run.runId,
      startedAt: new Date(this.run.createdAt),
      step: (id, maxRetries, body) => this.step(id, maxRetries, body),
      hook: token => this.hook(token),
      hookToken: () => this.nextKey(`${this.run.runId}:hook`),
      sleep: ms => this.sleep(ms)
    }

    let outcome:
      | { readonly ok: true; readonly value: unknown }
      | { readonly ok: false; readonly error: unknown }

    try {
      const value: unknown = await workflowStorage.run(scope, () => workflow(...args))
      outcome = { ok: true, value }
    } catch (error) {
      outcome = { ok: false, error }
    }

    const current = store.readRun()

    if (this.halted) return

    // Ended elsewhere (cancelled, or by an earlier instance): wake this instance's waiters anyway.
    if (current === undefined || isTerminal(current)) {
      this.host.runSettled()

      return
    }

    if (outcome.ok) {
      try {
        store.finishRun('completed', serialize(outcome.value))
      } catch (error) {
        store.finishRun(
          'failed',
          serialize(new FatalError('Workflow result is not serializable', { cause: error }))
        )
      }
    } else {
      store.finishRun('failed', this.serializeError(outcome.error))
    }

    this.host.runSettled()
  }

  private serializeError(error: unknown): string {
    try {
      return serialize(error)
    } catch {
      return serialize(new Error(error instanceof Error ? error.message : 'Workflow failed'))
    }
  }

  private nextKey(prefix: string): string {
    const count = this.counters.get(prefix) ?? 0

    this.counters.set(prefix, count + 1)

    return `${prefix}#${count}`
  }

  private async step(
    id: string,
    maxRetries: number,
    body: () => Promise<unknown>
  ): Promise<unknown> {
    if (this.halted) return halted()

    const store = this.host.store
    const key = this.nextKey(`step:${id}`)
    const recorded = store.readJournal(key)

    if (recorded !== undefined) return replayEntry(recorded)

    this.stepsInFlight += 1
    this.host.wakeAt(Date.now() + stepGuardIntervalMs)

    try {
      for (let attempt = 1; ; attempt++) {
        const scope: StepScope = {
          runId: this.run.runId,
          stepId: key,
          attempt,
          stepStartedAt: new Date(),
          workflowStartedAt: new Date(this.run.createdAt),
          writable: () => this.writable()
        }

        try {
          const value: unknown = await stepStorage.run(scope, body)
          const text = serialize(value)

          if (this.halted) return halted()

          store.writeJournal(key, { ok: true, value: text })

          return deserialize(text)
        } catch (error) {
          if (this.halted) return halted()

          if (!FatalError.is(error) && attempt <= maxRetries) {
            this.host.log(`Workflow step ${id} attempt ${attempt} failed; retrying`, error)
            await delay(retryDelayMs(attempt, error))

            if (this.halted) return halted()

            continue
          }

          const failure = FatalError.is(error)
            ? error
            : new FatalError(`Step ${id} failed after ${attempt} attempts`, { cause: error })

          const text = this.serializeError(failure)

          store.writeJournal(key, { ok: false, value: text })

          throw deserialize(text)
        }
      }
    } finally {
      this.stepsInFlight -= 1
    }
  }

  private hook(token: string): Promise<unknown> {
    if (this.halted) return halted()

    const store = this.host.store
    const key = this.nextKey(`hook:${token}`)
    const recorded = store.readJournal(key)

    if (recorded !== undefined) {
      try {
        return Promise.resolve(replayEntry(recorded))
      } catch (error) {
        return Promise.reject(error)
      }
    }

    store.writePendingHook(token, key)

    return new Promise(resolve => {
      this.hookWaiters.set(key, resolve)
      this.host.registerHook(token).catch(error => {
        this.host.log(`Could not register workflow hook ${token}`, error)
      })
    })
  }

  private sleep(ms: number): Promise<void> {
    if (this.halted) return halted()

    const store = this.host.store
    const key = this.nextKey('sleep')

    if (store.readJournal(key) !== undefined) return Promise.resolve()

    const wakeAt = store.readSleep(key) ?? Date.now() + ms

    if (store.readSleep(key) === undefined) store.writeSleep(key, wakeAt)

    this.host.wakeAt(wakeAt)

    return new Promise(resolve => {
      const timer = setTimeout(
        () => {
          this.sleepTimers.delete(timer)

          if (this.halted) return

          store.writeJournal(key, { ok: true, value: serialize(undefined) })
          resolve()
        },
        Math.max(0, wakeAt - Date.now())
      )

      this.sleepTimers.add(timer)
    })
  }

  private writable(): WritableStream<Uint8Array> {
    const store = this.host.store

    return new WritableStream<Uint8Array>({
      write: chunk => {
        const bytes = encodeChunk(chunk)
        const index = store.appendChunk(bytes)

        this.host.chunkAppended(index, bytes)
      },
      close: () => {
        if (store.isStreamClosed()) throw new Error('The workflow stream is already closed')

        store.closeStream()
        this.host.streamClosed()
      }
    })
  }
}

export class WorkflowExecution {
  private live: LiveRun | undefined
  private readonly host: ExecutionHost

  constructor(host: ExecutionHost) {
    this.host = host
  }

  get stepsInFlight(): number {
    return this.live?.stepsInFlight ?? 0
  }

  get running(): boolean {
    return this.live !== undefined
  }

  /** Runs (or replays) the body unless it already runs here or the run ended. */
  kick(): void {
    if (this.live !== undefined) return

    const run = this.host.store.readRun()

    if (run === undefined || isTerminal(run)) return

    const live = new LiveRun(run, this.host)

    this.live = live

    live
      .execute()
      .catch(error => this.host.log('Workflow execution failed', error))
      .finally(() => {
        if (this.live === live) this.live = undefined
      })
  }

  /** Records a hook's payload, then hands it to the waiting body or replays the run. */
  deliverHook(token: string, payloadText: string): void {
    const store = this.host.store
    const key = store.readPendingHook(token)

    if (key === undefined) throw new HookNotFoundError(token)

    store.writeJournal(key, { ok: true, value: payloadText })
    store.deletePendingHook(token)

    if (this.live?.resolveHook(key, deserialize(payloadText)) === true) return

    this.kick()
  }

  cancel(): void {
    const run = this.host.store.readRun()

    if (run === undefined || isTerminal(run)) return

    this.host.store.finishRun('cancelled', serialize(undefined))
    this.live?.halt()
    this.live = undefined
    this.host.runSettled()
  }

  /** An alarm: re-arm while a step runs here, or replay a run lost with an earlier instance. */
  wake(): void {
    if (this.live !== undefined) {
      if (this.live.stepsInFlight > 0) this.host.wakeAt(Date.now() + stepGuardIntervalMs)

      return
    }

    this.kick()
  }
}
