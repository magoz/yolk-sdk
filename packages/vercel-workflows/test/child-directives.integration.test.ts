import { describe, expect, it } from 'vitest'
import { getRun, resumeHook, start } from 'workflow/api'
import { waitForHook, waitForSleep } from '@workflow/vitest'
import { isolatedParentFixture } from './fixtures/child-workflow-fixture.ts'

const readChildId = async (readable: ReadableStream<string>) => {
  const reader = readable.getReader()
  try {
    for (;;) {
      const chunk = await reader.read()
      if (chunk.done) throw new Error('Missing child handle')
      if (chunk.value.startsWith('child:')) return chunk.value.slice(6)
    }
  } finally {
    reader.releaseLock()
  }
}
const collect = async (readable: ReadableStream<string>) => {
  const reader = readable.getReader()
  const values: string[] = []
  try {
    for (;;) {
      const chunk = await reader.read()
      if (chunk.done) return values
      values.push(chunk.value)
    }
  } finally {
    reader.releaseLock()
  }
}

describe('independent Workflow child directives', () => {
  for (const failParent of [false, true]) {
    it(`background child survives parent ${failParent ? 'failure' : 'completion'} and has real model/tool steps`, async () => {
      const token = `child-background-${failParent}`
      const parent = await start(isolatedParentFixture, [
        { token, background: true, failParent, failChild: false }
      ])
      const childId = await readChildId(parent.getReadable<string>())
      expect(childId).toMatch(/^wrun_/)
      expect(childId).not.toBe(parent.runId)
      const child = getRun(childId)
      await waitForHook(child, { token })
      if (failParent) await expect(parent.returnValue).rejects.toThrow()
      else
        await expect(parent.returnValue).resolves.toMatchObject({
          _tag: 'Completed',
          state: { createdMessages: ['model-1', 'accepted', 'sibling-result', 'model-2'] }
        })
      expect(await child.status).toBe('running')
      // Only a model turn ran so far; parent finalization did not close/cancel the child.
      await resumeHook(token, 'go')
      await expect(child.returnValue).resolves.toMatchObject({
        _tag: 'Completed',
        state: { createdMessages: ['model-1', 'child-tool-result', 'model-2'] }
      })
      expect(await collect(child.getReadable<string>())).toEqual([
        'model-1',
        'child-tool',
        'model-2'
      ])
    })
  }

  for (const failChild of [false, true]) {
    it(`awaits foreground child ${failChild ? 'failure' : 'success'} without failing parent or siblings`, async () => {
      const token = `child-foreground-${failChild}`
      const parent = await start(isolatedParentFixture, [
        { token, background: false, failParent: false, failChild }
      ])
      const childId = await readChildId(parent.getReadable<string>())
      const child = getRun(childId)
      await waitForHook(child, { token })
      const sleeping = await waitForSleep(parent)
      expect(await parent.status).toBe('running')
      await resumeHook(token, 'go')
      if (failChild) await expect(child.returnValue).rejects.toThrow()
      else await expect(child.returnValue).resolves.toMatchObject({ _tag: 'Completed' })
      expect(await child.status).toBe(failChild ? 'failed' : 'completed')
      await parent.wakeUp({ correlationIds: [sleeping] })
      await expect(parent.returnValue).resolves.toMatchObject({
        _tag: 'Completed',
        state: {
          createdMessages: [
            'model-1',
            failChild ? 'child-failed' : 'child-completed',
            'sibling-result',
            'model-2'
          ]
        }
      })
    })
  }
})
