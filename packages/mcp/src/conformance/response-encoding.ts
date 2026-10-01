import type { WireFixture } from '@yolk-sdk/conformance/fixture'
import { legacyListingExchanges, mcpSyntheticFixture, modernListingExchanges } from './synthetic.ts'

const caseId = 'mcp.transport.response-encoding'

/** Every answer to a request is one JSON body holding the response. */
export const mcpResponseEncodingModernFixture: WireFixture = mcpSyntheticFixture({
  caseId,
  era: 'modern',
  note: 'Every answer is application/json holding the response to its request.',
  exchanges: modernListingExchanges()
})

/**
 * Every answer to a request is an SSE stream: a notification, then the response, then the end;
 * 202 has no body.
 */
export const mcpResponseEncodingLegacyFixture: WireFixture = mcpSyntheticFixture({
  caseId,
  era: 'legacy',
  note: 'Every answer to a request is text/event-stream: a notification, the response, then the stream ends; 202 has no body.',
  exchanges: legacyListingExchanges()
})
