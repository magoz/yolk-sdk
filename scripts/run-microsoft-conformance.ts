/**
 * Microsoft Graph conformance runner for a Microsoft 365 practice tenant.
 *
 * Default: DRY RUN. Prints every case id, its safety, and whether it would run under the chosen
 * flags, then exits without any network call.
 *
 * `--live --owner-approved --account <label>`: runs the cases against the real Microsoft Graph API
 * with a `FetchHttpClient`: Outlook, OneDrive, SharePoint site, and Teams cases through the real
 * connector actions, calendar cases through raw Graph requests over the same connector ports (the
 * connector has no calendar actions yet). Refused whenever `CI` is non-empty (`0` and `false`
 * included) and without `--owner-approved` (the repository owner's explicit approval), in both
 * cases before any credential read. Requires `MICROSOFT_ACCESS_TOKEN` (environment only, never a
 * flag; a delegated token for the practice user with the scopes of the cases that will run, see
 * `usage`) and the seed identities of every case that will run (flags or environment, see
 * `usage`). The label is synthetic and non-identifying (for example `practice`): it is printed in
 * reports and recorded in fixtures. Read cases always run; `--allow-writes reversible` adds the
 * write-reversible cases, which create their own event, draft, or folder and always remove it
 * again. Nothing sends mail or invitations. The write-irreversible
 * `microsoft.teams.send-chat-message` posts one real message to the `--chat` practice chat that
 * the connector cannot remove; it runs only with `--allow-irreversible
 * microsoft.teams.send-chat-message` (`--allow-writes` never starts it), and its text names a fresh
 * random `runId` the runner generates per invocation (never a flag), printed before any case when
 * the send will run.
 *
 * `--record` (with `--live`) wraps the live client with the conformance `WireRecorder`. After the
 * run it builds `verified` fixtures (today's date, the account label) for the cases that passed,
 * re-runs each case on replay against its new fixture, and renders every fixture module plus the
 * seeds module. Only if every recorded case verified and passed the secret scan, no recorded
 * exchange carries the live access token (the shared `recordingContainsAccessToken`, before
 * rendering), and no rendered file or review-checklist line does either (`textCarriesSecret`),
 * does it write them, all or nothing, to a NEW run directory under the GITIGNORED root
 * `.conformance-recordings/microsoft/<YYYY-MM-DD>T<HHMMSS>Z-<random>/`: it writes the whole batch
 * into a sibling temp directory and publishes it with one rename, refuses an existing destination,
 * and leaves no run directory when anything fails. It never writes committed sources. Like the
 * shared connector runners (`connector-conformance-internal.ts`), it refuses a recordings directory
 * that is not physically where it appears to be (every component checked with lstat, symlinks
 * refused, dangling ones included, re-checked before the rename); this guards against
 * misconfiguration, not a concurrent local process. It then prints a review checklist (email-like
 * strings outside `example.test`/`example.com`, names, subjects, and chat topics, body text, tenant
 * URLs and tenant GUIDs, binary bodies, and shared seeds that changed).
 *
 * Live runs are interruptible (the shared `runInterruptibly`): the first SIGINT/SIGTERM interrupts
 * the run fiber, so a running write case still attempts its uninterruptible removal of the event,
 * draft, or folder it created, and a removal that fails meanwhile prints a WARN line naming the
 * case (`ConformanceCleanupReporter`, provided by `runMicrosoftLive`); a duplicate signal within
 * `duplicateSignalWindowMs` (one Ctrl-C reaches every process of the foreground group) is ignored,
 * and a later one force-exits. An interrupt-only exit is 130.
 *
 * Every line a live run prints (the report, cleanup WARN lines, staging output, the run's own
 * failure, and the interruption messages) goes through the shared `redactAccessToken`
 * (`redactingLiveRunIo`, `redactingCliIo`), as in the shared runners: Graph can echo the live token
 * into a field a case reports before any staging guard runs.
 *
 * Microsoft keeps its own runner rather than the shared `ConnectorConformanceRunner`: its review
 * checklist flags practice-tenant SharePoint hosts, and its credential and seeds module differ.
 *
 * Promotion is manual: scrub the staged files of practice-tenant data (user names, tenant host
 * names, and ids), copy them into `packages/connectors/src/microsoft/conformance/`, run
 * `pnpm format:fix`, and update `packages/connectors/test/microsoft-conformance.test.ts` and
 * `scripts/test/run-microsoft-conformance.test.ts` in the same change: promoted fixtures change the
 * fixture ids (`.recorded`), `evidence` (`verified`), `account`, and the exchange indices and
 * bodies the drills rely on. The recorder keeps only allowlisted request headers, so recorded
 * fixtures lose the `prefer` headers the synthetic ones show.
 *
 * Never run live in CI.
 */
import { randomBytes } from 'node:crypto'
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'
import { Effect, Layer, Option, Predicate, Ref } from 'effect'
import * as Schema from 'effect/Schema'
import { HttpClient } from 'effect/http'
import type { ConformanceSafety } from '../packages/conformance/src/case.ts'
import {
  isWireBase64BodyResponse,
  isWireStreamResponse,
  type WireFixture
} from '../packages/conformance/src/fixture.ts'
import {
  makeRecordingHttpClient,
  makeWireFixture,
  type WireRecorderApi
} from '../packages/conformance/src/record.ts'
import { ReplayHttpClient } from '../packages/conformance/src/replay.ts'
import {
  conformanceReportFailed,
  conformanceSkipReason,
  formatConformanceReport,
  runConformance,
  type ConformanceReport,
  type ConformanceSkipReason,
  type ConformanceTarget
} from '../packages/conformance/src/runner.ts'
import {
  connectorHttpClientsFromEffectHttpClientLayer,
  staticCredentialResolverLayer
} from '../packages/connectors/src/conformance/index.ts'
import { ConformanceCleanupReporter } from '../packages/connectors/src/conformance/cleanup-reporter.ts'
import { OAuthCredential } from '../packages/connectors/src/credential.ts'
import {
  MicrosoftConformanceConfig,
  MicrosoftConformanceSeeds,
  microsoftConformanceCases,
  microsoftConformanceFixtureSeeds,
  type MicrosoftConformanceCase,
  type MicrosoftConformanceSeedKey
} from '../packages/connectors/src/microsoft/conformance/index.ts'
import { microsoftGraphApiBaseUrl } from '../packages/connectors/src/microsoft/index.ts'
import {
  liveInCiMessage,
  nodeRecordingWriter,
  ownerApprovalRequiredMessage,
  physicallyContained,
  processCliIo,
  processLiveRunIo,
  processSignals,
  recordingContainsAccessToken,
  redactingCliIo,
  redactingLiveRunIo,
  runInterruptibly,
  stderrCleanupReporter,
  textCarriesSecret,
  unknownArgumentMessage,
  type CliIo,
  type LiveRunIo,
  type RecordingWriter,
  type RunInterruptiblyOptions,
  type SignalSource
} from './connector-conformance-internal.ts'
import { isCiEnvironment, workspaceRoot } from './fixture-probe-internal.ts'

type SeedSource = {
  readonly key: MicrosoftConformanceSeedKey
  readonly flag: string
  readonly env: string
  readonly description: string
}

/** Where each seed identity comes from. Flags win over environment variables. */
export const microsoftSeedSources: ReadonlyArray<SeedSource> = [
  {
    key: 'mailbox',
    flag: '--mailbox',
    env: 'MICROSOFT_CONFORMANCE_MAILBOX',
    description: 'practice mailbox (UPN or id); optional, default /me'
  },
  {
    key: 'calendarId',
    flag: '--calendar',
    env: 'MICROSOFT_CONFORMANCE_CALENDAR',
    description: 'calendar id; optional, default calendar'
  },
  {
    key: 'calendarRangeStart',
    flag: '--range-start',
    env: 'MICROSOFT_CONFORMANCE_RANGE_START',
    description: 'start of a range with known events (ISO UTC, e.g. 2026-09-21T00:00:00Z)'
  },
  {
    key: 'calendarRangeEnd',
    flag: '--range-end',
    env: 'MICROSOFT_CONFORMANCE_RANGE_END',
    description: 'end of that range (ISO UTC, exclusive)'
  },
  {
    key: 'calendarEventId',
    flag: '--event',
    env: 'MICROSOFT_CONFORMANCE_EVENT',
    description: 'known event in the range (among its first 50 events)'
  },
  {
    key: 'calendarEventStart',
    flag: '--event-start',
    env: 'MICROSOFT_CONFORMANCE_EVENT_START',
    description: "that event's start instant (ISO UTC, at most milliseconds)"
  },
  {
    key: 'attachmentMessageId',
    flag: '--attachment-message',
    env: 'MICROSOFT_CONFORMANCE_ATTACHMENT_MESSAGE',
    description: 'message with an inline and a regular file attachment'
  },
  {
    key: 'pagingFolderId',
    flag: '--paging-folder',
    env: 'MICROSOFT_CONFORMANCE_PAGING_FOLDER',
    description: 'mail folder holding more than two messages'
  },
  {
    key: 'driveId',
    flag: '--drive',
    env: 'MICROSOFT_CONFORMANCE_DRIVE',
    description: 'drive id; optional for the folder case, required for copy'
  },
  {
    key: 'driveParentItemId',
    flag: '--drive-parent',
    env: 'MICROSOFT_CONFORMANCE_DRIVE_PARENT',
    description: 'concrete folder id (not root) the cases create their own folders under'
  },
  {
    key: 'copySourceItemId',
    flag: '--copy-source',
    env: 'MICROSOFT_CONFORMANCE_COPY_SOURCE',
    description: 'small file the copy case copies into its own folder'
  },
  {
    key: 'siteSearchQuery',
    flag: '--site-query',
    env: 'MICROSOFT_CONFORMANCE_SITE_QUERY',
    description: 'keyword sharepoint.search_sites finds the --site site with (first page)'
  },
  {
    key: 'siteId',
    flag: '--site',
    env: 'MICROSOFT_CONFORMANCE_SITE',
    description: 'SharePoint site id ({hostname},{collection-id},{web-id}) with a library'
  },
  {
    key: 'chatId',
    flag: '--chat',
    env: 'MICROSOFT_CONFORMANCE_CHAT',
    description: 'practice Teams chat with more than two messages (the send posts there)'
  },
  {
    key: 'teamId',
    flag: '--team',
    env: 'MICROSOFT_CONFORMANCE_TEAM',
    description: 'team the signed-in user joined'
  },
  {
    key: 'channelId',
    flag: '--channel',
    env: 'MICROSOFT_CONFORMANCE_CHANNEL',
    description: 'channel of that team (on the first page of its channels)'
  },
  {
    key: 'channelMessageId',
    flag: '--channel-message',
    env: 'MICROSOFT_CONFORMANCE_CHANNEL_MESSAGE',
    description: 'top-level post of that channel with at least one reply'
  },
  {
    key: 'meetingJoinWebUrl',
    flag: '--meeting-join-url',
    env: 'MICROSOFT_CONFORMANCE_MEETING_JOIN_URL',
    description: 'https://teams.microsoft.com join link of a transcribed meeting'
  }
]

/**
 * Seeds the live runner generates itself, fresh per invocation (never flags or environment): the
 * send case's invocation-unique `runId`. Case specs list them; they are never reported missing,
 * and they are rendered into the staged seeds module like any other seed.
 */
export const microsoftGeneratedSeedKeys: ReadonlyArray<MicrosoftConformanceSeedKey> = ['runId']

/** A fresh `run-<8 hex>` run id for one live invocation. */
export const generateRunId = (): string => `run-${randomBytes(4).toString('hex')}`

export type MicrosoftCaseSpec = {
  readonly caseId: string
  /** Seeds the case cannot run without. */
  readonly seeds: ReadonlyArray<MicrosoftConformanceSeedKey>
  /** Seeds the case uses when present (they change the recorded URLs). */
  readonly optionalSeeds: ReadonlyArray<MicrosoftConformanceSeedKey>
  readonly fileName: string
  readonly exportName: string
  readonly doc: string
}

const calendarSeeds: ReadonlyArray<MicrosoftConformanceSeedKey> = ['mailbox', 'calendarId']

/** Seeds each case needs, and the fixture module `--record` rewrites for it. */
export const microsoftCaseSpecs: ReadonlyArray<MicrosoftCaseSpec> = [
  {
    caseId: 'microsoft.calendar.list-range-returns-events',
    seeds: ['calendarRangeStart', 'calendarRangeEnd', 'calendarEventId'],
    optionalSeeds: calendarSeeds,
    fileName: 'calendar-list-range.ts',
    exportName: 'microsoftCalendarListRangeFixture',
    doc: 'One calendar view page over the seeded range.'
  },
  {
    caseId: 'microsoft.calendar.timestamp-precision',
    seeds: ['calendarRangeStart', 'calendarRangeEnd', 'calendarEventId', 'calendarEventStart'],
    optionalSeeds: calendarSeeds,
    fileName: 'calendar-timestamp-precision.ts',
    exportName: 'microsoftCalendarTimestampPrecisionFixture',
    doc: 'The seeded range view and the seeded event, both with seven-digit fractional UTC `dateTime` values.'
  },
  {
    caseId: 'microsoft.calendar.create-returns-event-id',
    seeds: [],
    optionalSeeds: calendarSeeds,
    fileName: 'calendar-create-event.ts',
    exportName: 'microsoftCalendarCreateEventFixture',
    doc: 'Event create, GET, PATCH, DELETE, and a final GET with the returned id.'
  },
  {
    caseId: 'microsoft.calendar.cancel-semantics',
    seeds: [],
    optionalSeeds: calendarSeeds,
    fileName: 'calendar-cancel.ts',
    exportName: 'microsoftCalendarCancelFixture',
    doc: 'Event create, cancel, GET after cancel, and DELETE after cancel.'
  },
  {
    caseId: 'microsoft.outlook.attachments-listing',
    seeds: ['attachmentMessageId'],
    optionalSeeds: ['mailbox'],
    fileName: 'outlook-attachments-listing.ts',
    exportName: 'microsoftOutlookAttachmentsListingFixture',
    doc: 'Attachment listing and retrieval of each listed file attachment.'
  },
  {
    caseId: 'microsoft.outlook.attachment-content-id',
    seeds: ['attachmentMessageId'],
    optionalSeeds: ['mailbox'],
    fileName: 'outlook-attachment-content-id.ts',
    exportName: 'microsoftOutlookAttachmentContentIdFixture',
    doc: 'Attachment listing without `contentId`, then the inline file attachment with its `contentId`.'
  },
  {
    caseId: 'microsoft.outlook.paging-next-link',
    seeds: ['pagingFolderId'],
    optionalSeeds: ['mailbox'],
    fileName: 'outlook-paging-next-link.ts',
    exportName: 'microsoftOutlookPagingNextLinkFixture',
    doc: 'A two-message first page with `@odata.nextLink`, then the page the link returns.'
  },
  {
    caseId: 'microsoft.outlook.immutable-id-survives-move',
    seeds: [],
    optionalSeeds: ['mailbox'],
    fileName: 'outlook-immutable-id.ts',
    exportName: 'microsoftOutlookImmutableIdFixture',
    doc: 'Draft create, move to Deleted Items keeping the immutable id, mark read by the original id, then the permanent-delete batch.'
  },
  {
    caseId: 'microsoft.outlook.concurrent-writes-same-message',
    seeds: [],
    optionalSeeds: ['mailbox'],
    fileName: 'outlook-concurrent-writes.ts',
    exportName: 'microsoftOutlookConcurrentWritesFixture',
    doc: 'Draft create, two concurrent PATCHes, then the permanent-delete batch.'
  },
  {
    caseId: 'microsoft.onedrive.create-folder-roundtrip',
    seeds: ['driveParentItemId'],
    optionalSeeds: ['driveId'],
    fileName: 'onedrive-create-folder.ts',
    exportName: 'microsoftOneDriveCreateFolderFixture',
    doc: 'Folder create, parent listing, DELETE, and GET of the deleted folder.'
  },
  {
    caseId: 'microsoft.onedrive.copy-accepted-monitor',
    seeds: ['driveId', 'driveParentItemId', 'copySourceItemId'],
    optionalSeeds: [],
    fileName: 'onedrive-copy-monitor.ts',
    exportName: 'microsoftOneDriveCopyMonitorFixture',
    doc: 'Source read, folder create, copy accepted with a monitor `Location`, status polls, the folder listing, and the folder removal.'
  },
  {
    caseId: 'microsoft.sharepoint.search-finds-site',
    seeds: ['siteSearchQuery', 'siteId'],
    optionalSeeds: [],
    fileName: 'sharepoint-search-sites.ts',
    exportName: 'microsoftSharePointSearchSitesFixture',
    doc: 'A keyword site search that lists the seeded team site with its comma-separated site id.'
  },
  {
    caseId: 'microsoft.sharepoint.site-drives-libraries',
    seeds: ['siteId'],
    optionalSeeds: [],
    fileName: 'sharepoint-site-drives.ts',
    exportName: 'microsoftSharePointSiteDrivesFixture',
    doc: "The seeded site's document libraries, listed by its site id with literal commas."
  },
  {
    caseId: 'microsoft.teams.chats-list-members',
    seeds: [],
    optionalSeeds: [],
    fileName: 'teams-chats-list.ts',
    exportName: 'microsoftTeamsChatsListMembersFixture',
    doc: "A page of the signed-in user's chats with their members, then the first chat by id."
  },
  {
    caseId: 'microsoft.teams.chat-messages-paging',
    seeds: ['chatId'],
    optionalSeeds: [],
    fileName: 'teams-chat-messages-paging.ts',
    exportName: 'microsoftTeamsChatMessagesPagingFixture',
    doc: 'A two-message first page of the seeded chat with `@odata.nextLink`, the page the link returns, and the first message by id.'
  },
  {
    caseId: 'microsoft.teams.team-channels',
    seeds: ['teamId', 'channelId'],
    optionalSeeds: [],
    fileName: 'teams-team-channels.ts',
    exportName: 'microsoftTeamsTeamChannelsFixture',
    doc: 'The joined teams, the seeded team by id, its channels, and the seeded channel by id.'
  },
  {
    caseId: 'microsoft.teams.channel-message-replies',
    seeds: ['teamId', 'channelId', 'channelMessageId'],
    optionalSeeds: [],
    fileName: 'teams-channel-replies.ts',
    exportName: 'microsoftTeamsChannelMessageRepliesFixture',
    doc: "The seeded channel's top-level posts, the seeded post by id, and its replies."
  },
  {
    caseId: 'microsoft.teams.meeting-transcripts',
    seeds: ['meetingJoinWebUrl'],
    optionalSeeds: [],
    fileName: 'teams-meeting-transcripts.ts',
    exportName: 'microsoftTeamsMeetingTranscriptsFixture',
    doc: 'The seeded meeting found by its join link, then its transcripts by meeting id.'
  },
  {
    caseId: 'microsoft.teams.send-chat-message',
    seeds: ['chatId', 'runId'],
    optionalSeeds: [],
    fileName: 'teams-send-chat-message.ts',
    exportName: 'microsoftTeamsSendChatMessageFixture',
    doc: 'A plain-text message posted to the seeded chat (escaped HTML, `<br>` line break), then read back by the returned id.'
  }
]

/** Ids of the write-irreversible cases (the only values `--allow-irreversible` takes). */
export const microsoftIrreversibleCaseIds: ReadonlyArray<string> = microsoftConformanceCases
  .filter(testCase => testCase.safety === 'write-irreversible')
  .map(testCase => testCase.id)

export type RunOptions = {
  readonly live: boolean
  readonly help: boolean
  readonly record: boolean
  /** Explicit confirmation that the repository owner approved this live run. */
  readonly ownerApproved: boolean
  /** Synthetic, non-identifying account label. Required with `--live`. */
  readonly account: string | undefined
  readonly allowWrites: 'none' | 'reversible'
  /** Exact ids of write-irreversible cases a person explicitly started (`--allow-irreversible`). */
  readonly allowIrreversible: ReadonlyArray<string>
  /** Raw seed identities from flags or environment (validated before a live run). */
  readonly seeds: Readonly<Partial<Record<MicrosoftConformanceSeedKey, string>>>
}

export const defaultRunOptions: RunOptions = {
  live: false,
  help: false,
  record: false,
  ownerApproved: false,
  account: undefined,
  allowWrites: 'none',
  allowIrreversible: [],
  seeds: {}
}

const accountLabelPattern = /^[a-z0-9]+(?:-[a-z0-9]+)*$/

export const liveAccountRequiredMessage =
  '--live requires --account <label>: a synthetic, non-identifying label (for example practice)'

export const accessTokenRequiredMessage = 'MICROSOFT_ACCESS_TOKEN is required for --live'

const usage = `Usage: pnpm conformance:microsoft [--live --owner-approved --account <label>] [options]

Dry run by default: prints each case, its safety, and whether it would run. No network I/O and no
credential read.

Options:
  --live                          Run against the real Microsoft Graph API (needs
                                  --owner-approved, MICROSOFT_ACCESS_TOKEN, --account, and the
                                  seeds of every case that will run; refused whenever CI is
                                  non-empty)
  --owner-approved                confirm the repository owner approved this live run
  --account <label>               required with --live: synthetic, non-identifying label
                                  (lower-case letters, digits, hyphens; for example practice)
  --allow-writes <none|reversible>
                                  default none; reversible runs the write-reversible cases (each
                                  creates its own event, draft, or folder and removes it again)
  --allow-irreversible <case-id>  run this exact write-irreversible case, which cannot be undone
                                  (repeatable; only microsoft.teams.send-chat-message, which posts
                                  a real message naming a fresh run id to the --chat chat)
  --record                        with --live: record the cases that passed, verify on replay,
                                  and stage them in a new run directory under
                                  .conformance-recordings/microsoft/ (gitignored) for manual
                                  scrubbing and promotion
${microsoftSeedSources
  .map(
    source =>
      `  ${`${source.flag} <value>`.padEnd(32)}${source.description}\n${' '.repeat(34)}(env ${source.env})`
  )
  .join('\n')}
  --help

MICROSOFT_ACCESS_TOKEN is read from the environment only: a delegated token for the practice
user with the scopes of the cases that will run (Mail.ReadWrite, Calendars.ReadWrite, and
Files.ReadWrite; Sites.Read.All for the SharePoint site cases; Chat.Read, Team.ReadBasic.All,
Channel.ReadBasic.All, ChannelMessage.Read.All, OnlineMeetings.Read, and
OnlineMeetingTranscript.Read.All for the Teams reads; ChatMessage.Send for the Teams send). Use a
practice tenant, never a real one, and never run live in CI. Recordings are never written over
committed fixtures: scrub the staged files, copy them into
packages/connectors/src/microsoft/conformance/, and update the Microsoft conformance tests in the
same change (fixture ids, evidence, and account change).`

/**
 * Parse CLI arguments (without the node/script prefix) and seed environment variables. Throws on
 * unknown flags, missing values, invalid labels, an `--allow-irreversible` value that is not the
 * exact id of a write-irreversible case, `--record` without `--live`, and `--live` in CI (`CI`
 * non-empty), without `--owner-approved`, or without `--account`.
 */
export const parseRunArgs = (
  argv: ReadonlyArray<string>,
  env: Readonly<Record<string, string | undefined>> = {}
): RunOptions => {
  let live = false
  let help = false
  let record = false
  let ownerApproved = false
  let account: string | undefined
  let allowWrites: RunOptions['allowWrites'] = 'none'
  const allowIrreversible: Array<string> = []
  const seeds: Partial<Record<MicrosoftConformanceSeedKey, string>> = {}

  for (const source of microsoftSeedSources) {
    const value = env[source.env]?.trim()

    if (value !== undefined && value.length > 0) {
      seeds[source.key] = value
    }
  }

  for (let index = 0; index < argv.length; index++) {
    const argument = argv[index] ?? ''
    const equals = argument.indexOf('=')
    const flag = equals === -1 ? argument : argument.slice(0, equals)
    const inline = equals === -1 ? undefined : argument.slice(equals + 1)

    const value = () => {
      const next = inline ?? argv[++index]

      if (next === undefined || next.length === 0) {
        throw new Error(`${flag} requires a value`)
      }

      return next
    }

    const seed = microsoftSeedSources.find(source => source.flag === flag)

    if (seed !== undefined) {
      seeds[seed.key] = value()
      continue
    }

    switch (flag) {
      case '--live':
        live = true
        break
      case '--owner-approved':
        ownerApproved = true
        break
      case '--help':
      case '-h':
        help = true
        break
      case '--record':
        record = true
        break
      case '--account': {
        const label = value()

        if (!accountLabelPattern.test(label) || label.length > 40) {
          throw new Error(
            '--account must be a short synthetic label of lower-case letters, digits, and hyphens'
          )
        }

        account = label
        break
      }

      case '--allow-writes': {
        const mode = value()

        if (mode !== 'none' && mode !== 'reversible') {
          throw new Error('--allow-writes must be none or reversible')
        }

        allowWrites = mode
        break
      }

      case '--allow-irreversible': {
        const caseId = value()

        if (!microsoftIrreversibleCaseIds.includes(caseId)) {
          throw new Error(
            `--allow-irreversible takes an exact write-irreversible case id: ${microsoftIrreversibleCaseIds.join(', ')}`
          )
        }

        if (!allowIrreversible.includes(caseId)) {
          allowIrreversible.push(caseId)
        }

        break
      }

      default:
        throw new Error(unknownArgumentMessage)
    }
  }

  if (!help && record && !live) {
    throw new Error('--record requires --live')
  }

  if (!help && live && isCiEnvironment(env)) {
    throw new Error(liveInCiMessage)
  }

  if (!help && live && !ownerApproved) {
    throw new Error(ownerApprovalRequiredMessage)
  }

  if (!help && live && account === undefined) {
    throw new Error(liveAccountRequiredMessage)
  }

  return { live, help, record, ownerApproved, account, allowWrites, allowIrreversible, seeds }
}

/** The live target the chosen flags describe (the dry run plans against the same target). */
export const liveTarget = (options: RunOptions): ConformanceTarget => ({
  kind: 'live',
  account: options.account ?? 'dry-run',
  allowWrites: options.allowWrites,
  allowIrreversible: options.allowIrreversible
})

const specFor = (caseId: string): MicrosoftCaseSpec | undefined =>
  microsoftCaseSpecs.find(spec => spec.caseId === caseId)

export type PlannedCase = {
  readonly id: string
  readonly safety: ConformanceSafety
  readonly skipReason: ConformanceSkipReason | undefined
  /** Seeds this case needs that the flags/environment do not supply. */
  readonly missingSeeds: ReadonlyArray<MicrosoftConformanceSeedKey>
}

/** Pure plan: which cases run live under these flags, and which seeds they still need. */
export const planMicrosoftRun = (options: RunOptions): ReadonlyArray<PlannedCase> =>
  microsoftConformanceCases.map(testCase => ({
    id: testCase.id,
    safety: testCase.safety,
    skipReason: conformanceSkipReason(liveTarget(options), testCase),
    missingSeeds: (specFor(testCase.id)?.seeds ?? []).filter(
      key => options.seeds[key] === undefined && !microsoftGeneratedSeedKeys.includes(key)
    )
  }))

const seedFlag = (key: MicrosoftConformanceSeedKey): string =>
  microsoftSeedSources.find(source => source.key === key)?.flag ?? key

export const dryRunReport = (options: RunOptions): string => {
  const planned = planMicrosoftRun(options)

  const lines = planned.map(entry => {
    const status = entry.skipReason === undefined ? 'RUN ' : 'SKIP'
    const detail = entry.skipReason ?? ''

    const missing =
      entry.skipReason === undefined && entry.missingSeeds.length > 0
        ? `needs ${entry.missingSeeds.map(seedFlag).join(', ')}`
        : ''

    return [status, entry.id, `[${entry.safety}]`, detail, missing]
      .filter(part => part.length > 0)
      .join('  ')
  })

  return [
    'DRY RUN: no network request was made and no credential was read. Pass --live --owner-approved --account <label> to run (needs MICROSOFT_ACCESS_TOKEN).',
    `Plan for a live target: allowWrites=${options.allowWrites}${options.allowIrreversible.length === 0 ? '' : `, allowIrreversible=[${options.allowIrreversible.join(', ')}]`}${options.record ? ', record' : ''}`,
    ...lines,
    "Use a Microsoft 365 practice tenant only, with the repository owner's approval; never in CI. Write-reversible cases create their own event, draft, or folder and remove it again; nothing sends mail or invitations.",
    'The write-irreversible microsoft.teams.send-chat-message case posts a real message naming a fresh run id to --chat that the connector cannot remove; it runs only with --allow-irreversible microsoft.teams.send-chat-message.'
  ].join('\n')
}

export type LiveInputs = {
  readonly account: string
  readonly accessToken: string
  readonly seeds: MicrosoftConformanceSeeds
}

const decodeSeeds = Schema.decodeUnknownOption(MicrosoftConformanceSeeds)

/**
 * Everything a live run needs, or why it must refuse (before any network): CI, a missing owner
 * approval, account label, or access token, missing seeds for cases that will run, or seeds that
 * are not valid.
 */
export const liveInputs = (
  options: RunOptions,
  env: Readonly<Record<string, string | undefined>>,
  runId: string = generateRunId()
): { readonly refusal: string } | { readonly inputs: LiveInputs } => {
  if (isCiEnvironment(env)) {
    return { refusal: liveInCiMessage }
  }

  if (!options.ownerApproved) {
    return { refusal: ownerApprovalRequiredMessage }
  }

  if (options.account === undefined) {
    return { refusal: liveAccountRequiredMessage }
  }

  const accessToken = env.MICROSOFT_ACCESS_TOKEN?.trim()

  if (accessToken === undefined || accessToken.length === 0) {
    return { refusal: accessTokenRequiredMessage }
  }

  const missing = planMicrosoftRun(options)
    .filter(entry => entry.skipReason === undefined)
    .flatMap(entry => entry.missingSeeds)

  if (missing.length > 0) {
    const flags = [...new Set(missing)].map(seedFlag)

    return { refusal: `Missing seed identities for the cases that would run: ${flags.join(', ')}` }
  }

  // The generated run id is merged over the flag/environment seeds (it is never a flag).
  const seeds = decodeSeeds({ ...options.seeds, runId })

  if (Option.isNone(seeds)) {
    return {
      refusal:
        'Seed identities must be non-empty trimmed values, and --range-start, --range-end, and --event-start ISO UTC instants (for example 2026-09-21T00:00:00Z)'
    }
  }

  return { inputs: { account: options.account, accessToken, seeds: seeds.value } }
}

export class MicrosoftRunFailed extends Schema.TaggedError<MicrosoftRunFailed>()(
  'MicrosoftRunFailed',
  { message: Schema.String }
) {}

export const recordedTokenRefusal =
  'A recorded exchange contains the live access token; nothing was written'

export const renderedTokenRefusal =
  'The staged files or the review checklist would contain the live access token; nothing was written'

/** Gitignored root of staged recordings; one new directory per `--record` run. */
export const recordingsRoot = join(workspaceRoot, '.conformance-recordings', 'microsoft')

const committedSources = join(workspaceRoot, 'packages')

const isInside = (child: string, parent: string): boolean => {
  const path = relative(resolve(parent), resolve(child))

  return path === '' || (!path.startsWith('..') && !isAbsolute(path))
}

/**
 * The live credential: a delegated OAuth token whose `accountId` is the mailbox seed (so the
 * connector keeps ordinary Mail.* scopes for its own mailbox).
 */
export const liveCredential = (accessToken: string, seeds: MicrosoftConformanceSeeds) => {
  const expiresAt = Date.now() + 60 * 60 * 1000

  return seeds.mailbox === undefined
    ? OAuthCredential.make({ provider: 'microsoft', accessToken, expiresAt })
    : OAuthCredential.make({
        provider: 'microsoft',
        accessToken,
        expiresAt,
        accountId: seeds.mailbox
      })
}

const casePorts = (
  httpLayer: Layer.Layer<HttpClient.HttpClient>,
  accessToken: string,
  seeds: MicrosoftConformanceSeeds
) =>
  Layer.mergeAll(
    connectorHttpClientsFromEffectHttpClientLayer.pipe(Layer.provide(httpLayer)),
    staticCredentialResolverLayer(liveCredential(accessToken, seeds)),
    Layer.succeed(MicrosoftConformanceConfig, seeds)
  )

export const renderFixtureModule = (spec: MicrosoftCaseSpec, fixture: WireFixture): string =>
  [
    "import type { WireFixture } from '@yolk-sdk/conformance/fixture'",
    '',
    '/**',
    ` * ${spec.doc}`,
    ' *',
    ` * Verified recording (${fixture.recordedAt}), scrubbed and promoted by hand from`,
    ' * `pnpm conformance:microsoft --live --owner-approved --account <label> --record`.',
    ' */',
    `export const ${spec.exportName}: WireFixture = ${JSON.stringify(fixture, null, 2)}`,
    ''
  ].join('\n')

const quoted = (value: string): string =>
  /^[^'\\\u0000-\u001f\u007f\u2028\u2029]*$/u.test(value) ? `'${value}'` : JSON.stringify(value)

/** Every seed key in the seeds module's order: the flag/environment seeds, then generated ones. */
const seedKeys: ReadonlyArray<MicrosoftConformanceSeedKey> = [
  ...microsoftSeedSources.map(source => source.key),
  ...microsoftGeneratedSeedKeys
]

/** Longest line Oxfmt keeps on one line in the committed seeds module. */
const seedLineWidth = 100

/**
 * One `key: value` entry (`separator` is the `,` every entry but the last ends with), moved onto
 * its own line as Oxfmt does when the entry would pass the width.
 */
const seedEntry = (key: string, value: string, separator: string): string => {
  const line = `  ${key}: ${quoted(value)}${separator}`

  return line.length > seedLineWidth ? `  ${key}:\n    ${quoted(value)}${separator}` : line
}

/** The seeds module, in the exact committed format. */
export const renderSeedsModule = (seeds: MicrosoftConformanceSeeds): string => {
  const present = seedKeys.flatMap(key => {
    const value = seeds[key]

    return value === undefined ? [] : [{ key, value }]
  })

  const entries = present.map(({ key, value }, index) =>
    seedEntry(key, value, index === present.length - 1 ? '' : ',')
  )

  return [
    "import type { MicrosoftConformanceSeeds } from './cases.ts'",
    '',
    '/**',
    ' * Seed identities the committed Microsoft fixtures were recorded with. Replaying the fixtures needs',
    ' * these exact seeds in `MicrosoftConformanceConfig`. `pnpm conformance:microsoft --record` stages an',
    ' * updated copy for manual promotion together with the fixtures it records.',
    ' */',
    'export const microsoftConformanceFixtureSeeds: MicrosoftConformanceSeeds = {',
    entries.join('\n'),
    '}',
    ''
  ].join('\n')
}

type MutableSeeds = {
  -readonly [K in MicrosoftConformanceSeedKey]?: MicrosoftConformanceSeeds[K]
}

const seedsUsedBy = (caseId: string): ReadonlyArray<MicrosoftConformanceSeedKey> => {
  const spec = specFor(caseId)

  return spec === undefined ? [] : [...spec.seeds, ...spec.optionalSeeds]
}

/** Seeds for the committed fixtures after recording `recorded` with `live` seeds. */
export const mergedFixtureSeeds = (
  current: MicrosoftConformanceSeeds,
  live: MicrosoftConformanceSeeds,
  recorded: ReadonlyArray<string>
): MicrosoftConformanceSeeds => {
  const keys = new Set(recorded.flatMap(seedsUsedBy))
  const merged: MutableSeeds = { ...current }

  for (const key of keys) {
    const value = live[key]

    if (value === undefined) {
      delete merged[key]
    } else {
      merged[key] = value
    }
  }

  return merged
}

/**
 * Seeds that changed in the merged seeds module but are also used by committed fixtures that were
 * NOT recorded in this run (for example the mailbox): those fixtures no longer replay with the new
 * seeds, so a person must re-record or re-scrub them before promoting.
 */
export const staleSharedSeeds = (
  current: MicrosoftConformanceSeeds,
  merged: MicrosoftConformanceSeeds,
  recorded: ReadonlyArray<string>
): ReadonlyArray<{
  readonly key: MicrosoftConformanceSeedKey
  readonly cases: ReadonlyArray<string>
}> =>
  seedKeys.flatMap(key => {
    if (current[key] === merged[key]) {
      return []
    }

    const cases = microsoftCaseSpecs.flatMap(spec =>
      !recorded.includes(spec.caseId) && seedsUsedBy(spec.caseId).includes(key) ? [spec.caseId] : []
    )

    return cases.length === 0 ? [] : [{ key, cases }]
  })

type RecordedFixture = {
  readonly testCase: MicrosoftConformanceCase
  readonly spec: MicrosoftCaseSpec
  readonly fixture: WireFixture
}

/** Build a verified fixture for one passed case and prove it replays with the same case. */
const verifiedFixture = (
  testCase: MicrosoftConformanceCase,
  recorder: WireRecorderApi,
  inputs: LiveInputs,
  recordedAt: string
) =>
  Effect.gen(function* () {
    const spec = specFor(testCase.id)

    if (spec === undefined) {
      return yield* new MicrosoftRunFailed({ message: `No fixture module for ${testCase.id}` })
    }

    const exchanges = yield* recorder.drain

    const fixture = yield* makeWireFixture({
      id: `${testCase.id}.recorded`,
      caseId: testCase.id,
      evidence: 'verified',
      recordedAt,
      account: inputs.account,
      endpoint: microsoftGraphApiBaseUrl,
      note: 'Recorded from a Microsoft 365 practice tenant by pnpm conformance:microsoft --live --record.',
      exchanges
    })

    const replayed = yield* runConformance([testCase], {
      target: { kind: 'replay' },
      layer: () => casePorts(ReplayHttpClient.layer([fixture]), 'replay-access-token', inputs.seeds)
    })

    if (conformanceReportFailed(replayed)) {
      return yield* new MicrosoftRunFailed({
        message: `${testCase.id} did not pass on replay of its recording; nothing was written`
      })
    }

    return { testCase, spec, fixture }
  }).pipe(
    Effect.mapError(error =>
      error instanceof MicrosoftRunFailed
        ? error
        : new MicrosoftRunFailed({
            message: `${testCase.id}: recording rejected (${error._tag}); nothing was written`
          })
    )
  )

/**
 * A unique run directory name, `<YYYY-MM-DD>T<HHMMSS>Z-<suffix>` (UTC), so two recordings on the
 * same day never share a directory.
 */
export const recordingRunId = (now: Date, suffix: string): string => {
  const iso = now.toISOString()

  return `${iso.slice(0, 10)}T${iso.slice(11, 19).replaceAll(':', '')}Z-${suffix}`
}

const randomRunSuffix = (): string => randomBytes(4).toString('hex')

export type StageRecordingsOptions = {
  readonly writer: RecordingWriter
  /** The gitignored recordings root (defaults to `recordingsRoot`). */
  readonly recordingsRoot?: string
  /**
   * The directory the recordings root must physically stay inside (defaults to the workspace
   * root): every existing component between it and the run directory must resolve to exactly that
   * lexical location, so no symlink can redirect the writes.
   */
  readonly containmentRoot?: string
  /**
   * The run directory to publish; must be a new, direct child of the recordings root (for example
   * `join(recordingsRoot, recordingRunId(now, suffix))`).
   */
  readonly stagingDir: string
  /** `recordedAt` of the staged fixtures (`YYYY-MM-DD`). */
  readonly recordedAt: string
}

export type StagedRecordings = {
  readonly stagingDir: string
  readonly files: ReadonlyArray<string>
  readonly checklist: ReadonlyArray<string>
}

/** Email-address domains the committed fixtures may contain. */
const allowedEmailDomains = ['example.test', 'example.com']

const emailPattern = /[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g

const isAllowedEmail = (email: string): boolean => {
  const domain = email.slice(email.lastIndexOf('@') + 1).toLowerCase()

  return allowedEmailDomains.some(allowed => domain === allowed || domain.endsWith(`.${allowed}`))
}

/** Keys whose string values usually name a person, a thread (a Teams chat `topic`), or a file. */
const isNameKey = (key: string): boolean => /^(?:name|displayName|subject|topic)$/.test(key)

/** Keys whose string values hold message or event text. */
const isTextKey = (key: string): boolean => /^(?:bodyPreview|content)$/.test(key)

/** Host names that identify a tenant (SharePoint/OneDrive for Business). */
const tenantHostPattern = /\b[a-z0-9-]+(?:-my)?\.sharepoint\.com\b/gi

const syntheticTenantHost = /^synthetic(?:-my)?\.sharepoint\.com$/i

const guidSource = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}'

/**
 * Tenant GUIDs in text: a `tenantId=` URL parameter (Teams `webUrl` values) or a `"Tid":"…"` member
 * of a join link's percent-encoded `context` (Teams `joinWebUrl` values), found raw or once decoded.
 */
const tenantGuidPattern = new RegExp(`(?:tenantId=|"Tid"\\s*:\\s*")(${guidSource})`, 'gi')

const guidPattern = new RegExp(`^${guidSource}$`, 'i')

/** The synthetic GUIDs the committed fixtures use (`00000000-0000-4000-8000-…`). */
const syntheticGuid = /^00000000-0000-4000-8000-[0-9a-f]{12}$/i

/** `text` percent-decoded once, or unchanged when it is not valid percent-encoding. */
const percentDecoded = (text: string): string => {
  try {
    return decodeURIComponent(text)
  } catch {
    return text
  }
}

/** Tenant GUIDs a string carries: as a `tenantId` value, or in a URL or join-link context. */
const tenantGuids = (value: string, key: string | undefined): ReadonlyArray<string> => [
  ...(key === 'tenantId' && guidPattern.test(value) ? [value] : []),
  ...[value, percentDecoded(value)].flatMap(text =>
    [...text.matchAll(tenantGuidPattern)].flatMap(match =>
      match[1] === undefined ? [] : [match[1]]
    )
  )
]

type ReviewFindings = {
  readonly emails: Set<string>
  readonly names: Set<string>
  readonly texts: Set<string>
  readonly tenantHosts: Set<string>
  readonly tenantIds: Set<string>
}

const collectStrings = (value: unknown, key: string | undefined, found: ReviewFindings): void => {
  if (Predicate.isString(value)) {
    for (const email of value.match(emailPattern) ?? []) {
      if (!isAllowedEmail(email)) {
        found.emails.add(email)
      }
    }

    for (const host of value.match(tenantHostPattern) ?? []) {
      if (!syntheticTenantHost.test(host)) {
        found.tenantHosts.add(host.toLowerCase())
      }
    }

    for (const guid of tenantGuids(value, key)) {
      if (!syntheticGuid.test(guid)) {
        found.tenantIds.add(guid.toLowerCase())
      }
    }

    if (key !== undefined && value.trim().length > 0) {
      if (isTextKey(key)) found.texts.add(value)
      else if (isNameKey(key)) found.names.add(value)
    }

    return
  }

  if (Array.isArray(value)) {
    for (const item of value) collectStrings(item, key, found)

    return
  }

  if (Predicate.isObject(value)) {
    for (const [childKey, child] of Object.entries(value)) collectStrings(child, childKey, found)
  }
}

/** A text body as JSON when it parses, otherwise the raw text (still scanned for emails). */
const parsedText = (text: string): unknown => {
  try {
    return JSON.parse(text)
  } catch {
    return text
  }
}

const quotedList = (values: ReadonlySet<string>): string =>
  [...values].map(value => JSON.stringify(value)).join(', ')

/**
 * What a person must check in each staged fixture before promoting it: email-like strings outside
 * `example.test`/`example.com`, names, subjects, and chat topics, body text, tenant host names,
 * tenant GUIDs (`tenantId` values, `tenantId=` URL parameters, and join-link `Tid` members, except
 * the fixtures' synthetic `00000000-0000-4000-8000-…` ones), and binary bodies. The script only
 * lists candidates; it does not decide what is personal data.
 */
export const recordingReviewChecklist = (
  recorded: ReadonlyArray<{ readonly spec: MicrosoftCaseSpec; readonly fixture: WireFixture }>
): ReadonlyArray<string> => {
  const lines = [
    'REVIEW before promoting (staged files hold practice-tenant data):',
    '  also check ids, @odata.context URLs, webLink/webUrl values, and request-id GUIDs by hand'
  ]

  for (const { spec, fixture } of recorded) {
    const found: ReviewFindings = {
      emails: new Set(),
      names: new Set(),
      texts: new Set(),
      tenantHosts: new Set(),
      tenantIds: new Set()
    }

    let binaryBodies = 0

    for (const exchange of fixture.exchanges) {
      collectStrings(exchange.request.url, undefined, found)
      collectStrings(exchange.request.body, undefined, found)
      collectStrings(Object.values(exchange.response.headers), undefined, found)

      const { response } = exchange

      if (isWireBase64BodyResponse(response)) {
        binaryBodies += 1
      } else if (isWireStreamResponse(response)) {
        const text = response.chunks.map(chunk => (Predicate.isString(chunk) ? chunk : '')).join('')

        binaryBodies += response.chunks.some(chunk => !Predicate.isString(chunk)) ? 1 : 0
        collectStrings(parsedText(text), undefined, found)
      } else {
        collectStrings(parsedText(response.body), undefined, found)
      }
    }

    const items = [
      found.emails.size > 0
        ? `emails outside ${allowedEmailDomains.join('/')}: ${quotedList(found.emails)}`
        : undefined,
      found.tenantHosts.size > 0
        ? `tenant host names: ${quotedList(found.tenantHosts)}`
        : undefined,
      found.tenantIds.size > 0 ? `tenant GUIDs: ${quotedList(found.tenantIds)}` : undefined,
      found.names.size > 0 ? `names and subjects: ${quotedList(found.names)}` : undefined,
      found.texts.size > 0 ? `body text: ${quotedList(found.texts)}` : undefined,
      binaryBodies > 0 ? `${binaryBodies} binary body: open it and check its content` : undefined
    ].filter((item): item is string => item !== undefined)

    lines.push(
      `  ${spec.fileName}: ${items.length === 0 ? 'no candidates found; still read it' : ''}`.trimEnd(),
      ...items.map(item => `    - ${item}`)
    )
  }

  lines.push(
    'PROMOTE by hand: scrub, copy into packages/connectors/src/microsoft/conformance/, run pnpm format:fix,',
    '  and update the Microsoft conformance tests in the same change (fixture ids, evidence, account change).'
  )

  return lines
}

/**
 * The `--record` gate. Verifies every passed case's recording on replay (and the secret scan),
 * refuses the recordings if any exchange carries the live access token
 * (`recordingContainsAccessToken`), then renders every fixture module, the seeds module, and the
 * review checklist, refuses them if any carries the token (`textCarriesSecret`), writes the
 * files into a sibling temp directory (`<root>/.tmp-<run>`), and publishes it to
 * `options.stagingDir` with one rename. All or nothing: any failure (verification, either token
 * check, a write, or the rename) leaves no staging directory, and the temp directory is removed
 * (best effort). A staging directory that is not a direct child of the recordings root, that
 * already exists, or that is not physically inside the containment root (a symlinked or redirected
 * component, checked before and after creating the temp directory and again before the rename) is
 * refused. Returns `undefined` when no case passed.
 */
export const stageRecordings = (
  report: ConformanceReport,
  recorders: ReadonlyMap<string, WireRecorderApi>,
  inputs: LiveInputs,
  options: StageRecordingsOptions
) =>
  Effect.gen(function* () {
    const root = resolve(options.recordingsRoot ?? recordingsRoot)
    const stagingDir = resolve(options.stagingDir)
    const runName = basename(stagingDir)

    if (isInside(root, committedSources)) {
      return yield* new MicrosoftRunFailed({
        message: `Refusing a recordings root inside committed package sources (${root}); nothing was written`
      })
    }

    if (dirname(stagingDir) !== root || runName.startsWith('.')) {
      return yield* new MicrosoftRunFailed({
        message: `Refusing to stage recordings outside the recordings root (${root}); nothing was written`
      })
    }

    const { writer } = options
    const tempDir = join(root, `.tmp-${runName}`)
    const base = resolve(options.containmentRoot ?? workspaceRoot)

    const refuseRedirect = Effect.suspend(() =>
      physicallyContained(writer, base, [root, tempDir, stagingDir])
        ? Effect.void
        : Effect.fail(
            new MicrosoftRunFailed({
              message: `Refusing recordings under a symlinked or redirected directory (${root}); nothing was written`
            })
          )
    )

    yield* refuseRedirect

    const refuseExisting = Effect.suspend(() =>
      writer.exists(stagingDir) || writer.exists(tempDir)
        ? Effect.fail(
            new MicrosoftRunFailed({
              message: `Refusing to overwrite ${stagingDir}; nothing was written`
            })
          )
        : Effect.void
    )

    yield* refuseExisting

    const passed = report.results.filter(result => result.status === 'passed')
    const recorded: Array<RecordedFixture> = []

    for (const result of passed) {
      const testCase = microsoftConformanceCases.find(candidate => candidate.id === result.id)
      const recorder = recorders.get(result.id)

      if (testCase === undefined || recorder === undefined) {
        return yield* new MicrosoftRunFailed({ message: `No recording for ${result.id}` })
      }

      recorded.push(yield* verifiedFixture(testCase, recorder, inputs, options.recordedAt))
    }

    if (recorded.length === 0) {
      return undefined
    }

    // The recorded exchanges themselves, before rendering: every URL, header, text body, and JSON
    // string value and key (parsed, so JSON escapes are undone); a body that is not UTF-8 text is
    // searched as text rather than refused.
    if (
      recorded.some(({ fixture }) =>
        recordingContainsAccessToken(fixture.exchanges, inputs.accessToken)
      )
    ) {
      return yield* new MicrosoftRunFailed({ message: recordedTokenRefusal })
    }

    const recordedIds = recorded.map(({ testCase }) => testCase.id)

    const seeds = mergedFixtureSeeds(microsoftConformanceFixtureSeeds, inputs.seeds, recordedIds)

    // Everything verified: render every file before writing any of them.
    const files = [
      ...recorded.map(({ spec, fixture }) => ({
        name: spec.fileName,
        contents: renderFixtureModule(spec, fixture)
      })),
      { name: 'seeds.ts', contents: renderSeedsModule(seeds) }
    ]

    const stale = staleSharedSeeds(microsoftConformanceFixtureSeeds, seeds, recordedIds)

    const checklist = [
      ...recordingReviewChecklist(recorded),
      ...stale.map(
        ({ key, cases }) =>
          `SHARED SEED ${key} changed: the committed fixtures of ${cases.join(', ')} still use the old value; re-record them or keep the old seed.`
      )
    ]

    // Last line of defence, over exactly what would be written and printed (seeds included).
    if (
      [...files.map(file => file.contents), ...checklist].some(text =>
        textCarriesSecret(text, inputs.accessToken)
      )
    ) {
      return yield* new MicrosoftRunFailed({ message: renderedTokenRefusal })
    }

    yield* refuseExisting
    yield* refuseRedirect

    yield* Effect.try({
      try: () => {
        writer.mkdir(tempDir)

        // Re-check after creating the temp directory, before any file is written.
        if (!physicallyContained(writer, base, [tempDir])) {
          throw new Error('recordings directory redirected')
        }

        for (const file of files) {
          writer.writeFile(join(tempDir, file.name), file.contents)
        }

        // Re-check the temp and target directories immediately before publishing.
        if (!physicallyContained(writer, base, [tempDir, stagingDir])) {
          throw new Error('recordings directory redirected')
        }

        // Publish the complete batch in one step, only after every file is written.
        writer.rename(tempDir, stagingDir)
      },
      catch: () => {
        try {
          writer.rm(tempDir)
        } catch {
          // Best effort: the temp directory is gitignored and never read as a staged run.
        }

        return new MicrosoftRunFailed({
          message: `Writing the staged recordings failed; nothing was staged in ${stagingDir}`
        })
      }
    })

    return {
      stagingDir,
      files: files.map(file => join(stagingDir, file.name)),
      checklist
    }
  })

/**
 * When the write-irreversible send will run, the run id its message names, printed before any case
 * so the owner can find the message in the chat even after a forced exit.
 */
export const runIdLines = (options: RunOptions, inputs: LiveInputs): ReadonlyArray<string> =>
  planMicrosoftRun(options).some(
    entry => entry.skipReason === undefined && entry.safety === 'write-irreversible'
  ) && inputs.seeds.runId !== undefined
    ? [
        `runId for this run: ${inputs.seeds.runId} (the Teams send names it in the message it posts to --chat)`
      ]
    : []

/**
 * One live run over checked inputs: every case (with the stderr WARN cleanup reporter provided
 * around `runConformance`, so a removal that fails, or an id-less or ambiguous create answered,
 * while the run is interrupted prints a WARN line naming the case or create), the report, and the
 * `--record` staging. Every printed line (report, WARN lines, staging output) goes through the
 * shared `redactingLiveRunIo` with the live access token, as in the shared runners. `liveIo` is
 * injectable so tests replay fixtures instead of calling Graph.
 */
export const runMicrosoftLive = (
  options: RunOptions,
  inputs: LiveInputs,
  liveIo: LiveRunIo = processLiveRunIo
) =>
  Effect.gen(function* () {
    const io = redactingLiveRunIo(liveIo, inputs.accessToken)
    const recorders = yield* Ref.make(new Map<string, WireRecorderApi>())

    // Printed before any case, so the owner can find the message even after a forced exit.
    for (const line of runIdLines(options, inputs)) {
      io.out(line)
    }

    const httpFor = (testCase: MicrosoftConformanceCase): Layer.Layer<HttpClient.HttpClient> =>
      options.record
        ? Layer.unwrap(
            Effect.gen(function* () {
              const upstream = yield* HttpClient.HttpClient
              const { client, recorder } = yield* makeRecordingHttpClient(upstream)

              yield* Ref.update(recorders, current => new Map(current).set(testCase.id, recorder))

              return Layer.succeed(HttpClient.HttpClient, client)
            })
          ).pipe(Layer.provide(io.http))
        : io.http

    const report = yield* runConformance(microsoftConformanceCases, {
      target: liveTarget(options),
      layer: testCase => casePorts(httpFor(testCase), inputs.accessToken, inputs.seeds)
    }).pipe(Effect.provideService(ConformanceCleanupReporter, stderrCleanupReporter(io.err)))

    io.out(formatConformanceReport(report))

    if (options.record) {
      const now = new Date()

      const staged = yield* stageRecordings(report, yield* Ref.get(recorders), inputs, {
        writer: nodeRecordingWriter,
        stagingDir: join(recordingsRoot, recordingRunId(now, randomRunSuffix())),
        recordedAt: now.toISOString().slice(0, 10)
      })

      if (staged === undefined) {
        io.out('No passed case to record.')
      } else {
        io.out(
          [
            `Staged ${staged.files.length} files (gitignored) in ${relative(workspaceRoot, staged.stagingDir)}; nothing committed was changed.`,
            ...staged.checklist
          ].join('\n')
        )
      }
    }

    if (conformanceReportFailed(report)) {
      process.exitCode = 1
    }
  })

const invokedAsCli = (): boolean => {
  const invoked = process.argv[1]

  return invoked !== undefined && resolve(invoked) === fileURLToPath(import.meta.url)
}

const parseCliArgs = (): RunOptions | undefined => {
  try {
    return parseRunArgs(process.argv.slice(2), process.env)
  } catch (error) {
    console.error(error instanceof Error ? error.message : error)
    process.exitCode = 1

    return undefined
  }
}

/**
 * What an interrupted Microsoft run may have left behind and where to look, for the interruption
 * and forced-exit messages of `runInterruptibly` (this runner has no leftover lookup). The mailbox
 * and calendar seeds are optional, the immutable-id case moves its draft to Deleted Items, and the
 * write-irreversible Teams send leaves its message in the chat.
 */
export const microsoftRecoveryAdvice =
  "Case-created items may remain; their subjects and names start with yolk-conformance. Look for messages in the --mailbox mailbox (without it, the token user's mailbox), in Drafts and Deleted Items too; events in the --calendar calendar (without it, the default calendar); and folders under the --drive-parent folder. Remove them by hand (removed folders also sit in the OneDrive recycle bin). A Teams send (only with --allow-irreversible) may have posted a yolk-conformance run- message to the --chat chat; the connector cannot remove it."

/** `runInterruptibly` options of the Microsoft runner: its recovery advice; its cases clean up. */
export const microsoftInterruptOptions: Pick<
  RunInterruptiblyOptions,
  'recoveryAdvice' | 'hasCleanups'
> = { recoveryAdvice: microsoftRecoveryAdvice, hasCleanups: true }

/**
 * Run a live program so that SIGINT/SIGTERM interrupt it instead of killing the process (see
 * `runInterruptibly`); signals and io are injectable so tests send no real signals.
 */
export const runMicrosoftInterruptibly = <E>(
  program: Effect.Effect<void, E>,
  signals: SignalSource = processSignals,
  io: CliIo = processCliIo,
  options: Omit<RunInterruptiblyOptions, 'recoveryAdvice' | 'hasCleanups'> = {}
): Promise<void> =>
  runInterruptibly(program, signals, io, { ...options, ...microsoftInterruptOptions })

/**
 * What `pnpm conformance:microsoft --live` runs once its inputs are checked: `runMicrosoftLive`,
 * made interruptible, with the run's own failure and the interruption messages printed through the
 * shared `redactingCliIo` (and the run's lines through `redactingLiveRunIo`) with the live access
 * token. Signals and io are injectable so tests send no real signals and print nothing.
 */
export const runMicrosoftLiveCli = (
  options: RunOptions,
  inputs: LiveInputs,
  signals: SignalSource = processSignals,
  cliIo: CliIo = processCliIo,
  liveIo: LiveRunIo = processLiveRunIo,
  interruptOptions: Omit<RunInterruptiblyOptions, 'recoveryAdvice' | 'hasCleanups'> = {}
): Promise<void> =>
  runMicrosoftInterruptibly(
    runMicrosoftLive(options, inputs, liveIo),
    signals,
    redactingCliIo(cliIo, inputs.accessToken),
    interruptOptions
  )

const runCli = (options: RunOptions): void => {
  if (options.help) {
    console.log(usage)
  } else if (!options.live) {
    console.log(dryRunReport(options))
  } else {
    const checked = liveInputs(options, process.env)

    if ('refusal' in checked) {
      console.error(checked.refusal)
      process.exitCode = 1

      return
    }

    void runMicrosoftLiveCli(options, checked.inputs)
  }
}

if (invokedAsCli()) {
  const options = parseCliArgs()

  if (options !== undefined) {
    runCli(options)
  }
}
