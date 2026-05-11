import { Effect } from 'effect'
import { describe, expect, it } from '@effect/vitest'
import { callMcpServerTool, listMcpServerTools } from '../src'
import type { McpServerConfig } from '../src'

describe('MCP client', () => {
  it.effect('lists and calls local stdio tools when enabled', () =>
    Effect.gen(function* () {
      const script = `
const readline = require('node:readline')
const lines = readline.createInterface({ input: process.stdin })
lines.on('line', line => {
  const request = JSON.parse(line)
  if (request.method === 'notifications/initialized') return
  const result = request.method === 'initialize'
    ? { protocolVersion: '2024-11-05', capabilities: {}, serverInfo: { name: 'local', version: '0' } }
    : request.method === 'tools/list'
      ? { tools: [{ name: 'echo', description: 'Echo', inputSchema: { type: 'object' } }] }
      : { content: [{ type: 'text', text: 'local result' }] }
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: request.id, result }) + '\\n')
})
`
      const config: McpServerConfig = {
        name: 'local',
        type: 'local',
        command: [process.execPath, '-e', script]
      }
      const options = { securityPolicy: { allowLocalServers: true, allowDevHttpLocalhost: false } }

      const tools = yield* listMcpServerTools(config, options)
      expect(tools.map(tool => tool.def.name)).toEqual(['local_echo'])

      const result = yield* callMcpServerTool({
        config,
        mcpToolName: 'echo',
        toolCallId: 'call_1',
        params: { text: 'hello' },
        options
      })
      expect(result.content).toBe('local result')
    })
  )
})
