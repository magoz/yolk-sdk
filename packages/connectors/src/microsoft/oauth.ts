import { CredentialSlot } from '../credential.ts'

export const microsoftConnectorId = 'microsoft'
export const microsoftOAuthSlotId = 'microsoft.oauth'
export const microsoftIdentityAuthorityUrl = 'https://login.microsoftonline.com'
export const microsoftOAuthTenant = 'common'
export const microsoftOAuthAuthorizeUrl = `${microsoftIdentityAuthorityUrl}/${microsoftOAuthTenant}/oauth2/v2.0/authorize`
export const microsoftOAuthTokenUrl = `${microsoftIdentityAuthorityUrl}/${microsoftOAuthTenant}/oauth2/v2.0/token`

export const microsoftGraphMailReadScope = 'https://graph.microsoft.com/Mail.Read'
export const microsoftGraphMailReadWriteScope = 'https://graph.microsoft.com/Mail.ReadWrite'
export const microsoftGraphMailSendScope = 'https://graph.microsoft.com/Mail.Send'
export const microsoftGraphMailReadSharedScope = 'https://graph.microsoft.com/Mail.Read.Shared'
export const microsoftGraphMailReadWriteSharedScope =
  'https://graph.microsoft.com/Mail.ReadWrite.Shared'
export const microsoftGraphMailSendSharedScope = 'https://graph.microsoft.com/Mail.Send.Shared'

export const microsoftOutlookReadScopes = Object.freeze([microsoftGraphMailReadScope])
export const microsoftOutlookWriteScopes = Object.freeze([microsoftGraphMailReadWriteScope])
export const microsoftOutlookSendScopes = Object.freeze([microsoftGraphMailSendScope])
export const microsoftOutlookSharedReadScopes = Object.freeze([microsoftGraphMailReadSharedScope])
export const microsoftOutlookSharedWriteScopes = Object.freeze([
  microsoftGraphMailReadWriteSharedScope
])
export const microsoftOutlookSharedSendScopes = Object.freeze([microsoftGraphMailSendSharedScope])

export const MicrosoftOAuthCredentialSlot = CredentialSlot.make({
  id: microsoftOAuthSlotId,
  kind: 'oauth'
})

export const MicrosoftOutlookReadOAuthCredentialSlot = CredentialSlot.make({
  id: microsoftOAuthSlotId,
  kind: 'oauth',
  requiredScopes: [...microsoftOutlookReadScopes]
})

export const MicrosoftOutlookWriteOAuthCredentialSlot = CredentialSlot.make({
  id: microsoftOAuthSlotId,
  kind: 'oauth',
  requiredScopes: [...microsoftOutlookWriteScopes]
})

export const MicrosoftOutlookSendOAuthCredentialSlot = CredentialSlot.make({
  id: microsoftOAuthSlotId,
  kind: 'oauth',
  requiredScopes: [...microsoftOutlookSendScopes]
})

export const MicrosoftOutlookSharedReadOAuthCredentialSlot = CredentialSlot.make({
  id: microsoftOAuthSlotId,
  kind: 'oauth',
  requiredScopes: [...microsoftOutlookSharedReadScopes]
})

export const MicrosoftOutlookSharedWriteOAuthCredentialSlot = CredentialSlot.make({
  id: microsoftOAuthSlotId,
  kind: 'oauth',
  requiredScopes: [...microsoftOutlookSharedWriteScopes]
})

export const MicrosoftOutlookSharedSendOAuthCredentialSlot = CredentialSlot.make({
  id: microsoftOAuthSlotId,
  kind: 'oauth',
  requiredScopes: [...microsoftOutlookSharedSendScopes]
})

export const MicrosoftCombinedOAuthCredentialSlot = CredentialSlot.make({
  id: microsoftOAuthSlotId,
  kind: 'oauth',
  requiredScopes: [
    microsoftGraphMailReadScope,
    microsoftGraphMailReadWriteScope,
    microsoftGraphMailSendScope,
    microsoftGraphMailReadSharedScope,
    microsoftGraphMailReadWriteSharedScope,
    microsoftGraphMailSendSharedScope
  ]
})

export const microsoftAuthorizationHeaders = (accessToken: string) => ({
  authorization: `Bearer ${accessToken}`
})
