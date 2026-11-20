/**
 * Builders of the synthetic Figma MCP wire fixtures (the legacy era: an `initialize` handshake
 * with a session, SSE answers) on the provider endpoint `https://mcp.figma.com/mcp`.
 *
 * Provenance: synthetic placeholders, not a live recording and not derived from provider source.
 * The envelopes are the ones a pre-2026 stateful MCP server built on the official server SDK
 * answers (the era probe refused 400 without a session, `initialize` answered over SSE with an
 * `mcp-session-id`, `notifications/initialized` 202, the standing GET 405, and the `DELETE` that
 * ends the session answered 200 with no body, as that SDK answers it); the tool listing
 * publishes a small subset of tool NAMES the Figma remote MCP server is known to offer, with
 * synthetic placeholder schemas and descriptions (never Figma's; dynamic discovery owns the real
 * contract); the tool results and the 401 are minimal synthetic bodies. The requests are the ones
 * `@yolk-sdk/mcp/client` sends, in its order. No live service was contacted. Every value is
 * synthetic; no fixture records `authorization`.
 *
 * @experimental
 */
import type * as Schema from 'effect/Schema'
import type { WireExchange, WireFixture, WireResponse } from '@yolk-sdk/conformance/fixture'
import { figmaMcpServerUrl } from '../index.ts'
import { figmaMcpConformanceTools } from './tools.ts'

/** Calendar date of the synthetic fixtures. */
export const figmaMcpConformanceRecordedAt = '2026-11-20'

/** The legacy protocol version the pinned client asks for in `initialize` and the server answers. */
export const figmaMcpConformanceProtocolVersion = '2025-11-25'

/** The modern protocol version the client's era probe (`server/discover`) carries. */
const modernProtocolVersion = '2026-07-28'

/** The session id the synthetic fixtures record (the emulator mints its own). */
export const figmaMcpConformanceSessionId = 'yolk-synthetic-figma-session-0001'

/** The JSON-RPC id the pinned client SDK gives its era probe (`server/discover`). */
const discoverRequestId = 'server-discover-probe-1'

/** Synthetic server info (never the provider's). */
const serverInfo = { name: 'yolk-synthetic-figma', version: '0.0.0' }

const clientInfo = { name: 'yolk', version: '0.1.0' }

const metaKeys = {
  protocolVersion: 'io.modelcontextprotocol/protocolVersion',
  clientInfo: 'io.modelcontextprotocol/clientInfo',
  clientCapabilities: 'io.modelcontextprotocol/clientCapabilities'
}

/** The `_meta` envelope of the era probe (the client's default `yolk` client info). */
export const figmaMcpConformanceProbeEnvelope: Schema.JsonObject = {
  [metaKeys.protocolVersion]: modernProtocolVersion,
  [metaKeys.clientInfo]: clientInfo,
  [metaKeys.clientCapabilities]: {}
}

type RpcId = string | number

const accept = 'application/json, text/event-stream'

const jsonAnswer = (status: number, body: Schema.JsonObject): WireResponse => ({
  status,
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(body)
})

/** One SSE answer holding the response only; the stream ends after it. */
const sseAnswer = (message: Schema.JsonObject): WireResponse => ({
  status: 200,
  headers: {
    'content-type': 'text/event-stream',
    'mcp-session-id': figmaMcpConformanceSessionId
  },
  chunks: [`event: message\ndata: ${JSON.stringify(message)}\n\n`]
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

/** The era probe the client sends first (modern routing headers, no session). */
const probeRequest: WireExchange['request'] = {
  method: 'POST',
  url: figmaMcpServerUrl,
  headers: {
    accept,
    'content-type': 'application/json',
    'mcp-method': 'server/discover',
    'mcp-protocol-version': modernProtocolVersion
  },
  body: {
    jsonrpc: '2.0',
    id: discoverRequestId,
    method: 'server/discover',
    params: { _meta: figmaMcpConformanceProbeEnvelope }
  }
}

const sessionHeaders = {
  accept,
  'content-type': 'application/json',
  'mcp-protocol-version': figmaMcpConformanceProtocolVersion,
  'mcp-session-id': figmaMcpConformanceSessionId
}

/** The initialize answer. */
export const figmaMcpConformanceInitializeResult: Schema.JsonObject = {
  protocolVersion: figmaMcpConformanceProtocolVersion,
  capabilities: { tools: {} },
  serverInfo
}

/**
 * The legacy handshake: the era probe answered 400 with a JSON-RPC error (the session-less
 * rejection a pre-2026 stateful server sends), `initialize` (id 0) answered over SSE with a session
 * id, `notifications/initialized` answered 202, and the client's standing `GET` answered 405.
 */
const handshakeExchanges = (): ReadonlyArray<WireExchange> => [
  {
    request: probeRequest,
    response: jsonAnswer(400, failure(null, -32_000, 'Bad Request: Server not initialized'))
  },
  {
    request: {
      method: 'POST',
      url: figmaMcpServerUrl,
      headers: { accept, 'content-type': 'application/json' },
      body: {
        jsonrpc: '2.0',
        id: 0,
        method: 'initialize',
        params: {
          protocolVersion: figmaMcpConformanceProtocolVersion,
          capabilities: {},
          clientInfo
        }
      }
    },
    response: sseAnswer(success(0, figmaMcpConformanceInitializeResult))
  },
  {
    request: {
      method: 'POST',
      url: figmaMcpServerUrl,
      headers: sessionHeaders,
      body: { jsonrpc: '2.0', method: 'notifications/initialized' }
    },
    response: { status: 202, headers: {}, body: '' }
  },
  {
    request: {
      method: 'GET',
      url: figmaMcpServerUrl,
      headers: {
        accept: 'text/event-stream',
        'mcp-protocol-version': figmaMcpConformanceProtocolVersion,
        'mcp-session-id': figmaMcpConformanceSessionId
      }
    },
    response: { status: 405, headers: {}, body: '' }
  }
]

const toolsList = (): WireExchange => ({
  request: {
    method: 'POST',
    url: figmaMcpServerUrl,
    headers: sessionHeaders,
    body: { jsonrpc: '2.0', id: 1, method: 'tools/list' }
  },
  response: sseAnswer(success(1, { tools: [...figmaMcpConformanceTools] }))
})

/**
 * The client ending its session as it closes (MCP `2025-11-25` basic/transports, "Session
 * Management" item 5): `DELETE` with the session and `mcp-protocol-version` headers, no body,
 * answered 200 with no body. Every operation ends with it, after its last POST.
 */
const sessionEnd = (): WireExchange => ({
  request: {
    method: 'DELETE',
    url: figmaMcpServerUrl,
    headers: {
      'mcp-protocol-version': figmaMcpConformanceProtocolVersion,
      'mcp-session-id': figmaMcpConformanceSessionId
    }
  },
  response: { status: 200, headers: {}, body: '' }
})

/**
 * `listRemoteMcpServerTools`: the handshake, tools/list (id 1) on the session, and the `DELETE`
 * that ends it.
 */
export const figmaListingExchanges = (): ReadonlyArray<WireExchange> => [
  ...handshakeExchanges(),
  toolsList(),
  sessionEnd()
]

/** How the server answers one tools/call: a tool result, or a JSON-RPC error event. */
export type FigmaMcpCallAnswer =
  | { readonly kind: 'result'; readonly result: Schema.JsonObject }
  | { readonly kind: 'error'; readonly code: number; readonly message: string }

/**
 * `callRemoteMcpServerTool`: the handshake, tools/list (id 1), tools/call (id 2), all on the
 * session, and the `DELETE` that ends it. A JSON-RPC error is answered HTTP 200 inside the SSE
 * stream, as a legacy server does.
 */
export const figmaCallExchanges = (
  call: { readonly name: string; readonly arguments: Schema.JsonObject },
  answer: FigmaMcpCallAnswer
): ReadonlyArray<WireExchange> => [
  ...handshakeExchanges(),
  toolsList(),
  {
    request: {
      method: 'POST',
      url: figmaMcpServerUrl,
      headers: sessionHeaders,
      body: {
        jsonrpc: '2.0',
        id: 2,
        method: 'tools/call',
        params: { name: call.name, arguments: call.arguments }
      }
    },
    response: sseAnswer(
      answer.kind === 'result' ? success(2, answer.result) : failure(2, answer.code, answer.message)
    )
  },
  sessionEnd()
]

/** The answer to an unknown tool: JSON-RPC -32602 (invalid params). */
export const figmaMcpConformanceUnknownTool: FigmaMcpCallAnswer = {
  kind: 'error',
  code: -32_602,
  message: 'Tool yolk_conformance_absent not found'
}

/** The read call's tool result: synthetic node metadata as text content. */
export const figmaMcpConformanceReadResult: Schema.JsonObject = {
  content: [{ type: 'text', text: 'Synthetic metadata of node 0:1.' }]
}

/** The tool error for arguments that fail the read tool's input schema. */
export const figmaMcpConformanceToolErrorResult: Schema.JsonObject = {
  content: [{ type: 'text', text: 'Invalid arguments: nodeId must be a string.' }],
  isError: true
}

/** The answer to a rejected token: 401 with a Bearer challenge. */
export const figmaMcpConformanceUnauthorizedAnswer: WireResponse = {
  status: 401,
  headers: {
    'content-type': 'application/json',
    'www-authenticate': 'Bearer error="invalid_token"'
  },
  body: JSON.stringify({ error: 'invalid_token', error_description: 'Synthetic rejection.' })
}

/** The era probe with the reserved invalid credential (never recorded), answered 401. */
export const figmaUnauthorizedProbeExchanges = (): ReadonlyArray<WireExchange> => [
  { request: probeRequest, response: figmaMcpConformanceUnauthorizedAnswer }
]

const provenance =
  'Synthetic placeholder shaped like the MCP wire of a pre-2026 stateful server on the official SDK, on the Figma endpoint; the listing publishes known Figma tool names with synthetic schemas; not recorded from a live service.'

/**
 * A synthetic Figma fixture for one case: id `<caseId>.figma.synthetic`, `evidence:
 * 'unverified'`, account `synthetic`. Throws at module load when `exchanges` is empty (a
 * programmer error).
 */
export const figmaMcpFixture = (input: {
  readonly caseId: string
  readonly note: string
  readonly exchanges: ReadonlyArray<WireExchange>
}): WireFixture => {
  const [first, ...rest] = input.exchanges

  if (first === undefined) {
    throw new Error(`Figma MCP fixture for ${input.caseId} has no exchanges`)
  }

  return {
    id: `${input.caseId}.figma.synthetic`,
    caseId: input.caseId,
    evidence: 'unverified',
    recordedAt: figmaMcpConformanceRecordedAt,
    account: 'synthetic',
    endpoint: figmaMcpServerUrl,
    note: `${input.note} ${provenance}`,
    exchanges: [first, ...rest]
  }
}
