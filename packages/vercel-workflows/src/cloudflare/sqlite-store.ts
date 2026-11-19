import type { DurableObjectSql, SqlRow } from 'cloudflare:workers'
import { Predicate } from 'effect'
import type { JournalEntry, RunRecord, RunStatus, RunStore } from './store.ts'

// The run store on a Durable Object's SQLite. Values are devalue text split into parts, since a
// step result (a conversation) can exceed one row's size limit.

const partSize = 512 * 1024

const schema = [
  `CREATE TABLE IF NOT EXISTS wf_run (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    run_id TEXT NOT NULL,
    workflow_id TEXT NOT NULL,
    status TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    completed_at INTEGER
  )`,
  `CREATE TABLE IF NOT EXISTS wf_value (
    key TEXT NOT NULL,
    part INTEGER NOT NULL,
    text TEXT NOT NULL,
    PRIMARY KEY (key, part)
  )`,
  `CREATE TABLE IF NOT EXISTS wf_journal (key TEXT PRIMARY KEY, ok INTEGER NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS wf_sleep (key TEXT PRIMARY KEY, wake_at INTEGER NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS wf_hook (token TEXT PRIMARY KEY, key TEXT NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS wf_chunk (idx INTEGER PRIMARY KEY, data BLOB NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS wf_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)`
]

const text = (row: SqlRow | undefined, column: string): string | undefined => {
  const value = row?.[column]

  return Predicate.isString(value) ? value : undefined
}

const number = (row: SqlRow | undefined, column: string): number | undefined => {
  const value = row?.[column]

  return Predicate.isNumber(value) ? value : undefined
}

const isStatus = (value: string | undefined): value is RunStatus =>
  value === 'pending' ||
  value === 'running' ||
  value === 'completed' ||
  value === 'failed' ||
  value === 'cancelled'

export const makeSqliteRunStore = (sql: DurableObjectSql): RunStore => {
  for (const statement of schema) sql.exec(statement)

  const rows = (query: string, ...bindings: ReadonlyArray<unknown>) =>
    sql.exec(query, ...bindings).toArray()

  const writeValue = (key: string, value: string) => {
    sql.exec('DELETE FROM wf_value WHERE key = ?', key)

    for (let part = 0, offset = 0; offset < value.length || part === 0; part++) {
      sql.exec(
        'INSERT INTO wf_value (key, part, text) VALUES (?, ?, ?)',
        key,
        part,
        value.slice(offset, offset + partSize)
      )
      offset += partSize
    }
  }

  const readValue = (key: string): string | undefined => {
    const parts = rows('SELECT text FROM wf_value WHERE key = ? ORDER BY part', key)

    if (parts.length === 0) return undefined

    return parts.map(row => text(row, 'text') ?? '').join('')
  }

  const meta = (key: string) =>
    text(rows('SELECT value FROM wf_meta WHERE key = ?', key)[0], 'value')

  const setMeta = (key: string, value: string) => {
    sql.exec('INSERT OR REPLACE INTO wf_meta (key, value) VALUES (?, ?)', key, value)
  }

  return {
    readRun: () => {
      const row = rows('SELECT * FROM wf_run WHERE id = 1')[0]
      const runId = text(row, 'run_id')
      const workflowId = text(row, 'workflow_id')
      const status = text(row, 'status')
      const createdAt = number(row, 'created_at')

      if (
        runId === undefined ||
        workflowId === undefined ||
        !isStatus(status) ||
        createdAt === undefined
      ) {
        return undefined
      }

      const record: RunRecord = {
        runId,
        workflowId,
        args: readValue('run:args') ?? '[]',
        status,
        outcome: readValue('run:outcome'),
        createdAt,
        completedAt: number(row, 'completed_at')
      }

      return record
    },
    createRun: run => {
      sql.exec(
        'INSERT INTO wf_run (id, run_id, workflow_id, status, created_at) VALUES (1, ?, ?, ?, ?)',
        run.runId,
        run.workflowId,
        run.status,
        run.createdAt
      )
      writeValue('run:args', run.args)
    },
    setStatus: status => {
      sql.exec('UPDATE wf_run SET status = ? WHERE id = 1', status)
    },
    finishRun: (status, outcome) => {
      writeValue('run:outcome', outcome)
      sql.exec('UPDATE wf_run SET status = ?, completed_at = ? WHERE id = 1', status, Date.now())
    },
    readJournal: key => {
      const row = rows('SELECT ok FROM wf_journal WHERE key = ?', key)[0]
      const ok = number(row, 'ok')
      const value = readValue(`journal:${key}`)

      if (ok === undefined || value === undefined) return undefined

      const entry: JournalEntry = { ok: ok === 1, value }

      return entry
    },
    writeJournal: (key, entry) => {
      writeValue(`journal:${key}`, entry.value)
      sql.exec('INSERT OR REPLACE INTO wf_journal (key, ok) VALUES (?, ?)', key, entry.ok ? 1 : 0)
    },
    readSleep: key => number(rows('SELECT wake_at FROM wf_sleep WHERE key = ?', key)[0], 'wake_at'),
    writeSleep: (key, wakeAt) => {
      sql.exec('INSERT OR REPLACE INTO wf_sleep (key, wake_at) VALUES (?, ?)', key, wakeAt)
    },
    earliestPendingSleep: () =>
      number(
        rows(
          'SELECT MIN(wake_at) AS wake_at FROM wf_sleep WHERE key NOT IN (SELECT key FROM wf_journal)'
        )[0],
        'wake_at'
      ),
    readPendingHook: token =>
      text(rows('SELECT key FROM wf_hook WHERE token = ?', token)[0], 'key'),
    writePendingHook: (token, key) => {
      sql.exec('INSERT OR REPLACE INTO wf_hook (token, key) VALUES (?, ?)', token, key)
    },
    deletePendingHook: token => {
      sql.exec('DELETE FROM wf_hook WHERE token = ?', token)
    },
    appendChunk: chunk => {
      const index = number(rows('SELECT COUNT(*) AS count FROM wf_chunk')[0], 'count') ?? 0

      sql.exec(
        'INSERT INTO wf_chunk (idx, data) VALUES (?, ?)',
        index,
        chunk.buffer.slice(chunk.byteOffset, chunk.byteOffset + chunk.byteLength)
      )

      return index
    },
    readChunks: fromIndex =>
      rows('SELECT data FROM wf_chunk WHERE idx >= ? ORDER BY idx', fromIndex).flatMap(row => {
        const data = row.data

        return data instanceof ArrayBuffer ? [new Uint8Array(data)] : []
      }),
    chunkCount: () => number(rows('SELECT COUNT(*) AS count FROM wf_chunk')[0], 'count') ?? 0,
    isStreamClosed: () => meta('stream_closed') === '1',
    closeStream: () => {
      setMeta('stream_closed', '1')
    }
  }
}

/** A hook-index instance (named `hook:<token>`) maps its token to the run that waits on it. */
export const makeHookIndex = (sql: DurableObjectSql) => {
  sql.exec(
    'CREATE TABLE IF NOT EXISTS wf_hook_run (id INTEGER PRIMARY KEY CHECK (id = 1), run_id TEXT NOT NULL)'
  )

  return {
    read: () =>
      text(sql.exec('SELECT run_id FROM wf_hook_run WHERE id = 1').toArray()[0], 'run_id'),
    write: (runId: string) => {
      sql.exec('INSERT OR REPLACE INTO wf_hook_run (id, run_id) VALUES (1, ?)', runId)
    }
  }
}
