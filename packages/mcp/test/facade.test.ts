import { describe, expect, it } from '@effect/vitest'
import { Client, defaultMcpClientInfo } from '@yolk-sdk/mcp/client'
import { DiscoverRequestSchema } from '@yolk-sdk/mcp/core'
import { latestMcpProtocolVersion, makeJsonRpcRequest } from '@yolk-sdk/mcp/protocol'
import { McpServer, makeMcpToolServer } from '@yolk-sdk/mcp/server'

describe('@yolk-sdk/mcp subpaths', () => {
  it('imports every public subpath', async () => {
    const [root, client, nodeClient, core, protocol, server, nodeServer] = await Promise.all([
      import('@yolk-sdk/mcp'),
      import('@yolk-sdk/mcp/client'),
      import('@yolk-sdk/mcp/client/node'),
      import('@yolk-sdk/mcp/core'),
      import('@yolk-sdk/mcp/protocol'),
      import('@yolk-sdk/mcp/server'),
      import('@yolk-sdk/mcp/server/node')
    ])

    expect(root).toBeDefined()
    expect(client.defaultMcpClientInfo).toBeDefined()
    expect(nodeClient.StdioClientTransport).toBeDefined()
    expect(nodeClient.listMcpToolsNode).toBeDefined()
    expect(core.DiscoverRequestSchema).toBeDefined()
    expect(protocol.makeJsonRpcRequest).toBeDefined()
    expect(server.McpServer).toBeDefined()
    expect(server.makeMcpToolServer).toBeDefined()
    expect(nodeServer.serveStdio).toBeDefined()
  })

  it('exports client, protocol, and server subpaths', () => {
    const request = makeJsonRpcRequest({ id: 1, method: 'tools/list', params: {} })
    const server = makeMcpToolServer({ name: 'test', version: '0.0.0', tools: [] })

    expect(defaultMcpClientInfo.name).toBe('yolk')
    expect(DiscoverRequestSchema).toBeDefined()
    expect(latestMcpProtocolVersion).toBe('2026-07-28')
    expect(Client).toBeDefined()
    expect(McpServer).toBeDefined()
    expect(request.method).toBe('tools/list')
    expect(server).toBeDefined()
  })
})
