/** Workflow orchestration only. Callbacks must be durable steps (sleep must be Workflow sleep).
 * A read is short-lived; never put a long returnValue poll inside a step.
 */
export async function awaitWorkflowChild<A>(input: {
  readonly read: () => Promise<
    { readonly done: false } | { readonly done: true; readonly value: A }
  >
  readonly sleep: () => Promise<void>
}): Promise<A> {
  const { read, sleep } = input
  for (;;) {
    const state = await read()
    if (state.done) return state.value
    await sleep()
  }
}

/** Preflight fences the entire batch. On rejection, stop dispatching new work, settle already
 * active siblings, and return their ordered progress alongside failures. Hosts must handle failures.
 */
export async function orchestrateWorkflowToolBatch<Call, Result, Pause>(input: {
  readonly calls: ReadonlyArray<Call>
  readonly concurrency: number
  readonly preflight: () => Promise<
    { readonly ready: true } | { readonly ready: false; readonly value: Pause }
  >
  readonly execute: (call: Call, index: number) => Promise<Result>
}): Promise<
  | {
      readonly ready: true
      readonly results: ReadonlyArray<Result>
      readonly failures?: ReadonlyArray<{ readonly index: number; readonly error: unknown }>
    }
  | { readonly ready: false; readonly value: Pause }
> {
  const { calls, concurrency, preflight, execute } = input
  const prepared = await preflight()
  if (!prepared.ready) return prepared
  const width = Number.isFinite(concurrency) ? Math.max(1, Math.floor(concurrency)) : 1
  const entries = calls.map((call, index) => ({ call, index }))
  let next = 0
  const results = new Map<number, Result>()
  const failures: Array<{ readonly index: number; readonly error: unknown }> = []
  await Promise.all(
    Array.from({ length: Math.min(width, calls.length) }, async () => {
      while (failures.length === 0) {
        const entry = entries[next++]
        if (entry === undefined) return
        try {
          results.set(entry.index, await execute(entry.call, entry.index))
        } catch (error) {
          failures.push({ index: entry.index, error })
        }
      }
    })
  )
  return {
    ready: true,
    results: [...results.entries()].sort(([a], [b]) => a - b).map(([, result]) => result),
    ...(failures.length === 0 ? {} : { failures: failures.sort((a, b) => a.index - b.index) })
  }
}
