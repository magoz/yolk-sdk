import type { WireFixture } from '@yolk-sdk/conformance/fixture'
import {
  mcpConformanceSyntheticLegacyUrl,
  mcpConformanceSyntheticModernUrl,
  mcpSyntheticFixture,
  unauthorizedProbeExchanges
} from './synthetic.ts'

const caseId = 'mcp.auth.rejected'

const note =
  'The era probe sent with the reserved invalid credential (authorization is never recorded), answered 401 with a WWW-Authenticate challenge.'

export const mcpAuthRejectedModernFixture: WireFixture = mcpSyntheticFixture({
  caseId,
  era: 'modern',
  note,
  exchanges: unauthorizedProbeExchanges(mcpConformanceSyntheticModernUrl)
})

export const mcpAuthRejectedLegacyFixture: WireFixture = mcpSyntheticFixture({
  caseId,
  era: 'legacy',
  note,
  exchanges: unauthorizedProbeExchanges(mcpConformanceSyntheticLegacyUrl)
})
