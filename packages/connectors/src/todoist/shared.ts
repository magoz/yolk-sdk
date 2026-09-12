import { Effect } from 'effect'
import { CredentialSlot, resolveCredential } from '../credential.ts'
import { ConnectorError } from '../error.ts'
import type { ConnectorIntegration } from '../integration.ts'

export const todoistConnectorId = 'todoist'

export const todoistApiTokenSlotId = 'todoist.api_token'

export const todoistApiBaseUrl = 'https://api.todoist.com/api/v1'

export const TodoistApiTokenSlot = CredentialSlot.make({
  id: todoistApiTokenSlotId,
  kind: 'api_key'
})

export const resolveTodoistToken = (integration: ConnectorIntegration) =>
  Effect.gen(function* () {
    const credential = yield* resolveCredential(integration, TodoistApiTokenSlot)

    switch (credential._tag) {
      case 'ApiKeyCredential':
        return credential.key
      case 'BearerTokenCredential':
        return credential.token
      case 'OAuthCredential':
        return credential.accessToken
      case 'UsernamePasswordCredential':
        return yield* Effect.fail(
          new ConnectorError({
            cause: 'credential_invalid',
            message: 'Todoist connector does not accept username/password credentials',
            connectorId: integration.connectorId,
            slotId: TodoistApiTokenSlot.id
          })
        )
    }
  })
