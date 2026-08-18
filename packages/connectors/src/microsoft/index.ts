export {
  microsoftGraphApiBaseUrl,
  MicrosoftMailboxAccessMode,
  microsoftMailboxAccessModeConfigKey,
  OutlookComposeInput,
  outlookCreateDraftAction,
  OutlookCreateReplyDraftInput,
  outlookCreateReplyDraftAction,
  OutlookEmailAddress,
  outlookGetMessageAction,
  OutlookListMessagesInput,
  OutlookListMessagesOutput,
  outlookListMessagesAction,
  outlookMailActions,
  OutlookMessage,
  OutlookMessageBody,
  OutlookMessageIdInput,
  OutlookRecipient,
  OutlookSearchMessagesInput,
  outlookSearchMessagesAction,
  OutlookSendMailInput,
  outlookSendDraftAction,
  outlookSendMailAction,
  OutlookSendOutput
} from './mail.ts'
export {
  MicrosoftCombinedOAuthCredentialSlot,
  MicrosoftOAuthCredentialSlot,
  MicrosoftOutlookReadOAuthCredentialSlot,
  MicrosoftOutlookSendOAuthCredentialSlot,
  MicrosoftOutlookSharedReadOAuthCredentialSlot,
  MicrosoftOutlookSharedSendOAuthCredentialSlot,
  MicrosoftOutlookSharedWriteOAuthCredentialSlot,
  MicrosoftOutlookWriteOAuthCredentialSlot,
  microsoftAuthorizationHeaders,
  microsoftConnectorId,
  microsoftGraphMailReadScope,
  microsoftGraphMailReadSharedScope,
  microsoftGraphMailReadWriteScope,
  microsoftGraphMailReadWriteSharedScope,
  microsoftGraphMailSendScope,
  microsoftGraphMailSendSharedScope,
  microsoftIdentityAuthorityUrl,
  microsoftOAuthAuthorizeUrl,
  microsoftOAuthSlotId,
  microsoftOAuthTenant,
  microsoftOAuthTokenUrl,
  microsoftOutlookReadScopes,
  microsoftOutlookSendScopes,
  microsoftOutlookSharedReadScopes,
  microsoftOutlookSharedSendScopes,
  microsoftOutlookSharedWriteScopes,
  microsoftOutlookWriteScopes
} from './oauth.ts'
export { resolveMicrosoftAccessToken } from './shared.ts'

import { defineConnector } from '../connector.ts'
import { outlookMailActions } from './mail.ts'
import { microsoftConnectorId } from './oauth.ts'

export const MicrosoftConnector = defineConnector({
  id: microsoftConnectorId,
  description: 'Microsoft Outlook mail actions through Microsoft Graph.',
  actions: outlookMailActions
})
