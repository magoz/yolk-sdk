import { DatabaseSync, type SQLInputValue, type SQLOutputValue } from 'node:sqlite'
import { Predicate } from 'effect'
import {
  env,
  type DurableObjectSql,
  type DurableObjectState,
  type SqlRow,
  type SqlValue
} from 'cloudflare:workers'
import { WorkflowRun } from '../src/cloudflare/durable-object.ts'
import {
  workflowRunsBinding,
  type WorkflowRunNamespace,
  type WorkflowRunStub
} from '../src/cloudflare/namespace.ts'

// A Durable Object namespace of `WorkflowRun` instances in memory, each over its own SQLite
// database (`node:sqlite`, as Durable Object SQLite: blobs read back as `ArrayBuffer`). `evict`
// drops an instance but keeps its storage, as Cloudflare does when it evicts an object.

const toBinding = (value: unknown): SQLInputValue => {
  if (value instanceof ArrayBuffer) return new Uint8Array(value)

  if (
    value === null ||
    Predicate.isNumber(value) ||
    Predicate.isBigInt(value) ||
    Predicate.isString(value) ||
    Predicate.isUint8Array(value)
  ) {
    return value
  }

  throw new TypeError(`Durable Object SQL cannot bind ${String(value)}`)
}

const fromColumn = (value: SQLOutputValue): SqlValue => {
  if (value instanceof Uint8Array) {
    return value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength)
  }

  return Predicate.isBigInt(value) ? Number(value) : value
}

export const makeSqliteSql = (database: DatabaseSync): DurableObjectSql => ({
  exec: (query, ...bindings) => {
    const statement = database.prepare(query)
    const values = bindings.map(toBinding)

    const rows = statement.all(...values).map(row => {
      const converted: SqlRow = {}

      for (const [column, value] of Object.entries(row)) converted[column] = fromColumn(value)

      return converted
    })

    return { toArray: () => rows }
  }
})

type Instance = {
  readonly database: DatabaseSync
  object: WorkflowRun | undefined
  alarm: number | null
}

export const makeFakeWorkflowRuns = () => {
  const instances = new Map<string, Instance>()
  const background: Array<Promise<unknown>> = []

  const instanceNamed = (name: string): Instance => {
    const existing = instances.get(name)

    if (existing !== undefined) return existing

    const created: Instance = {
      database: new DatabaseSync(':memory:'),
      object: undefined,
      alarm: null
    }

    instances.set(name, created)

    return created
  }

  const objectOf = (name: string): WorkflowRun => {
    const instance = instanceNamed(name)

    if (instance.object !== undefined) return instance.object

    const state: DurableObjectState = {
      id: { toString: () => name, name },
      storage: {
        sql: makeSqliteSql(instance.database),
        setAlarm: async time => {
          instance.alarm = time
        },
        getAlarm: async () => instance.alarm
      },
      waitUntil: promise => {
        background.push(promise)
      }
    }

    instance.object = new WorkflowRun(state, {})

    return instance.object
  }

  const namespace: WorkflowRunNamespace = {
    getByName: (name): WorkflowRunStub => ({
      start: input => objectOf(name).start(input),
      status: () => objectOf(name).status(),
      settled: () => objectOf(name).settled(),
      cancel: () => objectOf(name).cancel(),
      resumeHook: (token, payload) => objectOf(name).resumeHook(token, payload),
      tailIndex: () => objectOf(name).tailIndex(),
      readable: startIndex => objectOf(name).readable(startIndex),
      hookHeld: token => objectOf(name).hookHeld(token),
      hookClaim: (token, runId) => objectOf(name).hookClaim(token, runId),
      hookRun: () => objectOf(name).hookRun()
    })
  }

  return {
    namespace,
    install: () => {
      Reflect.set(env, workflowRunsBinding, namespace)
    },
    /** Drops the live object; the next call builds a new one over the same storage. */
    evict: (name: string) => {
      const instance = instances.get(name)

      if (instance !== undefined) instance.object = undefined
    },
    /** Fires the instance's alarm, as Cloudflare does once it is due (or after an eviction). */
    fireAlarm: (name: string) => objectOf(name).alarm(),
    alarmOf: (name: string) => instances.get(name)?.alarm ?? null,
    settleBackground: () => Promise.all(background.splice(0))
  }
}
