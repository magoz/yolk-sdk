/**
 * The Figma target, seeds, and wire fixtures for the MCP conformance cases of
 * `@yolk-sdk/mcp/conformance`. This subpath holds NO case code and never imports `@yolk-sdk/mcp`:
 * the cases live with the MCP client; Figma owns only what it claims (its endpoint, the
 * `Authorization: Bearer <access token>` header, the legacy era, and the tools it lists), reaching
 * the cases as target and seed data.
 *
 * The target is built by running the REAL `figma.mcp_auth` action
 * (`makeFigmaMcpConformanceTarget` over a `CredentialResolver`, such as
 * `staticCredentialResolverLayer` of `@yolk-sdk/connectors/conformance` over an `OAuthCredential`).
 * The target speaks the legacy era (`2025-11-25`, an `initialize` handshake with a session; the
 * action names no protocol version, so this is unverified until a live run), so every case applies
 * except `mcp.modern.stateless` (`figmaMcpConformanceNotApplicable`).
 *
 * The fixtures are synthetic placeholders (see `wire.ts`), `evidence: 'unverified'`, on the real
 * endpoint `https://mcp.figma.com/mcp`; no case is observed live yet. The listing publishes six
 * known Figma tool names with synthetic schemas. `pnpm conformance:mcp --target figma` stays
 * refused until an owner-approved practice seat exists, so there is no live run yet.
 *
 * @experimental
 */
export {
  figmaMcpAuthRejectedFixture,
  figmaMcpCallReadFixture,
  figmaMcpCallToolErrorFixture,
  figmaMcpConformanceFixtureFor,
  figmaMcpConformanceFixtures,
  figmaMcpConformanceNotApplicable,
  figmaMcpLegacySessionFixture,
  figmaMcpNegotiationEraFixture,
  figmaMcpResponseEncodingFixture,
  figmaMcpToolsListFixture,
  figmaMcpUnknownToolFixture
} from './fixtures.ts'

export {
  figmaMcpConformanceExpectedTools,
  figmaMcpConformanceFixtureSeeds,
  figmaMcpConformanceInvalidArguments,
  figmaMcpConformanceLiveSeeds,
  figmaMcpConformanceNotReadOnly,
  figmaMcpConformanceReadCall,
  type FigmaMcpConformanceSeeds
} from './seeds.ts'

export {
  FigmaMcpConformanceAuthFailed,
  figmaMcpConformanceCredentialRef,
  figmaMcpConformanceIntegration,
  figmaMcpConformanceInvalidCredential,
  figmaMcpConformanceRequestHeaders,
  figmaMcpConformanceTarget,
  figmaMcpConformanceTimeoutMs,
  makeFigmaMcpConformanceTarget,
  type FigmaMcpConformanceTargetSettings
} from './target.ts'

export { figmaMcpConformanceTools } from './tools.ts'

export {
  figmaMcpConformanceInitializeResult,
  figmaMcpConformanceProbeEnvelope,
  figmaMcpConformanceProtocolVersion,
  figmaMcpConformanceReadResult,
  figmaMcpConformanceRecordedAt,
  figmaMcpConformanceSessionId,
  figmaMcpConformanceToolErrorResult,
  figmaMcpConformanceUnauthorizedAnswer,
  figmaMcpConformanceUnknownTool,
  type FigmaMcpCallAnswer
} from './wire.ts'
