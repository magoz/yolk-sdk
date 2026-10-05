/**
 * Google (Gmail, Calendar, Drive) conformance cases for `@yolk-sdk/conformance/runner` and the
 * wire fixtures that back their replay (`@yolk-sdk/conformance/replay`).
 *
 * Every case runs the real connector actions over the connector ports. The current fixtures are
 * synthetic placeholders (`evidence: 'unverified'`) shaped like the Gmail, Calendar, and Drive
 * APIs. `pnpm conformance:google --live --owner-approved --account <label> --record` stages
 * verified recordings from a practice account in a gitignored directory; a person scrubs them and
 * promotes them here, updating the tests together with them (fixture ids, `evidence`, and
 * `account` change).
 *
 * @experimental
 */
import type { WireFixture } from '@yolk-sdk/conformance/fixture'
import { calendarDeletedGoneFixture } from './calendar-deleted-gone.ts'
import { calendarEventLifecycleFixture } from './calendar-event-lifecycle.ts'
import { calendarListRangeFixture } from './calendar-list-range.ts'
import { driveFolderLifecycleFixture } from './drive-folder-lifecycle.ts'
import { driveGetFileFieldsFixture } from './drive-get-file-fields.ts'
import { driveListPagingFixture } from './drive-list-paging.ts'
import { gmailAttachmentFixture } from './gmail-attachment.ts'
import { gmailDraftLifecycleFixture } from './gmail-draft-lifecycle.ts'
import { gmailLabelLifecycleFixture } from './gmail-label-lifecycle.ts'
import { gmailListPagingFixture } from './gmail-list-paging.ts'
import { gmailListThreadsPagingFixture } from './gmail-list-threads-paging.ts'
import { gmailMetadataHeadersFixture } from './gmail-metadata-headers.ts'
import { gmailNotFoundEnvelopeFixture } from './gmail-not-found-envelope.ts'
import { gmailSendPracticeFixture } from './gmail-send-practice.ts'
import { gmailTrashUntrashFixture } from './gmail-trash-untrash.ts'

export {
  calendarDeletedGoneCase,
  calendarEventLifecycleCase,
  calendarListRangeCase,
  driveFolderLifecycleCase,
  driveGetFileFieldsCase,
  driveListPagingCase,
  findGoogleConformanceLeftovers,
  gmailAttachmentCase,
  gmailDraftLifecycleCase,
  gmailLabelLifecycleCase,
  gmailListPagingCase,
  gmailListThreadsPagingCase,
  gmailMetadataHeadersCase,
  gmailNotFoundEnvelopeCase,
  gmailSendPracticeCase,
  gmailTrashUntrashCase,
  GoogleConformanceActionFailed,
  googleConformanceCases,
  GoogleConformanceCleanupRefused,
  GoogleConformanceConfig,
  googleConformanceCredentialRef,
  googleConformanceIntegration,
  googleConformanceMarker,
  GoogleConformanceRestoreFailed,
  googleConformanceRunPrefix,
  GoogleConformanceRunId,
  GoogleConformanceSeeds,
  GooglePracticeAddress,
  type GoogleConformanceCase,
  type GoogleConformanceError,
  type GoogleConformanceRequirements,
  type GoogleConformanceSeedKey
} from './cases.ts'

export { googleConformanceFixtureSeeds } from './seeds.ts'

export {
  calendarDeletedGoneFixture,
  calendarEventLifecycleFixture,
  calendarListRangeFixture,
  driveFolderLifecycleFixture,
  driveGetFileFieldsFixture,
  driveListPagingFixture,
  gmailAttachmentFixture,
  gmailDraftLifecycleFixture,
  gmailLabelLifecycleFixture,
  gmailListPagingFixture,
  gmailListThreadsPagingFixture,
  gmailMetadataHeadersFixture,
  gmailNotFoundEnvelopeFixture,
  gmailSendPracticeFixture,
  gmailTrashUntrashFixture
}

/** Every Google wire fixture, in case order, for replaying the whole suite at once. */
export const googleConformanceFixtures: ReadonlyArray<WireFixture> = [
  gmailListPagingFixture,
  gmailAttachmentFixture,
  gmailNotFoundEnvelopeFixture,
  gmailListThreadsPagingFixture,
  gmailMetadataHeadersFixture,
  gmailLabelLifecycleFixture,
  gmailDraftLifecycleFixture,
  gmailTrashUntrashFixture,
  gmailSendPracticeFixture,
  calendarListRangeFixture,
  calendarEventLifecycleFixture,
  calendarDeletedGoneFixture,
  driveListPagingFixture,
  driveGetFileFieldsFixture,
  driveFolderLifecycleFixture
]
