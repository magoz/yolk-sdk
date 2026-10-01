/**
 * Builders for the synthetic MCP wire fixtures: two synthetic servers on one reserved origin,
 * `https://mcp.example.test/modern/mcp` (stateless `2026-07-28`, JSON answers) and
 * `https://mcp.example.test/legacy/mcp` (an `initialize` handshake with a session, SSE answers).
 *
 * Each builder returns exchanges in the order `@yolk-sdk/mcp/client` sends the requests (replay
 * consumes per method and URL in that order, so the order is the fixture). Request bodies carry the
 * exact JSON-RPC ids and `_meta` envelope the pinned official SDK sends; request headers are the
 * MCP routing and session headers only (never `authorization`). Every value is synthetic.
 *
 * @experimental
 */
import { Predicate } from 'effect'
import type * as Schema from 'effect/Schema'
import type { WireExchange, WireFixture, WireResponse } from '@yolk-sdk/conformance/fixture'
import { defaultMcpClientInfo } from '../client/config.ts'
import { latestMcpProtocolVersion } from '../client/protocol.ts'
import { encodeMcpParamValue } from './param-value.ts'
import type {
  McpConformanceEra,
  McpConformanceSeeds,
  McpConformanceTargetSettings
} from './target.ts'

export const mcpConformanceSyntheticOrigin = 'https://mcp.example.test'

/** The synthetic modern server: stateless `2026-07-28`, JSON answers. */
export const mcpConformanceSyntheticModernUrl = `${mcpConformanceSyntheticOrigin}/modern/mcp`

/** The synthetic legacy server: an `initialize` handshake, a session, and SSE answers. */
export const mcpConformanceSyntheticLegacyUrl = `${mcpConformanceSyntheticOrigin}/legacy/mcp`

/** The session id the synthetic legacy server issues (`yolk-synthetic-session-NNNN`). */
export const mcpConformanceSyntheticSessionId = 'yolk-synthetic-session-0001'

/** The legacy protocol version the pinned SDK asks for in `initialize` and the server answers. */
export const mcpConformanceSyntheticLegacyProtocolVersion = '2025-11-25'

/** Calendar date of the synthetic fixtures. */
export const mcpConformanceSyntheticRecordedAt = '2026-10-01'

/** The JSON-RPC id the pinned SDK gives its era probe (`server/discover`). */
export const mcpConformanceDiscoverRequestId = 'server-discover-probe-1'

const serverInfo = { name: 'yolk-synthetic-mcp', version: '0.0.0' }

const metaKeys = {
  protocolVersion: 'io.modelcontextprotocol/protocolVersion',
  clientInfo: 'io.modelcontextprotocol/clientInfo',
  clientCapabilities: 'io.modelcontextprotocol/clientCapabilities',
  serverInfo: 'io.modelcontextprotocol/serverInfo'
}

/** The `_meta` envelope every modern request carries (the default `yolk` client info). */
export const mcpConformanceSyntheticEnvelope: Schema.JsonObject = {
  [metaKeys.protocolVersion]: latestMcpProtocolVersion,
  [metaKeys.clientInfo]: { name: defaultMcpClientInfo.name, version: defaultMcpClientInfo.version },
  [metaKeys.clientCapabilities]: {}
}

/** A read-only synthetic tool with an output schema. */
export const mcpConformanceSyntheticReadTool: Schema.JsonObject = {
  name: 'get_synthetic_note',
  title: 'Get a synthetic note',
  description: 'Read one synthetic note by id.',
  inputSchema: {
    type: 'object',
    properties: { noteId: { type: 'string' } },
    required: ['noteId'],
    additionalProperties: false
  },
  outputSchema: {
    type: 'object',
    properties: { noteId: { type: 'string' }, text: { type: 'string' } },
    required: ['noteId', 'text'],
    additionalProperties: false
  },
  annotations: { readOnlyHint: true }
}

/** A synthetic tool that writes (`readOnlyHint: false`). */
export const mcpConformanceSyntheticWriteTool: Schema.JsonObject = {
  name: 'create_synthetic_note',
  description: 'Create one synthetic note.',
  inputSchema: {
    type: 'object',
    properties: { text: { type: 'string' } },
    required: ['text'],
    additionalProperties: false
  },
  annotations: { readOnlyHint: false, destructiveHint: false }
}

/** Every tool of the synthetic servers, in listing order. */
export const mcpConformanceSyntheticTools: ReadonlyArray<Schema.JsonObject> = [
  mcpConformanceSyntheticReadTool,
  mcpConformanceSyntheticWriteTool
]

/** The cursor between the two pages of the paged synthetic listing. */
export const mcpConformanceSyntheticCursor = 'synthetic-cursor-0001'

/** The synthetic read call (`readTool` of the fixture seeds). */
export const mcpConformanceSyntheticReadCall = {
  name: 'get_synthetic_note',
  arguments: { noteId: 'note-0001' }
} satisfies { readonly name: string; readonly arguments: Schema.JsonObject }

/** The same tool with arguments it rejects (`invalidArguments` of the fixture seeds). */
export const mcpConformanceSyntheticInvalidCall = {
  name: 'get_synthetic_note',
  arguments: { noteId: 42 }
} satisfies { readonly name: string; readonly arguments: Schema.JsonObject }

/** The seeds the committed synthetic fixtures replay with. */
export const mcpConformanceFixtureSeeds: McpConformanceSeeds = {
  readTool: mcpConformanceSyntheticReadCall,
  invalidArguments: mcpConformanceSyntheticInvalidCall.arguments,
  expectedTools: ['get_synthetic_note', 'create_synthetic_note'],
  notReadOnly: ['create_synthetic_note']
}

/** A replay target for one synthetic server: no credential header, a 5 s timeout. */
export const mcpConformanceSyntheticTarget = (
  era: McpConformanceEra
): McpConformanceTargetSettings => ({
  name: 'synthetic',
  url: era === 'modern' ? mcpConformanceSyntheticModernUrl : mcpConformanceSyntheticLegacyUrl,
  headers: {},
  era,
  protocolVersion:
    era === 'modern' ? latestMcpProtocolVersion : mcpConformanceSyntheticLegacyProtocolVersion,
  timeoutMs: 5_000
})

const accept = 'application/json, text/event-stream'

const jsonHeaders = { 'content-type': 'application/json' }

type RpcId = string | number

const jsonAnswer = (status: number, message: Schema.JsonObject): WireResponse => ({
  status,
  headers: jsonHeaders,
  body: JSON.stringify(message)
})

const success = (id: RpcId, result: Schema.JsonObject): Schema.JsonObject => ({
  jsonrpc: '2.0',
  id,
  result
})

const failure = (id: RpcId | null, code: number, message: string): Schema.JsonObject => ({
  jsonrpc: '2.0',
  id,
  error: { code, message }
})

// Modern (stateless `2026-07-28`) exchanges.

type ModernRequest = {
  readonly id: RpcId
  readonly method: string
  readonly params?: Schema.JsonObject
}

const modernRequest = (url: string, request: ModernRequest): WireExchange['request'] => {
  const name = request.method === 'tools/call' ? request.params?.['name'] : undefined

  const routing = {
    accept,
    'content-type': 'application/json',
    'mcp-method': request.method,
    'mcp-protocol-version': latestMcpProtocolVersion
  }

  return {
    method: 'POST',
    url,
    headers: Predicate.isString(name)
      ? { ...routing, 'mcp-name': encodeMcpParamValue(name) }
      : routing,
    body: {
      jsonrpc: '2.0',
      id: request.id,
      method: request.method,
      params: { ...request.params, _meta: mcpConformanceSyntheticEnvelope }
    }
  }
}

/** The modern discover answer: `2026-07-28` supported, `capabilities.tools` advertised. */
export const mcpConformanceModernDiscoverResult: Schema.JsonObject = {
  supportedVersions: [latestMcpProtocolVersion],
  capabilities: { tools: {} },
  resultType: 'complete',
  ttlMs: 0,
  cacheScope: 'private',
  _meta: { [metaKeys.serverInfo]: serverInfo }
}

const modernDiscover = (url: string): WireExchange => ({
  request: modernRequest(url, { id: mcpConformanceDiscoverRequestId, method: 'server/discover' }),
  response: jsonAnswer(
    200,
    success(mcpConformanceDiscoverRequestId, mcpConformanceModernDiscoverResult)
  )
})

const toolsPage = (
  tools: ReadonlyArray<Schema.JsonObject>,
  nextCursor?: string
): Schema.JsonObject => {
  const page = { tools: [...tools], resultType: 'complete', ttlMs: 0, cacheScope: 'private' }

  return nextCursor === undefined ? page : { ...page, nextCursor }
}

/** A listing page as one tools/list answer: the tools and an optional `nextCursor`. */
export type McpSyntheticToolsPage = {
  readonly tools: ReadonlyArray<Schema.JsonObject>
  readonly nextCursor?: string
}

const singlePage: ReadonlyArray<McpSyntheticToolsPage> = [{ tools: mcpConformanceSyntheticTools }]

/**
 * `listRemoteMcpServerTools` against the modern server: `server/discover`, then one tools/list per
 * page (ids from 0; each page after the first sends the previous page's `nextCursor`).
 */
export const modernListingExchanges = (
  pages: ReadonlyArray<McpSyntheticToolsPage> = singlePage
): ReadonlyArray<WireExchange> => {
  const url = mcpConformanceSyntheticModernUrl

  return [
    modernDiscover(url),
    ...pages.map((page, index) => {
      const cursor = index === 0 ? undefined : pages[index - 1]?.nextCursor

      return {
        request: modernRequest(
          url,
          cursor === undefined
            ? { id: index, method: 'tools/list' }
            : { id: index, method: 'tools/list', params: { cursor } }
        ),
        response: jsonAnswer(200, success(index, toolsPage(page.tools, page.nextCursor)))
      }
    })
  ]
}

/** How the server answers a tools/call: a result, or a JSON-RPC error at an HTTP status. */
export type McpSyntheticCallAnswer =
  | { readonly kind: 'result'; readonly result: Schema.JsonObject }
  | {
      readonly kind: 'error'
      readonly status: number
      readonly code: number
      readonly message: string
    }

/**
 * `callRemoteMcpServerTool` against the modern server: `server/discover`, tools/list (id 0), and
 * tools/call (id 1). A modern result carries `resultType: 'complete'`.
 */
export const modernCallExchanges = (
  call: { readonly name: string; readonly arguments: Schema.JsonObject },
  answer: McpSyntheticCallAnswer
): ReadonlyArray<WireExchange> => {
  const url = mcpConformanceSyntheticModernUrl

  return [
    ...modernListingExchanges(),
    {
      request: modernRequest(url, {
        id: 1,
        method: 'tools/call',
        params: { name: call.name, arguments: call.arguments }
      }),
      response:
        answer.kind === 'result'
          ? jsonAnswer(200, success(1, { ...answer.result, resultType: 'complete' }))
          : jsonAnswer(answer.status, failure(1, answer.code, answer.message))
    }
  ]
}

// Legacy (initialize-based) exchanges.

const legacyHeaders = (handshake: boolean) => {
  const base = { accept, 'content-type': 'application/json' }

  return handshake
    ? base
    : {
        ...base,
        'mcp-protocol-version': mcpConformanceSyntheticLegacyProtocolVersion,
        'mcp-session-id': mcpConformanceSyntheticSessionId
      }
}

/**
 * One SSE answer: a logging notification the client ignores, then the response; the stream ends
 * after the response. Chunk boundaries are kept for the chunk faults.
 */
export const legacySseAnswer = (message: Schema.JsonObject): WireResponse => ({
  status: 200,
  headers: {
    'content-type': 'text/event-stream',
    'mcp-session-id': mcpConformanceSyntheticSessionId
  },
  chunks: [
    `event: message\nid: evt-1\ndata: ${JSON.stringify({
      jsonrpc: '2.0',
      method: 'notifications/message',
      params: { level: 'info', data: 'synthetic notification' }
    })}\n\n`,
    `event: message\nid: evt-2\ndata: ${JSON.stringify(message)}\n\n`
  ]
})

/** The legacy initialize answer. */
export const mcpConformanceLegacyInitializeResult: Schema.JsonObject = {
  protocolVersion: mcpConformanceSyntheticLegacyProtocolVersion,
  capabilities: { tools: {} },
  serverInfo
}

/**
 * The legacy handshake: the era probe answered 400 with a JSON-RPC error (the session-less
 * rejection a pre-2026 stateful server sends), `initialize` (id 0) answered over SSE with a session
 * id, `notifications/initialized` answered 202, and the client's standing `GET` answered 405.
 */
export const legacyHandshakeExchanges = (): ReadonlyArray<WireExchange> => {
  const url = mcpConformanceSyntheticLegacyUrl

  return [
    {
      request: modernRequest(url, {
        id: mcpConformanceDiscoverRequestId,
        method: 'server/discover'
      }),
      response: jsonAnswer(400, failure(null, -32_000, 'Bad Request: Server not initialized'))
    },
    {
      request: {
        method: 'POST',
        url,
        headers: legacyHeaders(true),
        body: {
          jsonrpc: '2.0',
          id: 0,
          method: 'initialize',
          params: {
            protocolVersion: mcpConformanceSyntheticLegacyProtocolVersion,
            capabilities: {},
            clientInfo: { name: defaultMcpClientInfo.name, version: defaultMcpClientInfo.version }
          }
        }
      },
      response: legacySseAnswer(success(0, mcpConformanceLegacyInitializeResult))
    },
    {
      request: {
        method: 'POST',
        url,
        headers: legacyHeaders(false),
        body: { jsonrpc: '2.0', method: 'notifications/initialized' }
      },
      response: { status: 202, headers: {}, body: '' }
    },
    {
      request: {
        method: 'GET',
        url,
        headers: {
          accept: 'text/event-stream',
          'mcp-protocol-version': mcpConformanceSyntheticLegacyProtocolVersion,
          'mcp-session-id': mcpConformanceSyntheticSessionId
        }
      },
      response: { status: 405, headers: {}, body: '' }
    }
  ]
}

const legacyToolsList = (): WireExchange => ({
  request: {
    method: 'POST',
    url: mcpConformanceSyntheticLegacyUrl,
    headers: legacyHeaders(false),
    body: { jsonrpc: '2.0', id: 1, method: 'tools/list' }
  },
  response: legacySseAnswer(success(1, { tools: [...mcpConformanceSyntheticTools] }))
})

/** `listRemoteMcpServerTools` against the legacy server: the handshake, then tools/list (id 1). */
export const legacyListingExchanges = (): ReadonlyArray<WireExchange> => [
  ...legacyHandshakeExchanges(),
  legacyToolsList()
]

/**
 * `callRemoteMcpServerTool` against the legacy server: the handshake, tools/list (id 1), and
 * tools/call (id 2). The answer is SSE with HTTP 200 (a legacy server answers a JSON-RPC error
 * inside the stream too); `status` of an error answer is ignored.
 */
export const legacyCallExchanges = (
  call: { readonly name: string; readonly arguments: Schema.JsonObject },
  answer: McpSyntheticCallAnswer
): ReadonlyArray<WireExchange> => [
  ...legacyListingExchanges(),
  {
    request: {
      method: 'POST',
      url: mcpConformanceSyntheticLegacyUrl,
      headers: legacyHeaders(false),
      body: {
        jsonrpc: '2.0',
        id: 2,
        method: 'tools/call',
        params: { name: call.name, arguments: call.arguments }
      }
    },
    response: legacySseAnswer(
      answer.kind === 'result' ? success(2, answer.result) : failure(2, answer.code, answer.message)
    )
  }
]

/** The answer the synthetic servers give a credential they reject. */
export const mcpConformanceUnauthorizedAnswer: WireResponse = {
  status: 401,
  headers: {
    'content-type': 'application/json',
    'www-authenticate': 'Bearer error="invalid_token"'
  },
  body: JSON.stringify({ error: 'invalid_token', error_description: 'Synthetic rejection.' })
}

/**
 * The era probe sent with the reserved invalid credential (never recorded: fixtures drop
 * `authorization`), answered 401.
 */
export const unauthorizedProbeExchanges = (url: string): ReadonlyArray<WireExchange> => [
  {
    request: modernRequest(url, { id: mcpConformanceDiscoverRequestId, method: 'server/discover' }),
    response: mcpConformanceUnauthorizedAnswer
  }
]

/** The synthetic read call's arguments, result, and the tool-error answer to invalid arguments. */
export const mcpConformanceSyntheticReadResult: Schema.JsonObject = {
  content: [{ type: 'text', text: 'Synthetic note note-0001.' }],
  structuredContent: { noteId: 'note-0001', text: 'Synthetic note note-0001.' }
}

export const mcpConformanceSyntheticToolErrorResult: Schema.JsonObject = {
  content: [{ type: 'text', text: 'Invalid arguments: noteId must be a string.' }],
  isError: true
}

/**
 * A synthetic fixture for one case on one synthetic server: id `<caseId>.<era>.synthetic`,
 * `evidence: 'unverified'`, account `synthetic`. Throws at module load when `exchanges` is empty
 * (a programmer error, like an invalid case definition).
 */
export const mcpSyntheticFixture = (input: {
  readonly caseId: string
  readonly era: McpConformanceEra
  readonly note: string
  readonly exchanges: ReadonlyArray<WireExchange>
}): WireFixture => {
  const [first, ...rest] = input.exchanges

  if (first === undefined) {
    throw new Error(`MCP fixture for ${input.caseId} has no exchanges`)
  }

  return {
    id: `${input.caseId}.${input.era}.synthetic`,
    caseId: input.caseId,
    evidence: 'unverified',
    recordedAt: mcpConformanceSyntheticRecordedAt,
    account: 'synthetic',
    endpoint:
      input.era === 'modern' ? mcpConformanceSyntheticModernUrl : mcpConformanceSyntheticLegacyUrl,
    note: `${input.note} Synthetic placeholder shaped like the MCP wire the pinned SDK speaks; not recorded from a live service.`,
    exchanges: [first, ...rest]
  }
}
