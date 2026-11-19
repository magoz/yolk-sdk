import { createHook, getWritable, sleep } from 'workflow'
import {
  runVercelAgentWorkflow,
  type VercelAgentWorkflowRunResult,
  type VercelAgentWorkflowToolBatchStepInput
} from '@yolk-sdk/vercel-workflows'

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

export async function packageHitlDirectiveWorkflow(
  input: FixtureInput
): Promise<VercelAgentWorkflowRunResult> {
  'use workflow'

  return await runVercelAgentWorkflow({
    input,
    maxTurns: 4,
    runModelStep: packageHitlModelStep,
    runToolBatchStep: packageHitlToolBatchStep,
    awaitInput: async awaitingInput => {
      using hook = createHook<unknown>({ token: awaitingInput.hookToken })

      return await hook
    },
    closeStream: packageCloseStep,
    writeError: packageErrorStep
  })
}

export async function packageStreamWorkflow(): Promise<string> {
  'use workflow'

  await packageWriteStreamStep('first')
  await packageWriteStreamStep('second')
  await packageCloseStreamStep()

  return 'stream-complete'
}

export async function packageStreamHitlWorkflow(): Promise<string> {
  'use workflow'

  await packageWriteStreamStep('before-hitl')
  using hook = createHook<string>({ token: 'package-stream-hitl-hook' })
  const response = await hook

  await packageWriteStreamStep(`after-${response}`)
  await packageCloseStreamStep()

  return response
}

// Reads one payload, then sleeps with the hook still live, then sleeps again after disposing it.
export async function packageHookAnswersWorkflow(token: string): Promise<string> {
  'use workflow'

  let answer: string

  {
    using hook = createHook<string>({ token })

    answer = await hook
    await sleep('10m')
  }

  await sleep('10m')

  return answer
}

// Two pauses that (wrongly) share one token.
export async function packageHookTwoPausesWorkflow(token: string): Promise<Array<string>> {
  'use workflow'

  const answers: Array<string> = []

  for (let pause = 1; pause <= 2; pause++) {
    using hook = createHook<string>({ token })

    answers.push(await hook)
  }

  return answers
}

export async function packageHookOnceWorkflow(token: string): Promise<string> {
  'use workflow'

  using hook = createHook<string>({ token })

  return await hook
}

// Creates a hook whose token another hook may hold; returns its answer or the failure awaiting it
// reports.
export async function packageHookConflictWorkflow(token: string): Promise<string> {
  'use workflow'

  using hook = createHook<string>({ token })

  return await hook.then(
    answer => `answer: ${answer}`,
    (error: unknown) => String(error)
  )
}

// Two live hooks of one run share a token: the second is refused, the first still answers.
export async function packageHookSameRunConflictWorkflow(token: string): Promise<Array<string>> {
  'use workflow'

  using first = createHook<string>({ token })
  using second = createHook<string>({ token })

  const refused = await second.then(
    answer => `answer: ${answer}`,
    (error: unknown) => String(error)
  )

  return [refused, await first]
}

// Creates the next hook before disposing the one holding its token: the run applies the disposal
// first when it suspends, so the next hook takes the token.
export async function packageHookDisposeAfterCreateWorkflow(token: string): Promise<Array<string>> {
  'use workflow'

  const previous = createHook<string>({ token })
  const first = await previous
  using next = createHook<string>({ token })

  previous[Symbol.dispose]()

  return [first, await next]
}

// As above, but the run suspends on a step before the disposal, while the token is still held.
export async function packageHookDisposeAfterStepWorkflow(token: string): Promise<Array<string>> {
  'use workflow'

  const previous = createHook<string>({ token })
  const first = await previous
  using next = createHook<string>({ token })

  await packageWriteStreamStep('between hooks')
  previous[Symbol.dispose]()

  const refused = await next.then(
    answer => `answer: ${answer}`,
    (error: unknown) => String(error)
  )

  return [first, refused]
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

async function packageHitlModelStep(input: {
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
      toolCalls: ['approval-tool'],
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

async function packageHitlToolBatchStep(input: VercelAgentWorkflowToolBatchStepInput) {
  'use step'

  const response = input.hitlResponses?.[0]

  if (response !== 'approved') {
    return {
      messages: [],
      createdMessages: input.createdMessages,
      awaitingInput: {
        hookToken: 'package-hitl-hook',
        requests: ['approval-request'],
        messages: input.createdMessages,
        usage: input.usage,
        turns: input.turn ?? 0,
        eventSequence: 7
      },
      eventSequence: 5
    }
  }

  const messages = [`result-${String(input.calls[0])}-${String(response)}`]

  return {
    messages,
    createdMessages: [...input.createdMessages, ...messages],
    eventSequence: 9
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
