/**
 * The Afloat target, seeds, and wire fixtures for the MCP conformance cases of
 * `@yolk-sdk/mcp/conformance`. This subpath holds NO case code and never imports `@yolk-sdk/mcp`:
 * the cases live with the MCP client; Afloat owns only what it claims (its endpoint, the
 * `2026-07-28` protocol version, the `Authorization: Bearer <afloat_ key>` header, and the tools
 * it lists), reaching the cases as target and seed data.
 *
 * The target is built by running the REAL `afloat.mcp_auth` action
 * (`makeAfloatMcpConformanceTarget` over a `CredentialResolver`, such as
 * `staticCredentialResolverLayer` of `@yolk-sdk/connectors/conformance`). Afloat speaks the modern
 * era, so every case applies except `mcp.legacy.session` (`afloatMcpConformanceNotApplicable`).
 *
 * The fixtures are DERIVED from the provider's source (see `wire.ts`), `evidence: 'unverified'`,
 * on the real endpoint `https://useafloat.com/mcp`; no case is observed live yet. The listing
 * publishes a nine-tool subset of the provider's catalog with the source's schemas and rewritten
 * descriptions. `pnpm conformance:mcp --target afloat --live --owner-approved --account <label>`
 * runs the cases against a practice account (tool calls only with `--read-tool`); `--record`
 * stages recordings for wholesale synthetic replacement, never for direct promotion.
 *
 * @experimental
 */
export {
  afloatMcpAuthRejectedFixture,
  afloatMcpCallReadFixture,
  afloatMcpCallToolErrorFixture,
  afloatMcpConformanceFixtureFor,
  afloatMcpConformanceFixtures,
  afloatMcpConformanceNotApplicable,
  afloatMcpModernStatelessFixture,
  afloatMcpNegotiationEraFixture,
  afloatMcpResponseEncodingFixture,
  afloatMcpToolsListFixture,
  afloatMcpUnknownToolFixture
} from './fixtures.ts'

export {
  afloatMcpConformanceExpectedTools,
  afloatMcpConformanceFixtureSeeds,
  afloatMcpConformanceInvalidArguments,
  afloatMcpConformanceLiveSeeds,
  afloatMcpConformanceNotReadOnly,
  afloatMcpConformanceReadCall,
  type AfloatMcpConformanceSeeds
} from './seeds.ts'

export {
  AfloatMcpConformanceAuthFailed,
  afloatMcpConformanceCredentialRef,
  afloatMcpConformanceIntegration,
  afloatMcpConformanceInvalidCredential,
  afloatMcpConformanceRequestHeaders,
  afloatMcpConformanceTarget,
  afloatMcpConformanceTimeoutMs,
  makeAfloatMcpConformanceTarget,
  type AfloatMcpConformanceTargetSettings
} from './target.ts'

export { afloatMcpConformanceTools } from './tools.ts'

export {
  afloatMcpConformanceDiscoverResult,
  afloatMcpConformanceEnvelope,
  afloatMcpConformanceInvoicePage,
  afloatMcpConformanceReadResult,
  afloatMcpConformanceRecordedAt,
  afloatMcpConformanceSyntheticRequestId,
  afloatMcpConformanceToolErrorResult,
  afloatMcpConformanceUnauthorizedAnswer,
  afloatMcpConformanceUnknownTool,
  type AfloatMcpCallAnswer
} from './wire.ts'
