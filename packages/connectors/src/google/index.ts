export {
  googleCalendarActions,
  googleCalendarApiBaseUrl,
  googleCalendarCreateEventAction,
  googleCalendarDeleteEventAction,
  googleCalendarGetEventAction,
  googleCalendarListAccountsAction,
  googleCalendarListCalendarsAction,
  googleCalendarListEventsAction,
  googleCalendarUpdateEventAction,
  GoogleCalendarCreateEventInput,
  GoogleCalendarEvent,
  GoogleCalendarEventDateTime,
  GoogleCalendarEventIdInput,
  GoogleCalendarListCalendarsInput,
  GoogleCalendarListCalendarsOutput,
  GoogleCalendarListEventsInput,
  GoogleCalendarListEventsOutput,
  GoogleCalendarRef,
  GoogleCalendarUpdateEventInput
} from './calendar.ts'
export {
  gmailActions,
  gmailDraftComposeAction,
  GmailDraftComposeInput,
  gmailDraftDeleteAction,
  GmailDraftIdInput,
  gmailDraftReplyAction,
  GmailDraftReplyInput,
  gmailDraftUpdateAction,
  GmailDraftUpdateInput,
  gmailGetAttachmentAction,
  GmailGetAttachmentInput,
  gmailGetMessageAction,
  GmailGetMessageInput,
  gmailGetThreadAction,
  GmailListInput,
  gmailListAccountsAction,
  gmailListAction,
  gmailListDraftsAction,
  gmailListLabelsAction,
  gmailListSendAsAction,
  GmailListSendAsOutput,
  GmailMessageIdInput,
  gmailSearchAction,
  gmailModifyLabelsAction,
  GmailModifyLabelsInput,
  GmailMessageOutput,
  GmailMessageRef,
  GmailSearchInput,
  GmailSearchOutput,
  GmailSendAs,
  gmailTrashAction,
  gmailUntrashAction,
  googleGmailApiBaseUrl
} from './gmail.ts'
export {
  GoogleCalendarEventsOAuthCredentialSlot,
  googleCalendarEventsScopes,
  GoogleOAuthCredentialSlot,
  GoogleCalendarReadonlyOAuthCredentialSlot,
  googleCalendarReadonlyScopes,
  GoogleCombinedOAuthCredentialSlot,
  googleAuthorizationHeaders,
  googleCalendarEventsScope,
  googleCalendarReadonlyScope,
  googleConnectorId,
  GoogleGmailComposeOAuthCredentialSlot,
  googleGmailComposeScope,
  googleGmailComposeScopes,
  GoogleGmailDraftReplyOAuthCredentialSlot,
  googleGmailDraftReplyScopes,
  GoogleGmailModifyOAuthCredentialSlot,
  googleGmailModifyScope,
  googleGmailModifyScopes,
  GoogleGmailReadonlyOAuthCredentialSlot,
  googleGmailReadonlyScope,
  googleGmailReadonlyScopes,
  googleGmailSendScope,
  GoogleGmailSettingsOAuthCredentialSlot,
  googleGmailSettingsBasicScope,
  googleGmailSettingsScopes,
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
