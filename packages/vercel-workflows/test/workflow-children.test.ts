import { describe, expect, it } from 'vitest'
import { awaitWorkflowChild, orchestrateWorkflowToolBatch } from '../src/workflow-children.ts'

const latch = () => {
  let release = () => {}
  const promise = new Promise<void>(resolve => {
    release = resolve
  })
  return { promise, release }
}

describe('workflow child orchestration', () => {
  it('continues the parent after background acceptance while child remains blocked', async () => {
    const child = latch()
    let childDone = false
    const independentRun = child.promise.then(() => {
      childDone = true
    })
    const batch = await orchestrateWorkflowToolBatch({
      calls: ['launch', 'normal'],
      concurrency: 2,
      preflight: async () => ({ ready: true }),
      execute: async call => (call === 'launch' ? 'accepted' : 'normal-result')
    })
    expect(batch).toEqual({ ready: true, results: ['accepted', 'normal-result'] })
    expect(childDone).toBe(false)
    child.release()
    await independentRun
  })

  it('keeps ordered results and siblings despite a failed foreground child outcome', async () => {
    const blocked = latch()
    const entered = latch()
    const batch = orchestrateWorkflowToolBatch({
      calls: [0, 1, 2],
      concurrency: 2,
      preflight: async () => ({ ready: true }),
      execute: async call => {
        if (call === 0) {
          entered.release()
          await blocked.promise
          return 'child-error'
        }
        return `result-${call}`
      }
    })
    await entered.promise
    blocked.release()
    expect(await batch).toEqual({ ready: true, results: ['child-error', 'result-1', 'result-2'] })
  })

  it('does not dispatch anything before all HITL requests are resolved', async () => {
    let executed = 0
    const batch = await orchestrateWorkflowToolBatch({
      calls: ['child', 'write'],
      concurrency: 4,
      preflight: async () => ({ ready: false, value: 'awaiting-approval' }),
      execute: async () => {
        executed++
        return ''
      }
    })
    expect(batch).toEqual({ ready: false, value: 'awaiting-approval' })
    expect(executed).toBe(0)
  })

  it('settles in-flight siblings and preserves their progress after execution rejection', async () => {
    const blocked = latch()
    const entered = latch()
    const calls: number[] = []
    const batch = orchestrateWorkflowToolBatch({
      calls: [0, 1, 2],
      concurrency: 2,
      preflight: async () => ({ ready: true }),
      execute: async call => {
        calls.push(call)
        if (call === 0) {
          await entered.promise
          throw new Error('step failed')
        }
        entered.release()
        await blocked.promise
        return 'committed sibling'
      }
    })
    await entered.promise
    // Let the rejection reach the scheduler before the surviving sibling resolves.
    await Promise.resolve()
    await Promise.resolve()
    blocked.release()
    expect(await batch).toMatchObject({
      ready: true,
      results: ['committed sibling'],
      failures: [{ index: 0, error: { message: 'step failed' } }]
    })
    expect(calls).toEqual([0, 1])
  })

  it('uses short reads separated by the host durable sleep and preserves terminal failures', async () => {
    const operations: string[] = []
    let reads = 0
    const result = await awaitWorkflowChild<string>({
      read: async () => {
        operations.push('read')
        return ++reads === 3 ? { done: true, value: 'failed' } : { done: false }
      },
      sleep: async () => {
        operations.push('durable-sleep')
      }
    })
    expect(result).toBe('failed')
    expect(operations).toEqual(['read', 'durable-sleep', 'read', 'durable-sleep', 'read'])
  })
})
