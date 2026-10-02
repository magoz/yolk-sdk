import { Config } from 'effect'

/**
 * The Gateway credential every Vercel AI Gateway layer reads from the environment: an AI Gateway
 * API key (`AI_GATEWAY_API_KEY`), falling back to a Vercel OIDC token (`VERCEL_OIDC_TOKEN`). Both
 * are sent as Bearer auth. Internal; not a package export.
 */
export const vercelAiGatewayCredentialConfig = Config.Redacted('AI_GATEWAY_API_KEY').pipe(
  Config.orElse(() => Config.Redacted('VERCEL_OIDC_TOKEN'))
)
