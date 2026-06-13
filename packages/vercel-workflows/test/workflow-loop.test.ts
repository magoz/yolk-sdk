import { describe, expect, it } from 'vitest'
import {
  runVercelAgentWorkflow,
  retryWorkflowStep,
  settleWorkflowStep,
  type SerializableWorkflowState,
  type VercelAgentWorkflowModelStepInput,
  type VercelAgentWorkflowModelStepResult,
  type VercelAgentWorkflowToolBatchStepInput,
  type VercelAgentWorkflowToolBatchStepResult
} from '../src/workflow.ts'

const terminalModelResult = (input: VercelAgentWorkflowModelStepInput) => ({
  done: true,
  messages: [...(input.state.messages ?? [input.state.request]), `assistant-${input.state.turn}`],
  createdMessages: [...input.state.createdMessages, `assistant-${input.state.turn}`],
  toolCalls: [],
  usage: { turns: input.state.turn },
  turn: input.state.turn
}) satisfies VercelAgentWorkflowModelStepResult

const toolModelResult = (input: VercelAgentWorkflowModelStepInput) => ({
  done: false,
  messages: [...(input.state.messages ?? [input.state.request]), `assistant-${input.state.turn}`],
  createdMessages: [...input.state.createdMessages, `assistant-${input.state.turn}`],
  toolCalls: [`tool-${input.state.turn}-a`, `tool-${input.state.turn}-b`],
  usage: { turns: input.state.turn },
  turn: input.state.turn
}) satisfies VercelAgentWorkflowModelStepResult

const toolBatchResult = (input: VercelAgentWorkflowToolBatchStepInput) => ({
  messages: input.calls.map(call => `result-${String(call)}`),
  createdMessages: [
    ...input.createdMessages,
    ...input.calls.map(call => `result-${String(call)}`)
  ]
}) satisfies VercelAgentWorkflowToolBatchStepResult

describe('runVercelAgentWorkflow', () => {
  it('closes stream after terminal model step', async () => {
    const states: Array<SerializableWorkflowState> = []
    let closeCount = 0

    const result = await runVercelAgentWorkflow({
      input: { request: 'request-1', context: 'ctx-1' },
      runModelStep: async input => {
        states.push(input.state)
        return terminalModelResult(input)
      },
      runToolBatchStep: async input => toolBatchResult(input),
      closeStream: async () => {
        closeCount += 1
      },
      writeError: async () => undefined
    })

    expect(result._tag).toBe('Completed')
    expect(states).toEqual([{ request: 'request-1', createdMessages: [], turn: 1, eventSequence: 0 }])
    expect(closeCount).toBe(1)
  })

  it('continues from model tool calls through tool batch result', async () => {
    const modelStates: Array<SerializableWorkflowState> = []
    const toolInputs: Array<VercelAgentWorkflowToolBatchStepInput> = []

    const result = await runVercelAgentWorkflow({
      input: { request: 'request-1', context: 'ctx-1' },
      runModelStep: async input => {
        modelStates.push(input.state)
        return input.state.turn === 1 ? toolModelResult(input) : terminalModelResult(input)
      },
      runToolBatchStep: async input => {
        toolInputs.push(input)
        return toolBatchResult(input)
      },
      closeStream: async () => undefined,
      writeError: async () => undefined
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
      usage: { turns: 1 },
      turn: 2,
      eventSequence: 0
    })
  })

  it('carries event sequence across model and tool steps', async () => {
    const modelStates: Array<SerializableWorkflowState> = []
    const toolInputs: Array<VercelAgentWorkflowToolBatchStepInput> = []

    const result = await runVercelAgentWorkflow({
      input: { request: 'request-1', context: 'ctx-1' },
      runModelStep: async input => {
        modelStates.push(input.state)

        return input.state.turn === 1
          ? { ...toolModelResult(input), eventSequence: 3 }
          : terminalModelResult(input)
      },
      runToolBatchStep: async input => {
        toolInputs.push(input)

        return { ...toolBatchResult(input), eventSequence: 5 }
      },
      closeStream: async () => undefined,
      writeError: async () => undefined
    })

    expect(result._tag).toBe('Completed')
    expect(toolInputs[0]?.eventSequence).toBe(3)
    expect(modelStates[1]?.eventSequence).toBe(5)
  })

  it('waits for HITL input and reruns tool batch with responses', async () => {
    const toolInputs: Array<VercelAgentWorkflowToolBatchStepInput> = []
    const awaitedInputs: Array<unknown> = []
    const awaitingInput = {
      hookToken: 'hook-1',
      requests: ['request-approval'],
      messages: ['assistant-1'],
      usage: { turns: 1 },
      turns: 1,
      eventSequence: 7
    }

    const result = await runVercelAgentWorkflow({
      input: { request: 'request-1', context: 'ctx-1' },
      runModelStep: async input =>
        input.state.turn === 1 ? toolModelResult(input) : terminalModelResult(input),
      runToolBatchStep: async input => {
        toolInputs.push(input)

        return input.hitlResponses?.[0] === 'approved'
          ? { ...toolBatchResult(input), eventSequence: 9 }
          : { ...toolBatchResult(input), awaitingInput, eventSequence: 5 }
      },
      awaitInput: async input => {
        awaitedInputs.push(input)

        return 'approved'
      },
      closeStream: async () => undefined,
      writeError: async () => undefined
    })

    expect(result).toMatchObject({ _tag: 'Completed', turns: 2 })
    expect(awaitedInputs).toEqual([awaitingInput])
    expect(toolInputs.map(input => input.hitlResponses)).toEqual([[], ['approved']])
    expect(toolInputs.map(input => input.eventSequence)).toEqual([0, 7])
  })

  it('fails when awaiting input without handler', async () => {
    const errors: Array<unknown> = []
    const awaitingInput = {
      hookToken: 'hook-1',
      requests: ['request-approval'],
      messages: ['assistant-1'],
      usage: { turns: 1 },
      turns: 1
    }

    const result = await runVercelAgentWorkflow({
      input: { request: 'request-1', context: 'ctx-1' },
      runModelStep: async input => toolModelResult(input),
      runToolBatchStep: async input => ({ ...toolBatchResult(input), awaitingInput }),
      closeStream: async () => undefined,
      writeError: async value => {
        errors.push(value)
      }
    })

    expect(result).toMatchObject({ _tag: 'AwaitInputFailed', turn: 1, awaitingInput })
    expect(errors).toHaveLength(1)
    expect(String(errors[0])).toContain('no awaitInput handler')
  })

  it('writes model step errors and stops', async () => {
    const error = new Error('model failed')
    const errors: Array<unknown> = []
    let closeCount = 0

    const result = await runVercelAgentWorkflow({
      input: { request: 'request-1', context: 'ctx-1' },
      runModelStep: async () => Promise.reject(error),
      runToolBatchStep: async input => toolBatchResult(input),
      closeStream: async () => {
        closeCount += 1
      },
      writeError: async value => {
        errors.push(value)
      }
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

  it('retries model steps when policy allows', async () => {
    const errors: Array<unknown> = []
    let modelAttempts = 0

    const result = await runVercelAgentWorkflow({
      input: { request: 'request-1', context: 'ctx-1' },
      modelStepRetry: { maxAttempts: 2 },
      runModelStep: async input => {
        modelAttempts += 1

        if (modelAttempts === 1) {
          throw new Error('transient model failure')
        }

        return terminalModelResult(input)
      },
      runToolBatchStep: async input => toolBatchResult(input),
      closeStream: async () => undefined,
      writeError: async value => {
        errors.push(value)
      }
    })

    expect(result._tag).toBe('Completed')
    expect(modelAttempts).toBe(2)
    expect(errors).toEqual([])
  })

  it('keeps step retries disabled by default', async () => {
    const error = new Error('model failed')
    const errors: Array<unknown> = []
    let modelAttempts = 0

    const result = await runVercelAgentWorkflow({
      input: { request: 'request-1', context: 'ctx-1' },
      runModelStep: async () => {
        modelAttempts += 1
        throw error
      },
      runToolBatchStep: async input => toolBatchResult(input),
      closeStream: async () => undefined,
      writeError: async value => {
        errors.push(value)
      }
    })

    expect(result._tag).toBe('ModelStepFailed')
    expect(modelAttempts).toBe(1)
    expect(errors).toEqual([error])
  })

  it('retries tool batch steps with the same event sequence', async () => {
    const toolInputs: Array<VercelAgentWorkflowToolBatchStepInput> = []
    let toolAttempts = 0

    const result = await runVercelAgentWorkflow({
      input: { request: 'request-1', context: 'ctx-1' },
      maxTurns: 2,
      toolBatchStepRetry: { maxAttempts: 2 },
      runModelStep: async input =>
        input.state.turn === 1
          ? { ...toolModelResult(input), eventSequence: 3 }
          : terminalModelResult(input),
      runToolBatchStep: async input => {
        toolAttempts += 1
        toolInputs.push(input)

        if (toolAttempts === 1) {
          throw new Error('transient tool failure')
        }

        return { ...toolBatchResult(input), eventSequence: 5 }
      },
      closeStream: async () => undefined,
      writeError: async () => undefined
    })

    expect(result._tag).toBe('Completed')
    expect(toolInputs.map(input => input.eventSequence)).toEqual([3, 3])
  })

  it('returns tool batch failures with the current workflow state', async () => {
    const error = new Error('tools failed')

    const result = await runVercelAgentWorkflow({
      input: { request: 'request-1', context: 'ctx-1' },
      runModelStep: async input => toolModelResult(input),
      runToolBatchStep: async () => Promise.reject(error),
      closeStream: async () => undefined,
      writeError: async () => undefined
    })

    expect(result).toEqual({
      _tag: 'ToolBatchStepFailed',
      turn: 1,
      error,
      state: { request: 'request-1', createdMessages: [], turn: 1, eventSequence: 0 }
    })
  })

  it('writes close errors after terminal model step', async () => {
    const error = new Error('close failed')
    const errors: Array<unknown> = []

    const result = await runVercelAgentWorkflow({
      input: { request: 'request-1', context: 'ctx-1' },
      runModelStep: async input => terminalModelResult(input),
      runToolBatchStep: async input => toolBatchResult(input),
      closeStream: async () => Promise.reject(error),
      writeError: async value => {
        errors.push(value)
      }
    })

    expect(result).toEqual({
      _tag: 'CloseStreamFailed',
      turns: 1,
      error,
      state: { request: 'request-1', createdMessages: [], turn: 1, eventSequence: 0 }
    })
    expect(errors).toEqual([error])
  })

  it('writes max-turn error when loop does not terminate', async () => {
    const errors: Array<unknown> = []

    const result = await runVercelAgentWorkflow({
      input: { request: 'request-1', context: 'ctx-1' },
      maxTurns: 2,
      runModelStep: async input => toolModelResult(input),
      runToolBatchStep: async input => toolBatchResult(input),
      closeStream: async () => undefined,
      writeError: async value => {
        errors.push(value)
      }
    })

    expect(result).toMatchObject({ _tag: 'MaxTurnsExceeded', maxTurns: 2 })
    expect(errors).toHaveLength(1)
    expect(errors[0]).toBeInstanceOf(Error)
    expect(String(errors[0])).toContain('exceeded max turns: 2')
  })
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
  it('normalizes invalid retry attempts to one attempt', async () => {
    let attempts = 0

    await expect(
      retryWorkflowStep(
        async () => {
          attempts += 1
          throw new Error('failed')
        },
        { maxAttempts: 0 }
      )
    ).rejects.toThrow('failed')

    expect(attempts).toBe(1)
  })
})
