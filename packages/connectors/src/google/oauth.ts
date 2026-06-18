import { CredentialSlot } from '../credential.ts'

export const googleConnectorId = 'google'
export const googleOAuthSlotId = 'google.oauth'
export const googleOAuthAuthorizeUrl = 'https://accounts.google.com/o/oauth2/v2/auth'
export const googleOAuthTokenUrl = 'https://oauth2.googleapis.com/token'

export const googleGmailReadonlyScope = 'https://www.googleapis.com/auth/gmail.readonly'
export const googleGmailSendScope = 'https://www.googleapis.com/auth/gmail.send'
export const googleGmailSettingsBasicScope =
  'https://www.googleapis.com/auth/gmail.settings.basic'
export const googleCalendarReadonlyScope = 'https://www.googleapis.com/auth/calendar.readonly'
export const googleCalendarEventsScope = 'https://www.googleapis.com/auth/calendar.events'

export const GoogleOAuthCredentialSlot = CredentialSlot.make({
  id: googleOAuthSlotId,
  kind: 'oauth',
  requiredScopes: [
    googleGmailReadonlyScope,
    googleGmailSendScope,
    googleGmailSettingsBasicScope,
    googleCalendarReadonlyScope,
    googleCalendarEventsScope
  ]
})

export const googleAuthorizationHeaders = (accessToken: string) => ({
  authorization: `Bearer ${accessToken}`
})
