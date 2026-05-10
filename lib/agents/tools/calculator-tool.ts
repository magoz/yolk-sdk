import { Effect } from 'effect'
import * as Schema from 'effect/Schema'
import { ToolError } from '@yolk/agent-loop'
import { ToolDef, ToolResult, type ToolCall } from '@yolk/protocol'
import type { ToolModule, ToolRegistration } from '@yolk/tool-registry'
import type { AgentToolContext } from './tool-context'

const calculatorToolName = 'calculate'

const CalculatorOperation = Schema.Literals(['add', 'subtract', 'multiply', 'divide'])
const CalculatorParams = Schema.Struct({
  operation: CalculatorOperation,
  left: Schema.Number,
  right: Schema.Number
})

type CalculatorParams = typeof CalculatorParams.Type

const calculatorParameters = {
  type: 'object',
  additionalProperties: false,
  properties: {
    operation: {
      type: 'string',
      enum: ['add', 'subtract', 'multiply', 'divide'],
      description: 'Arithmetic operation to perform.'
    },
    left: {
      type: 'number',
      description: 'Left operand.'
    },
    right: {
      type: 'number',
      description: 'Right operand.'
    }
  },
  required: ['operation', 'left', 'right']
}

const calculatorToolDef = ToolDef.make({
  name: calculatorToolName,
  description:
    'Perform basic arithmetic. Use this for addition, subtraction, multiplication, or division.',
  parameters: calculatorParameters
})

const unknownToMessage = (error: unknown) =>
  error instanceof Error ? error.message : String(error)

const makeValidationError = (message: string) =>
  new ToolError({
    tool: calculatorToolName,
    message,
    cause: 'validation'
  })

const decodeCalculatorParams = (params: unknown) =>
  Schema.decodeUnknownEffect(CalculatorParams)(params).pipe(
    Effect.mapError(error => makeValidationError(`Invalid calculator arguments: ${unknownToMessage(error)}`))
  )

const ensureFiniteNumber = (value: number, name: string) =>
  Number.isFinite(value)
    ? Effect.succeed(value)
    : Effect.fail(makeValidationError(`${name} must be finite`))

const calculate = (params: CalculatorParams) =>
  Effect.gen(function* () {
    const left = yield* ensureFiniteNumber(params.left, 'left')
    const right = yield* ensureFiniteNumber(params.right, 'right')

    switch (params.operation) {
      case 'add':
        return left + right
      case 'subtract':
        return left - right
      case 'multiply':
        return left * right
      case 'divide':
        if (right === 0) {
          return yield* Effect.fail(makeValidationError('Cannot divide by zero'))
        }

        return left / right
    }
  })

const executeCalculator = (call: ToolCall) => {
  if (call.name !== calculatorToolName) {
    return Effect.fail(
      new ToolError({
        tool: call.name,
        message: `Tool is not configured: ${call.name}`,
        cause: 'permission'
      })
    )
  }

  return Effect.gen(function* () {
    const params = yield* decodeCalculatorParams(call.params)
    const result = yield* calculate(params)

    return ToolResult.make({ toolCallId: call.id, content: String(result) })
  })
}

export const calculatorToolRegistration: ToolRegistration<AgentToolContext> = {
  def: calculatorToolDef,
  access: 'read',
  execute: ({ call }) => executeCalculator(call)
}

export const calculatorToolModule: ToolModule<AgentToolContext> = {
  id: 'calculator',
  tools: [calculatorToolRegistration]
}
