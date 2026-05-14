/**
 * @fileoverview Keep app agent tools runtime-portable.
 *
 * Agent tools must run in Next, Cloudflare Workers, and future hosts. Tool code must not import
 * Node-only modules or use raw fetch; use Effect services/adapters instead.
 */

const nodeBuiltins = new Set([
  'assert',
  'async_hooks',
  'buffer',
  'child_process',
  'cluster',
  'console',
  'crypto',
  'dgram',
  'dns',
  'domain',
  'events',
  'fs',
  'http',
  'http2',
  'https',
  'module',
  'net',
  'os',
  'path',
  'perf_hooks',
  'process',
  'punycode',
  'querystring',
  'readline',
  'repl',
  'stream',
  'string_decoder',
  'timers',
  'tls',
  'tty',
  'url',
  'util',
  'v8',
  'vm',
  'worker_threads',
  'zlib'
])

const isAgentToolFile = filename =>
  filename.includes('/lib/agents/tools/') &&
  !filename.endsWith('.test.ts') &&
  !filename.endsWith('.test.tsx')

const isForbiddenImport = source => {
  if (source.startsWith('node:')) {
    return true
  }

  if (source === '@effect/platform-node' || source.startsWith('@effect/platform-node/')) {
    return true
  }

  if (source === '@yolk/mcp/client/node' || source === '@yolk/mcp/client/node.ts') {
    return true
  }

  return nodeBuiltins.has(source)
}

/** @type {import('eslint').Rule.RuleModule} */
export const noNodeDepsInAgentTools = {
  meta: {
    type: 'problem',
    docs: {
      description: 'Disallow Node-only dependencies and raw fetch in agent tools',
      category: 'Best Practices',
      recommended: true
    },
    messages: {
      noNodeImport:
        'Agent tools must be Node-dependency free. Use portable Effect APIs/adapters instead of importing {{source}}.',
      noRawFetch: 'Agent tools must use Effect HttpClient, not raw fetch().'
    },
    schema: []
  },
  create(context) {
    const filename = context.filename ?? context.getFilename()
    if (!isAgentToolFile(filename)) {
      return {}
    }

    return {
      ImportDeclaration(node) {
        const source = String(node.source.value)
        if (isForbiddenImport(source)) {
          context.report({ node, messageId: 'noNodeImport', data: { source } })
        }
      },
      CallExpression(node) {
        if (node.callee.type === 'Identifier' && node.callee.name === 'fetch') {
          context.report({ node, messageId: 'noRawFetch' })
        }
      }
    }
  }
}
