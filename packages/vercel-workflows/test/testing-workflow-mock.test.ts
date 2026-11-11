import { describe, expect, it, vi } from 'vitest'
import { TestWorkflowWorld } from '../src/testing/index.ts'

// Hosts mock the ambient `workflow` module with `testWorkflowModule`; the world's step-error
// serializer must still be the installed runtime's.
vi.mock('workflow', async () => {
  const { testWorkflowModule } = await import('../src/testing/index.ts')

  return testWorkflowModule
})

describe('TestWorkflowWorld under a mocked workflow module', () => {
  it('still stores step errors with the installed runtime', async () => {
    const world = new TestWorkflowWorld()

    class TaggedFailure extends Error {
      readonly _tag = 'TaggedFailure'
    }

    const step = Object.assign(
      async (): Promise<never> => {
        throw new TaggedFailure('permanent')
      },
      { maxRetries: 0 }
    )

    const { runId } = world.start(async () => world.runStep(step, [], 'doomed'), [])
    await world.settled(runId)

    const { runError } = world.inspect(runId)

    expect(runError).toMatchObject({
      name: 'FatalError',
      message: 'Step "doomed" failed after 0 retries: permanent',
      cause: { message: 'permanent' }
    })
    // Read back from storage: the tag is gone.
    expect(runError instanceof Error ? runError.cause : undefined).not.toHaveProperty('_tag')
  })
})
