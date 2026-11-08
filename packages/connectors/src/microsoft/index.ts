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
  OutlookGetAttachmentFileOutput,
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
  OneDriveCopyAcceptedOutput,
  OneDriveCopyItemInput,
  OneDriveCopyMonitorUrl,
  OneDriveCopyStatus,
  OneDriveCopyStatusError,
  OneDriveCopyStatusInput,
  OneDriveCopyStatusOutput,
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
  OneDriveMoveItemInput,
  OneDrivePackageFacet,
  OneDriveParentReference,
  OneDriveResolveSharingLinkInput,
  OneDriveSearchItemsInput,
  OneDriveSharingUrl,
  oneDriveActions,
  oneDriveCopyItemAction,
  oneDriveCreateFolderAction,
  oneDriveDeleteItemAction,
  oneDriveGetCopyStatusAction,
  oneDriveGetItemAction,
  oneDriveListItemsAction,
  oneDriveMoveItemAction,
  oneDriveResolveSharingLinkAction,
  oneDriveSearchItemsAction,
  oneDriveSharingUrlMaxLength,
  oneDriveSharingUrlShareId
} from './drive.ts'

export {
  SharePointDrive,
  SharePointListSiteDrivesInput,
  SharePointListSiteDrivesOutput,
  SharePointSearchSitesInput,
  SharePointSearchSitesOutput,
  SharePointSite,
  sharePointActions,
  sharePointListSiteDrivesAction,
  sharePointSearchSitesAction
} from './sites.ts'

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
  MicrosoftSharePointSitesReadOAuthCredentialSlot,
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
  microsoftGraphSitesReadAllScope,
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
  microsoftOutlookWriteScopes,
  microsoftSharePointSitesReadScopes
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
import { sharePointActions } from './sites.ts'

export const MicrosoftConnector = defineConnector({
  id: microsoftConnectorId,
  description: 'Microsoft Outlook, OneDrive, and SharePoint actions through Microsoft Graph.',
  actions: [...outlookMailActions, ...oneDriveActions, ...sharePointActions]
})

export { createOneDriveFile, updateOneDriveFile, oneDriveSingleUploadMaxBytes } from './write.ts'

export type { OneDriveCreateFileInput, OneDriveUpdateFileInput } from './write.ts'

export { downloadOutlookAttachment } from './mail-download.ts'

export type { OutlookDownloadAttachmentInput } from './mail-download.ts'

export {
  addOutlookAttachment,
  outlookAttachmentSingleRequestMaxBytes,
  outlookAttachmentUploadChunkBytes,
  outlookAttachmentUploadSessionMaxBytes
} from './mail-upload.ts'

export type { OutlookAddAttachmentInput, OutlookAddAttachmentResult } from './mail-upload.ts'
