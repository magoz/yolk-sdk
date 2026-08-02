import { Effect } from 'effect'
import * as Schema from 'effect/Schema'
import { defineAction } from '../action.ts'
import { defineConnector } from '../connector.ts'
import { CredentialSlot, resolveCredential } from '../credential.ts'
import { ConnectorError } from '../error.ts'
import { ActionResult } from '../result.ts'
import type { ConnectorIntegration } from '../integration.ts'

export const afloatConnectorId = 'afloat'
export const afloatApiKeySlotId = 'afloat.api_key'
export const afloatMcpServerUrl = 'https://app.useafloat.com/mcp'
export const afloatMcpProtocolVersion = '2026-07-28'

export const AfloatApiKeyCredentialSlot = CredentialSlot.make({
  id: afloatApiKeySlotId,
  kind: 'api_key'
})

const resolveAfloatApiKey = (integration: ConnectorIntegration) =>
  Effect.gen(function* () {
    const credential = yield* resolveCredential(integration, AfloatApiKeyCredentialSlot)

    if (credential._tag !== 'ApiKeyCredential') {
      return yield* Effect.fail(
        new ConnectorError({
          cause: 'credential_invalid',
          message: 'Afloat connector requires an API key credential',
          connectorId: integration.connectorId,
          slotId: AfloatApiKeyCredentialSlot.id
        })
      )
    }

    if (!credential.key.startsWith('afloat_')) {
      return yield* Effect.fail(
        new ConnectorError({
          cause: 'credential_invalid',
          message: 'Afloat API keys must start with afloat_',
          connectorId: integration.connectorId,
          slotId: AfloatApiKeyCredentialSlot.id
        })
      )
    }

    return credential.key
  })

export class AfloatMcpAuthInput extends Schema.Class<AfloatMcpAuthInput>('AfloatMcpAuthInput')(
  {}
) {}

export class AfloatMcpAuthOutput extends Schema.Class<AfloatMcpAuthOutput>('AfloatMcpAuthOutput')({
  provider: Schema.Literal('afloat'),
  serverUrl: Schema.String,
  protocolVersion: Schema.Literal('2026-07-28'),
  apiKey: Schema.String
}) {}

export const makeAfloatMcpAuthData = (apiKey: string) =>
  AfloatMcpAuthOutput.make({
    provider: 'afloat',
    serverUrl: afloatMcpServerUrl,
    protocolVersion: afloatMcpProtocolVersion,
    apiKey
  })

export const afloatMcpAuthAction = defineAction({
  id: 'afloat.mcp_auth',
  description: 'Build Afloat remote MCP auth data from a host-provided API key.',
  inputSchema: AfloatMcpAuthInput,
  outputSchema: AfloatMcpAuthOutput,
  execute: ({ integration }) =>
    Effect.gen(function* () {
      const apiKey = yield* resolveAfloatApiKey(integration)
      return ActionResult.success(makeAfloatMcpAuthData(apiKey))
    })
})

export const afloatActions = [afloatMcpAuthAction]

export const AfloatConnector = defineConnector({
  id: afloatConnectorId,
  description: 'Afloat remote MCP connector actions.',
  actions: afloatActions
})
