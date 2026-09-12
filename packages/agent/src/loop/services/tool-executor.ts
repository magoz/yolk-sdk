import { Context, Effect, Layer } from 'effect'
import type { ToolCall, ToolResult } from '@yolk-sdk/agent/protocol'
import { ToolError } from '../error.ts'

export const unavailableToolExecutor = {
  execute: (call: ToolCall): Effect.Effect<ToolResult, ToolError> =>
    Effect.fail(
      new ToolError({
        tool: call.name,
        message: 'Tool execution is not available: no ToolExecutor was provided',
        cause: 'execution'
      })
    )
} as const

export class ToolExecutor extends Context.Service<
  ToolExecutor,
  {
    readonly execute: (call: ToolCall) => Effect.Effect<ToolResult, ToolError>
  }
>()('@yolk-sdk/agent/loop/ToolExecutor') {
  static unavailable = Layer.succeed(this, this.of(unavailableToolExecutor))
}
