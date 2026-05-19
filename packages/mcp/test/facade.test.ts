import { describe, expect, it } from '@effect/vitest'
import { defaultMcpClientInfo } from '@yolk-sdk/mcp/client'
import { latestMcpProtocolVersion, makeJsonRpcRequest } from '@yolk-sdk/mcp/protocol'
import { makeMcpToolServer } from '@yolk-sdk/mcp/server'

describe('@yolk-sdk/mcp subpaths', () => {
  it('imports every public subpath', async () => {
    const [root, client, nodeClient, protocol, server] = await Promise.all([
      import('@yolk-sdk/mcp'),
      import('@yolk-sdk/mcp/client'),
      import('@yolk-sdk/mcp/client/node'),
      import('@yolk-sdk/mcp/protocol'),
      import('@yolk-sdk/mcp/server')
    ])

    expect(root).toBeDefined()
    expect(client.defaultMcpClientInfo).toBeDefined()
    expect(nodeClient.listMcpToolsNode).toBeDefined()
    expect(protocol.makeJsonRpcRequest).toBeDefined()
    expect(server.makeMcpToolServer).toBeDefined()
  })

  it('exports client, protocol, and server subpaths', () => {
    const request = makeJsonRpcRequest({ id: 1, method: 'tools/list', params: {} })
    const server = makeMcpToolServer({ name: 'test', version: '0.0.0', tools: [] })

    expect(defaultMcpClientInfo.name).toBe('yolk')
    expect(latestMcpProtocolVersion).toMatch(/^\d{4}-\d{2}-\d{2}$/)
    expect(request.method).toBe('tools/list')
    expect(server).toBeDefined()
  })
})
