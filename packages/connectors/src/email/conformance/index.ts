/**
 * Generic email conformance cases for `@yolk-sdk/conformance/runner`, the `PortFixture`s that back
 * their replay, and the plain-JSON backend bridge to the `EmailClient` port.
 *
 * Yolk never speaks IMAP, POP3, or SMTP: the cases run the real connector email actions over the
 * host-provided `EmailClient`. `emailClientLayerFromBackend` turns any plain-JSON backend into that
 * port: `makeEmailReplayBackend` over these fixtures, or a structural fake such as
 * `@yolk-sdk/emulators/email` (the connectors package never depends on it). Live verification needs
 * a host `EmailClient` implementation connected to a practice mailbox; no live probe ships here.
 *
 * The current fixtures are synthetic placeholders (no `observed`, so `unverified`) shaped like a
 * host `EmailClient` answer for the seeds in `emailConformanceFixtureSeeds`.
 *
 * @experimental
 */
import type { PortFixture } from '@yolk-sdk/conformance/fixture'
import { emailAcceptanceNotDeliveryFixtures } from './acceptance-not-delivery.ts'
import { emailDraftsDiscoveryFixtures } from './draft-drafts-discovery.ts'
import { emailFilteredListNoFallbackFixtures } from './filtered-list-no-fallback.ts'
import { emailLegacySentCopyFixtures } from './legacy-host-sent-copy.ts'
import { emailListAndGetHeadersFixtures } from './list-and-get-headers.ts'
import { emailMoveDestinationIdsFixtures } from './move-destination-ids.ts'
import { emailPop3RejectionsFixtures } from './pop3-rejections.ts'
import { emailSentCopyStatusesFixtures } from './sent-copy-statuses.ts'
import { emailSetReadAndFlagFixtures } from './set-read-and-flag.ts'
import { emailTrashUntrashFixtures } from './trash-untrash-to-inbox.ts'

export {
  EmailConformanceActionFailed,
  EmailConformanceConfig,
  EmailConformanceRestoreFailed,
  EmailConformanceSeeds,
  emailAcceptanceNotDeliveryCase,
  emailAcceptanceNotDeliveryCaseId,
  emailConformanceCases,
  emailConformanceCredentialRefs,
  emailConformanceIntegration,
  emailConformanceMarker,
  emailConformanceMissingFolder,
  emailConformanceSubjects,
  emailDraftsDiscoveryCase,
  emailDraftsDiscoveryCaseId,
  emailFilteredListNoFallbackCase,
  emailFilteredListNoFallbackCaseId,
  emailLegacySentCopyCase,
  emailLegacySentCopyCaseId,
  emailListAndGetHeadersCase,
  emailListAndGetHeadersCaseId,
  emailMessageNotFoundCode,
  emailMoveDestinationIdsCase,
  emailMoveDestinationIdsCaseId,
  emailPop3RejectionsCase,
  emailPop3RejectionsCaseId,
  emailSentCopyStatusesCase,
  emailSentCopyStatusesCaseId,
  emailSetReadAndFlagCase,
  emailSetReadAndFlagCaseId,
  emailTrashUntrashCase,
  emailTrashUntrashCaseId,
  type EmailConformanceCase,
  type EmailConformanceError,
  type EmailConformanceRequirements,
  type EmailConformanceSeedKey
} from './cases.ts'

export {
  emailBackendMethods,
  emailClientFromBackend,
  emailClientLayerFromBackend,
  emailPortName,
  emailPortRequestJson,
  makeEmailReplayBackend,
  type EmailBackend,
  type EmailBackendMethod,
  type EmailBackendReply,
  type EmailReplay,
  type EmailReplayLedgerEntry
} from './backend.ts'

export { emailConformanceFixtureSeeds } from './seeds.ts'

export {
  emailAcceptanceNotDeliveryFixtures,
  emailDraftsDiscoveryFixtures,
  emailFilteredListNoFallbackFixtures,
  emailLegacySentCopyFixtures,
  emailListAndGetHeadersFixtures,
  emailMoveDestinationIdsFixtures,
  emailPop3RejectionsFixtures,
  emailSentCopyStatusesFixtures,
  emailSetReadAndFlagFixtures,
  emailTrashUntrashFixtures
}

/** Every email `PortFixture`, in case order, for replaying the whole suite at once. */
export const emailConformanceFixtures: ReadonlyArray<PortFixture> = [
  ...emailListAndGetHeadersFixtures,
  ...emailFilteredListNoFallbackFixtures,
  ...emailDraftsDiscoveryFixtures,
  ...emailSetReadAndFlagFixtures,
  ...emailTrashUntrashFixtures,
  ...emailMoveDestinationIdsFixtures,
  ...emailPop3RejectionsFixtures,
  ...emailSentCopyStatusesFixtures,
  ...emailLegacySentCopyFixtures,
  ...emailAcceptanceNotDeliveryFixtures
]
