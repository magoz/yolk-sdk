import { describe, expect, it } from '@effect/vitest'
import { defaultMcpClientInfo } from '@yolk/mcp/client'
import { latestMcpProtocolVersion, makeJsonRpcRequest } from '@yolk/mcp/protocol'
import { makeMcpToolServer } from '@yolk/mcp/server'

describe('@yolk/mcp subpaths', () => {
  it('imports every public subpath', async () => {
    const [root, client, nodeClient, protocol, server] = await Promise.all([
      import('@yolk/mcp'),
      import('@yolk/mcp/client'),
      import('@yolk/mcp/client/node'),
      import('@yolk/mcp/protocol'),
      import('@yolk/mcp/server')
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
