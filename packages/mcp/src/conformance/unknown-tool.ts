import type { WireFixture } from '@yolk-sdk/conformance/fixture'
import {
  legacyCallExchanges,
  legacyListingExchanges,
  mcpSyntheticFixture,
  modernCallExchanges,
  modernListingExchanges
} from './synthetic.ts'
import { mcpConformanceDefaultAbsentToolName } from './target.ts'

const caseId = 'mcp.errors.unknown-tool'

const absentCall = { name: mcpConformanceDefaultAbsentToolName, arguments: {} }

const message = 'Tool yolk_conformance_absent not found'

/**
 * The precondition listing (the absent tool is not listed), then the absent tool answered 400 with
 * a JSON-RPC error carrying the request id (modern routing).
 */
export const mcpUnknownToolModernFixture: WireFixture = mcpSyntheticFixture({
  caseId,
  era: 'modern',
  note: 'A listing without the absent tool, then tools/call of it answered HTTP 400 with a JSON-RPC -32602 error carrying the request id.',
  exchanges: [
    ...modernListingExchanges(),
    ...modernCallExchanges(absentCall, {
      kind: 'error',
      status: 400,
      code: -32_602,
      message
    })
  ]
})

/** The precondition listing, then the absent tool answered 200 with an SSE JSON-RPC error event. */
export const mcpUnknownToolLegacyFixture: WireFixture = mcpSyntheticFixture({
  caseId,
  era: 'legacy',
  note: 'A listing without the absent tool, then tools/call of it answered HTTP 200 with a JSON-RPC -32602 error event carrying the request id.',
  exchanges: [
    ...legacyListingExchanges(),
    ...legacyCallExchanges(absentCall, {
      kind: 'error',
      status: 200,
      code: -32_602,
      message
    })
  ]
})
