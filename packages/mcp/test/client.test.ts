import { Effect } from 'effect'
import { describe, expect, it } from '@effect/vitest'
import { createServer, type IncomingMessage } from 'node:http'
import { callMcpServerTool, listMcpServerTools } from '../src'
import type { McpServerConfig } from '../src'

type ResponseMode = 'json' | 'sse'

const collectBody = (request: IncomingMessage) =>
  new Promise<string>((resolve, reject) => {
    const chunks: Buffer[] = []
    request.on('data', (chunk: Buffer | string) => {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
    })
    request.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    request.on('error', reject)
  })

const responseId = (body: string) => {
  if (body.includes('"id":1')) {
    return 1
  }
  if (body.includes('"id":2')) {
    return 2
  }
  return 3
}

const responseResult = (body: string) => {
  if (body.includes('"method":"initialize"')) {
    return {
      protocolVersion: '2024-11-05',
      capabilities: {},
      serverInfo: { name: 'test', version: '0' }
    }
  }
  if (body.includes('"method":"tools/list"')) {
    return { tools: [{ name: 'search', description: 'Search', inputSchema: { type: 'object' } }] }
  }
  return { content: [{ type: 'text', text: 'remote result' }] }
}

const withRemoteMcpServer = async <A>(mode: ResponseMode, run: (url: string) => Promise<A>) => {
  const server = createServer(async (request, response) => {
    const body = await collectBody(request)
    if (body.includes('"method":"notifications/initialized"')) {
      response.writeHead(204)
      response.end()
      return
    }

    const payload = JSON.stringify({
      jsonrpc: '2.0',
      id: responseId(body),
      result: responseResult(body)
    })

    if (mode === 'sse') {
      response.writeHead(200, { 'content-type': 'text/event-stream' })
      response.end(`event: message\ndata: ${payload}\n\n`)
      return
    }

    response.writeHead(200, { 'content-type': 'application/json' })
    response.end(payload)
  })

  await new Promise<void>(resolve => server.listen(0, 'localhost', resolve))
  const address = server.address()
  if (address === null || typeof address === 'string') {
    server.close()
    throw new Error('HTTP test server did not bind to a TCP port')
  }

  try {
    return await run(`http://localhost:${address.port}`)
  } finally {
    await new Promise<void>(resolve => server.close(() => resolve()))
  }
}

describe('MCP client', () => {
  it('lists and calls remote JSON-RPC tools', async () => {
    await withRemoteMcpServer('json', async url => {
      const config: McpServerConfig = { name: 'remote', type: 'remote', url }
      const options = { securityPolicy: { allowLocalServers: false, allowDevHttpLocalhost: true } }

      const tools = await Effect.runPromise(listMcpServerTools(config, options))
      expect(tools.map(tool => tool.def.name)).toEqual(['remote_search'])

      const result = await Effect.runPromise(
        callMcpServerTool({
          config,
          mcpToolName: 'search',
          toolCallId: 'call_1',
          params: { query: 'effect' },
          options
        })
      )
      expect(result.content).toBe('remote result')
    })
  })

  it('parses remote SSE JSON-RPC responses', async () => {
    await withRemoteMcpServer('sse', async url => {
      const tools = await Effect.runPromise(
        listMcpServerTools(
          { name: 'remote', type: 'remote', url },
          { securityPolicy: { allowLocalServers: false, allowDevHttpLocalhost: true } }
        )
      )

      expect(tools.map(tool => tool.def.name)).toEqual(['remote_search'])
    })
  })

  it('lists and calls local stdio tools when enabled', async () => {
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

    const tools = await Effect.runPromise(listMcpServerTools(config, options))
    expect(tools.map(tool => tool.def.name)).toEqual(['local_echo'])

    const result = await Effect.runPromise(
      callMcpServerTool({
        config,
        mcpToolName: 'echo',
        toolCallId: 'call_1',
        params: { text: 'hello' },
        options
      })
    )
    expect(result.content).toBe('local result')
  })
})
