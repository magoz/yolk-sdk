/**
 * The Figma MCP conformance target: built from the output of the REAL `figma.mcp_auth` action,
 * never from hand-written connection data.
 *
 * Its shape is the `McpConformanceTargetSettings` of `@yolk-sdk/mcp/conformance` (this package
 * never imports `@yolk-sdk/mcp`; hosts pass the value to `McpConformanceTarget`).
 *
 * @experimental
 */
import { Data, Effect, Predicate } from 'effect'
import * as Schema from 'effect/Schema'
import { makeCredentialBinding } from '../../credential.ts'
import { makeIntegration } from '../../integration.ts'
import {
  figmaConnectorId,
  figmaMcpAuthAction,
  FigmaMcpAuthOutput,
  figmaOAuthSlotId
} from '../index.ts'
import { figmaMcpConformanceProtocolVersion } from './wire.ts'

/** The credential ref the conformance integration binds the Figma OAuth slot to. */
export const figmaMcpConformanceCredentialRef = 'figma.conformance'

/** The integration the conformance target runs `figma.mcp_auth` with. */
export const figmaMcpConformanceIntegration = makeIntegration({
  connectorId: figmaConnectorId,
  credentialBindings: [
    makeCredentialBinding({
      slotId: figmaOAuthSlotId,
      credentialRef: figmaMcpConformanceCredentialRef
    })
  ]
})

/**
 * The reserved invalid credential of the auth case (`mcp.auth.rejected`): the public MCP
 * conformance value, never valid anywhere, and never recorded (fixtures drop `authorization`).
 */
export const figmaMcpConformanceInvalidCredential = 'yolk-conformance-invalid-credential-0000'

/** The request headers for a Figma access token: `Authorization: Bearer <token>`. */
export const figmaMcpConformanceRequestHeaders = (accessToken: string) => ({
  authorization: `Bearer ${accessToken}`
})

/** The structural `McpConformanceTargetSettings` of a Figma target (the legacy era). */
export type FigmaMcpConformanceTargetSettings = {
  readonly name: string
  readonly url: string
  readonly headers: Readonly<Record<string, string>>
  readonly era: 'legacy'
  readonly protocolVersion: string
  readonly timeoutMs: number
  readonly invalidCredentialHeaders: Readonly<Record<string, string>>
}

/** The default request timeout of a Figma target, in milliseconds. */
export const figmaMcpConformanceTimeoutMs = 30_000

/**
 * The target for the output of `figma.mcp_auth`: server `figma`, the action's `serverUrl`, the
 * access token as `Authorization: Bearer`, the legacy era with protocol `2025-11-25` (unverified:
 * which era and version the Figma server negotiates; `figma.mcp_auth` names neither), and the
 * reserved invalid credential in the same header for the auth case. The refresh token and client
 * credentials of the output are never sent.
 */
export const figmaMcpConformanceTarget = (
  output: FigmaMcpAuthOutput,
  options: { readonly timeoutMs?: number } = {}
): FigmaMcpConformanceTargetSettings => ({
  name: figmaConnectorId,
  url: output.serverUrl,
  headers: figmaMcpConformanceRequestHeaders(output.tokens.accessToken),
  era: 'legacy',
  protocolVersion: figmaMcpConformanceProtocolVersion,
  timeoutMs: options.timeoutMs ?? figmaMcpConformanceTimeoutMs,
  invalidCredentialHeaders: figmaMcpConformanceRequestHeaders(figmaMcpConformanceInvalidCredential)
})

/**
 * `figma.mcp_auth` answered a provider failure (its `code`), or an output that does not decode as
 * `FigmaMcpAuthOutput` (`invalid_output`), where the target needed its output.
 */
export class FigmaMcpConformanceAuthFailed extends Data.TaggedError(
  'FigmaMcpConformanceAuthFailed'
)<{
  readonly code: string
}> {
  override get message(): string {
    return `figma.mcp_auth failed (${this.code})`
  }
}

/**
 * Run the real `figma.mcp_auth` action over the host's `CredentialResolver` (for example
 * `staticCredentialResolverLayer` of `@yolk-sdk/connectors/conformance` over an `OAuthCredential`
 * or `BearerTokenCredential`) and build the target from its output. Fails with the action's
 * `ConnectorError` for a missing credential or one that is neither OAuth nor bearer.
 */
export const makeFigmaMcpConformanceTarget = (options: { readonly timeoutMs?: number } = {}) =>
  Effect.gen(function* () {
    const result = yield* figmaMcpAuthAction.execute({
      integration: figmaMcpConformanceIntegration,
      input: {}
    })

    if (Predicate.isTagged(result, 'Failure')) {
      return yield* new FigmaMcpConformanceAuthFailed({ code: result.error.code })
    }

    // The dynamic `execute` answers an undecoded value: decode it before trusting it.
    const output = yield* Schema.decodeUnknownEffect(FigmaMcpAuthOutput)(result.value).pipe(
      Effect.mapError(() => new FigmaMcpConformanceAuthFailed({ code: 'invalid_output' }))
    )

    return figmaMcpConformanceTarget(output, options)
  })
