import { CredentialSlot } from '../credential.ts'

export const googleConnectorId = 'google'
export const googleOAuthSlotId = 'google.oauth'
export const googleOAuthAuthorizeUrl = 'https://accounts.google.com/o/oauth2/v2/auth'
export const googleOAuthTokenUrl = 'https://oauth2.googleapis.com/token'

export const googleGmailReadonlyScope = 'https://www.googleapis.com/auth/gmail.readonly'
export const googleGmailSendScope = 'https://www.googleapis.com/auth/gmail.send'
export const googleGmailComposeScope = 'https://www.googleapis.com/auth/gmail.compose'
export const googleGmailModifyScope = 'https://www.googleapis.com/auth/gmail.modify'
export const googleGmailSettingsBasicScope = 'https://www.googleapis.com/auth/gmail.settings.basic'
export const googleCalendarReadonlyScope = 'https://www.googleapis.com/auth/calendar.readonly'
export const googleCalendarEventsScope = 'https://www.googleapis.com/auth/calendar.events'
export const googleDriveMetadataReadonlyScope =
  'https://www.googleapis.com/auth/drive.metadata.readonly'
export const googleDriveFileScope = 'https://www.googleapis.com/auth/drive.file'

export const googleGmailReadonlyScopes = Object.freeze([googleGmailReadonlyScope])
export const googleGmailComposeScopes = Object.freeze([
  googleGmailComposeScope,
  googleGmailSettingsBasicScope
])
export const googleGmailDraftReplyScopes = Object.freeze([
  googleGmailReadonlyScope,
  googleGmailComposeScope,
  googleGmailSettingsBasicScope
])
export const googleGmailModifyScopes = Object.freeze([googleGmailModifyScope])
export const googleGmailSettingsScopes = Object.freeze([googleGmailSettingsBasicScope])
export const googleCalendarReadonlyScopes = Object.freeze([googleCalendarReadonlyScope])
export const googleCalendarEventsScopes = Object.freeze([googleCalendarEventsScope])
export const googleDriveMetadataReadonlyScopes = Object.freeze([googleDriveMetadataReadonlyScope])
export const googleDriveFileScopes = Object.freeze([googleDriveFileScope])

export const GoogleOAuthCredentialSlot = CredentialSlot.make({
  id: googleOAuthSlotId,
  kind: 'oauth'
})

export const GoogleGmailReadonlyOAuthCredentialSlot = CredentialSlot.make({
  id: googleOAuthSlotId,
  kind: 'oauth',
  requiredScopes: [...googleGmailReadonlyScopes]
})

export const GoogleGmailComposeOAuthCredentialSlot = CredentialSlot.make({
  id: googleOAuthSlotId,
  kind: 'oauth',
  requiredScopes: [...googleGmailComposeScopes]
})

export const GoogleGmailDraftReplyOAuthCredentialSlot = CredentialSlot.make({
  id: googleOAuthSlotId,
  kind: 'oauth',
  requiredScopes: [...googleGmailDraftReplyScopes]
})

export const GoogleGmailModifyOAuthCredentialSlot = CredentialSlot.make({
  id: googleOAuthSlotId,
  kind: 'oauth',
  requiredScopes: [...googleGmailModifyScopes]
})

export const GoogleGmailSettingsOAuthCredentialSlot = CredentialSlot.make({
  id: googleOAuthSlotId,
  kind: 'oauth',
  requiredScopes: [...googleGmailSettingsScopes]
})

export const GoogleCalendarReadonlyOAuthCredentialSlot = CredentialSlot.make({
  id: googleOAuthSlotId,
  kind: 'oauth',
  requiredScopes: [...googleCalendarReadonlyScopes]
})

export const GoogleCalendarEventsOAuthCredentialSlot = CredentialSlot.make({
  id: googleOAuthSlotId,
  kind: 'oauth',
  requiredScopes: [...googleCalendarEventsScopes]
})

export const GoogleDriveMetadataReadonlyOAuthCredentialSlot = CredentialSlot.make({
  id: googleOAuthSlotId,
  kind: 'oauth',
  requiredScopes: [...googleDriveMetadataReadonlyScopes]
})

export const GoogleDriveFileOAuthCredentialSlot = CredentialSlot.make({
  id: googleOAuthSlotId,
  kind: 'oauth',
  requiredScopes: [...googleDriveFileScopes]
})

export const GoogleCombinedOAuthCredentialSlot = CredentialSlot.make({
  id: googleOAuthSlotId,
  kind: 'oauth',
  requiredScopes: [
    googleGmailReadonlyScope,
    googleGmailComposeScope,
    googleGmailModifyScope,
    googleGmailSettingsBasicScope,
    googleCalendarReadonlyScope,
    googleCalendarEventsScope,
    googleDriveMetadataReadonlyScope,
    googleDriveFileScope
  ]
})

export const googleAuthorizationHeaders = (accessToken: string) => ({
  authorization: `Bearer ${accessToken}`
})
