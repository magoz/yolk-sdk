import { Effect } from 'effect'
import * as Schema from 'effect/Schema'
import { defineAction } from '../action.ts'
import { defineConnector } from '../connector.ts'
import { CredentialSlot, resolveCredential } from '../credential.ts'
import { ConnectorError } from '../error.ts'
import { ActionResult } from '../result.ts'
import type { ConnectorIntegration } from '../integration.ts'

export const figmaConnectorId = 'figma'
export const figmaOAuthSlotId = 'figma.oauth'
export const figmaMcpServerUrl = 'https://mcp.figma.com/mcp'
export const figmaOAuthRegisterUrl = 'https://api.figma.com/v1/oauth/mcp/register'
export const figmaOAuthAuthorizeUrl = 'https://www.figma.com/oauth/mcp'
export const figmaOAuthTokenUrl = 'https://api.figma.com/v1/oauth/token'
export const figmaMcpScope = 'mcp:connect'

export const FigmaOAuthCredentialSlot = CredentialSlot.make({
  id: figmaOAuthSlotId,
  kind: 'oauth',
  requiredScopes: [figmaMcpScope]
})

const resolveFigmaAccessToken = (integration: ConnectorIntegration) =>
  Effect.gen(function* () {
    const credential = yield* resolveCredential(integration, FigmaOAuthCredentialSlot)

    switch (credential._tag) {
      case 'OAuthCredential':
        return {
          accessToken: credential.accessToken,
          expiresAt: credential.expiresAt,
          refreshToken: credential.refreshToken,
          clientId: credential.clientId,
          clientSecret: credential.clientSecret
        }
      case 'BearerTokenCredential':
        return {
          accessToken: credential.token,
          expiresAt: credential.expiresAt
        }
      case 'ApiKeyCredential':
        return yield* Effect.fail(
          new ConnectorError({
            cause: 'credential_invalid',
            message: 'Figma connector requires an OAuth or bearer token credential',
            connectorId: integration.connectorId,
            slotId: FigmaOAuthCredentialSlot.id
          })
        )
    }
  })

export class FigmaMcpAuthInput extends Schema.Class<FigmaMcpAuthInput>('FigmaMcpAuthInput')({}) {}

export class FigmaMcpTokens extends Schema.Class<FigmaMcpTokens>('FigmaMcpTokens')({
  accessToken: Schema.String,
  refreshToken: Schema.optional(Schema.String),
  expiresAt: Schema.optional(Schema.Number)
}) {}

export class FigmaMcpClientInfo extends Schema.Class<FigmaMcpClientInfo>('FigmaMcpClientInfo')({
  clientId: Schema.optional(Schema.String),
  clientSecret: Schema.optional(Schema.String)
}) {}

export class FigmaMcpAuthOutput extends Schema.Class<FigmaMcpAuthOutput>('FigmaMcpAuthOutput')({
  provider: Schema.Literal('figma'),
  serverUrl: Schema.String,
  tokens: FigmaMcpTokens,
  clientInfo: FigmaMcpClientInfo
}) {}

export const makeFigmaMcpAuthData = (input: {
  readonly accessToken: string
  readonly refreshToken?: string
  readonly expiresAt?: number
  readonly clientId?: string
  readonly clientSecret?: string
}) =>
  FigmaMcpAuthOutput.make({
    provider: 'figma',
    serverUrl: figmaMcpServerUrl,
    tokens: FigmaMcpTokens.make({
      accessToken: input.accessToken,
      refreshToken: input.refreshToken,
      expiresAt: input.expiresAt
    }),
    clientInfo: FigmaMcpClientInfo.make({
      clientId: input.clientId,
      clientSecret: input.clientSecret
    })
  })

export const figmaMcpAuthAction = defineAction({
  id: 'figma.mcp_auth',
  description: 'Build Figma remote MCP auth data from host-provided OAuth credentials.',
  inputSchema: FigmaMcpAuthInput,
  outputSchema: FigmaMcpAuthOutput,
  execute: ({ integration }) =>
    Effect.gen(function* () {
      const token = yield* resolveFigmaAccessToken(integration)
      return ActionResult.success(
        makeFigmaMcpAuthData({
          accessToken: token.accessToken,
          refreshToken: token.refreshToken,
          expiresAt: token.expiresAt,
          clientId: token.clientId,
          clientSecret: token.clientSecret
        })
      )
    })
})

export const figmaActions = [figmaMcpAuthAction]

export const FigmaConnector = defineConnector({
  id: figmaConnectorId,
  description: 'Figma remote MCP connector actions.',
  actions: figmaActions
})
