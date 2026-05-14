export type VercelAgentWorkflowInput = {
  readonly request: unknown
  readonly context: unknown
}

export type SerializableWorkflowState = {
  readonly request: unknown
  readonly messages?: ReadonlyArray<unknown>
  readonly createdMessages: ReadonlyArray<unknown>
  readonly usage?: unknown
  readonly turn: number
  readonly eventSequence?: number
}

export type VercelAgentWorkflowModelStepInput = {
  readonly context: unknown
  readonly state: SerializableWorkflowState
}

export type VercelAgentWorkflowModelStepResult = {
  readonly done: boolean
  readonly messages: ReadonlyArray<unknown>
  readonly createdMessages: ReadonlyArray<unknown>
  readonly toolCalls: ReadonlyArray<unknown>
  readonly usage: unknown
  readonly turn: number
  readonly eventSequence?: number
}

export type VercelAgentWorkflowToolBatchStepInput = {
  readonly context: unknown
  readonly request: unknown
  readonly calls: ReadonlyArray<unknown>
  readonly createdMessages: ReadonlyArray<unknown>
  readonly turn?: number
  readonly eventSequence?: number
}

export type VercelAgentWorkflowToolBatchStepResult = {
  readonly messages: ReadonlyArray<unknown>
  readonly createdMessages: ReadonlyArray<unknown>
  readonly eventSequence?: number
}

export type WorkflowStepResult<A> =
  | {
      readonly _tag: 'Success'
      readonly value: A
    }
  | {
      readonly _tag: 'Failure'
      readonly error: unknown
    }

export type VercelAgentWorkflowLoopConfig = {
  readonly input: VercelAgentWorkflowInput
  readonly maxTurns?: number
  readonly runModelStep: (
    input: VercelAgentWorkflowModelStepInput
  ) => Promise<VercelAgentWorkflowModelStepResult>
  readonly runToolBatchStep: (
    input: VercelAgentWorkflowToolBatchStepInput
  ) => Promise<VercelAgentWorkflowToolBatchStepResult>
  readonly closeStream: () => Promise<void>
  readonly writeError: (error: unknown) => Promise<void>
}

export const defaultMaxWorkflowTurns = 500

export const settleWorkflowStep = <A>(promise: Promise<A>): Promise<WorkflowStepResult<A>> =>
  promise.then(
    value => ({ _tag: 'Success', value }),
    error => ({ _tag: 'Failure', error })
  )

const workflowMaxTurnsError = (maxTurns: number) =>
  new Error(`Vercel agent workflow exceeded max turns: ${maxTurns}`)

const writeErrorSafely = (writeError: (error: unknown) => Promise<void>, error: unknown) =>
  writeError(error).catch(() => undefined)

export async function runVercelAgentWorkflow(config: VercelAgentWorkflowLoopConfig): Promise<void> {
  let state: SerializableWorkflowState = {
    request: config.input.request,
    createdMessages: [],
    turn: 1,
    eventSequence: 0
  }
  const maxTurns = config.maxTurns ?? defaultMaxWorkflowTurns

  for (let step = 0; step < maxTurns; step++) {
    const modelResult = await settleWorkflowStep(
      config.runModelStep({ context: config.input.context, state })
    )

    if (modelResult._tag === 'Failure') {
      await writeErrorSafely(config.writeError, modelResult.error)
      return
    }

    if (modelResult.value.done) {
      const closeResult = await settleWorkflowStep(config.closeStream())

      if (closeResult._tag === 'Failure') {
        await writeErrorSafely(config.writeError, closeResult.error)
      }

      return
    }

    const toolsResult = await settleWorkflowStep(
      config.runToolBatchStep({
        context: config.input.context,
        request: config.input.request,
        calls: modelResult.value.toolCalls,
        createdMessages: modelResult.value.createdMessages,
        turn: modelResult.value.turn,
        eventSequence: modelResult.value.eventSequence ?? state.eventSequence
      })
    )

    if (toolsResult._tag === 'Failure') {
      await writeErrorSafely(config.writeError, toolsResult.error)
      return
    }

    state = {
      request: config.input.request,
      messages: [...modelResult.value.messages, ...toolsResult.value.messages],
      createdMessages: toolsResult.value.createdMessages,
      usage: modelResult.value.usage,
      turn: modelResult.value.turn + 1,
      eventSequence: toolsResult.value.eventSequence ?? modelResult.value.eventSequence ?? state.eventSequence
    }
  }

  await writeErrorSafely(config.writeError, workflowMaxTurnsError(maxTurns))
}
