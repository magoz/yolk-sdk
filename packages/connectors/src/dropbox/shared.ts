import { Effect, Match } from 'effect'
import { CredentialSlot, resolveCredential } from '../credential.ts'
import type { CredentialSlot as CredentialSlotType } from '../credential.ts'
import { ConnectorError } from '../error.ts'
import type { ConnectorIntegration } from '../integration.ts'

export const dropboxConnectorId = 'dropbox'

export const dropboxOAuthSlotId = 'dropbox.oauth'

export const dropboxOAuthAuthorizeUrl = 'https://www.dropbox.com/oauth2/authorize'

export const dropboxOAuthTokenUrl = 'https://api.dropboxapi.com/oauth2/token'

export const dropboxApiBaseUrl = 'https://api.dropboxapi.com/2'

export const dropboxContentApiBaseUrl = 'https://content.dropboxapi.com/2'

export const dropboxFilesMetadataReadScope = 'files.metadata.read'

export const dropboxFilesContentReadScope = 'files.content.read'

export const dropboxFilesContentWriteScope = 'files.content.write'

export const dropboxMetadataReadScopes = Object.freeze([dropboxFilesMetadataReadScope])

export const dropboxContentReadScopes = Object.freeze([dropboxFilesContentReadScope])

export const dropboxContentWriteScopes = Object.freeze([dropboxFilesContentWriteScope])

export const dropboxCombinedScopes = Object.freeze([
  dropboxFilesMetadataReadScope,
  dropboxFilesContentReadScope,
  dropboxFilesContentWriteScope
])

export const DropboxOAuthCredentialSlot = CredentialSlot.make({
  id: dropboxOAuthSlotId,
  kind: 'oauth'
})

export const DropboxMetadataReadOAuthCredentialSlot = CredentialSlot.make({
  id: dropboxOAuthSlotId,
  kind: 'oauth',
  requiredScopes: [...dropboxMetadataReadScopes]
})

/** Host-only download helper slot; no default connector action requests file content. */
export const DropboxContentReadOAuthCredentialSlot = CredentialSlot.make({
  id: dropboxOAuthSlotId,
  kind: 'oauth',
  requiredScopes: [...dropboxContentReadScopes]
})

export const DropboxContentWriteOAuthCredentialSlot = CredentialSlot.make({
  id: dropboxOAuthSlotId,
  kind: 'oauth',
  requiredScopes: [...dropboxContentWriteScopes]
})

export const DropboxCombinedOAuthCredentialSlot = CredentialSlot.make({
  id: dropboxOAuthSlotId,
  kind: 'oauth',
  requiredScopes: [...dropboxCombinedScopes]
})

export const dropboxAuthorizationHeaders = (accessToken: string) => ({
  authorization: `Bearer ${accessToken}`
})

export const resolveDropboxAccessToken = (
  integration: ConnectorIntegration,
  slot: CredentialSlotType
) =>
  Effect.gen(function* () {
    const credential = yield* resolveCredential(integration, slot)

    const invalidCredential = () =>
      Effect.fail(
        new ConnectorError({
          cause: 'credential_invalid',
          message: 'Dropbox connector requires an OAuth or bearer token credential',
          connectorId: integration.connectorId,
          slotId: slot.id
        })
      )

    return yield* Match.value(credential).pipe(
      Match.tag('OAuthCredential', current => Effect.succeed(current.accessToken)),
      Match.tag('BearerTokenCredential', current => Effect.succeed(current.token)),
      Match.tag('ApiKeyCredential', 'UsernamePasswordCredential', invalidCredential),
      Match.exhaustive
    )
  })
