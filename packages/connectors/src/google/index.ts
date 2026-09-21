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
  googleDriveActions,
  googleDriveApiBaseUrl,
  googleDriveCreateFolderAction,
  GoogleDriveCapabilities,
  GoogleDriveContentRestriction,
  GoogleDriveCreateFolderInput,
  googleDriveDeleteFileAction,
  GoogleDriveDeleteFileOutput,
  GoogleDriveFile,
  googleDriveFileFields,
  GoogleDriveFileIdInput,
  googleDriveFolderMimeType,
  googleDriveGetFileAction,
  GoogleDriveLinkShareMetadata,
  GoogleDriveListFilesInput,
  GoogleDriveListFilesOutput,
  googleDriveListFilesAction,
  GoogleDriveSearchFilesInput,
  googleDriveSearchFilesAction,
  GoogleDriveShortcutDetails,
  googleDriveTrashFileAction,
  GoogleDriveUser
} from './drive.ts'

export {
  gmailActions,
  gmailBatchModifyLabelsAction,
  GmailBatchModifyLabelsInput,
  gmailBatchSetReadAction,
  GmailBatchSetReadInput,
  gmailBatchSetStarredAction,
  GmailBatchSetStarredInput,
  gmailBatchTrashAction,
  GmailBatchTrashInput,
  gmailBatchUntrashAction,
  GmailBatchUntrashInput,
  gmailCreateLabelAction,
  GmailCreateLabelInput,
  gmailDeleteLabelAction,
  GmailDeleteLabelOutput,
  gmailDraftComposeAction,
  GmailDraftComposeInput,
  gmailDraftDeleteAction,
  GmailDraftIdInput,
  gmailDraftReplyAction,
  GmailDraftReplyInput,
  gmailDraftUpdateAction,
  GmailDraftUpdateInput,
  GmailAttachmentBase64,
  GmailAttachmentBase64Url,
  gmailDeletePermanentlyAction,
  GmailDeletePermanentlyInput,
  gmailGetAttachmentAction,
  GmailGetAttachmentInput,
  GmailGetAttachmentOutput,
  gmailGetMessageAction,
  GmailGetMessageInput,
  gmailSetReadAction,
  GmailSetReadInput,
  gmailGetLabelAction,
  gmailGetThreadAction,
  GmailGetThreadInput,
  GmailLabel,
  GmailLabelIdInput,
  GmailLabelListVisibility,
  GmailLabelMessageListVisibility,
  GmailLabelType,
  GmailListAttachmentsInput,
  GmailListAttachmentsOutput,
  gmailListAttachmentsAction,
  GmailThreadAttachment,
  GmailThreadMessage,
  GmailThreadOutput,
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
  GmailRawMessage,
  GmailSendMessageInput,
  GmailSendMessageOutput,
  gmailSendMessageAction,
  gmailSetStarredAction,
  GmailSetStarredInput,
  gmailTrashAction,
  gmailUntrashAction,
  gmailUpdateLabelAction,
  GmailUpdateLabelInput,
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
  GoogleDriveFileOAuthCredentialSlot,
  googleDriveFileScope,
  googleDriveFileScopes,
  GoogleDriveMetadataReadonlyOAuthCredentialSlot,
  googleDriveMetadataReadonlyScope,
  googleDriveMetadataReadonlyScopes,
  GoogleGmailComposeOAuthCredentialSlot,
  googleGmailComposeScope,
  googleGmailComposeScopes,
  GoogleGmailDraftReplyOAuthCredentialSlot,
  googleGmailDraftReplyScopes,
  GoogleGmailFullMailOAuthCredentialSlot,
  googleGmailFullMailScope,
  googleGmailFullMailScopes,
  GoogleGmailModifyOAuthCredentialSlot,
  googleGmailModifyScope,
  googleGmailModifyScopes,
  GoogleGmailReadonlyOAuthCredentialSlot,
  googleGmailReadonlyScope,
  googleGmailReadonlyScopes,
  googleGmailSendScope,
  googleGmailSendScopes,
  GoogleGmailSendOAuthCredentialSlot,
  GoogleGmailSettingsOAuthCredentialSlot,
  googleGmailSettingsBasicScope,
  googleGmailSettingsScopes,
  googleOAuthAuthorizeUrl,
  googleOAuthSlotId,
  googleOAuthTokenUrl
} from './oauth.ts'

export { resolveGoogleAccessToken } from './shared.ts'

export {
  EmailBatchMessageIds,
  EmailBatchOperationOutput,
  EmailBatchOperationStatus,
  EmailBatchResultCode,
  EmailBatchResultItem,
  EmailBatchSummary,
  hasCompleteBatchCoverage,
  makeEmailBatchSummary
} from '../email-batch.ts'

import { defineConnector } from '../connector.ts'
import { googleCalendarActions } from './calendar.ts'
import { googleDriveActions } from './drive.ts'
import { gmailActions } from './gmail.ts'
import { googleConnectorId } from './oauth.ts'

export const GoogleConnector = defineConnector({
  id: googleConnectorId,
  description: 'Google Gmail, Calendar, and Drive connector actions.',
  actions: [...gmailActions, ...googleCalendarActions, ...googleDriveActions]
})

export {
  downloadGoogleDriveFile,
  exportGoogleDriveFile,
  GoogleDriveReadonlyOAuthCredentialSlot,
  googleDriveReadonlyScope,
  googleDriveExportMaxBytes
} from './drive-download.ts'

export type {
  GoogleDriveDownloadInput,
  GoogleDriveExportInput,
  GoogleDriveDownloadBudget
} from './drive-download.ts'

export { downloadGmailAttachment } from './gmail-download.ts'

export type { GmailDownloadAttachmentInput } from './gmail-download.ts'
