import { Predicate } from 'effect'
import {
  stepStorage,
  workflowStorage,
  type StepScope,
  type WorkflowHook,
  type WorkflowScope
} from './context.ts'
import { FatalError, HookConflictError, HookNotFoundError, RetryableError } from './errors.ts'
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

/** A hook index's answer to a run's claim on a token: taken, or held by another run's live hook. */
export type HookClaim =
  | { readonly claimed: true }
  | { readonly claimed: false; readonly holderRunId: string }

export interface ExecutionHost {
  readonly store: RunStore
  /** Arm a wake-up (an alarm) no later than `time`. */
  readonly wakeAt: (time: number) => void
  /**
   * Route `token` to this run from outside (`resumeHook`), unless a live hook of another run holds
   * it. A run may claim a token it already holds (a replay asks again): that claim is granted.
   */
  readonly claimHook: (token: string) => Promise<HookClaim>
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

/** The run whose hook held the token when a refused hook's journal entry was written. */
const holderOf = (entry: JournalEntry): string | undefined => {
  const holder = deserialize(entry.value)

  return Predicate.isString(holder) ? holder : undefined
}

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

/** A hook change the run applies when it next waits: a new hook takes its token, or frees it. */
type HookChange = {
  readonly kind: 'claim' | 'release'
  readonly token: string
  /** The hook's journal key. */
  readonly key: string
}

type HookWaiter = {
  readonly resolve: (payload: unknown) => void
  readonly reject: (error: HookConflictError) => void
}

/** A promise whose rejection is reported only to whoever awaits it. */
const quiet = <A>(promise: Promise<A>): Promise<A> => {
  promise.catch(() => undefined)

  return promise
}

class LiveRun {
  stepsInFlight = 0
  private halted = false
  private readonly counters = new Map<string, number>()
  private readonly hookWaiters = new Map<string, HookWaiter>()
  private hookChanges: Array<HookChange> = []
  private hookTimer: ReturnType<typeof setTimeout> | undefined
  /** Per token, the claim decided last, which the token's next claim waits for. */
  private readonly claimChains = new Map<string, Promise<void>>()
  /** Per token, the journal key of the undisposed hook whose claim awaits the index's answer. */
  private readonly claiming = new Map<string, string>()
  /** Per journal key, what ends a claim's wait to retry early. */
  private readonly claimWakers = new Map<string, () => void>()
  /** Journal keys of the hooks the body disposed. */
  private readonly disposedHooks = new Set<string>()
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

    if (this.hookTimer !== undefined) clearTimeout(this.hookTimer)

    this.hookTimer = undefined
    this.hookChanges = []

    for (const wake of [...this.claimWakers.values()]) wake()
  }

  resolveHook(key: string, payload: unknown): boolean {
    const waiter = this.hookWaiters.get(key)

    if (waiter === undefined) return false

    this.hookWaiters.delete(key)
    waiter.resolve(payload)

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

  // A hook holds its token from when the run next waits until it is disposed or the run ends; one
  // live hook holds a token at a time. Its journal entry is its first payload, or the run holding
  // the token when it was refused, so a replay reads the same outcome.
  private hook(token: string): WorkflowHook {
    if (this.halted) return { payload: halted(), dispose: () => undefined }

    const key = this.nextKey(`hook:${token}`)
    const recorded = this.host.store.readJournal(key)
    let disposed = false

    const dispose = () => {
      if (disposed) return

      disposed = true
      this.disposeHook(token, key)
    }

    if (recorded !== undefined) {
      const payload = recorded.ok
        ? Promise.resolve(deserialize(recorded.value))
        : Promise.reject(new HookConflictError(token, holderOf(recorded)))

      return { payload: quiet(payload), dispose }
    }

    const payload = new Promise<unknown>((resolve, reject) => {
      this.hookWaiters.set(key, { resolve, reject })
    })

    this.changeHook({ kind: 'claim', token, key })

    return { payload: quiet(payload), dispose }
  }

  private disposeHook(token: string, key: string) {
    const unclaimed = this.hookChanges.findIndex(
      change => change.kind === 'claim' && change.key === key
    )

    this.disposedHooks.add(key)

    // A claim still waiting for its answer, or to retry, no longer makes the index refuse others.
    if (this.claiming.get(token) === key) this.claiming.delete(token)

    this.claimWakers.get(key)?.()

    // Disposed before the run waited: it never takes the token.
    if (unclaimed !== -1) {
      this.hookChanges.splice(unclaimed, 1)
      this.hookWaiters.delete(key)
    }

    // Released even then: a replay disposes a hook whose row an earlier execution kept when the
    // object went away before applying the disposal. A release frees only this hook's row.
    this.changeHook({ kind: 'release', token, key })
  }

  // The platform creates hooks, and records their disposals, when the run next suspends. This
  // runtime applies them once the body is idle (the next macrotask), in order, after earlier ones.
  private changeHook(change: HookChange) {
    this.hookChanges.push(change)

    if (this.hookTimer !== undefined) return

    this.hookTimer = setTimeout(() => {
      const changes = this.hookChanges

      this.hookTimer = undefined
      this.hookChanges = []
      this.applyHookChanges(changes)
    }, 0)
  }

  // Disposals first: they are of hooks created before this batch's new ones, and the platform
  // frees a disposed hook's token before a later hook of the run claims it. A release is
  // synchronous and frees only its hook's row, so it never waits for a claim; a claim waits only
  // for earlier claims on its token (the platform decides each token on its own), so an index that
  // keeps failing holds up no other token.
  private applyHookChanges(changes: ReadonlyArray<HookChange>) {
    const store = this.host.store

    for (const change of changes) {
      if (change.kind === 'release' && store.readPendingHook(change.token) === change.key) {
        store.deletePendingHook(change.token)
      }
    }

    for (const { kind, token, key } of changes) {
      if (kind !== 'claim') continue

      const decided: Promise<void> = (this.claimChains.get(token) ?? Promise.resolve())
        .then(() => this.claimHook(token, key))
        .catch(error => this.host.log(`Could not claim workflow hook ${token}`, error))
        .finally(() => {
          if (this.claimChains.get(token) === decided) this.claimChains.delete(token)
        })

      this.claimChains.set(token, decided)
    }
  }

  private isLive(): boolean {
    const run = this.host.store.readRun()

    return !this.halted && run !== undefined && !isTerminal(run)
  }

  // The row of a hook (its token's `wf_hook` entry) is written only once the index granted the
  // claim, so a resume never reaches a hook that may still lose it; until then a resume answers
  // `HookNotFoundError`, which callers retry. While the claim is undecided, `isClaiming` tells the
  // index the token is taken, so the grant it may already have sent is not given to another run.
  private async claimHook(token: string, key: string) {
    const store = this.host.store

    if (!this.isLive() || this.disposedHooks.has(key)) return

    const held = store.readPendingHook(token)

    if (held !== undefined && held !== key) {
      this.refuseHook(token, key, this.run.runId)

      return
    }

    // `held === key`: a replay re-creating a hook with a row. Its claim is asked again: the row
    // may predate the grant (builds before this one wrote it before claiming).
    this.claiming.set(token, key)

    try {
      const claim = await this.requestClaim(token, key)

      if (claim === undefined || !this.isLive()) return

      if (claim.claimed) {
        // Disposed meanwhile: it never holds the token (the index asks `hookHeld` next time).
        if (!this.disposedHooks.has(key)) store.writePendingHook(token, key)

        return
      }

      if (store.readPendingHook(token) === key) store.deletePendingHook(token)

      this.refuseHook(token, key, claim.holderRunId)
    } finally {
      if (this.claiming.get(token) === key) this.claiming.delete(token)
    }
  }

  // The index is another object: a failed call (a reset, an overload) is retried with the step
  // backoff and never journaled. The guard alarm, armed while a claim is in flight, replays the run
  // if this object goes away meanwhile. Undefined once the run ended or the hook was disposed (the
  // disposal, or the run's halt, ends the wait to retry at once).
  private async requestClaim(token: string, key: string): Promise<HookClaim | undefined> {
    for (let attempt = 1; ; attempt++) {
      if (!this.isLive() || this.disposedHooks.has(key)) return undefined

      this.host.wakeAt(Date.now() + stepGuardIntervalMs)

      try {
        return await this.host.claimHook(token)
      } catch (error) {
        this.host.log(`Could not claim workflow hook ${token}; retrying`, error)

        await new Promise<void>(resolve => {
          const wake = () => {
            clearTimeout(timer)
            this.claimWakers.delete(key)
            resolve()
          }

          const timer = setTimeout(wake, retryDelayMs(attempt, error))

          this.claimWakers.set(key, wake)
        })
      }
    }
  }

  /** Whether an undisposed hook's claim on `token` is waiting for the index's answer. */
  isClaiming(token: string): boolean {
    return this.claiming.has(token)
  }

  /** Whether the body disposed the hook journaled under `key`. */
  hasDisposed(key: string): boolean {
    return this.disposedHooks.has(key)
  }

  get claimsInFlight(): number {
    return this.claiming.size
  }

  private refuseHook(token: string, key: string, holderRunId: string) {
    const store = this.host.store

    if (store.readJournal(key) === undefined) {
      store.writeJournal(key, { ok: false, value: serialize(holderRunId) })
    }

    const waiter = this.hookWaiters.get(key)

    this.hookWaiters.delete(key)
    waiter?.reject(new HookConflictError(token, holderRunId))
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

  /**
   * Whether a live hook of this run holds `token`: granted by the index, neither disposed nor ended
   * with its run. Only such a hook takes payloads.
   */
  holdsHook(token: string): boolean {
    const run = this.host.store.readRun()

    return (
      run !== undefined && !isTerminal(run) && this.host.store.readPendingHook(token) !== undefined
    )
  }

  /** What the index asks: this run holds `token`, or a claim of its own on it awaits an answer. */
  claimsHook(token: string): boolean {
    const run = this.host.store.readRun()

    if (run === undefined || isTerminal(run)) return false

    return (
      this.host.store.readPendingHook(token) !== undefined || this.live?.isClaiming(token) === true
    )
  }

  /**
   * Records the first payload of the hook holding `token`, then hands it to the waiting body or
   * replays the run. A hook is read once here, so later payloads are accepted and dropped.
   */
  deliverHook(token: string, payloadText: string): void {
    const store = this.host.store
    const key = store.readPendingHook(token)

    if (key === undefined || !this.holdsHook(token)) throw new HookNotFoundError(token)

    // Disposed, its release not applied yet: accepted and dropped, never journaled, so a replay
    // sees the hook unanswered as the body did.
    if (this.live?.hasDisposed(key) === true || store.readJournal(key) !== undefined) return

    store.writeJournal(key, { ok: true, value: payloadText })

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

  /**
   * An alarm: re-arm while a step or a hook claim runs here, or replay a run lost with an earlier
   * instance.
   */
  wake(): void {
    if (this.live !== undefined) {
      if (this.live.stepsInFlight > 0 || this.live.claimsInFlight > 0) {
        this.host.wakeAt(Date.now() + stepGuardIntervalMs)
      }

      return
    }

    this.kick()
  }
}
