import { describe, expect, it } from 'vitest'
import {
  runVercelAgentWorkflow,
  retryWorkflowStep,
  settleWorkflowStep,
  type SerializableWorkflowState,
  type VercelAgentWorkflowLoopConfig,
  type VercelAgentWorkflowModelStepInput,
  type VercelAgentWorkflowModelStepResult,
  type VercelAgentWorkflowToolBatchStepInput,
  type VercelAgentWorkflowToolBatchStepResult
} from '../src/workflow.ts'

const terminalModelResult = (input: VercelAgentWorkflowModelStepInput) =>
  ({
    done: true,
    messages: [...(input.state.messages ?? [input.state.request]), `assistant-${input.state.turn}`],
    createdMessages: [...input.state.createdMessages, `assistant-${input.state.turn}`],
    toolCalls: [],
    usage: { turns: input.state.turn },
    turn: input.state.turn
  }) satisfies VercelAgentWorkflowModelStepResult

const toolModelResult = (input: VercelAgentWorkflowModelStepInput) =>
  ({
    done: false,
    messages: [...(input.state.messages ?? [input.state.request]), `assistant-${input.state.turn}`],
    createdMessages: [...input.state.createdMessages, `assistant-${input.state.turn}`],
    toolCalls: [`tool-${input.state.turn}-a`, `tool-${input.state.turn}-b`],
    usage: { turns: input.state.turn },
    turn: input.state.turn
  }) satisfies VercelAgentWorkflowModelStepResult

const toolBatchResult = (input: VercelAgentWorkflowToolBatchStepInput) =>
  ({
    messages: input.calls.map(call => `result-${String(call)}`),
    createdMessages: [
      ...input.createdMessages,
      ...input.calls.map(call => `result-${String(call)}`)
    ]
  }) satisfies VercelAgentWorkflowToolBatchStepResult

const step = <A>(body: () => A | Promise<A>) =>
  Promise.resolve().then(body)

const emptyStep = () => Promise.resolve()

const failStep = (error: unknown) => Promise.reject(error)

const runWorkflow = (config: VercelAgentWorkflowLoopConfig) =>
  runVercelAgentWorkflow(config)

describe('runVercelAgentWorkflow', () => {
  it('closes stream after terminal model step', async () => {
    const states: Array<SerializableWorkflowState> = []
    let closeCount = 0

    const result = await runWorkflow({
      input: { request: 'request-1', context: 'ctx-1' },
      runModelStep: input => step(() => {
        states.push(input.state)
        return terminalModelResult(input)
      }),
      runToolBatchStep: input => step(() => toolBatchResult(input)),
      closeStream: () => step(() => {
        closeCount += 1
      }),
      writeError: emptyStep
    })

    expect(result).toMatchObject({
      _tag: 'Completed',
      state: {
        request: 'request-1',
        messages: ['request-1', 'assistant-1'],
        createdMessages: ['assistant-1'],
        usage: { turns: 1 },
        turn: 1,
        eventSequence: 0
      }
    })
    expect(states).toEqual([
      { request: 'request-1', createdMessages: [], turn: 1, eventSequence: 0 }
    ])
    expect(closeCount).toBe(1)
  })

  it('continues from model tool calls through tool batch result', async () => {
    const modelStates: Array<SerializableWorkflowState> = []
    const toolInputs: Array<VercelAgentWorkflowToolBatchStepInput> = []

    const result = await runWorkflow({
      input: { request: 'request-1', context: 'ctx-1' },
      runModelStep: input => step(() => {
        modelStates.push(input.state)
        return input.state.turn === 1 ? toolModelResult(input) : terminalModelResult(input)
      }),
      runToolBatchStep: input => step(() => {
        toolInputs.push(input)
        return { ...toolBatchResult(input), usage: { turns: 1, subagentTurns: 3 } }
      }),
      closeStream: emptyStep,
      writeError: emptyStep
    })

    expect(result).toMatchObject({ _tag: 'Completed', turns: 2 })
    expect(toolInputs).toEqual([
      {
        context: 'ctx-1',
        request: 'request-1',
        calls: ['tool-1-a', 'tool-1-b'],
        createdMessages: ['assistant-1'],
        hitlResponses: [],
        usage: { turns: 1 },
        turn: 1,
        eventSequence: 0
      }
    ])
    expect(modelStates[1]).toEqual({
      request: 'request-1',
      messages: ['request-1', 'assistant-1', 'result-tool-1-a', 'result-tool-1-b'],
      createdMessages: ['assistant-1', 'result-tool-1-a', 'result-tool-1-b'],
      usage: { turns: 1, subagentTurns: 3 },
      turn: 2,
      eventSequence: 0
    })
  })

  it('continues directly to the next model step when no tools were requested', async () => {
    const modelStates: Array<SerializableWorkflowState> = []
    let toolBatchCalls = 0

    const result = await runWorkflow({
      input: { request: 'request-1', context: 'ctx-1' },
      runModelStep: input => step(() => {
        modelStates.push(input.state)

        return input.state.turn === 1
          ? {
              done: false,
              messages: ['request-1', 'assistant-1', 'steered-user-2'],
              createdMessages: ['assistant-1', 'steered-user-2'],
              toolCalls: [],
              usage: { inputTokens: 12, outputTokens: 4 },
              turn: input.state.turn,
              eventSequence: 7
            }
          : terminalModelResult(input)
      }),
      runToolBatchStep: input => step(() => {
        toolBatchCalls += 1
        return toolBatchResult(input)
      }),
      closeStream: emptyStep,
      writeError: emptyStep
    })

    expect(result).toMatchObject({ _tag: 'Completed', turns: 2 })
    expect(toolBatchCalls).toBe(0)
    expect(modelStates[1]).toEqual({
      request: 'request-1',
      messages: ['request-1', 'assistant-1', 'steered-user-2'],
      createdMessages: ['assistant-1', 'steered-user-2'],
      usage: { inputTokens: 12, outputTokens: 4 },
      turn: 2,
      eventSequence: 7
    })
  })

  it('carries event sequence across model and tool steps', async () => {
    const modelStates: Array<SerializableWorkflowState> = []
    const toolInputs: Array<VercelAgentWorkflowToolBatchStepInput> = []

    const result = await runWorkflow({
      input: { request: 'request-1', context: 'ctx-1' },
      runModelStep: input => step(() => {
        modelStates.push(input.state)

        return input.state.turn === 1
          ? { ...toolModelResult(input), eventSequence: 3 }
          : terminalModelResult(input)
      }),
      runToolBatchStep: input => step(() => {
        toolInputs.push(input)

        return { ...toolBatchResult(input), eventSequence: 5 }
      }),
      closeStream: emptyStep,
      writeError: emptyStep
    })

    expect(result._tag).toBe('Completed')
    expect(toolInputs[0]?.eventSequence).toBe(3)
    expect(modelStates[1]?.eventSequence).toBe(5)
  })

  it('waits for HITL input and reruns tool batch with responses', async () => {
    const modelStates: Array<SerializableWorkflowState> = []
    const toolInputs: Array<VercelAgentWorkflowToolBatchStepInput> = []
    const awaitedInputs: Array<unknown> = []
    let closeCount = 0
    const awaitingInput = {
      hookToken: 'hook-1',
      requests: ['request-approval'],
      messages: ['assistant-1'],
      usage: { turns: 1 },
      turns: 1,
      eventSequence: 7
    }

    const result = await runWorkflow({
      input: { request: 'request-1', context: 'ctx-1' },
      runModelStep: input => step(() => {
        modelStates.push(input.state)
        return input.state.turn === 1 ? toolModelResult(input) : terminalModelResult(input)
      }),
      runToolBatchStep: input => step(() => {
        toolInputs.push(input)

        return input.hitlResponses?.[0] === 'approved'
          ? { ...toolBatchResult(input), eventSequence: 9 }
          : {
              ...toolBatchResult(input),
              usage: { turns: 1, subagentTurns: 3 },
              awaitingInput,
              eventSequence: 5
            }
      }),
      awaitInput: input => step(() => {
        awaitedInputs.push(input)
        expect(closeCount).toBe(0)

        return 'approved'
      }),
      closeStream: () => step(() => {
        closeCount += 1
      }),
      writeError: emptyStep
    })

    expect(result).toMatchObject({ _tag: 'Completed', turns: 2 })
    expect(awaitedInputs).toEqual([awaitingInput])
    expect(toolInputs.map(input => input.hitlResponses)).toEqual([[], ['approved']])
    expect(toolInputs.map(input => input.usage)).toEqual([
      { turns: 1 },
      { turns: 1, subagentTurns: 3 }
    ])
    expect(toolInputs.map(input => input.eventSequence)).toEqual([0, 7])
    expect(modelStates[1]?.usage).toEqual({ turns: 1, subagentTurns: 3 })
    expect(closeCount).toBe(1)
  })

  it('fails when awaiting input without handler', async () => {
    const errors: Array<unknown> = []
    const awaitingInput = {
      hookToken: 'hook-1',
      requests: ['request-approval'],
      messages: ['assistant-1'],
      usage: { turns: 1 },
      turns: 1,
      eventSequence: 7
    }

    const result = await runWorkflow({
      input: { request: 'request-1', context: 'ctx-1' },
      runModelStep: input => step(() => toolModelResult(input)),
      runToolBatchStep: input =>
        step(() => ({
          ...toolBatchResult(input),
          usage: { turns: 1, subagentTurns: 3 },
          awaitingInput
        })),
      closeStream: emptyStep,
      writeError: value => step(() => {
        errors.push(value)
      })
    })

    expect(result).toMatchObject({
      _tag: 'AwaitInputFailed',
      turn: 1,
      awaitingInput,
      state: {
        request: 'request-1',
        messages: ['request-1', 'assistant-1', 'result-tool-1-a', 'result-tool-1-b'],
        createdMessages: ['assistant-1', 'result-tool-1-a', 'result-tool-1-b'],
        usage: { turns: 1, subagentTurns: 3 },
        turn: 1,
        eventSequence: 7
      }
    })
    expect(errors).toHaveLength(1)
    expect(String(errors[0])).toContain('no awaitInput handler')
  })

  it('delegates model step failures without calling the success close', async () => {
    const error = new Error('model failed')
    const errors: Array<unknown> = []
    let closeCount = 0

    const result = await runWorkflow({
      input: { request: 'request-1', context: 'ctx-1' },
      runModelStep: () => failStep(error),
      runToolBatchStep: input => step(() => toolBatchResult(input)),
      closeStream: () => step(() => {
        closeCount += 1
      }),
      writeError: value => step(() => {
        errors.push(value)
      })
    })

    expect(result).toEqual({
      _tag: 'ModelStepFailed',
      turn: 1,
      error,
      state: { request: 'request-1', createdMessages: [], turn: 1, eventSequence: 0 }
    })
    expect(errors).toEqual([error])
    expect(closeCount).toBe(0)
  })

  it('preserves the original failure when writeError also fails', async () => {
    const error = new Error('model failed')

    const result = await runWorkflow({
      input: { request: 'request-1', context: 'ctx-1' },
      runModelStep: () => failStep(error),
      runToolBatchStep: input => step(() => toolBatchResult(input)),
      closeStream: emptyStep,
      writeError: () => failStep(new Error('error writer failed'))
    })

    expect(result).toMatchObject({ _tag: 'ModelStepFailed', error })
  })

  it('retries model steps when policy allows', async () => {
    const errors: Array<unknown> = []
    let modelAttempts = 0

    const result = await runWorkflow({
      input: { request: 'request-1', context: 'ctx-1' },
      modelStepRetry: { maxAttempts: 2 },
      runModelStep: input => step(() => {
        modelAttempts += 1

        if (modelAttempts === 1) {
          throw new Error('transient model failure')
        }

        return terminalModelResult(input)
      }),
      runToolBatchStep: input => step(() => toolBatchResult(input)),
      closeStream: emptyStep,
      writeError: value => step(() => {
        errors.push(value)
      })
    })

    expect(result._tag).toBe('Completed')
    expect(modelAttempts).toBe(2)
    expect(errors).toEqual([])
  })

  it('keeps step retries disabled by default', async () => {
    const error = new Error('model failed')
    const errors: Array<unknown> = []
    let modelAttempts = 0

    const result = await runWorkflow({
      input: { request: 'request-1', context: 'ctx-1' },
      runModelStep: () => step(() => {
        modelAttempts += 1
        throw error
      }),
      runToolBatchStep: input => step(() => toolBatchResult(input)),
      closeStream: emptyStep,
      writeError: value => step(() => {
        errors.push(value)
      })
    })

    expect(result._tag).toBe('ModelStepFailed')
    expect(modelAttempts).toBe(1)
    expect(errors).toEqual([error])
  })

  it('retries tool batch steps with the same event sequence', async () => {
    const toolInputs: Array<VercelAgentWorkflowToolBatchStepInput> = []
    let toolAttempts = 0

    const result = await runWorkflow({
      input: { request: 'request-1', context: 'ctx-1' },
      maxTurns: 2,
      toolBatchStepRetry: { maxAttempts: 2 },
      runModelStep: input =>
        step(() =>
          input.state.turn === 1
            ? { ...toolModelResult(input), eventSequence: 3 }
            : terminalModelResult(input)
        ),
      runToolBatchStep: input => step(() => {
        toolAttempts += 1
        toolInputs.push(input)

        if (toolAttempts === 1) {
          throw new Error('transient tool failure')
        }

        return { ...toolBatchResult(input), eventSequence: 5 }
      }),
      closeStream: emptyStep,
      writeError: emptyStep
    })

    expect(result._tag).toBe('Completed')
    expect(toolInputs.map(input => input.eventSequence)).toEqual([3, 3])
  })

  it('preserves accumulated usage when a resumed tool batch fails', async () => {
    const error = new Error('resumed tools failed')
    const awaitingInput = {
      hookToken: 'hook-1',
      requests: ['request-approval'],
      messages: ['assistant-1'],
      usage: { turns: 1 },
      turns: 1,
      eventSequence: 7
    }

    const result = await runWorkflow({
      input: { request: 'request-1', context: 'ctx-1' },
      runModelStep: input => step(() => toolModelResult(input)),
      runToolBatchStep: input =>
        input.hitlResponses?.[0] === 'approved'
          ? failStep(error)
          : step(() => ({
              ...toolBatchResult(input),
              usage: { turns: 1, subagentTurns: 3 },
              awaitingInput
            })),
      awaitInput: () => step(() => 'approved'),
      closeStream: emptyStep,
      writeError: emptyStep
    })

    expect(result).toMatchObject({
      _tag: 'ToolBatchStepFailed',
      turn: 1,
      error,
      state: {
        request: 'request-1',
        messages: ['request-1', 'assistant-1'],
        createdMessages: ['assistant-1'],
        usage: { turns: 1, subagentTurns: 3 },
        turn: 1,
        eventSequence: 7
      }
    })
  })

  it('preserves partial tool usage returned with a captured batch failure', async () => {
    const error = new Error('tools failed after partial progress')

    const result = await runWorkflow({
      input: { request: 'request-1', context: 'ctx-1' },
      runModelStep: input => step(() => toolModelResult(input)),
      runToolBatchStep: input =>
        step(() => ({
          ...toolBatchResult(input),
          usage: { turns: 1, subagentTurns: 4 },
          eventSequence: 11,
          failure: error
        })),
      closeStream: emptyStep,
      writeError: emptyStep
    })

    expect(result).toMatchObject({
      _tag: 'ToolBatchStepFailed',
      error,
      state: {
        messages: ['request-1', 'assistant-1', 'result-tool-1-a', 'result-tool-1-b'],
        createdMessages: ['assistant-1', 'result-tool-1-a', 'result-tool-1-b'],
        usage: { turns: 1, subagentTurns: 4 },
        eventSequence: 11
      }
    })
  })

  it('preserves model usage when the initial tool batch fails', async () => {
    const error = new Error('tools failed')

    const result = await runWorkflow({
      input: { request: 'request-1', context: 'ctx-1' },
      runModelStep: input =>
        step(() => ({
          ...toolModelResult(input),
          usage: { turns: 1, subagentTurns: 2 },
          eventSequence: 9
        })),
      runToolBatchStep: () => failStep(error),
      closeStream: emptyStep,
      writeError: emptyStep
    })

    expect(result).toEqual({
      _tag: 'ToolBatchStepFailed',
      turn: 1,
      error,
      state: {
        request: 'request-1',
        messages: ['request-1', 'assistant-1'],
        createdMessages: ['assistant-1'],
        usage: { turns: 1, subagentTurns: 2 },
        turn: 1,
        eventSequence: 9
      }
    })
  })

  it('writes close errors after terminal model step', async () => {
    const error = new Error('close failed')
    const errors: Array<unknown> = []

    const result = await runWorkflow({
      input: { request: 'request-1', context: 'ctx-1' },
      runModelStep: input => step(() => terminalModelResult(input)),
      runToolBatchStep: input => step(() => toolBatchResult(input)),
      closeStream: () => failStep(error),
      writeError: value => step(() => {
        errors.push(value)
      })
    })

    expect(result).toEqual({
      _tag: 'CloseStreamFailed',
      turns: 1,
      error,
      state: {
        request: 'request-1',
        messages: ['request-1', 'assistant-1'],
        createdMessages: ['assistant-1'],
        usage: { turns: 1 },
        turn: 1,
        eventSequence: 0
      }
    })
    expect(errors).toEqual([error])
  })

  it('writes max-turn error when loop does not terminate', async () => {
    const errors: Array<unknown> = []

    const result = await runWorkflow({
      input: { request: 'request-1', context: 'ctx-1' },
      maxTurns: 2,
      runModelStep: input => step(() => toolModelResult(input)),
      runToolBatchStep: input => step(() => toolBatchResult(input)),
      closeStream: emptyStep,
      writeError: value => step(() => {
        errors.push(value)
      })
    })

    expect(result).toMatchObject({ _tag: 'MaxTurnsExceeded', maxTurns: 2 })
    expect(errors).toHaveLength(1)
    expect(errors[0]).toBeInstanceOf(Error)
    expect(String(errors[0])).toContain('exceeded max turns: 2')
  })

  it.each([
    [0, 1],
    [-1, 1],
    [1.9, 1]
  ])('normalizes finite max turns (%s) to %s', async (configured, expectedTurns) => {
    let modelTurns = 0

    const result = await runWorkflow({
      input: { request: 'request-1', context: 'ctx-1' },
      maxTurns: configured,
      runModelStep: input =>
        step(() => {
          modelTurns += 1
          return toolModelResult(input)
        }),
      runToolBatchStep: input => step(() => toolBatchResult(input)),
      closeStream: emptyStep,
      writeError: emptyStep
    })

    expect(result).toMatchObject({ _tag: 'MaxTurnsExceeded', maxTurns: expectedTurns })
    expect(modelTurns).toBe(expectedTurns)
  })

  it.each([Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY])(
    'normalizes non-finite max turns (%s) to the default',
    async configured => {
      let modelTurns = 0

      const result = await runWorkflow({
        input: { request: 'request-1', context: 'ctx-1' },
        maxTurns: configured,
        runModelStep: input =>
          step(() => {
            modelTurns += 1
            return modelTurns === 2 ? terminalModelResult(input) : toolModelResult(input)
          }),
        runToolBatchStep: input => step(() => toolBatchResult(input)),
        closeStream: emptyStep,
        writeError: emptyStep
      })

      expect(result).toMatchObject({ _tag: 'Completed', turns: 2 })
      expect(modelTurns).toBe(2)
    }
  )
})

describe('settleWorkflowStep', () => {
  it('captures success and failure without throwing', async () => {
    const error = new Error('nope')

    await expect(settleWorkflowStep(Promise.resolve('ok'))).resolves.toEqual({
      _tag: 'Success',
      value: 'ok'
    })
    await expect(settleWorkflowStep(Promise.reject(error))).resolves.toEqual({
      _tag: 'Failure',
      error
    })
  })
})

describe('retryWorkflowStep', () => {
  it.each([
    [0.9, 1],
    [1.9, 1],
    [2.9, 2]
  ])('floors finite retry attempts (%s) to %s', async (maxAttempts, expectedAttempts) => {
    let attempts = 0

    await expect(
      retryWorkflowStep(
        () => step(() => {
          attempts += 1
          throw new Error('failed')
        }),
        { maxAttempts }
      )
    ).rejects.toThrow('failed')

    expect(attempts).toBe(expectedAttempts)
  })

  it.each([0, -1, Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY])(
    'normalizes invalid retry attempts (%s) to one attempt',
    async maxAttempts => {
      let attempts = 0

      await expect(
        retryWorkflowStep(
          () => step(() => {
            attempts += 1
            throw new Error('failed')
          }),
          { maxAttempts }
        )
      ).rejects.toThrow('failed')

      expect(attempts).toBe(1)
    }
  )
})
