import type { WireFixture } from '@yolk-sdk/conformance/fixture'
import {
  legacyCallExchanges,
  legacyListingExchanges,
  mcpConformanceSyntheticInvalidCall,
  mcpConformanceSyntheticToolErrorResult,
  mcpSyntheticFixture,
  modernCallExchanges,
  modernListingExchanges,
  type McpSyntheticCallAnswer
} from './synthetic.ts'

const caseId = 'mcp.tools.call-tool-error'

const answer: McpSyntheticCallAnswer = {
  kind: 'result',
  result: mcpConformanceSyntheticToolErrorResult
}

/** The precondition listing, then the read tool with invalid arguments answered `isError: true`. */
export const mcpCallToolErrorModernFixture: WireFixture = mcpSyntheticFixture({
  caseId,
  era: 'modern',
  note: 'A listing (the readOnlyHint precondition), then get_synthetic_note with a numeric noteId answered as a tool result with isError true and text content.',
  exchanges: [
    ...modernListingExchanges(),
    ...modernCallExchanges(mcpConformanceSyntheticInvalidCall, answer)
  ]
})

export const mcpCallToolErrorLegacyFixture: WireFixture = mcpSyntheticFixture({
  caseId,
  era: 'legacy',
  note: 'A listing (the readOnlyHint precondition), then get_synthetic_note with a numeric noteId answered as a tool result with isError true and text content.',
  exchanges: [
    ...legacyListingExchanges(),
    ...legacyCallExchanges(mcpConformanceSyntheticInvalidCall, answer)
  ]
})
