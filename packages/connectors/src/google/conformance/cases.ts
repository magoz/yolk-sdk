/**
 * Google (Gmail, Calendar, Drive) conformance cases for `@yolk-sdk/conformance/runner`.
 *
 * Each case checks one wire claim the Google connector relies on, running the REAL connector
 * actions over the connector ports (`ConnectorHttpClient`, `CredentialResolver`) plus the
 * host-supplied `GoogleConformanceConfig` seeds (a practice mailbox address, practice messages and
 * a label, a practice calendar and time range, a practice Drive folder and file). Claims about
 * response bodies an action does not decode (error envelopes, `gmail.list` pages, draft and
 * message answers) are observed at the `ConnectorHttpClient` port or decoded in the case with
 * local schemas; the cases send no request of their own. The same cases run on replay fixtures,
 * an emulator, or by hand against a practice account. None is observed live yet (`observed`
 * absent = unverified); sub-claims no live run has settled are marked "(unverified: ...)" in their
 * `wire`.
 *
 * Write ownership. Every write names the per-invocation `runId` seed (`run-<hex>`; fixtures replay
 * with `run-synthetic`, the live runner generates a fresh one each time) or works only on a seeded
 * practice message:
 *
 * - The label case creates a `yolk-conformance <runId> label`, applies it to the seeded work
 *   message, and deletes it by id (write-reversible).
 * - The draft case composes a draft with NO recipient and a run-scoped subject, updates it, and
 *   deletes it by id (write-reversible; a draft without recipients cannot be sent).
 * - The trash case trashes and untrashes the seeded work message and restores its earlier labels.
 *   It refuses to start while the message is in Trash (write-reversible; not safe concurrently).
 * - The two event cases create a run-scoped event with NO attendees (so no invitation is ever sent)
 *   at a fixed synthetic time in the seeded calendar and delete it by id (write-reversible).
 * - The folder case creates a run-scoped folder in the seeded Drive folder, trashes it, and deletes
 *   it permanently by id (write-reversible; nothing stays in Trash unless the cleanup fails).
 * - The send case submits one message whose ONLY recipient is the seeded practice address. Gmail
 *   cannot unsend, so it is `write-irreversible` and runs only when a person names its exact id.
 *
 * The create request (label, draft, trash, event, folder), its decoding, its classification, and
 * the registration of what it created run uninterruptibly together. A definitive rejection (HTTP
 * 4xx other than 408) changed nothing: the case fails and undoes NOTHING. An ambiguous outcome (a
 * transport or decoding failure, no status, HTTP 408, or HTTP 5xx) may have written anyway without
 * the case learning what: it fails with `GoogleConformanceActionFailed` (`writeOutcome: 'unknown'`)
 * naming the exact item to check by hand, and undoes nothing. A create that answers an item
 * outside the run namespace (another label name, a non-draft, another message, an event with
 * another summary or with attendees, a Drive item with another name, type, or parent, or a seeded
 * item) is never adopted: `GoogleConformanceCleanupRefused`. Every later write is masked too, so an
 * aborted request cannot land after the cleanup. The cleanup undoes by id and then verifies the
 * result; a failed cleanup is reported as `GoogleConformanceRestoreFailed` naming the item (never
 * swallowed), also through the `ConformanceCleanupReporter` when the case is being interrupted.
 * Neither the runner nor the bridges set a request timeout, so a hanging request delays an
 * interruption until it answers. `findGoogleConformanceLeftovers` lists (read-only) what earlier
 * runs left behind.
 */
import { Effect } from 'effect'
import * as Schema from 'effect/Schema'
import { googleCalendarListEventsAction, GoogleCalendarListEventsInput } from '../calendar.ts'
import { googleDriveListFilesAction, GoogleDriveListFilesInput } from '../drive.ts'
import {
  gmailGetMessageAction,
  GmailGetMessageInput,
  gmailListDraftsAction,
  GmailListInput,
  gmailListLabelsAction
} from '../gmail.ts'
import {
  calendarDeletedGoneCase,
  calendarEventLifecycleCase,
  calendarListRangeCase
} from './calendar-cases.ts'
import {
  driveFolderLifecycleCase,
  driveGetFileFieldsCase,
  driveListPagingCase
} from './drive-cases.ts'
import {
  gmailAttachmentCase,
  gmailDraftLifecycleCase,
  gmailLabelLifecycleCase,
  gmailListPagingCase,
  gmailNotFoundEnvelopeCase,
  gmailSendPracticeCase,
  gmailTrashUntrashCase
} from './gmail-cases.ts'
import {
  decodeOutput,
  GoogleConformanceConfig,
  googleConformanceIntegration as integration,
  googleConformanceRunPrefix,
  successValue,
  type GoogleConformanceCase,
  type GoogleConformanceError,
  type GoogleConformanceRequirements
} from './shared.ts'

export {
  GoogleConformanceActionFailed,
  GoogleConformanceCleanupRefused,
  GoogleConformanceConfig,
  googleConformanceCredentialRef,
  googleConformanceIntegration,
  googleConformanceMarker,
  googleConformanceRunPrefix,
  GoogleConformanceRestoreFailed,
  GoogleConformanceSeeds,
  type GoogleConformanceCase,
  type GoogleConformanceError,
  type GoogleConformanceRequirements,
  type GoogleConformanceSeedKey
} from './shared.ts'

export {
  gmailAttachmentCase,
  gmailDraftLifecycleCase,
  gmailLabelLifecycleCase,
  gmailListPagingCase,
  gmailNotFoundEnvelopeCase,
  gmailSendPracticeCase,
  gmailTrashUntrashCase
} from './gmail-cases.ts'

export {
  calendarDeletedGoneCase,
  calendarEventLifecycleCase,
  calendarListRangeCase
} from './calendar-cases.ts'

export {
  driveFolderLifecycleCase,
  driveGetFileFieldsCase,
  driveListPagingCase
} from './drive-cases.ts'

const GmailLabelsListing = Schema.Struct({
  labels: Schema.optionalKey(
    Schema.Array(Schema.Struct({ id: Schema.String, name: Schema.String }))
  )
})

const GmailDraftsListing = Schema.Struct({
  drafts: Schema.optionalKey(Schema.Array(Schema.Struct({ id: Schema.String })))
})

/** Pages read before giving up, and their sizes. */
const leftoverPageCap = 4

const leftoverDraftPageSize = 100

const leftoverEventPageSize = 250

const leftoverFilePageSize = 100

/**
 * READ-ONLY and bounded: what earlier runs left behind in the practice account (a killed process,
 * a failed or ambiguous cleanup). With any Gmail seed (`practiceAddress`, `pagingLabelId`,
 * `attachmentMessageId`, `workMessageId`): Gmail labels named `yolk-conformance run-*` and drafts a
 * Gmail search for `subject:yolk-conformance` finds (one page of 100; search-based, so best
 * effort); with `workMessageId`, the work message when it is in Trash. With
 * `calendarId` seeded: events titled `yolk-conformance run-*` in it (a free-text query, at most 4
 * pages of 250). With `driveFolderId` seeded: items named `yolk-conformance run-*` in it, trashed
 * ones included (at most 4 pages of 100). Messages the send case sent are its documented residue
 * and are not listed. Live runners call it before any write case and warn per leftover; nothing is
 * ever changed automatically.
 */
export const findGoogleConformanceLeftovers: Effect.Effect<
  ReadonlyArray<string>,
  GoogleConformanceError,
  GoogleConformanceRequirements
> = Effect.gen(function* () {
  const seeds = yield* GoogleConformanceConfig
  const found: Array<string> = []

  const gmailSeeded =
    seeds.workMessageId !== undefined ||
    seeds.practiceAddress !== undefined ||
    seeds.pagingLabelId !== undefined ||
    seeds.attachmentMessageId !== undefined

  if (gmailSeeded) {
    const labels = yield* gmailListLabelsAction
      .executeTyped({ integration, input: {} })
      .pipe(
        Effect.flatMap(successValue(gmailListLabelsAction.id)),
        Effect.flatMap(decodeOutput(GmailLabelsListing, 'gmail.list_labels to answer labels'))
      )

    for (const label of labels.labels ?? []) {
      if (label.name.startsWith(googleConformanceRunPrefix)) {
        found.push(`Gmail label ${label.id} "${label.name}"`)
      }
    }

    const drafts = yield* gmailListDraftsAction
      .executeTyped({
        integration,
        input: GmailListInput.make({
          query: 'subject:yolk-conformance',
          maxResults: leftoverDraftPageSize
        })
      })
      .pipe(
        Effect.flatMap(successValue(gmailListDraftsAction.id)),
        Effect.flatMap(decodeOutput(GmailDraftsListing, 'gmail.list_drafts to answer drafts'))
      )

    for (const draft of drafts.drafts ?? []) {
      found.push(`Gmail draft ${draft.id} (found by subject:yolk-conformance)`)
    }
  }

  if (seeds.workMessageId !== undefined) {
    const message = yield* gmailGetMessageAction
      .executeTyped({
        integration,
        input: GmailGetMessageInput.make({ id: seeds.workMessageId, format: 'minimal' })
      })
      .pipe(Effect.flatMap(successValue(gmailGetMessageAction.id)))

    if ((message.labelIds ?? []).includes('TRASH')) {
      found.push(`work message ${seeds.workMessageId} in Gmail Trash`)
    }
  }

  if (seeds.calendarId !== undefined) {
    let pageToken: string | undefined

    for (let page = 1; page <= leftoverPageCap; page++) {
      const listing = yield* googleCalendarListEventsAction
        .executeTyped({
          integration,
          input: GoogleCalendarListEventsInput.make({
            calendarId: seeds.calendarId,
            query: 'yolk-conformance',
            maxResults: leftoverEventPageSize,
            pageToken
          })
        })
        .pipe(Effect.flatMap(successValue(googleCalendarListEventsAction.id)))

      for (const event of listing.items ?? []) {
        if (event.status !== 'cancelled' && event.summary?.startsWith(googleConformanceRunPrefix)) {
          found.push(
            `event ${event.id ?? '(no id)'} "${event.summary}" in calendar ${seeds.calendarId}`
          )
        }
      }

      pageToken = listing.nextPageToken

      if (pageToken === undefined) {
        break
      }
    }
  }

  if (seeds.driveFolderId !== undefined) {
    let pageToken: string | undefined

    for (let page = 1; page <= leftoverPageCap; page++) {
      const listing = yield* googleDriveListFilesAction
        .executeTyped({
          integration,
          input:
            pageToken === undefined
              ? GoogleDriveListFilesInput.make({
                  parentId: seeds.driveFolderId,
                  includeTrashed: true,
                  pageSize: leftoverFilePageSize
                })
              : GoogleDriveListFilesInput.make({
                  parentId: seeds.driveFolderId,
                  includeTrashed: true,
                  pageSize: leftoverFilePageSize,
                  pageToken
                })
        })
        .pipe(Effect.flatMap(successValue(googleDriveListFilesAction.id)))

      for (const file of listing.files) {
        if (file.name.startsWith(googleConformanceRunPrefix)) {
          found.push(
            `Drive item ${file.id} "${file.name}"${file.trashed === true ? ' (in Trash)' : ''}`
          )
        }
      }

      pageToken = listing.nextPageToken

      if (pageToken === undefined) {
        break
      }
    }
  }

  return found
})

/** Every Google conformance case, in fixture order. */
export const googleConformanceCases: ReadonlyArray<GoogleConformanceCase> = [
  gmailListPagingCase,
  gmailAttachmentCase,
  gmailNotFoundEnvelopeCase,
  gmailLabelLifecycleCase,
  gmailDraftLifecycleCase,
  gmailTrashUntrashCase,
  gmailSendPracticeCase,
  calendarListRangeCase,
  calendarEventLifecycleCase,
  calendarDeletedGoneCase,
  driveListPagingCase,
  driveGetFileFieldsCase,
  driveFolderLifecycleCase
]
