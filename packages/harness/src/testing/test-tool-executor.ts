import { Effect, Layer } from 'effect'
import { ToolResult } from '@yolk/protocol'
import { ToolError } from '../error'
import { ToolExecutor } from '../services/tool-executor'

export const TestToolExecutor = {
  layer: (resultsByName: Readonly<Record<string, string>>) =>
    Layer.succeed(
      ToolExecutor,
      ToolExecutor.of({
        execute: call => {
          const content = resultsByName[call.name]

          if (content === undefined) {
            return Effect.fail(
              new ToolError({
                tool: call.name,
                message: `No canned result for tool: ${call.name}`,
                cause: 'execution'
              })
            )
          }

          return Effect.succeed(ToolResult.make({ toolCallId: call.id, content }))
        }
      })
    )
}
