import type { WireFixture } from '@yolk-sdk/conformance/fixture'
import { legacyListingExchanges, mcpSyntheticFixture, modernListingExchanges } from './synthetic.ts'

const caseId = 'mcp.negotiation.era'

/** The era probe answered with a modern discover result, then the stateless listing. */
export const mcpNegotiationEraModernFixture: WireFixture = mcpSyntheticFixture({
  caseId,
  era: 'modern',
  note: 'server/discover answered with supportedVersions ["2026-07-28"]; the client then lists tools statelessly.',
  exchanges: modernListingExchanges()
})

/** The era probe answered 400 with a JSON-RPC error, then the legacy handshake and listing. */
export const mcpNegotiationEraLegacyFixture: WireFixture = mcpSyntheticFixture({
  caseId,
  era: 'legacy',
  note: 'server/discover answered 400 with a JSON-RPC error; the client falls back to initialize and lists tools in a session.',
  exchanges: legacyListingExchanges()
})
