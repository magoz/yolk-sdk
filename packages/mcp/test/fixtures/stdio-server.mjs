import readline from 'node:readline'

const lines = readline.createInterface({ input: process.stdin })

lines.on('line', line => {
  const request = JSON.parse(line)
  if (request.method === 'notifications/initialized') return

  const result =
    request.method === 'initialize'
      ? {
          protocolVersion: '2024-11-05',
          capabilities: {},
          serverInfo: { name: 'local', version: '0' }
        }
      : request.method === 'tools/list'
        ? { tools: [{ name: 'echo', description: 'Echo', inputSchema: { type: 'object' } }] }
        : { content: [{ type: 'text', text: 'local result' }] }

  process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id: request.id, result })}\n`)
})
