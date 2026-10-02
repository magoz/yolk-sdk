/**
 * The derived Afloat MCP wire fixtures: one per `@yolk-sdk/mcp/conformance` case that applies to
 * the modern era (every case but `mcp.legacy.session`). See `wire.ts` for their provenance.
 *
 * @experimental
 */
import type { WireFixture } from '@yolk-sdk/conformance/fixture'
import { afloatMcpConformanceInvalidArguments, afloatMcpConformanceReadCall } from './seeds.ts'
import {
  afloatCallExchanges,
  afloatListingExchanges,
  afloatMcpConformanceReadResult,
  afloatMcpConformanceToolErrorResult,
  afloatMcpConformanceUnknownTool,
  afloatMcpFixture,
  afloatUnauthorizedProbeExchanges
} from './wire.ts'

/** The tool name the unknown-tool cases call (the cases' default `absentToolName`). */
const absentCall = { name: 'yolk_conformance_absent', arguments: {} }

/** The era probe answered with a modern discover result, then the stateless listing. */
export const afloatMcpNegotiationEraFixture: WireFixture = afloatMcpFixture({
  caseId: 'mcp.negotiation.era',
  note: 'server/discover answered with supportedVersions ["2026-07-28"]; the client then lists tools statelessly.',
  exchanges: afloatListingExchanges()
})

/** A listing, then a call of the absent tool: routing headers everywhere, no session. */
export const afloatMcpModernStatelessFixture: WireFixture = afloatMcpFixture({
  caseId: 'mcp.modern.stateless',
  note: 'A stateless listing and an absent-tool call: routing headers on every request, no session id, results complete.',
  exchanges: [
    ...afloatListingExchanges(),
    ...afloatCallExchanges(absentCall, afloatMcpConformanceUnknownTool)
  ]
})

/** Every answer to a request is one JSON body holding the response. */
export const afloatMcpResponseEncodingFixture: WireFixture = afloatMcpFixture({
  caseId: 'mcp.transport.response-encoding',
  note: 'Every answer is application/json holding the response to its request.',
  exchanges: afloatListingExchanges()
})

/** The listing on one page: the published tool subset with the provider's annotations. */
export const afloatMcpToolsListFixture: WireFixture = afloatMcpFixture({
  caseId: 'mcp.tools.list',
  note: 'A listing on one tools/list page: the published tool subset, the receipt-upload tools marked readOnlyHint false.',
  exchanges: afloatListingExchanges()
})

/** The precondition listing, then `list-invoices` answered with matching structured content. */
export const afloatMcpCallReadFixture: WireFixture = afloatMcpFixture({
  caseId: 'mcp.tools.call-read',
  note: 'A listing (the readOnlyHint precondition), then list-invoices answered with structured content matching its output schema.',
  exchanges: [
    ...afloatListingExchanges(),
    ...afloatCallExchanges(afloatMcpConformanceReadCall, {
      kind: 'result',
      result: afloatMcpConformanceReadResult
    })
  ]
})

/** The precondition listing, then `list-invoices` with a non-numeric size answered `isError`. */
export const afloatMcpCallToolErrorFixture: WireFixture = afloatMcpFixture({
  caseId: 'mcp.tools.call-tool-error',
  note: 'A listing (the readOnlyHint precondition), then list-invoices with a non-numeric size answered as a tool result with isError true and a VALIDATION_ERROR text.',
  exchanges: [
    ...afloatListingExchanges(),
    ...afloatCallExchanges(
      { name: afloatMcpConformanceReadCall.name, arguments: afloatMcpConformanceInvalidArguments },
      { kind: 'result', result: afloatMcpConformanceToolErrorResult }
    )
  ]
})

/** The precondition listing, then the absent tool answered HTTP 200 with JSON-RPC -32602. */
export const afloatMcpUnknownToolFixture: WireFixture = afloatMcpFixture({
  caseId: 'mcp.errors.unknown-tool',
  note: 'A listing without the absent tool, then tools/call of it answered HTTP 200 with a JSON-RPC -32602 error carrying the request id.',
  exchanges: [
    ...afloatListingExchanges(),
    ...afloatCallExchanges(absentCall, afloatMcpConformanceUnknownTool)
  ]
})

/** The era probe with the reserved invalid credential, answered 401 with `WWW-Authenticate`. */
export const afloatMcpAuthRejectedFixture: WireFixture = afloatMcpFixture({
  caseId: 'mcp.auth.rejected',
  note: 'The era probe sent with the reserved invalid Afloat credential (authorization is never recorded), answered 401 with a WWW-Authenticate challenge of the Bearer scheme alone.',
  exchanges: afloatUnauthorizedProbeExchanges()
})

/** Every Afloat MCP fixture, in the order of `mcpConformanceCases`. */
export const afloatMcpConformanceFixtures: ReadonlyArray<WireFixture> = [
  afloatMcpNegotiationEraFixture,
  afloatMcpModernStatelessFixture,
  afloatMcpResponseEncodingFixture,
  afloatMcpToolsListFixture,
  afloatMcpCallReadFixture,
  afloatMcpCallToolErrorFixture,
  afloatMcpUnknownToolFixture,
  afloatMcpAuthRejectedFixture
]

/** The fixture of one case id, or `undefined` for a case with none (`mcp.legacy.session`). */
export const afloatMcpConformanceFixtureFor = (caseId: string): WireFixture | undefined =>
  afloatMcpConformanceFixtures.find(fixture => fixture.caseId === caseId)

/** The MCP cases that do not apply to Afloat, and why. */
export const afloatMcpConformanceNotApplicable: ReadonlyArray<{
  readonly id: string
  readonly reason: string
}> = [
  {
    id: 'mcp.legacy.session',
    reason:
      'Afloat is a modern 2026-07-28 server; its 2025-11-25 fallback is stateless (no session), and the client never selects it because server/discover answers 2026-07-28'
  }
]
