/**
 * Microsoft Graph conformance cases for `@yolk-sdk/conformance/runner` and the wire fixtures that
 * back their replay (`@yolk-sdk/conformance/replay`).
 *
 * The Outlook and OneDrive cases run the real connector actions. The connector has no calendar
 * actions yet: the calendar cases send raw Graph v1.0 requests through the same connector ports and
 * pin expected Graph behaviour (unverified until a live run) for hosts and the upcoming emulator.
 *
 * The current fixtures are synthetic placeholders (`evidence: 'unverified'`) shaped like the
 * Microsoft Graph wire.
 * `pnpm conformance:microsoft --live --owner-approved --account <label> --record` stages verified
 * recordings from a practice tenant in a gitignored directory; a person scrubs them and promotes
 * them here, updating the tests together with them (fixture ids, `evidence`, and `account` change).
 *
 * @experimental
 */
import type { WireFixture } from '@yolk-sdk/conformance/fixture'
import { microsoftCalendarCancelFixture } from './calendar-cancel.ts'
import { microsoftCalendarCreateEventFixture } from './calendar-create-event.ts'
import { microsoftCalendarListRangeFixture } from './calendar-list-range.ts'
import { microsoftCalendarTimestampPrecisionFixture } from './calendar-timestamp-precision.ts'
import { microsoftOneDriveCopyMonitorFixture } from './onedrive-copy-monitor.ts'
import { microsoftOneDriveCreateFolderFixture } from './onedrive-create-folder.ts'
import { microsoftOutlookAttachmentContentIdFixture } from './outlook-attachment-content-id.ts'
import { microsoftOutlookAttachmentsListingFixture } from './outlook-attachments-listing.ts'
import { microsoftOutlookConcurrentWritesFixture } from './outlook-concurrent-writes.ts'
import { microsoftOutlookImmutableIdFixture } from './outlook-immutable-id.ts'
import { microsoftOutlookPagingNextLinkFixture } from './outlook-paging-next-link.ts'

export {
  MicrosoftConformanceActionFailed,
  MicrosoftConformanceConfig,
  MicrosoftConformanceRestoreFailed,
  MicrosoftConformanceSeeds,
  microsoftCalendarCancelCase,
  microsoftCalendarCreateEventCase,
  microsoftCalendarListRangeCase,
  microsoftCalendarTimestampPrecisionCase,
  microsoftConformanceCases,
  microsoftConformanceCredentialRef,
  microsoftConformanceIntegration,
  microsoftConformanceMarker,
  microsoftOneDriveCopyMonitorCase,
  microsoftOneDriveCreateFolderCase,
  microsoftOutlookAttachmentContentIdCase,
  microsoftOutlookAttachmentsListingCase,
  microsoftOutlookConcurrentWritesCase,
  microsoftOutlookImmutableIdCase,
  microsoftOutlookPagingNextLinkCase,
  type MicrosoftConformanceCase,
  type MicrosoftConformanceError,
  type MicrosoftConformanceRequirements,
  type MicrosoftConformanceSeedKey
} from './cases.ts'

export { microsoftConformanceFixtureSeeds } from './seeds.ts'

export {
  microsoftCalendarCancelFixture,
  microsoftCalendarCreateEventFixture,
  microsoftCalendarListRangeFixture,
  microsoftCalendarTimestampPrecisionFixture,
  microsoftOneDriveCopyMonitorFixture,
  microsoftOneDriveCreateFolderFixture,
  microsoftOutlookAttachmentContentIdFixture,
  microsoftOutlookAttachmentsListingFixture,
  microsoftOutlookConcurrentWritesFixture,
  microsoftOutlookImmutableIdFixture,
  microsoftOutlookPagingNextLinkFixture
}

/** Every Microsoft wire fixture, in case order, for replaying the whole suite at once. */
export const microsoftConformanceFixtures: ReadonlyArray<WireFixture> = [
  microsoftCalendarListRangeFixture,
  microsoftCalendarTimestampPrecisionFixture,
  microsoftCalendarCreateEventFixture,
  microsoftCalendarCancelFixture,
  microsoftOutlookAttachmentsListingFixture,
  microsoftOutlookAttachmentContentIdFixture,
  microsoftOutlookPagingNextLinkFixture,
  microsoftOutlookImmutableIdFixture,
  microsoftOutlookConcurrentWritesFixture,
  microsoftOneDriveCreateFolderFixture,
  microsoftOneDriveCopyMonitorFixture
]
