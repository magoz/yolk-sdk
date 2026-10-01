import type { WireFixture } from '@yolk-sdk/conformance/fixture'
import {
  legacyListingExchanges,
  mcpConformanceSyntheticCursor,
  mcpConformanceSyntheticReadTool,
  mcpConformanceSyntheticWriteTool,
  mcpSyntheticFixture,
  modernListingExchanges
} from './synthetic.ts'

const caseId = 'mcp.tools.list'

/** The modern listing over two pages: the client follows the cursor once, then stops. */
export const mcpToolsListModernFixture: WireFixture = mcpSyntheticFixture({
  caseId,
  era: 'modern',
  note: 'A listing over two tools/list pages joined by one cursor; the second page has no nextCursor.',
  exchanges: modernListingExchanges([
    { tools: [mcpConformanceSyntheticReadTool], nextCursor: mcpConformanceSyntheticCursor },
    { tools: [mcpConformanceSyntheticWriteTool] }
  ])
})

/** The legacy listing on one page. */
export const mcpToolsListLegacyFixture: WireFixture = mcpSyntheticFixture({
  caseId,
  era: 'legacy',
  note: 'A listing on one tools/list page in a session.',
  exchanges: legacyListingExchanges()
})
