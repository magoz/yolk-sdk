import { getWritable, sleep } from 'workflow'
import { runVercelAgentWorkflow } from '@yolk-sdk/vercel-workflows-runtime/workflow'

type FixtureInput = {
  readonly request: unknown
  readonly context: unknown
}

export async function packageOwnedDirectiveWorkflow(input: FixtureInput): Promise<string> {
  'use workflow'

  await runVercelAgentWorkflow({
    input,
    maxTurns: 4,
    runModelStep: packageModelStep,
    runToolBatchStep: packageToolBatchStep,
    closeStream: packageCloseStep,
    writeError: packageErrorStep
  })

  return 'workflow-complete'
}

export async function packageStreamWorkflow(): Promise<string> {
  'use workflow'

  await packageWriteStreamStep('first')
  await packageWriteStreamStep('second')
  await packageCloseStreamStep()

  return 'stream-complete'
}

export async function packageCancellableWorkflow(): Promise<string> {
  'use workflow'

  await packageWriteStreamStep('started')
  await sleep('10m')

  return 'cancel-not-observed'
}

async function packageModelStep(input: {
  readonly state: {
    readonly request: unknown
    readonly messages?: ReadonlyArray<unknown>
    readonly createdMessages: ReadonlyArray<unknown>
    readonly turn: number
  }
}) {
  'use step'

  const baseMessages = input.state.messages ?? [input.state.request]
  const assistantMessage = `assistant-${input.state.turn}`

  if (input.state.turn === 1) {
    return {
      done: false,
      messages: [...baseMessages, assistantMessage],
      createdMessages: [...input.state.createdMessages, assistantMessage],
      toolCalls: ['tool-a', 'tool-b'],
      usage: { turns: input.state.turn },
      turn: input.state.turn
    }
  }

  return {
    done: true,
    messages: [...baseMessages, assistantMessage],
    createdMessages: [...input.state.createdMessages, assistantMessage],
    toolCalls: [],
    usage: { turns: input.state.turn },
    turn: input.state.turn
  }
}

async function packageToolBatchStep(input: {
  readonly calls: ReadonlyArray<unknown>
  readonly createdMessages: ReadonlyArray<unknown>
}) {
  'use step'

  const messages = input.calls.map(call => `result-${String(call)}`)

  return {
    messages,
    createdMessages: [...input.createdMessages, ...messages]
  }
}

async function packageCloseStep() {
  'use step'
}

async function packageErrorStep(error: unknown) {
  'use step'

  throw error instanceof Error ? error : new Error('workflow fixture failed')
}

async function packageWriteStreamStep(chunk: string) {
  'use step'

  const writer = getWritable<string>().getWriter()
  try {
    await writer.write(chunk)
  } finally {
    writer.releaseLock()
  }
}

async function packageCloseStreamStep() {
  'use step'

  await getWritable<string>().close()
}
