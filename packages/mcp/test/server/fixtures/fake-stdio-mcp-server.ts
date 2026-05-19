import { Effect } from 'effect'
import { NodeStdio } from '@effect/platform-node'
import { ToolDef, ToolResult } from '@yolk-sdk/agent/protocol'
import { makeMcpToolServer, runStdioMcpServer } from '@yolk-sdk/mcp/server'

const server = makeMcpToolServer({
  name: 'local',
  version: '0',
  tools: [
    {
      def: ToolDef.make({ name: 'echo', description: 'Echo', parameters: { type: 'object' } }),
      execute: call =>
        Effect.succeed(ToolResult.make({ toolCallId: call.id, content: 'local result' }))
    }
  ]
})

Effect.runPromise(runStdioMcpServer(server).pipe(Effect.provide(NodeStdio.layer)))
