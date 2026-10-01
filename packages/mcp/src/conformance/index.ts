/**
 * MCP conformance cases for `@yolk-sdk/conformance/runner`, the target and seeds they read, the
 * observing `HttpClient` they wrap around the host's client, the era filter, and the synthetic
 * wire fixtures that back their replay (`@yolk-sdk/conformance/replay`).
 *
 * The cases run the real `@yolk-sdk/mcp/client` operations and never name a product: provider
 * targets and seeds live with the provider. The fixtures are synthetic placeholders
 * (`evidence: 'unverified'`) on two synthetic servers sharing the reserved origin
 * `https://mcp.example.test`: `/modern/mcp` (stateless `2026-07-28`, JSON answers) and
 * `/legacy/mcp` (an `initialize` handshake with session `yolk-synthetic-session-0001`, SSE
 * answers). They never record `authorization`.
 *
 * @experimental
 */
import type { WireFixture } from '@yolk-sdk/conformance/fixture'
import { mcpAuthRejectedLegacyFixture, mcpAuthRejectedModernFixture } from './auth-rejected.ts'
import { mcpCallReadLegacyFixture, mcpCallReadModernFixture } from './call-read.ts'
import { mcpCallToolErrorLegacyFixture, mcpCallToolErrorModernFixture } from './call-tool-error.ts'
import { mcpLegacySessionFixture } from './legacy-session.ts'
import { mcpModernStatelessFixture } from './modern-stateless.ts'
import {
  mcpNegotiationEraLegacyFixture,
  mcpNegotiationEraModernFixture
} from './negotiation-era.ts'
import {
  mcpResponseEncodingLegacyFixture,
  mcpResponseEncodingModernFixture
} from './response-encoding.ts'
import { mcpToolsListLegacyFixture, mcpToolsListModernFixture } from './tools-list.ts'
import { mcpUnknownToolLegacyFixture, mcpUnknownToolModernFixture } from './unknown-tool.ts'

export {
  mcpAuthRejectedCase,
  mcpCallReadCase,
  mcpCallToolErrorCase,
  mcpConformanceCases,
  mcpLegacySessionCase,
  mcpModernStatelessCase,
  mcpNegotiationEraCase,
  mcpResponseEncodingCase,
  mcpToolsListCase,
  mcpUnknownToolCase,
  type McpConformanceCase,
  type McpConformanceError,
  type McpConformanceRequirements
} from './cases.ts'

export {
  makeMcpObservingHttpClient,
  mcpMediaType,
  mcpObservedRequestHeaders,
  mcpObservedResponseHeaders,
  type McpCallGate,
  type McpCallRefusal,
  type McpObservedExchange,
  type McpObservedHeaders,
  type McpObservedSession,
  type McpObservingHttpClient,
  type McpObservingOptions
} from './observe.ts'

export {
  McpConformanceConfig,
  McpConformanceEra,
  McpConformanceSeeds,
  McpConformanceTarget,
  mcpConformanceCaseEra,
  mcpConformanceDefaultAbsentToolName,
  mcpConformanceDefaultInvalidCredentialHeaders,
  mcpConformanceInvalidCredential,
  selectMcpConformanceCases,
  type McpConformanceNotApplicable,
  type McpConformanceSeedKey,
  type McpConformanceSelection,
  type McpConformanceTargetSettings
} from './target.ts'

export {
  legacyCallExchanges,
  legacyHandshakeExchanges,
  legacyListingExchanges,
  legacySseAnswer,
  mcpConformanceDiscoverRequestId,
  mcpConformanceFixtureSeeds,
  mcpConformanceLegacyInitializeResult,
  mcpConformanceModernDiscoverResult,
  mcpConformanceSyntheticCursor,
  mcpConformanceSyntheticEnvelope,
  mcpConformanceSyntheticInvalidCall,
  mcpConformanceSyntheticLegacyProtocolVersion,
  mcpConformanceSyntheticLegacyUrl,
  mcpConformanceSyntheticModernUrl,
  mcpConformanceSyntheticOrigin,
  mcpConformanceSyntheticReadCall,
  mcpConformanceSyntheticReadResult,
  mcpConformanceSyntheticReadTool,
  mcpConformanceSyntheticRecordedAt,
  mcpConformanceSyntheticSessionId,
  mcpConformanceSyntheticTarget,
  mcpConformanceSyntheticToolErrorResult,
  mcpConformanceSyntheticTools,
  mcpConformanceSyntheticWriteTool,
  mcpConformanceUnauthorizedAnswer,
  mcpSyntheticFixture,
  modernCallExchanges,
  modernListingExchanges,
  unauthorizedProbeExchanges,
  type McpSyntheticCallAnswer,
  type McpSyntheticToolsPage
} from './synthetic.ts'

export {
  mcpAuthRejectedLegacyFixture,
  mcpAuthRejectedModernFixture,
  mcpCallReadLegacyFixture,
  mcpCallReadModernFixture,
  mcpCallToolErrorLegacyFixture,
  mcpCallToolErrorModernFixture,
  mcpLegacySessionFixture,
  mcpModernStatelessFixture,
  mcpNegotiationEraLegacyFixture,
  mcpNegotiationEraModernFixture,
  mcpResponseEncodingLegacyFixture,
  mcpResponseEncodingModernFixture,
  mcpToolsListLegacyFixture,
  mcpToolsListModernFixture,
  mcpUnknownToolLegacyFixture,
  mcpUnknownToolModernFixture
}

/** Every MCP wire fixture, in case order (modern before legacy). */
export const mcpConformanceFixtures: ReadonlyArray<WireFixture> = [
  mcpNegotiationEraModernFixture,
  mcpNegotiationEraLegacyFixture,
  mcpModernStatelessFixture,
  mcpLegacySessionFixture,
  mcpResponseEncodingModernFixture,
  mcpResponseEncodingLegacyFixture,
  mcpToolsListModernFixture,
  mcpToolsListLegacyFixture,
  mcpCallReadModernFixture,
  mcpCallReadLegacyFixture,
  mcpCallToolErrorModernFixture,
  mcpCallToolErrorLegacyFixture,
  mcpUnknownToolModernFixture,
  mcpUnknownToolLegacyFixture,
  mcpAuthRejectedModernFixture,
  mcpAuthRejectedLegacyFixture
]
