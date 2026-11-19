// The parts of workerd's `cloudflare:workers` module the Cloudflare runtime uses, for this
// package's own type check only (not shipped: hosts type `cloudflare:workers` with their own
// Workers types). `@cloudflare/workers-types` declares Web globals that clash with the DOM library
// the workspace type-checks against, so these structural declarations stand in for it.
declare module 'cloudflare:workers' {
  export type SqlValue = ArrayBuffer | string | number | null

  export type SqlRow = Record<string, SqlValue>

  export interface SqlCursor {
    toArray(): Array<SqlRow>
  }

  export interface DurableObjectSql {
    exec(query: string, ...bindings: ReadonlyArray<unknown>): SqlCursor
  }

  export interface DurableObjectStorage {
    readonly sql: DurableObjectSql
    setAlarm(scheduledTime: number): Promise<void>
    getAlarm(): Promise<number | null>
  }

  export interface DurableObjectState {
    readonly id: { toString(): string; readonly name?: string }
    readonly storage: DurableObjectStorage
    waitUntil(promise: Promise<unknown>): void
  }

  export abstract class DurableObject<Env = unknown> {
    protected readonly ctx: DurableObjectState
    protected readonly env: Env
    constructor(ctx: DurableObjectState, env: Env)
  }

  export const env: object
}
