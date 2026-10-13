import type { WireFixture } from '@yolk-sdk/conformance/fixture'
import {
  legacyListingExchanges,
  mcpConformanceSyntheticElicitationEnvelope,
  mcpSyntheticFixture,
  modernListingExchanges
} from './synthetic.ts'

const caseId = 'mcp.elicitation.declaration'

/** The modern listing of a host that opted into form elicitation: the page declares it. */
export const mcpElicitationDeclarationModernFixture: WireFixture = mcpSyntheticFixture({
  caseId,
  era: 'modern',
  note: 'An opted-in listing: the probe keeps the plain envelope, tools/list declares elicitation.form in its _meta client capabilities, and the server lists normally.',
  exchanges: modernListingExchanges(undefined, mcpConformanceSyntheticElicitationEnvelope)
})

/** The legacy listing of the same host: nothing declares elicitation. */
export const mcpElicitationDeclarationLegacyFixture: WireFixture = mcpSyntheticFixture({
  caseId,
  era: 'legacy',
  note: 'An opted-in listing in a session: initialize declares no elicitation capability and no request carries _meta client capabilities.',
  exchanges: legacyListingExchanges()
})
