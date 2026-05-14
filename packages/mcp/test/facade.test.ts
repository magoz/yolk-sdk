import { describe, expect, it } from '@effect/vitest'
import { defaultMcpClientInfo } from '@yolk/mcp/client'
import { latestMcpProtocolVersion, makeJsonRpcRequest } from '@yolk/mcp/protocol'
import { makeMcpToolServer } from '@yolk/mcp/server'

describe('@yolk/mcp subpaths', () => {
  it('exports client, protocol, and server subpaths', () => {
    const request = makeJsonRpcRequest({ id: 1, method: 'tools/list', params: {} })
    const server = makeMcpToolServer({ name: 'test', version: '0.0.0', tools: [] })

    expect(defaultMcpClientInfo.name).toBe('yolk')
    expect(latestMcpProtocolVersion).toMatch(/^\d{4}-\d{2}-\d{2}$/)
    expect(request.method).toBe('tools/list')
    expect(server).toBeDefined()
  })
})
