/**
 * Google (Gmail, Calendar, Drive) conformance runner for a practice Google account
 * (`pnpm conformance:google`).
 *
 * Default: DRY RUN. Prints every case id, its safety, and whether it would run under the chosen
 * flags, then exits without any network call or credential read.
 *
 * `--live --owner-approved --account <label>`: runs the cases against the real Gmail, Calendar, and
 * Drive APIs with a `FetchHttpClient`, through the real connector actions. Refused whenever `CI` is
 * non-empty and without `--owner-approved`. Requires `GOOGLE_ACCESS_TOKEN` (environment only,
 * never a flag; an OAuth access token for the practice account only, with the scopes of the cases
 * that will run) and the seeds of every case that will run (flags or environment, see the usage
 * text). A token that is not `ya29.` followed by letters, digits, `.`, `_`, and `-` is refused
 * before any request (never printed). Read cases always run. `--allow-writes reversible` adds the
 * write-reversible cases: a `yolk-conformance <runId> label` created, applied to `--work-message`,
 * and deleted by id; a draft WITHOUT recipients composed, updated, and deleted by id;
 * `--work-message` trashed and untrashed (refused while it is in Trash); two events WITHOUT
 * attendees (so no invitation is ever sent) created in `--calendar` and deleted by id; and a folder
 * created in `--drive-folder`, trashed, and deleted permanently by id. The one write-irreversible
 * case, `google.gmail.send-practice-address`, sends a real message whose ONLY recipient is
 * `--practice-address` (a mailbox the owner controls); Gmail cannot unsend, so it runs only when
 * named with `--allow-irreversible google.gmail.send-practice-address` (`--allow-writes` never
 * starts it). The runner generates a fresh random `runId` per invocation (never a flag) and prints
 * it before any case when the send will run. A definitive write rejection undoes nothing, and an
 * ambiguous write is reported with the exact item to check by hand. Before any write case, and
 * again after an interrupt-only exit, a read-only lookup warns about `yolk-conformance run-*`
 * Gmail labels, `subject:yolk-conformance` drafts, the work message in Trash, run events in
 * `--calendar`, and run items in `--drive-folder`; nothing is changed automatically.
 *
 * The token travels only in the `Authorization` header, which the recorder never keeps; `--record`
 * still refuses to stage any recording in which the live token survives anywhere (an echo in a body
 * or header; raw, percent-encoded, escaped, or base64-encoded) or that holds a body outside the
 * guard's inspectable allowlist (strict UTF-8 text without NUL characters), and stages verified
 * recordings all or nothing in a new run directory under the gitignored
 * `.conformance-recordings/google/`. Promotion is manual: scrub the staged files of
 * practice-account data (addresses, message, thread, draft, label, event, and file ids, subjects,
 * snippets, message and attachment bodies, names, page tokens, links), copy them into
 * `packages/connectors/src/google/conformance/`, run `pnpm format:fix`, and update
 * `packages/connectors/test/google-conformance.test.ts` and
 * `scripts/test/run-google-conformance.test.ts` in the same change. See
 * `connector-conformance-internal.ts` for the shared gates.
 *
 * Never run live in CI.
 */
import { randomBytes } from 'node:crypto'
import { resolve } from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'
import { Layer } from 'effect'
import * as Schema from 'effect/Schema'
import type { HttpClient } from 'effect/unstable/http'
import {
  connectorHttpClientsFromEffectHttpClientLayer,
  staticCredentialResolverLayer
} from '../packages/connectors/src/conformance/index.ts'
import { BearerTokenCredential } from '../packages/connectors/src/credential.ts'
import {
  findGoogleConformanceLeftovers,
  GoogleConformanceConfig,
  googleConformanceCases,
  googleConformanceFixtureSeeds,
  GoogleConformanceSeeds,
  type GoogleConformanceError,
  type GoogleConformanceRequirements,
  type GoogleConformanceSeedKey
} from '../packages/connectors/src/google/conformance/index.ts'
import { googleGmailApiBaseUrl } from '../packages/connectors/src/google/index.ts'
import {
  recordingsRootFor,
  runConnectorConformanceCli,
  type CaseSpec,
  type ConnectorConformanceRunner,
  type SeedSource
} from './connector-conformance-internal.ts'

/** Where each seed comes from. Flags win over environment variables. */
export const googleSeedSources: ReadonlyArray<SeedSource<GoogleConformanceSeedKey>> = [
  {
    key: 'practiceAddress',
    flag: '--practice-address',
    env: 'GOOGLE_CONFORMANCE_PRACTICE_ADDRESS',
    description: 'practice mailbox the owner controls: the ONLY address the send case ever sends to'
  },
  {
    key: 'pagingLabelId',
    flag: '--paging-label',
    env: 'GOOGLE_CONFORMANCE_PAGING_LABEL',
    description: 'Gmail user label id on 3 to 20 practice messages (none in Trash or Spam)'
  },
  {
    key: 'attachmentMessageId',
    flag: '--attachment-message',
    env: 'GOOGLE_CONFORMANCE_ATTACHMENT_MESSAGE',
    description: 'Gmail practice message id with a file attachment'
  },
  {
    key: 'workMessageId',
    flag: '--work-message',
    env: 'GOOGLE_CONFORMANCE_WORK_MESSAGE',
    description:
      'Gmail practice message id (not in Trash) the label and trash cases change and restore'
  },
  {
    key: 'calendarId',
    flag: '--calendar',
    env: 'GOOGLE_CONFORMANCE_CALENDAR',
    description: 'practice calendar id the account owns (events are created and deleted there)'
  },
  {
    key: 'eventRangeStart',
    flag: '--event-range-start',
    env: 'GOOGLE_CONFORMANCE_EVENT_RANGE_START',
    description: 'RFC 3339 start of a window holding 3 to 20 events in --calendar'
  },
  {
    key: 'eventRangeEnd',
    flag: '--event-range-end',
    env: 'GOOGLE_CONFORMANCE_EVENT_RANGE_END',
    description: 'RFC 3339 end of that window'
  },
  {
    key: 'driveFolderId',
    flag: '--drive-folder',
    env: 'GOOGLE_CONFORMANCE_DRIVE_FOLDER',
    description: 'practice Drive folder id with 3 to 20 items the token may write into'
  },
  {
    key: 'driveFileId',
    flag: '--drive-file',
    env: 'GOOGLE_CONFORMANCE_DRIVE_FILE',
    description: 'practice Drive file id directly inside --drive-folder'
  }
]

/** Seeds each case needs, and the fixture module `--record` rewrites for it. */
export const googleCaseSpecs: ReadonlyArray<CaseSpec<GoogleConformanceSeedKey>> = [
  {
    caseId: 'google.gmail.list-page-token',
    seeds: ['pagingLabelId'],
    optionalSeeds: [],
    fileName: 'gmail-list-paging.ts',
    exportName: 'gmailListPagingFixture',
    doc: 'The seeded paging label read for its `messagesTotal`, then `gmail.list` pages of two chained through `nextPageToken`.'
  },
  {
    caseId: 'google.gmail.attachment-base64url',
    seeds: ['attachmentMessageId'],
    optionalSeeds: [],
    fileName: 'gmail-attachment.ts',
    exportName: 'gmailAttachmentFixture',
    doc: '`gmail.list_attachments` of the seeded attachment message, then `gmail.get_attachment` of its attachment.'
  },
  {
    caseId: 'google.gmail.not-found-envelope',
    seeds: [],
    optionalSeeds: [],
    fileName: 'gmail-not-found-envelope.ts',
    exportName: 'gmailNotFoundEnvelopeFixture',
    doc: '`gmail.get_message` of an id the practice mailbox never holds, with the Google error envelope.'
  },
  {
    caseId: 'google.gmail.label-create-apply-delete',
    seeds: ['workMessageId', 'runId'],
    optionalSeeds: [],
    fileName: 'gmail-label-lifecycle.ts',
    exportName: 'gmailLabelLifecycleFixture',
    doc: 'A run label created, applied to the work message, deleted by id, and gone from the message.'
  },
  {
    caseId: 'google.gmail.draft-compose-update-delete',
    seeds: ['runId'],
    optionalSeeds: [],
    fileName: 'gmail-draft-lifecycle.ts',
    exportName: 'gmailDraftLifecycleFixture',
    doc: 'A draft without recipients composed, read through `get_thread`, updated, read again, deleted by id, and deleted again.'
  },
  {
    caseId: 'google.gmail.trash-untrash',
    seeds: ['workMessageId'],
    optionalSeeds: [],
    fileName: 'gmail-trash-untrash.ts',
    exportName: 'gmailTrashUntrashFixture',
    doc: 'The work message trashed and untrashed, with its labels read around each step.'
  },
  {
    caseId: 'google.gmail.send-practice-address',
    seeds: ['practiceAddress', 'runId'],
    optionalSeeds: [],
    fileName: 'gmail-send-practice.ts',
    exportName: 'gmailSendPracticeFixture',
    doc: '`gmail.send_message` of one message to the seeded practice address, then the answered id read back.'
  },
  {
    caseId: 'google.calendar.list-range-paging',
    seeds: ['calendarId', 'eventRangeStart', 'eventRangeEnd'],
    optionalSeeds: [],
    fileName: 'calendar-list-range.ts',
    exportName: 'calendarListRangeFixture',
    doc: 'The seeded range listed on one page, then in pages of two chained through `nextPageToken`.'
  },
  {
    caseId: 'google.calendar.event-lifecycle',
    seeds: ['calendarId', 'runId'],
    optionalSeeds: [],
    fileName: 'calendar-event-lifecycle.ts',
    exportName: 'calendarEventLifecycleFixture',
    doc: 'A run event without attendees created, read, renamed, read, deleted by id, and read gone.'
  },
  {
    caseId: 'google.calendar.deleted-event-gone',
    seeds: ['calendarId', 'runId'],
    optionalSeeds: [],
    fileName: 'calendar-deleted-gone.ts',
    exportName: 'calendarDeletedGoneFixture',
    doc: 'A run event without attendees created, deleted by id, read gone, and deleted again.'
  },
  {
    caseId: 'google.drive.list-page-token',
    seeds: ['driveFolderId'],
    optionalSeeds: [],
    fileName: 'drive-list-paging.ts',
    exportName: 'driveListPagingFixture',
    doc: 'The practice folder listed on one page, then in pages of two chained through `nextPageToken`.'
  },
  {
    caseId: 'google.drive.get-file-fields',
    seeds: ['driveFileId', 'driveFolderId'],
    optionalSeeds: [],
    fileName: 'drive-get-file-fields.ts',
    exportName: 'driveGetFileFieldsFixture',
    doc: '`drive.get_file` of the practice file, then the practice folder listing that holds it.'
  },
  {
    caseId: 'google.drive.folder-trash-delete',
    seeds: ['driveFolderId', 'runId'],
    optionalSeeds: [],
    fileName: 'drive-folder-lifecycle.ts',
    exportName: 'driveFolderLifecycleFixture',
    doc: 'A run folder created, trashed, left out of the listing, deleted permanently by id, and read gone.'
  }
]

/** A fresh invocation-unique run id (`run-<8 hex>`), named in every name, subject, and summary. */
export const generateRunId = (): string => `run-${randomBytes(4).toString('hex')}`

/** The live credential: a bearer OAuth access token for the practice account. */
export const liveCredential = (accessToken: string) =>
  BearerTokenCredential.make({ token: accessToken })

const casePorts = (
  httpLayer: Layer.Layer<HttpClient.HttpClient>,
  accessToken: string,
  seeds: GoogleConformanceSeeds
) =>
  Layer.mergeAll(
    connectorHttpClientsFromEffectHttpClientLayer.pipe(Layer.provide(httpLayer)),
    staticCredentialResolverLayer(liveCredential(accessToken)),
    Layer.succeed(GoogleConformanceConfig, seeds)
  )

export const googleRunner = {
  provider: 'google',
  displayName: 'Google',
  practiceTarget: 'a practice Google account',
  tokenEnv: 'GOOGLE_ACCESS_TOKEN',
  tokenScopes:
    'an OAuth access token for the practice account only, with the scopes of the cases that will run (gmail.readonly, gmail.modify, gmail.compose, gmail.send, calendar.readonly, calendar.events, drive.metadata.readonly, drive.file)',
  // Recorded as each fixture `endpoint`; promotion sets the Calendar and Drive fixtures to their own
  // API base URL (`https://www.googleapis.com/calendar/v3`, `https://www.googleapis.com/drive/v3`).
  endpoint: googleGmailApiBaseUrl,
  writeNote:
    'create a yolk-conformance <run id> label, apply it to --work-message, and delete it by id; compose, update, and delete a draft without recipients; trash and untrash --work-message (refused while it is in Trash) and restore its labels; create two events without attendees in --calendar (so no invitation is sent) and delete them by id; and create a folder in --drive-folder, trash it, and delete it permanently by id (a fresh random run id per invocation)',
  irreversibleNote:
    'The write-irreversible google.gmail.send-practice-address case sends one real message whose only recipient is --practice-address (a mailbox you control); Gmail cannot unsend, so the message stays in Sent and at that address; it runs only with --allow-irreversible google.gmail.send-practice-address',
  cases: googleConformanceCases,
  seedSources: googleSeedSources,
  generatedSeeds: { keys: ['runId'], generate: () => ({ runId: generateRunId() }) },
  caseSpecs: googleCaseSpecs,
  fixtureSeeds: googleConformanceFixtureSeeds,
  seedNoun: 'values',
  seedsTypeName: 'GoogleConformanceSeeds',
  seedsExportName: 'googleConformanceFixtureSeeds',
  configName: 'GoogleConformanceConfig',
  decodeSeeds: Schema.decodeUnknownOption(GoogleConformanceSeeds),
  invalidSeedsMessage:
    '--practice-address must be a plain email address (no display name), the Gmail ids letters, digits, _ and -, --calendar a calendar id, the range bounds RFC 3339 instants with a Z or offset, and the Drive ids letters, digits, _ and - (10 or more)',
  casePorts,
  recordedRequestHeaders: [],
  // Checked before any request, never printed: Google OAuth access tokens are `ya29.` followed by
  // URL-safe characters.
  tokenFormat: {
    pattern: /^ya29\.[A-Za-z0-9._-]{20,4096}$/,
    description:
      'a Google OAuth access token (ya29. followed by 20 or more letters, digits, ., _ or -)'
  },
  // Read-only: run labels, run drafts, the work message in Trash, run events, run Drive items.
  leftovers: findGoogleConformanceLeftovers,
  leftoverAdvice:
    'delete, untrash, or remove it by hand after checking that no run is still using it',
  recoveryAdvice:
    'Look in the practice account by hand: Gmail labels named `yolk-conformance run-` and drafts with a `yolk-conformance run-` subject (delete them), --work-message in Trash (untrash it and restore its labels), events titled `yolk-conformance run-` in --calendar (delete them; they have no attendees), and items named `yolk-conformance run-` in --drive-folder or the Drive Trash (delete them). A message the send case sent stays in Sent and at --practice-address (the run id is printed when it runs): Gmail cannot unsend.',
  nameKeys: /^(?:name|summary|displayName|filename|originalFilename|title)$/,
  textKeys: /^(?:snippet|description|value|raw|data|body)$/
} satisfies ConnectorConformanceRunner<
  GoogleConformanceSeedKey,
  GoogleConformanceSeeds,
  GoogleConformanceError,
  GoogleConformanceRequirements
>

/** Gitignored root of staged Google recordings. */
export const recordingsRoot = recordingsRootFor(googleRunner.provider)

const invokedAsCli = (): boolean => {
  const invoked = process.argv[1]

  return invoked !== undefined && resolve(invoked) === fileURLToPath(import.meta.url)
}

if (invokedAsCli()) {
  runConnectorConformanceCli(googleRunner)
}
