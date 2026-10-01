import type { WireFixture } from '@yolk-sdk/conformance/fixture'
import {
  legacyCallExchanges,
  legacyListingExchanges,
  mcpConformanceSyntheticReadCall,
  mcpConformanceSyntheticReadResult,
  mcpSyntheticFixture,
  modernCallExchanges,
  modernListingExchanges,
  type McpSyntheticCallAnswer
} from './synthetic.ts'

const caseId = 'mcp.tools.call-read'

const answer: McpSyntheticCallAnswer = { kind: 'result', result: mcpConformanceSyntheticReadResult }

/** The precondition listing, then the read call answered with matching structured content. */
export const mcpCallReadModernFixture: WireFixture = mcpSyntheticFixture({
  caseId,
  era: 'modern',
  note: 'A listing (the readOnlyHint precondition), then get_synthetic_note answered with structured content matching its output schema.',
  exchanges: [
    ...modernListingExchanges(),
    ...modernCallExchanges(mcpConformanceSyntheticReadCall, answer)
  ]
})

/** The same over the legacy session (two connections: listing, then listing and call). */
export const mcpCallReadLegacyFixture: WireFixture = mcpSyntheticFixture({
  caseId,
  era: 'legacy',
  note: 'A listing (the readOnlyHint precondition), then get_synthetic_note answered with structured content matching its output schema.',
  exchanges: [
    ...legacyListingExchanges(),
    ...legacyCallExchanges(mcpConformanceSyntheticReadCall, answer)
  ]
})
