import { Data, Predicate } from 'effect'

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
  readonly hitlResponses?: ReadonlyArray<unknown>
  readonly usage?: unknown
  readonly turn?: number
  readonly eventSequence?: number
}

export type VercelAgentWorkflowAwaitingInput = {
  readonly hookToken: string
  readonly requests: ReadonlyArray<unknown>
  readonly messages: ReadonlyArray<unknown>
  readonly usage: unknown
  readonly turns: number
  readonly eventSequence?: number
}

export type VercelAgentWorkflowToolBatchStepResult = {
  readonly messages: ReadonlyArray<unknown>
  readonly createdMessages: ReadonlyArray<unknown>
  /** Updated cumulative usage when tools run nested model work such as subagents. */
  readonly usage?: unknown
  readonly awaitingInput?: VercelAgentWorkflowAwaitingInput
  readonly eventSequence?: number
  /**
   * A plain wire-safe failure captured after partial progress. Returning it instead of rejecting
   * lets orchestration retain usage and event sequencing from completed sibling tools.
   */
  readonly failure?: unknown
}

export type WorkflowStepResult<A> = Data.TaggedEnum<{
  Success: {
    readonly value: A
  }
  Failure: {
    readonly error: unknown
  }
}>

interface WorkflowStepResultDefinition extends Data.TaggedEnum.WithGenerics<1> {
  readonly taggedEnum: WorkflowStepResult<this['A']>
}

export const WorkflowStepResult = Data.taggedEnum<WorkflowStepResultDefinition>()

export type VercelAgentWorkflowStepRetryPolicy = {
  readonly maxAttempts: number
}

export type VercelAgentWorkflowRunResult = Data.TaggedEnum<{
  Completed: {
    readonly turns: number
    readonly state: SerializableWorkflowState
  }
  ModelStepFailed: {
    readonly turn: number
    readonly error: unknown
    readonly state: SerializableWorkflowState
  }
  ToolBatchStepFailed: {
    readonly turn: number
    readonly error: unknown
    readonly state: SerializableWorkflowState
  }
  AwaitInputFailed: {
    readonly turn: number
    readonly error: unknown
    readonly awaitingInput: VercelAgentWorkflowAwaitingInput
    readonly state: SerializableWorkflowState
  }
  CloseStreamFailed: {
    readonly turns: number
    readonly error: unknown
    readonly state: SerializableWorkflowState
  }
  MaxTurnsExceeded: {
    readonly maxTurns: number
    readonly error: Error
    readonly state: SerializableWorkflowState
  }
}>

export const VercelAgentWorkflowRunResult = Data.taggedEnum<VercelAgentWorkflowRunResult>()

export type VercelAgentWorkflowLoopConfig = {
  readonly input: VercelAgentWorkflowInput
  readonly maxTurns?: number
  readonly runModelStep: (
    input: VercelAgentWorkflowModelStepInput
  ) => Promise<VercelAgentWorkflowModelStepResult>
  readonly runToolBatchStep: (
    input: VercelAgentWorkflowToolBatchStepInput
  ) => Promise<VercelAgentWorkflowToolBatchStepResult>
  /** Called only after a model step returns `done: true`. */
  readonly closeStream: () => Promise<void>
  /**
   * Best-effort final failure handler. It must write a safe final error and
   * close the failure stream; rejection is suppressed in favor of the
   * original structured run result.
   */
  readonly writeError: (error: unknown) => Promise<void>
  /** A successful await suspends/resumes without invoking either finalizer. */
  readonly awaitInput?: (input: VercelAgentWorkflowAwaitingInput) => Promise<unknown>
  readonly modelStepRetry?: VercelAgentWorkflowStepRetryPolicy
  readonly toolBatchStepRetry?: VercelAgentWorkflowStepRetryPolicy
  readonly awaitInputRetry?: VercelAgentWorkflowStepRetryPolicy
  readonly closeStreamRetry?: VercelAgentWorkflowStepRetryPolicy
}

export const defaultMaxWorkflowTurns = 500

export const noWorkflowStepRetry: VercelAgentWorkflowStepRetryPolicy = { maxAttempts: 1 }

export const settleWorkflowStep = <A>(promise: Promise<A>): Promise<WorkflowStepResult<A>> =>
  promise.then(
    value => WorkflowStepResult.Success<A>({ value }),
    error => WorkflowStepResult.Failure<A>({ error })
  )

const workflowMaxTurnsError = (maxTurns: number) =>
  new Error(`Vercel agent workflow exceeded max turns: ${maxTurns}`)

const writeErrorSafely = (writeError: (error: unknown) => Promise<void>, error: unknown) =>
  writeError(error).catch(() => undefined)

const missingAwaitInputHandlerError = () =>
  new Error(
    'Vercel agent workflow awaiting input requested but no awaitInput handler is configured'
  )

const maxRetryAttempts = (policy: VercelAgentWorkflowStepRetryPolicy | undefined) => {
  const configured = policy?.maxAttempts ?? noWorkflowStepRetry.maxAttempts

  return Number.isFinite(configured) ? Math.max(1, Math.floor(configured)) : 1
}

const maxWorkflowTurns = (configured: number | undefined) => {
  if (configured === undefined || !Number.isFinite(configured)) {
    return defaultMaxWorkflowTurns
  }

  return Math.max(1, Math.floor(configured))
}

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
  const {
    input,
    maxTurns: configuredMaxTurns,
    runModelStep,
    runToolBatchStep,
    closeStream,
    writeError,
    awaitInput,
    modelStepRetry,
    toolBatchStepRetry,
    awaitInputRetry,
    closeStreamRetry
  } = config

  let state: SerializableWorkflowState = {
    request: input.request,
    createdMessages: [],
    turn: 1,
    eventSequence: 0
  }

  const maxTurns = maxWorkflowTurns(configuredMaxTurns)

  for (let step = 0; step < maxTurns; step++) {
    const modelResult = await settleWorkflowStep(
      retryWorkflowStep(() => runModelStep({ context: input.context, state }), modelStepRetry)
    )

    if (Predicate.isTagged(modelResult, 'Failure')) {
      await writeErrorSafely(writeError, modelResult.error)

      return VercelAgentWorkflowRunResult.ModelStepFailed({
        turn: state.turn,
        error: modelResult.error,
        state
      })
    }

    if (modelResult.value.done) {
      const terminalState: SerializableWorkflowState = {
        request: input.request,
        messages: modelResult.value.messages,
        createdMessages: modelResult.value.createdMessages,
        usage: modelResult.value.usage,
        turn: modelResult.value.turn,
        eventSequence: modelResult.value.eventSequence ?? state.eventSequence
      }

      const closeResult = await settleWorkflowStep(retryWorkflowStep(closeStream, closeStreamRetry))

      if (Predicate.isTagged(closeResult, 'Failure')) {
        await writeErrorSafely(writeError, closeResult.error)

        return VercelAgentWorkflowRunResult.CloseStreamFailed({
          turns: modelResult.value.turn,
          error: closeResult.error,
          state: terminalState
        })
      }

      return VercelAgentWorkflowRunResult.Completed({
        turns: modelResult.value.turn,
        state: terminalState
      })
    }

    if (modelResult.value.toolCalls.length === 0) {
      state = {
        request: input.request,
        messages: modelResult.value.messages,
        createdMessages: modelResult.value.createdMessages,
        usage: modelResult.value.usage,
        turn: modelResult.value.turn + 1,
        eventSequence: modelResult.value.eventSequence ?? state.eventSequence
      }
      continue
    }

    let completedToolsResult: VercelAgentWorkflowToolBatchStepResult | undefined
    const toolHitlResponses: Array<unknown> = []
    let cumulativeUsage = modelResult.value.usage
    let toolEventSequence = modelResult.value.eventSequence ?? state.eventSequence

    const currentTurnState = (
      toolResult?: VercelAgentWorkflowToolBatchStepResult
    ): SerializableWorkflowState => ({
      request: input.request,
      messages:
        toolResult === undefined
          ? modelResult.value.messages
          : [...modelResult.value.messages, ...toolResult.messages],
      createdMessages: toolResult?.createdMessages ?? modelResult.value.createdMessages,
      usage: cumulativeUsage,
      turn: modelResult.value.turn,
      eventSequence: toolEventSequence
    })

    for (;;) {
      const toolsResult = await settleWorkflowStep(
        retryWorkflowStep(
          () =>
            runToolBatchStep({
              context: input.context,
              request: input.request,
              calls: modelResult.value.toolCalls,
              createdMessages: modelResult.value.createdMessages,
              hitlResponses: toolHitlResponses.slice(),
              usage: cumulativeUsage,
              turn: modelResult.value.turn,
              eventSequence: toolEventSequence
            }),
          toolBatchStepRetry
        )
      )

      if (Predicate.isTagged(toolsResult, 'Failure')) {
        await writeErrorSafely(writeError, toolsResult.error)

        return VercelAgentWorkflowRunResult.ToolBatchStepFailed({
          turn: modelResult.value.turn,
          error: toolsResult.error,
          state: currentTurnState()
        })
      }

      cumulativeUsage = toolsResult.value.usage ?? cumulativeUsage
      toolEventSequence = toolsResult.value.eventSequence ?? toolEventSequence

      if (toolsResult.value.failure !== undefined) {
        await writeErrorSafely(writeError, toolsResult.value.failure)

        return VercelAgentWorkflowRunResult.ToolBatchStepFailed({
          turn: modelResult.value.turn,
          error: toolsResult.value.failure,
          state: currentTurnState(toolsResult.value)
        })
      }

      if (toolsResult.value.awaitingInput === undefined) {
        completedToolsResult = toolsResult.value
        break
      }

      const awaitingInput = toolsResult.value.awaitingInput
      cumulativeUsage = toolsResult.value.usage ?? awaitingInput.usage ?? cumulativeUsage
      toolEventSequence = awaitingInput.eventSequence ?? toolEventSequence

      const hitlResponse = await settleWorkflowStep(
        retryWorkflowStep(() => {
          if (awaitInput === undefined) {
            return Promise.reject(missingAwaitInputHandlerError())
          }

          return awaitInput(awaitingInput)
        }, awaitInputRetry)
      )

      if (Predicate.isTagged(hitlResponse, 'Failure')) {
        await writeErrorSafely(writeError, hitlResponse.error)

        return VercelAgentWorkflowRunResult.AwaitInputFailed({
          turn: modelResult.value.turn,
          error: hitlResponse.error,
          awaitingInput,
          state: currentTurnState(toolsResult.value)
        })
      }

      toolHitlResponses.push(hitlResponse.value)
    }

    if (completedToolsResult === undefined) {
      const error = new Error('Vercel agent workflow tool batch did not complete')
      await writeErrorSafely(writeError, error)

      return VercelAgentWorkflowRunResult.ToolBatchStepFailed({
        turn: modelResult.value.turn,
        error,
        state
      })
    }

    state = {
      request: input.request,
      messages: [...modelResult.value.messages, ...completedToolsResult.messages],
      createdMessages: completedToolsResult.createdMessages,
      usage: completedToolsResult.usage ?? cumulativeUsage,
      turn: modelResult.value.turn + 1,
      eventSequence: completedToolsResult.eventSequence ?? toolEventSequence
    }
  }

  const error = workflowMaxTurnsError(maxTurns)
  await writeErrorSafely(writeError, error)

  return VercelAgentWorkflowRunResult.MaxTurnsExceeded({
    maxTurns,
    error,
    state
  })
}
