import { createHook, getWritable, sleep } from 'workflow'
import { getRun, start } from 'workflow/api'
import {
  awaitWorkflowChild,
  orchestrateWorkflowToolBatch,
  runVercelAgentWorkflow,
  type VercelAgentWorkflowModelStepInput
} from '@yolk-sdk/vercel-workflows'
import { Predicate } from 'effect'

export type ChildFixtureInput = {
  readonly token: string
  readonly background: boolean
  readonly failParent: boolean
  readonly failChild: boolean
}

export async function isolatedParentFixture(input: ChildFixtureInput) {
  'use workflow'

  const terminal = await runVercelAgentWorkflow({
    input: { request: input, context: null },
    runModelStep: fixtureModelStep,
    runToolBatchStep: async batch => {
      const outcome = await orchestrateWorkflowToolBatch<string, string, never>({
        calls: ['child', 'sibling'],
        concurrency: 2,
        preflight: async () => {
          await fixturePreflightStep()

          return { ready: true }
        },
        execute: async call => {
          if (call === 'sibling') return await fixtureSiblingStep()
          const run = await start(isolatedChildFixture, [input.token, input.failChild])
          await fixtureWriteStep(`child:${run.runId}`)

          if (input.background) return 'accepted'

          return await awaitWorkflowChild<string>({
            read: async () => await fixtureChildStatusStep(run.runId),
            sleep: async () => {
              await sleep('1s')
            }
          })
        }
      })

      const messages = outcome.ready ? outcome.results : []

      return { messages, createdMessages: [...batch.createdMessages, ...messages] }
    },
    closeStream: fixtureCloseStep,
    writeError: fixtureErrorStep
  })

  if (input.failParent) throw new Error('Parent failed after launch')

  return terminal
}

export async function isolatedChildFixture(token: string, fail: boolean) {
  'use workflow'

  const terminal = await runVercelAgentWorkflow({
    input: { request: null, context: null },
    runModelStep: fixtureModelStep,
    runToolBatchStep: async batch => {
      using hook = createHook<string>({ token })
      await hook
      const result = await fixtureChildToolStep(fail)

      return { messages: [result], createdMessages: [...batch.createdMessages, result] }
    },
    closeStream: fixtureCloseStep,
    writeError: fixtureErrorStep
  })

  if (!Predicate.isTagged(terminal, 'Completed'))
    throw new Error('Child failed within isolated boundary')

  return terminal
}

async function fixtureModelStep(input: VercelAgentWorkflowModelStepInput) {
  'use step'
  const message = `model-${input.state.turn}`
  const writer = getWritable<string>().getWriter()

  try {
    await writer.write(message)
  } finally {
    writer.releaseLock()
  }

  return {
    done: input.state.turn === 2,
    messages: [...(input.state.messages ?? []), message],
    createdMessages: [...input.state.createdMessages, message],
    toolCalls: input.state.turn === 1 ? ['tool'] : [],
    usage: {},
    turn: input.state.turn
  }
}

async function fixturePreflightStep() {
  'use step'
}

async function fixtureSiblingStep() {
  'use step'

  return 'sibling-result'
}

async function fixtureChildToolStep(fail: boolean) {
  'use step'

  if (fail) throw new Error('Visible child tool defect')
  const writer = getWritable<string>().getWriter()

  try {
    await writer.write('child-tool')
  } finally {
    writer.releaseLock()
  }

  return 'child-tool-result'
}

fixtureChildToolStep.maxRetries = 0

async function fixtureWriteStep(value: string) {
  'use step'
  const writer = getWritable<string>().getWriter()

  try {
    await writer.write(value)
  } finally {
    writer.releaseLock()
  }
}

async function fixtureCloseStep() {
  'use step'
  await getWritable<string>().close()
}

async function fixtureErrorStep() {
  'use step'
  await getWritable<string>().close()
}

async function fixtureChildStatusStep(
  runId: string
): Promise<{ readonly done: false } | { readonly done: true; readonly value: string }> {
  'use step'
  const status = await getRun(runId).status

  return status === 'completed'
    ? { done: true, value: 'child-completed' }
    : status === 'failed' || status === 'cancelled'
      ? { done: true, value: 'child-failed' }
      : { done: false }
}
