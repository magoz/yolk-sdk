export {
  downloadOneDriveItem,
  OneDriveDownloadError,
  OneDriveDownloadErrorCode,
  OneDriveDownloadSource
} from './download.ts'

export type {
  OneDriveDownloadBudget,
  OneDriveDownloadInput,
  OneDriveDownloadResult
} from './download.ts'

export {
  MicrosoftMailboxAccessMode,
  microsoftMailboxAccessModeConfigKey,
  outlookBatchModifyCategoriesAction,
  OutlookBatchModifyCategoriesInput,
  outlookBatchMoveAction,
  OutlookBatchMoveInput,
  OutlookBatchMoveOutput,
  OutlookBatchMoveResultItem,
  outlookBatchSetFlagAction,
  OutlookBatchSetFlagInput,
  outlookBatchSetReadAction,
  OutlookBatchSetReadInput,
  outlookBatchTrashAction,
  OutlookBatchTrashInput,
  outlookBatchUntrashAction,
  OutlookBatchUntrashInput,
  OutlookAttachment,
  OutlookAttachmentKind,
  OutlookAttachmentMetadata,
  OutlookCategory,
  OutlookCategoryColor,
  OutlookComposeInput,
  outlookCreateCategoryAction,
  OutlookCreateCategoryInput,
  outlookCreateDraftAction,
  OutlookCreateReplyDraftInput,
  outlookCreateReplyDraftAction,
  outlookDeletePermanentlyAction,
  OutlookDeletePermanentlyInput,
  OutlookUpdateDraftInput,
  outlookUpdateDraftAction,
  outlookDeleteCategoryAction,
  OutlookDeleteCategoryInput,
  OutlookDeleteCategoryOutput,
  OutlookEmailAddress,
  outlookGetCategoryAction,
  OutlookGetCategoryInput,
  OutlookGetAttachmentInput,
  OutlookGetAttachmentOutput,
  outlookGetAttachmentAction,
  outlookGetMessageAction,
  outlookUpdateCategoryAction,
  OutlookUpdateCategoryInput,
  OutlookListAttachmentsInput,
  OutlookListAttachmentsOutput,
  outlookListAttachmentsAction,
  OutlookListCategoriesInput,
  OutlookListCategoriesOutput,
  outlookListCategoriesAction,
  OutlookListMessagesInput,
  OutlookListMessagesOutput,
  outlookListMessagesAction,
  outlookMailActions,
  OutlookMessage,
  OutlookMessageBody,
  OutlookMessageIdInput,
  OutlookMessageWithHeaders,
  OutlookInternetMessageHeader,
  outlookMoveMessageAction,
  OutlookMoveMessageInput,
  outlookModifyCategoriesAction,
  OutlookModifyCategoriesInput,
  OutlookRecipient,
  OutlookReplyInput,
  outlookReplyAction,
  OutlookSearchMessagesInput,
  outlookSearchMessagesAction,
  outlookSetFlagAction,
  OutlookSetFlagInput,
  OutlookSendMailInput,
  outlookSendDraftAction,
  outlookSendMailAction,
  outlookSetCategoriesAction,
  OutlookSetCategoriesInput,
  outlookSetReadAction,
  OutlookSetReadInput,
  outlookTrashAction,
  OutlookTrashInput,
  outlookUntrashAction,
  OutlookUntrashInput,
  OutlookSendOutput
} from './mail.ts'

export {
  MicrosoftOneDriveAccessMode,
  microsoftOneDriveAccessModeConfigKey,
  OneDriveCreateFolderInput,
  OneDriveDeleteItemInput,
  OneDriveDeleteItemOutput,
  OneDriveFileFacet,
  OneDriveFolderFacet,
  OneDriveHashes,
  OneDriveItem,
  OneDriveItemIdInput,
  OneDriveListItemsInput,
  OneDriveListItemsOutput,
  OneDrivePackageFacet,
  OneDriveParentReference,
  OneDriveSearchItemsInput,
  oneDriveActions,
  oneDriveCreateFolderAction,
  oneDriveDeleteItemAction,
  oneDriveGetItemAction,
  oneDriveListItemsAction,
  oneDriveSearchItemsAction
} from './drive.ts'

export {
  MicrosoftCombinedOAuthCredentialSlot,
  MicrosoftOAuthCredentialSlot,
  MicrosoftOneDriveReadAllOAuthCredentialSlot,
  MicrosoftOneDriveReadOAuthCredentialSlot,
  MicrosoftOneDriveWriteAllOAuthCredentialSlot,
  MicrosoftOneDriveWriteOAuthCredentialSlot,
  MicrosoftOutlookCategoryReadOAuthCredentialSlot,
  MicrosoftOutlookCategoryWriteOAuthCredentialSlot,
  MicrosoftOutlookReadOAuthCredentialSlot,
  MicrosoftOutlookSendOAuthCredentialSlot,
  MicrosoftOutlookSharedReadOAuthCredentialSlot,
  MicrosoftOutlookSharedSendOAuthCredentialSlot,
  MicrosoftOutlookSharedWriteOAuthCredentialSlot,
  MicrosoftOutlookWriteOAuthCredentialSlot,
  microsoftAuthorizationHeaders,
  microsoftConnectorId,
  microsoftGraphFilesReadAllScope,
  microsoftGraphFilesReadScope,
  microsoftGraphFilesReadWriteAllScope,
  microsoftGraphFilesReadWriteScope,
  microsoftGraphMailboxSettingsReadScope,
  microsoftGraphMailboxSettingsReadWriteScope,
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
  microsoftOneDriveReadAllScopes,
  microsoftOneDriveReadScopes,
  microsoftOneDriveWriteAllScopes,
  microsoftOneDriveWriteScopes,
  microsoftOutlookCategoryReadScopes,
  microsoftOutlookCategoryWriteScopes,
  microsoftOutlookReadScopes,
  microsoftOutlookSendScopes,
  microsoftOutlookSharedReadScopes,
  microsoftOutlookSharedSendScopes,
  microsoftOutlookSharedWriteScopes,
  microsoftOutlookWriteScopes
} from './oauth.ts'

export { microsoftGraphApiBaseUrl, resolveMicrosoftAccessToken } from './shared.ts'

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
import { oneDriveActions } from './drive.ts'
import { outlookMailActions } from './mail.ts'
import { microsoftConnectorId } from './oauth.ts'

export const MicrosoftConnector = defineConnector({
  id: microsoftConnectorId,
  description: 'Microsoft Outlook and OneDrive actions through Microsoft Graph.',
  actions: [...outlookMailActions, ...oneDriveActions]
})

export { createOneDriveFile, updateOneDriveFile, oneDriveSingleUploadMaxBytes } from './write.ts'

export type { OneDriveCreateFileInput, OneDriveUpdateFileInput } from './write.ts'

export { downloadOutlookAttachment } from './mail-download.ts'

export type { OutlookDownloadAttachmentInput } from './mail-download.ts'
