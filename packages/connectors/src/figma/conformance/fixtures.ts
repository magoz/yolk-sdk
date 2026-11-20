/**
 * The synthetic Figma MCP wire fixtures: one per `@yolk-sdk/mcp/conformance` case that applies to
 * the legacy era (every case but `mcp.modern.stateless`). See `wire.ts` for their provenance.
 *
 * @experimental
 */
import type { WireFixture } from '@yolk-sdk/conformance/fixture'
import { figmaMcpConformanceInvalidArguments, figmaMcpConformanceReadCall } from './seeds.ts'
import {
  figmaCallExchanges,
  figmaListingExchanges,
  figmaMcpConformanceReadResult,
  figmaMcpConformanceToolErrorResult,
  figmaMcpConformanceUnknownTool,
  figmaMcpFixture,
  figmaUnauthorizedProbeExchanges
} from './wire.ts'

/** The tool name the unknown-tool case calls (the cases' default `absentToolName`). */
const absentCall = { name: 'yolk_conformance_absent', arguments: {} }

/** The era probe answered 400 with a JSON-RPC error, then the legacy handshake and listing. */
export const figmaMcpNegotiationEraFixture: WireFixture = figmaMcpFixture({
  caseId: 'mcp.negotiation.era',
  note: 'server/discover answered 400 with a JSON-RPC error; the client falls back to initialize and lists tools in a session.',
  exchanges: figmaListingExchanges()
})

/** The handshake's session id, echoed on every later request; initialized 202, GET 405. */
export const figmaMcpLegacySessionFixture: WireFixture = figmaMcpFixture({
  caseId: 'mcp.legacy.session',
  note: 'initialize issues a synthetic session id that every later request echoes; initialized gets 202 and GET gets 405.',
  exchanges: figmaListingExchanges()
})

/** Every answer to a request is an SSE stream holding the response, then the end; 202 bodiless. */
export const figmaMcpResponseEncodingFixture: WireFixture = figmaMcpFixture({
  caseId: 'mcp.transport.response-encoding',
  note: 'Every answer to a request is text/event-stream holding the response, then the stream ends; 202 has no body.',
  exchanges: figmaListingExchanges()
})

/** The listing on one page: the published tool subset, the write tools not marked read-only. */
export const figmaMcpToolsListFixture: WireFixture = figmaMcpFixture({
  caseId: 'mcp.tools.list',
  note: 'A listing on one tools/list page in a session: the published tool subset, use_figma and create_new_file marked readOnlyHint false.',
  exchanges: figmaListingExchanges()
})

/** The precondition listing, then `get_metadata` answered with text content. */
export const figmaMcpCallReadFixture: WireFixture = figmaMcpFixture({
  caseId: 'mcp.tools.call-read',
  note: 'A listing (the readOnlyHint precondition), then get_metadata answered with a text tool result.',
  exchanges: [
    ...figmaListingExchanges(),
    ...figmaCallExchanges(figmaMcpConformanceReadCall, {
      kind: 'result',
      result: figmaMcpConformanceReadResult
    })
  ]
})

/** The precondition listing, then `get_metadata` with a numeric node id answered `isError`. */
export const figmaMcpCallToolErrorFixture: WireFixture = figmaMcpFixture({
  caseId: 'mcp.tools.call-tool-error',
  note: 'A listing (the readOnlyHint precondition), then get_metadata with a numeric nodeId answered as a tool result with isError true and text content.',
  exchanges: [
    ...figmaListingExchanges(),
    ...figmaCallExchanges(
      { name: figmaMcpConformanceReadCall.name, arguments: figmaMcpConformanceInvalidArguments },
      { kind: 'result', result: figmaMcpConformanceToolErrorResult }
    )
  ]
})

/** The precondition listing, then the absent tool answered with an SSE JSON-RPC -32602 error. */
export const figmaMcpUnknownToolFixture: WireFixture = figmaMcpFixture({
  caseId: 'mcp.errors.unknown-tool',
  note: 'A listing without the absent tool, then tools/call of it answered HTTP 200 with a JSON-RPC -32602 error event carrying the request id.',
  exchanges: [
    ...figmaListingExchanges(),
    ...figmaCallExchanges(absentCall, figmaMcpConformanceUnknownTool)
  ]
})

/** The era probe with the reserved invalid credential, answered 401 with `WWW-Authenticate`. */
export const figmaMcpAuthRejectedFixture: WireFixture = figmaMcpFixture({
  caseId: 'mcp.auth.rejected',
  note: 'The era probe sent with the reserved invalid credential (authorization is never recorded), answered 401 with a WWW-Authenticate challenge of the Bearer scheme.',
  exchanges: figmaUnauthorizedProbeExchanges()
})

/** Every Figma MCP fixture, in the order of `mcpConformanceCases`. */
export const figmaMcpConformanceFixtures: ReadonlyArray<WireFixture> = [
  figmaMcpNegotiationEraFixture,
  figmaMcpLegacySessionFixture,
  figmaMcpResponseEncodingFixture,
  figmaMcpToolsListFixture,
  figmaMcpCallReadFixture,
  figmaMcpCallToolErrorFixture,
  figmaMcpUnknownToolFixture,
  figmaMcpAuthRejectedFixture
]

/** The fixture of one case id, or `undefined` for a case with none (`mcp.modern.stateless`). */
export const figmaMcpConformanceFixtureFor = (caseId: string): WireFixture | undefined =>
  figmaMcpConformanceFixtures.find(fixture => fixture.caseId === caseId)

/** The MCP cases that do not apply to Figma, and why. */
export const figmaMcpConformanceNotApplicable: ReadonlyArray<{
  readonly id: string
  readonly reason: string
}> = [
  {
    id: 'mcp.modern.stateless',
    reason:
      'the Figma target is legacy-era (an initialize handshake with a session; unverified until a live run), so the stateless 2026-07-28 claim does not apply'
  }
]
