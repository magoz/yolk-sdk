import { Client, StreamableHTTPClientTransport } from '@yolk-sdk/mcp/client'
import {
  McpServer,
  acceptedContent,
  createMcpHandler,
  fromJsonSchema,
  inputRequired
} from '@yolk-sdk/mcp/server'
import { describe, expect, it } from 'vitest'

const endpoint = new URL('https://example.com/mcp')
const emptyObjectSchema = fromJsonSchema({ type: 'object', additionalProperties: false })

const makeServer = () => {
  const server = new McpServer(
    { name: 'sdk-v2-test', version: '1.0.0' },
    {
      capabilities: { tools: { listChanged: true } },
      cacheHints: {
        'server/discover': { ttlMs: 60_000, cacheScope: 'public' },
        'tools/list': { ttlMs: 60_000, cacheScope: 'public' }
      }
    }
  )

  server.registerTool(
    'confirm',
    {
      description: 'Confirm an operation.',
      inputSchema: emptyObjectSchema
    },
    async (_args, context) => {
      const confirmation = acceptedContent<{ confirmed: boolean }>(
        context.mcpReq.inputResponses,
        'confirmation'
      )

      if (confirmation === undefined) {
        return inputRequired({
          inputRequests: {
            confirmation: inputRequired.elicit({
              message: 'Continue?',
              requestedSchema: {
                type: 'object',
                properties: { confirmed: { type: 'boolean' } },
                required: ['confirmed']
              }
            })
          }
        })
      }

      return {
        content: [{ type: 'text', text: confirmation.confirmed ? 'confirmed' : 'declined' }]
      }
    }
  )

  server.registerResource('status', 'status://current', { mimeType: 'text/plain' }, async uri => ({
    contents: [{ uri: uri.href, text: 'ready' }]
  }))

  server.registerPrompt('review', { description: 'Review text.' }, async () => ({
    messages: [{ role: 'user', content: { type: 'text', text: 'Review this.' } }]
  }))

  return server
}

const makeTransport = (handler: ReturnType<typeof createMcpHandler>) =>
  new StreamableHTTPClientTransport(endpoint, {
    fetch: (input, init) => handler.fetch(new Request(input, init))
  })

describe('official MCP SDK v2 integration', () => {
  it('serves the full modern core with MRTR over stateless HTTP', async () => {
    const handler = createMcpHandler(makeServer)
    const client = new Client(
      { name: 'sdk-v2-client', version: '1.0.0' },
      {
        capabilities: { elicitation: { form: {} } },
        versionNegotiation: { mode: { pin: '2026-07-28' } }
      }
    )

    client.setRequestHandler('elicitation/create', async () => ({
      action: 'accept',
      content: { confirmed: true }
    }))

    await client.connect(makeTransport(handler))

    expect(client.getProtocolEra()).toBe('modern')
    expect(client.getNegotiatedProtocolVersion()).toBe('2026-07-28')
    expect((await client.listTools()).tools.map(tool => tool.name)).toEqual(['confirm'])
    expect((await client.listResources()).resources.map(resource => resource.uri)).toEqual([
      'status://current'
    ])
    expect((await client.listPrompts()).prompts.map(prompt => prompt.name)).toEqual(['review'])
    expect(await client.readResource({ uri: 'status://current' })).toMatchObject({
      contents: [{ text: 'ready' }]
    })
    expect(await client.getPrompt({ name: 'review' })).toMatchObject({
      messages: [{ role: 'user' }]
    })
    expect(await client.callTool({ name: 'confirm', arguments: {} })).toMatchObject({
      content: [{ type: 'text', text: 'confirmed' }]
    })

    const changed = Promise.withResolvers<void>()
    client.setNotificationHandler('notifications/tools/list_changed', async () => {
      changed.resolve()
    })
    const subscription = await client.listen({ toolsListChanged: true })
    expect(subscription.honoredFilter).toEqual({ toolsListChanged: true })
    handler.notify.toolsChanged()
    await changed.promise
    await subscription.close()

    await client.close()
    await handler.close()
  })

  it('preserves initialize-based legacy clients on the same handler', async () => {
    const handler = createMcpHandler(makeServer)
    const client = new Client({ name: 'legacy-client', version: '1.0.0' })

    await client.connect(makeTransport(handler))

    expect(client.getProtocolEra()).toBe('legacy')
    expect((await client.listTools()).tools.map(tool => tool.name)).toEqual(['confirm'])

    await client.close()
    await handler.close()
  })
})
