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

export const microsoftGraphMailboxSettingsReadScope =
  'https://graph.microsoft.com/MailboxSettings.Read'

export const microsoftGraphMailboxSettingsReadWriteScope =
  'https://graph.microsoft.com/MailboxSettings.ReadWrite'

export const microsoftGraphFilesReadScope = 'https://graph.microsoft.com/Files.Read'

export const microsoftGraphFilesReadAllScope = 'https://graph.microsoft.com/Files.Read.All'

export const microsoftGraphFilesReadWriteScope = 'https://graph.microsoft.com/Files.ReadWrite'

export const microsoftGraphFilesReadWriteAllScope =
  'https://graph.microsoft.com/Files.ReadWrite.All'

export const microsoftGraphSitesReadAllScope = 'https://graph.microsoft.com/Sites.Read.All'

export const microsoftGraphChatReadScope = 'https://graph.microsoft.com/Chat.Read'

export const microsoftGraphChatMessageSendScope = 'https://graph.microsoft.com/ChatMessage.Send'

export const microsoftGraphTeamReadBasicAllScope = 'https://graph.microsoft.com/Team.ReadBasic.All'

export const microsoftGraphChannelReadBasicAllScope =
  'https://graph.microsoft.com/Channel.ReadBasic.All'

export const microsoftGraphChannelMessageReadAllScope =
  'https://graph.microsoft.com/ChannelMessage.Read.All'

export const microsoftGraphChannelMessageSendScope =
  'https://graph.microsoft.com/ChannelMessage.Send'

export const microsoftGraphOnlineMeetingsReadScope =
  'https://graph.microsoft.com/OnlineMeetings.Read'

export const microsoftGraphOnlineMeetingTranscriptReadAllScope =
  'https://graph.microsoft.com/OnlineMeetingTranscript.Read.All'

export const microsoftOutlookReadScopes = Object.freeze([microsoftGraphMailReadScope])

export const microsoftOutlookWriteScopes = Object.freeze([microsoftGraphMailReadWriteScope])

export const microsoftOutlookSendScopes = Object.freeze([microsoftGraphMailSendScope])

export const microsoftOutlookSharedReadScopes = Object.freeze([microsoftGraphMailReadSharedScope])

export const microsoftOutlookSharedWriteScopes = Object.freeze([
  microsoftGraphMailReadWriteSharedScope
])

export const microsoftOutlookSharedSendScopes = Object.freeze([microsoftGraphMailSendSharedScope])

export const microsoftOutlookCategoryReadScopes = Object.freeze([
  microsoftGraphMailboxSettingsReadScope
])

export const microsoftOutlookCategoryWriteScopes = Object.freeze([
  microsoftGraphMailboxSettingsReadWriteScope
])

export const microsoftOneDriveReadScopes = Object.freeze([microsoftGraphFilesReadScope])

export const microsoftOneDriveReadAllScopes = Object.freeze([microsoftGraphFilesReadAllScope])

export const microsoftOneDriveWriteScopes = Object.freeze([microsoftGraphFilesReadWriteScope])

export const microsoftOneDriveWriteAllScopes = Object.freeze([microsoftGraphFilesReadWriteAllScope])

export const microsoftSharePointSitesReadScopes = Object.freeze([microsoftGraphSitesReadAllScope])

export const microsoftTeamsChatReadScopes = Object.freeze([microsoftGraphChatReadScope])

export const microsoftTeamsChatSendScopes = Object.freeze([microsoftGraphChatMessageSendScope])

export const microsoftTeamsTeamReadScopes = Object.freeze([microsoftGraphTeamReadBasicAllScope])

export const microsoftTeamsChannelReadScopes = Object.freeze([
  microsoftGraphChannelReadBasicAllScope
])

export const microsoftTeamsChannelMessageReadScopes = Object.freeze([
  microsoftGraphChannelMessageReadAllScope
])

export const microsoftTeamsChannelMessageSendScopes = Object.freeze([
  microsoftGraphChannelMessageSendScope
])

export const microsoftTeamsMeetingReadScopes = Object.freeze([
  microsoftGraphOnlineMeetingsReadScope
])

export const microsoftTeamsTranscriptReadScopes = Object.freeze([
  microsoftGraphOnlineMeetingTranscriptReadAllScope
])

/** Every delegated Teams scope the Teams actions and the transcript download use. */
export const microsoftTeamsScopes = Object.freeze([
  ...microsoftTeamsChatReadScopes,
  ...microsoftTeamsChatSendScopes,
  ...microsoftTeamsTeamReadScopes,
  ...microsoftTeamsChannelReadScopes,
  ...microsoftTeamsChannelMessageReadScopes,
  ...microsoftTeamsChannelMessageSendScopes,
  ...microsoftTeamsMeetingReadScopes,
  ...microsoftTeamsTranscriptReadScopes
])

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

// Master-category lifecycle consent is opt-in: listing needs MailboxSettings.Read
// while create/delete need MailboxSettings.ReadWrite (delegated, personal, and
// application alike). There are no `.Shared` mailbox-settings scopes, and the
// existing combined slot is intentionally not widened with these permissions.
export const MicrosoftOutlookCategoryReadOAuthCredentialSlot = CredentialSlot.make({
  id: microsoftOAuthSlotId,
  kind: 'oauth',
  requiredScopes: [...microsoftOutlookCategoryReadScopes]
})

export const MicrosoftOutlookCategoryWriteOAuthCredentialSlot = CredentialSlot.make({
  id: microsoftOAuthSlotId,
  kind: 'oauth',
  requiredScopes: [...microsoftOutlookCategoryWriteScopes]
})

export const MicrosoftOneDriveReadOAuthCredentialSlot = CredentialSlot.make({
  id: microsoftOAuthSlotId,
  kind: 'oauth',
  requiredScopes: [...microsoftOneDriveReadScopes]
})

export const MicrosoftOneDriveReadAllOAuthCredentialSlot = CredentialSlot.make({
  id: microsoftOAuthSlotId,
  kind: 'oauth',
  requiredScopes: [...microsoftOneDriveReadAllScopes]
})

export const MicrosoftOneDriveWriteOAuthCredentialSlot = CredentialSlot.make({
  id: microsoftOAuthSlotId,
  kind: 'oauth',
  requiredScopes: [...microsoftOneDriveWriteScopes]
})

export const MicrosoftOneDriveWriteAllOAuthCredentialSlot = CredentialSlot.make({
  id: microsoftOAuthSlotId,
  kind: 'oauth',
  requiredScopes: [...microsoftOneDriveWriteAllScopes]
})

// Site discovery is opt-in: Sites.Read.All (delegated and application alike) is the least
// privileged permission for site search, and the combined slot is intentionally not widened.
export const MicrosoftSharePointSitesReadOAuthCredentialSlot = CredentialSlot.make({
  id: microsoftOAuthSlotId,
  kind: 'oauth',
  requiredScopes: [...microsoftSharePointSitesReadScopes]
})

// Teams consent is opt-in, one slot per least-privileged delegated permission, and the combined
// slot is intentionally not widened. ChannelMessage.Read.All and OnlineMeetingTranscript.Read.All
// need tenant admin consent even as delegated permissions.
export const MicrosoftTeamsChatReadOAuthCredentialSlot = CredentialSlot.make({
  id: microsoftOAuthSlotId,
  kind: 'oauth',
  requiredScopes: [...microsoftTeamsChatReadScopes]
})

export const MicrosoftTeamsChatSendOAuthCredentialSlot = CredentialSlot.make({
  id: microsoftOAuthSlotId,
  kind: 'oauth',
  requiredScopes: [...microsoftTeamsChatSendScopes]
})

export const MicrosoftTeamsTeamReadOAuthCredentialSlot = CredentialSlot.make({
  id: microsoftOAuthSlotId,
  kind: 'oauth',
  requiredScopes: [...microsoftTeamsTeamReadScopes]
})

export const MicrosoftTeamsChannelReadOAuthCredentialSlot = CredentialSlot.make({
  id: microsoftOAuthSlotId,
  kind: 'oauth',
  requiredScopes: [...microsoftTeamsChannelReadScopes]
})

export const MicrosoftTeamsChannelMessageReadOAuthCredentialSlot = CredentialSlot.make({
  id: microsoftOAuthSlotId,
  kind: 'oauth',
  requiredScopes: [...microsoftTeamsChannelMessageReadScopes]
})

export const MicrosoftTeamsChannelMessageSendOAuthCredentialSlot = CredentialSlot.make({
  id: microsoftOAuthSlotId,
  kind: 'oauth',
  requiredScopes: [...microsoftTeamsChannelMessageSendScopes]
})

export const MicrosoftTeamsMeetingReadOAuthCredentialSlot = CredentialSlot.make({
  id: microsoftOAuthSlotId,
  kind: 'oauth',
  requiredScopes: [...microsoftTeamsMeetingReadScopes]
})

export const MicrosoftTeamsTranscriptReadOAuthCredentialSlot = CredentialSlot.make({
  id: microsoftOAuthSlotId,
  kind: 'oauth',
  requiredScopes: [...microsoftTeamsTranscriptReadScopes]
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
    microsoftGraphMailSendSharedScope,
    microsoftGraphFilesReadScope,
    microsoftGraphFilesReadAllScope,
    microsoftGraphFilesReadWriteScope,
    microsoftGraphFilesReadWriteAllScope
  ]
})

export const microsoftAuthorizationHeaders = (accessToken: string) => ({
  authorization: `Bearer ${accessToken}`
})
