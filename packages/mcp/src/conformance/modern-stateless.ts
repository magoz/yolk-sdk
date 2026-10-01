import type { WireFixture } from '@yolk-sdk/conformance/fixture'
import { mcpSyntheticFixture, modernCallExchanges, modernListingExchanges } from './synthetic.ts'
import { mcpConformanceDefaultAbsentToolName } from './target.ts'

/**
 * A modern listing, then a call of the absent tool (answered 400 with a JSON-RPC error): every
 * request carries the routing headers and the `_meta` envelope; no answer carries a session id.
 */
export const mcpModernStatelessFixture: WireFixture = mcpSyntheticFixture({
  caseId: 'mcp.modern.stateless',
  era: 'modern',
  note: 'A stateless listing and an absent-tool call: routing headers on every request, no session id, results complete.',
  exchanges: [
    ...modernListingExchanges(),
    ...modernCallExchanges(
      { name: mcpConformanceDefaultAbsentToolName, arguments: {} },
      {
        kind: 'error',
        status: 400,
        code: -32_602,
        message: 'Tool yolk_conformance_absent not found'
      }
    )
  ]
})
