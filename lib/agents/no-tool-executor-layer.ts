import { Effect, Layer } from 'effect'
import { ToolError, ToolExecutor } from '@yolk/agent/loop'

export const NoToolExecutorLayer = Layer.succeed(
  ToolExecutor,
  ToolExecutor.of({
    execute: call =>
      Effect.fail(
        new ToolError({
          tool: call.name,
          message: 'No tools are configured for this agent route',
          cause: 'permission'
        })
      )
  })
)
