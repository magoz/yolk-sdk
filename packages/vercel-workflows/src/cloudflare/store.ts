/**
 * What one workflow run persists. The Durable Object implements it on its own SQLite storage; tests
 * use the in-memory one. Every method is synchronous because Durable Object SQLite is.
 */

export type RunStatus = 'pending' | 'running' | 'completed' | 'failed' | 'cancelled'

export type RunRecord = {
  readonly runId: string
  readonly workflowId: string
  /** devalue text of the argument list. */
  readonly args: string
  readonly status: RunStatus
  /** devalue text of the return value or the thrown error once the run ended. */
  readonly outcome: string | undefined
  readonly createdAt: number
  readonly completedAt: number | undefined
}

export type JournalEntry = {
  readonly ok: boolean
  /** devalue text. */
  readonly value: string
}

export interface RunStore {
  readonly readRun: () => RunRecord | undefined
  readonly createRun: (run: RunRecord) => void
  readonly setStatus: (status: RunStatus) => void
  readonly finishRun: (status: 'completed' | 'failed' | 'cancelled', outcome: string) => void

  readonly readJournal: (key: string) => JournalEntry | undefined
  readonly writeJournal: (key: string, entry: JournalEntry) => void

  /** A sleep's wake time, kept from its first replay so later replays wake at the same time. */
  readonly readSleep: (key: string) => number | undefined
  readonly writeSleep: (key: string, wakeAt: number) => void
  readonly earliestPendingSleep: () => number | undefined

  /**
   * The run's live hooks: the journal key of the hook holding each token, kept from when the hook
   * takes the token until it is disposed (after its payload, too).
   */
  readonly readPendingHook: (token: string) => string | undefined
  readonly writePendingHook: (token: string, key: string) => void
  readonly deletePendingHook: (token: string) => void

  readonly appendChunk: (chunk: Uint8Array) => number
  readonly readChunks: (fromIndex: number) => ReadonlyArray<Uint8Array>
  readonly chunkCount: () => number
  readonly isStreamClosed: () => boolean
  readonly closeStream: () => void
}

/** An in-memory store, for tests. */
export const makeMemoryRunStore = (): RunStore => {
  let run: RunRecord | undefined
  const journal = new Map<string, JournalEntry>()
  const sleeps = new Map<string, number>()
  const firedSleeps = new Set<string>()
  const hooks = new Map<string, string>()
  const chunks: Array<Uint8Array> = []
  let closed = false

  return {
    readRun: () => run,
    createRun: record => {
      run = record
    },
    setStatus: status => {
      if (run !== undefined) run = { ...run, status }
    },
    finishRun: (status, outcome) => {
      if (run !== undefined) run = { ...run, status, outcome, completedAt: Date.now() }
    },
    readJournal: key => journal.get(key),
    writeJournal: (key, entry) => {
      journal.set(key, entry)

      if (key.startsWith('sleep:')) firedSleeps.add(key)
    },
    readSleep: key => sleeps.get(key),
    writeSleep: (key, wakeAt) => {
      sleeps.set(key, wakeAt)
    },
    earliestPendingSleep: () => {
      let earliest: number | undefined

      for (const [key, wakeAt] of sleeps) {
        if (firedSleeps.has(key)) continue

        if (earliest === undefined || wakeAt < earliest) earliest = wakeAt
      }

      return earliest
    },
    readPendingHook: token => hooks.get(token),
    writePendingHook: (token, key) => {
      hooks.set(token, key)
    },
    deletePendingHook: token => {
      hooks.delete(token)
    },
    appendChunk: chunk => {
      chunks.push(chunk)

      return chunks.length - 1
    },
    readChunks: fromIndex => chunks.slice(fromIndex),
    chunkCount: () => chunks.length,
    isStreamClosed: () => closed,
    closeStream: () => {
      closed = true
    }
  }
}
