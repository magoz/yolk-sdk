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

export type VercelAgentWorkflowStepRetryPolicy = {
  readonly maxAttempts: number
}

export type VercelAgentWorkflowRunResult =
  | {
      readonly _tag: 'Completed'
      readonly turns: number
      readonly state: SerializableWorkflowState
    }
  | {
      readonly _tag: 'ModelStepFailed'
      readonly turn: number
      readonly error: unknown
      readonly state: SerializableWorkflowState
    }
  | {
      readonly _tag: 'ToolBatchStepFailed'
      readonly turn: number
      readonly error: unknown
      readonly state: SerializableWorkflowState
    }
  | {
      readonly _tag: 'CloseStreamFailed'
      readonly turns: number
      readonly error: unknown
      readonly state: SerializableWorkflowState
    }
  | {
      readonly _tag: 'MaxTurnsExceeded'
      readonly maxTurns: number
      readonly error: Error
      readonly state: SerializableWorkflowState
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
  readonly modelStepRetry?: VercelAgentWorkflowStepRetryPolicy
  readonly toolBatchStepRetry?: VercelAgentWorkflowStepRetryPolicy
  readonly closeStreamRetry?: VercelAgentWorkflowStepRetryPolicy
}

export const defaultMaxWorkflowTurns = 500
export const noWorkflowStepRetry: VercelAgentWorkflowStepRetryPolicy = { maxAttempts: 1 }

export const settleWorkflowStep = <A>(promise: Promise<A>): Promise<WorkflowStepResult<A>> =>
  promise.then(
    value => ({ _tag: 'Success', value }),
    error => ({ _tag: 'Failure', error })
  )

const workflowMaxTurnsError = (maxTurns: number) =>
  new Error(`Vercel agent workflow exceeded max turns: ${maxTurns}`)

const writeErrorSafely = (writeError: (error: unknown) => Promise<void>, error: unknown) =>
  writeError(error).catch(() => undefined)

const maxRetryAttempts = (policy: VercelAgentWorkflowStepRetryPolicy | undefined) =>
  Math.max(1, Math.floor(policy?.maxAttempts ?? noWorkflowStepRetry.maxAttempts))

export async function retryWorkflowStep<A>(
  runStep: () => Promise<A>,
  policy?: VercelAgentWorkflowStepRetryPolicy
): Promise<A> {
  const maxAttempts = maxRetryAttempts(policy)
  let attempt = 1

  for (;;) {
    try {
      return await runStep()
    } catch (error) {
      if (attempt >= maxAttempts) {
        throw error
      }

      attempt += 1
    }
  }
}

export async function runVercelAgentWorkflow(
  config: VercelAgentWorkflowLoopConfig
): Promise<VercelAgentWorkflowRunResult> {
  let state: SerializableWorkflowState = {
    request: config.input.request,
    createdMessages: [],
    turn: 1,
    eventSequence: 0
  }
  const maxTurns = config.maxTurns ?? defaultMaxWorkflowTurns

  for (let step = 0; step < maxTurns; step++) {
    const modelResult = await settleWorkflowStep(
      retryWorkflowStep(
        () => config.runModelStep({ context: config.input.context, state }),
        config.modelStepRetry
      )
    )

    if (modelResult._tag === 'Failure') {
      await writeErrorSafely(config.writeError, modelResult.error)
      return {
        _tag: 'ModelStepFailed',
        turn: state.turn,
        error: modelResult.error,
        state
      }
    }

    if (modelResult.value.done) {
      const closeResult = await settleWorkflowStep(
        retryWorkflowStep(config.closeStream, config.closeStreamRetry)
      )

      if (closeResult._tag === 'Failure') {
        await writeErrorSafely(config.writeError, closeResult.error)

        return {
          _tag: 'CloseStreamFailed',
          turns: modelResult.value.turn,
          error: closeResult.error,
          state
        }
      }

      return {
        _tag: 'Completed',
        turns: modelResult.value.turn,
        state
      }
    }

    const toolsResult = await settleWorkflowStep(
      retryWorkflowStep(
        () =>
          config.runToolBatchStep({
            context: config.input.context,
            request: config.input.request,
            calls: modelResult.value.toolCalls,
            createdMessages: modelResult.value.createdMessages,
            turn: modelResult.value.turn,
            eventSequence: modelResult.value.eventSequence ?? state.eventSequence
          }),
        config.toolBatchStepRetry
      )
    )

    if (toolsResult._tag === 'Failure') {
      await writeErrorSafely(config.writeError, toolsResult.error)
      return {
        _tag: 'ToolBatchStepFailed',
        turn: modelResult.value.turn,
        error: toolsResult.error,
        state
      }
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

  const error = workflowMaxTurnsError(maxTurns)
  await writeErrorSafely(config.writeError, error)

  return {
    _tag: 'MaxTurnsExceeded',
    maxTurns,
    error,
    state
  }
}
