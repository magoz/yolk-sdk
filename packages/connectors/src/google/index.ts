export {
  googleCalendarActions,
  googleCalendarApiBaseUrl,
  googleCalendarCreateEventAction,
  googleCalendarListEventsAction,
  GoogleCalendarCreateEventInput,
  GoogleCalendarEvent,
  GoogleCalendarEventDateTime,
  GoogleCalendarListEventsInput,
  GoogleCalendarListEventsOutput
} from './calendar.ts'
export {
  gmailActions,
  gmailGetMessageAction,
  GmailGetMessageInput,
  gmailSearchAction,
  GmailMessageOutput,
  GmailMessageRef,
  GmailSearchInput,
  GmailSearchOutput,
  googleGmailApiBaseUrl
} from './gmail.ts'
export {
  GoogleOAuthCredentialSlot,
  googleAuthorizationHeaders,
  googleCalendarEventsScope,
  googleCalendarReadonlyScope,
  googleConnectorId,
  googleGmailReadonlyScope,
  googleGmailSendScope,
  googleOAuthAuthorizeUrl,
  googleOAuthSlotId,
  googleOAuthTokenUrl
} from './oauth.ts'
export { resolveGoogleAccessToken } from './shared.ts'

import { defineConnector } from '../connector.ts'
import { googleCalendarActions } from './calendar.ts'
import { gmailActions } from './gmail.ts'
import { googleConnectorId } from './oauth.ts'

export const GoogleConnector = defineConnector({
  id: googleConnectorId,
  description: 'Google Gmail and Calendar connector actions.',
  actions: [...gmailActions, ...googleCalendarActions]
})
