/**
 * Builders of the Afloat MCP wire fixtures (modern `2026-07-28`, stateless, JSON answers, no
 * session) on the provider endpoint `https://useafloat.com/mcp`.
 *
 * Provenance: derived from the provider's source (owner-supplied), not a live recording. The
 * answers are the bytes the pinned official MCP server SDK (`@modelcontextprotocol/server` 2.0.0,
 * the version the provider pins) produces when it runs in-process with the provider's handler
 * options (the stateless legacy fallback and JSON responses), server info, and tool capability,
 * over the published tool subset (`tools.ts`); the tool results and the 401 follow the provider's
 * output builders over synthetic data, and the server instructions are rewritten generically. The
 * requests are the ones `@yolk-sdk/mcp/client` sends, in its order. No live service was
 * contacted. Every value is synthetic; no fixture records `authorization`, and the provider's
 * `x-request-id` response header is not kept (the recorder keeps only the MCP headers).
 *
 * @experimental
 */
import { Predicate } from 'effect'
import type * as Schema from 'effect/Schema'
import type { WireExchange, WireFixture, WireResponse } from '@yolk-sdk/conformance/fixture'
import { afloatMcpProtocolVersion, afloatMcpServerUrl } from '../index.ts'
import { afloatMcpConformanceTools } from './tools.ts'

/** Calendar date of the derived fixtures. */
export const afloatMcpConformanceRecordedAt = '2026-10-02'

/** The JSON-RPC id the pinned client SDK gives its era probe (`server/discover`). */
const discoverRequestId = 'server-discover-probe-1'

/** The provider's server info (its public `serverInfo`). */
const serverInfo = { name: 'afloat', version: '2.0.0' }

/** Server instructions, rewritten generically. */
const instructions = 'Tools for reading and managing business records.'

/**
 * The synthetic request id the provider puts in its error bodies (it mints a UUID per request).
 */
export const afloatMcpConformanceSyntheticRequestId = '00000000-0000-4000-8000-000000000001'

const metaKeys = {
  protocolVersion: 'io.modelcontextprotocol/protocolVersion',
  clientInfo: 'io.modelcontextprotocol/clientInfo',
  clientCapabilities: 'io.modelcontextprotocol/clientCapabilities',
  serverInfo: 'io.modelcontextprotocol/serverInfo'
}

/** The `_meta` envelope every modern request carries (the client's default `yolk` client info). */
export const afloatMcpConformanceEnvelope: Schema.JsonObject = {
  [metaKeys.protocolVersion]: afloatMcpProtocolVersion,
  [metaKeys.clientInfo]: { name: 'yolk', version: '0.1.0' },
  [metaKeys.clientCapabilities]: {}
}

const resultMeta = { [metaKeys.serverInfo]: serverInfo }

type RpcId = string | number

const accept = 'application/json, text/event-stream'

const jsonAnswer = (status: number, body: Schema.JsonObject): WireResponse => ({
  status,
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(body)
})

/** A result answer, in the server SDK's member order (`result`, `jsonrpc`, `id`). */
const resultAnswer = (id: RpcId, result: Schema.JsonObject): WireResponse =>
  jsonAnswer(200, { result: { ...result, _meta: resultMeta }, jsonrpc: '2.0', id })

/** An error answer, in the server SDK's member order (`jsonrpc`, `id`, `error`). */
const errorAnswer = (id: RpcId, code: number, message: string): WireResponse =>
  jsonAnswer(200, { jsonrpc: '2.0', id, error: { code, message } })

const request = (
  id: RpcId,
  method: string,
  params: Schema.JsonObject = {}
): WireExchange['request'] => {
  const name = method === 'tools/call' ? params['name'] : undefined

  const routing = {
    accept,
    'content-type': 'application/json',
    'mcp-method': method,
    'mcp-protocol-version': afloatMcpProtocolVersion
  }

  return {
    method: 'POST',
    url: afloatMcpServerUrl,
    // Every tool name here is plain ASCII, so the client sends it as is.
    headers: Predicate.isString(name) ? { ...routing, 'mcp-name': name } : routing,
    body: {
      jsonrpc: '2.0',
      id,
      method,
      params: { ...params, _meta: afloatMcpConformanceEnvelope }
    }
  }
}

/** The discover result: `2026-07-28` supported, `capabilities.tools`, no session. */
export const afloatMcpConformanceDiscoverResult: Schema.JsonObject = {
  supportedVersions: [afloatMcpProtocolVersion],
  capabilities: { tools: { listChanged: false } },
  instructions,
  resultType: 'complete',
  ttlMs: 0,
  cacheScope: 'private'
}

const discover: WireExchange = {
  request: request(discoverRequestId, 'server/discover'),
  response: resultAnswer(discoverRequestId, afloatMcpConformanceDiscoverResult)
}

const toolsList: WireExchange = {
  request: request(0, 'tools/list'),
  response: resultAnswer(0, {
    tools: [...afloatMcpConformanceTools],
    resultType: 'complete',
    ttlMs: 0,
    cacheScope: 'private'
  })
}

/** `listRemoteMcpServerTools`: the era probe, then one tools/list page (id 0). */
export const afloatListingExchanges = (): ReadonlyArray<WireExchange> => [discover, toolsList]

/** How the provider answers one tools/call: a tool result, or a JSON-RPC error. */
export type AfloatMcpCallAnswer =
  | { readonly kind: 'result'; readonly result: Schema.JsonObject }
  | { readonly kind: 'error'; readonly code: number; readonly message: string }

/**
 * `callRemoteMcpServerTool`: the era probe, tools/list (id 0), and tools/call (id 1). A result
 * carries `resultType: 'complete'`; a JSON-RPC error is answered HTTP 200.
 */
export const afloatCallExchanges = (
  call: { readonly name: string; readonly arguments: Schema.JsonObject },
  answer: AfloatMcpCallAnswer
): ReadonlyArray<WireExchange> => [
  ...afloatListingExchanges(),
  {
    request: request(1, 'tools/call', { name: call.name, arguments: call.arguments }),
    response:
      answer.kind === 'result'
        ? resultAnswer(1, { ...answer.result, resultType: 'complete' })
        : errorAnswer(1, answer.code, answer.message)
  }
]

/** The provider's answer to an unknown tool: JSON-RPC -32602 (invalid params). */
export const afloatMcpConformanceUnknownTool: AfloatMcpCallAnswer = {
  kind: 'error',
  code: -32_602,
  message: 'Requested tool was not found'
}

/** The synthetic invoice page the read call answers (structured content and its JSON text). */
export const afloatMcpConformanceInvoicePage: Schema.JsonObject = {
  items: [
    {
      id: 'yolksyntheticinvoice0001',
      invoiceNumber: 1,
      status: 'ISSUED',
      computedStatus: 'PAID',
      invoiceDate: '2026-01-15',
      invoiceDueDays: 30,
      currency: 'EUR',
      taxPercentage: '21',
      itemsValue: '100',
      invoiceValue: '121',
      paymentDate: '2026-01-31',
      paymentValue: '121',
      paymentCurrency: 'EUR',
      purchaseOrder: null,
      notes: null,
      customer: { id: 'yolksyntheticcustomer001', name: 'Synthetic Customer' },
      sequence: { prefix: 'SYN-', suffix: '' },
      updatedAt: '2026-01-31T12:00:00.000Z'
    }
  ],
  totalCount: 1
}

/** The read call's tool result: the page as text content and as structured content. */
export const afloatMcpConformanceReadResult: Schema.JsonObject = {
  content: [{ type: 'text', text: JSON.stringify(afloatMcpConformanceInvoicePage) }],
  structuredContent: afloatMcpConformanceInvoicePage
}

/** The tool error for arguments that fail the tool's input schema (`VALIDATION_ERROR`). */
export const afloatMcpConformanceToolErrorResult: Schema.JsonObject = {
  content: [
    {
      type: 'text',
      text: JSON.stringify({
        error: {
          code: 'VALIDATION_ERROR',
          message: 'The tool arguments did not match the expected schema.',
          requestId: afloatMcpConformanceSyntheticRequestId
        }
      })
    }
  ],
  isError: true
}

/** The provider's answer to a missing or rejected API key: 401 with a bare Bearer challenge. */
export const afloatMcpConformanceUnauthorizedAnswer: WireResponse = {
  status: 401,
  headers: { 'content-type': 'application/json', 'www-authenticate': 'Bearer' },
  body: JSON.stringify({
    error: {
      code: 'UNAUTHORIZED',
      message: 'Authentication required.',
      requestId: afloatMcpConformanceSyntheticRequestId
    }
  })
}

/** The era probe with the reserved invalid credential (never recorded), answered 401. */
export const afloatUnauthorizedProbeExchanges = (): ReadonlyArray<WireExchange> => [
  {
    request: request(discoverRequestId, 'server/discover'),
    response: afloatMcpConformanceUnauthorizedAnswer
  }
]

const provenance =
  'Derived from the provider source (owner-supplied), not a live recording: the envelopes are the pinned official MCP server SDK 2.0.0 run in-process with the provider handler options, the listing is the published tool subset, and the results follow the provider output builders over synthetic data.'

/**
 * A derived Afloat fixture for one case: id `<caseId>.afloat.synthetic`, `evidence:
 * 'unverified'`, account `synthetic`. Throws at module load when `exchanges` is empty (a
 * programmer error).
 */
export const afloatMcpFixture = (input: {
  readonly caseId: string
  readonly note: string
  readonly exchanges: ReadonlyArray<WireExchange>
}): WireFixture => {
  const [first, ...rest] = input.exchanges

  if (first === undefined) {
    throw new Error(`Afloat MCP fixture for ${input.caseId} has no exchanges`)
  }

  return {
    id: `${input.caseId}.afloat.synthetic`,
    caseId: input.caseId,
    evidence: 'unverified',
    recordedAt: afloatMcpConformanceRecordedAt,
    account: 'synthetic',
    endpoint: afloatMcpServerUrl,
    note: `${input.note} ${provenance}`,
    exchanges: [first, ...rest]
  }
}
