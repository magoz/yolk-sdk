/**
 * Microsoft Graph emulator state: the typed entities, the seed input, the default seed, and the
 * profiles (internal; re-exported by `src/microsoft.ts`).
 *
 * Entity shapes and the default entities follow the synthetic Microsoft conformance fixtures,
 * copied as data (the same mailbox, calendar, event, message, folder, drive, and item ids as
 * `microsoftConformanceFixtureSeeds`), never imported from SDK code. Where no fixture records a
 * value, the default is synthesized and says so below: the user id, the well-known mail folders
 * other than Drafts and Deleted Items, the attachment message itself, and the drive root and
 * `Sources` folder have no fixture.
 *
 * @experimental
 */
import { Result, Struct } from 'effect'
import * as Schema from 'effect/Schema'

const Timestamp = Schema.String

/** A recipient as stored: `name` falls back to the address when Graph has none. */
export const MicrosoftEmulatorRecipient = Schema.Struct({
  name: Schema.NullOr(Schema.String),
  address: Schema.String
})

export type MicrosoftEmulatorRecipient = typeof MicrosoftEmulatorRecipient.Type

/** The mailbox owner every `/users/{userId}` route answers for (id, `mail`, or UPN). */
export const MicrosoftEmulatorUser = Schema.Struct({
  id: Schema.String,
  displayName: Schema.String,
  mail: Schema.String,
  userPrincipalName: Schema.String
})

export type MicrosoftEmulatorUser = typeof MicrosoftEmulatorUser.Type

const WellKnownFolder = Schema.Literals(['inbox', 'drafts', 'deleteditems'])

/** A mail folder; `wellKnownName` lets routes address it by name (`deleteditems`). */
export const MicrosoftEmulatorMailFolder = Schema.Struct({
  id: Schema.String,
  displayName: Schema.String,
  wellKnownName: Schema.NullOr(WellKnownFolder)
})

export type MicrosoftEmulatorMailFolder = typeof MicrosoftEmulatorMailFolder.Type

const BodyContentType = Schema.Literals(['text', 'html'])

const messageFields = {
  /** The immutable id (`Prefer: IdType="ImmutableId"`): stable across moves. */
  id: Schema.String,
  parentFolderId: Schema.String,
  subject: Schema.String,
  bodyContentType: BodyContentType,
  bodyContent: Schema.String,
  from: Schema.NullOr(MicrosoftEmulatorRecipient),
  sender: Schema.NullOr(MicrosoftEmulatorRecipient),
  toRecipients: Schema.Array(MicrosoftEmulatorRecipient),
  ccRecipients: Schema.Array(MicrosoftEmulatorRecipient),
  bccRecipients: Schema.Array(MicrosoftEmulatorRecipient),
  replyTo: Schema.Array(MicrosoftEmulatorRecipient),
  isRead: Schema.Boolean,
  isDraft: Schema.Boolean,
  importance: Schema.Literals(['low', 'normal', 'high']),
  flagStatus: Schema.Literals(['notFlagged', 'flagged', 'complete']),
  categories: Schema.Array(Schema.String),
  /** Answered as stored (not derived from the attachments; no fixture shows the rule). */
  hasAttachments: Schema.Boolean,
  createdDateTime: Timestamp,
  lastModifiedDateTime: Timestamp,
  receivedDateTime: Timestamp,
  sentDateTime: Timestamp,
  conversationId: Schema.String,
  internetMessageId: Schema.String,
  changeKey: Schema.String
}

/** A stored message. Every message is addressed by its immutable id. */
export const MicrosoftEmulatorMessage = Schema.Struct(messageFields)

export type MicrosoftEmulatorMessage = typeof MicrosoftEmulatorMessage.Type

const attachmentFields = {
  id: Schema.String,
  /** Immutable id of the owning message. */
  messageId: Schema.String,
  name: Schema.String,
  contentType: Schema.String,
  size: Schema.Int,
  isInline: Schema.Boolean,
  contentId: Schema.NullOr(Schema.String),
  contentLocation: Schema.NullOr(Schema.String),
  contentBytes: Schema.String,
  lastModifiedDateTime: Timestamp
}

/** A stored file attachment (`#microsoft.graph.fileAttachment`). */
export const MicrosoftEmulatorAttachment = Schema.Struct(attachmentFields)

export type MicrosoftEmulatorAttachment = typeof MicrosoftEmulatorAttachment.Type

export const MicrosoftEmulatorCalendar = Schema.Struct({
  id: Schema.String,
  name: Schema.String
})

export type MicrosoftEmulatorCalendar = typeof MicrosoftEmulatorCalendar.Type

/** Graph local date-time in UTC with seven fractional digits (`2026-09-23T12:00:00.0000000`). */
export const microsoftEmulatorDateTimePattern = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{7}$/u

const UtcDateTime = Schema.String.check(Schema.isPattern(microsoftEmulatorDateTimePattern))

const eventFields = {
  id: Schema.String,
  calendarId: Schema.String,
  subject: Schema.String,
  bodyContentType: BodyContentType,
  bodyContent: Schema.String,
  /** Start in UTC, seven fractional digits. */
  start: UtcDateTime,
  /** End in UTC, seven fractional digits. */
  end: UtcDateTime,
  isCancelled: Schema.Boolean,
  isReminderOn: Schema.Boolean,
  showAs: Schema.Literals(['free', 'tentative', 'busy', 'oof', 'workingElsewhere', 'unknown']),
  changeKey: Schema.String,
  createdDateTime: Timestamp,
  lastModifiedDateTime: Timestamp
}

/** A stored single-instance calendar event (no attendees, no recurrence). */
export const MicrosoftEmulatorEvent = Schema.Struct(eventFields)

export type MicrosoftEmulatorEvent = typeof MicrosoftEmulatorEvent.Type

/** The one emulated drive. */
export const MicrosoftEmulatorDrive = Schema.Struct({
  id: Schema.String,
  driveType: Schema.Literals(['business', 'personal']),
  rootId: Schema.String
})

export type MicrosoftEmulatorDrive = typeof MicrosoftEmulatorDrive.Type

const driveItemFields = {
  id: Schema.String,
  /** `null` only for the drive root. */
  parentId: Schema.NullOr(Schema.String),
  name: Schema.String,
  kind: Schema.Literals(['folder', 'file']),
  /** File size in bytes; folders report the sum of their contents instead. */
  size: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  mimeType: Schema.NullOr(Schema.String),
  quickXorHash: Schema.NullOr(Schema.String),
  createdDateTime: Timestamp,
  lastModifiedDateTime: Timestamp
}

/** A stored drive item (file or folder). Deleted items are removed (no recycle bin). */
export const MicrosoftEmulatorDriveItem = Schema.Struct(driveItemFields)

export type MicrosoftEmulatorDriveItem = typeof MicrosoftEmulatorDriveItem.Type

const Counter = Schema.Int.check(Schema.isGreaterThanOrEqualTo(1))

const Counters = Schema.Struct({
  /** Next number in created event ids (`AAMkAGI2-synthetic-event-0101=`). */
  nextEventNumber: Counter,
  /** Next number in created message immutable ids. */
  nextMessageNumber: Counter,
  /** Next change key number (message and event writes). */
  nextChangeKeyNumber: Counter,
  /** Next number in created drive item ids. */
  nextItemNumber: Counter
})

/** The whole emulator state (JSON-compatible; what `snapshot()` returns). */
export const MicrosoftEmulatorStateSchema = Schema.Struct({
  user: MicrosoftEmulatorUser,
  mailFolders: Schema.Array(MicrosoftEmulatorMailFolder),
  messages: Schema.Array(MicrosoftEmulatorMessage),
  attachments: Schema.Array(MicrosoftEmulatorAttachment),
  calendars: Schema.Array(MicrosoftEmulatorCalendar),
  events: Schema.Array(MicrosoftEmulatorEvent),
  drive: MicrosoftEmulatorDrive,
  driveItems: Schema.Array(MicrosoftEmulatorDriveItem),
  counters: Counters
})

/**
 * The emulator state. The container is mutable (route handlers replace whole entity lists);
 * every entity is replaced, never edited in place.
 */
export type MicrosoftEmulatorState = {
  user: MicrosoftEmulatorUser
  mailFolders: ReadonlyArray<MicrosoftEmulatorMailFolder>
  messages: ReadonlyArray<MicrosoftEmulatorMessage>
  attachments: ReadonlyArray<MicrosoftEmulatorAttachment>
  calendars: ReadonlyArray<MicrosoftEmulatorCalendar>
  events: ReadonlyArray<MicrosoftEmulatorEvent>
  drive: MicrosoftEmulatorDrive
  driveItems: ReadonlyArray<MicrosoftEmulatorDriveItem>
  counters: typeof Counters.Type
}

/** A seeded message: `id`, `parentFolderId`, and `subject` are required. */
export const MicrosoftEmulatorMessageSeed = Schema.Struct(
  Struct.mapOmit(messageFields, ['id', 'parentFolderId', 'subject'], Schema.optionalKey)
)

export type MicrosoftEmulatorMessageSeed = typeof MicrosoftEmulatorMessageSeed.Type

/** A seeded attachment: `id`, `messageId`, and `name` are required. */
export const MicrosoftEmulatorAttachmentSeed = Schema.Struct(
  Struct.mapOmit(attachmentFields, ['id', 'messageId', 'name'], Schema.optionalKey)
)

export type MicrosoftEmulatorAttachmentSeed = typeof MicrosoftEmulatorAttachmentSeed.Type

/**
 * A seeded event: `id`, `calendarId`, `subject`, `start`, and `end` are required. `start` and
 * `end` are UTC: either an ISO instant ending in `Z` or a seven-digit local date-time.
 */
export const MicrosoftEmulatorEventSeed = Schema.Struct({
  ...Struct.mapOmit(
    eventFields,
    ['id', 'calendarId', 'subject', 'start', 'end'],
    Schema.optionalKey
  ),
  start: Schema.String,
  end: Schema.String
})

export type MicrosoftEmulatorEventSeed = typeof MicrosoftEmulatorEventSeed.Type

/** A seeded drive item: `id`, `parentId`, `name`, and `kind` are required. */
export const MicrosoftEmulatorDriveItemSeed = Schema.Struct(
  Struct.mapOmit(driveItemFields, ['id', 'parentId', 'name', 'kind'], Schema.optionalKey)
)

export type MicrosoftEmulatorDriveItemSeed = typeof MicrosoftEmulatorDriveItemSeed.Type

/** Account-variance profiles for the default seed. */
export const MicrosoftEmulatorProfile = Schema.Literals(['default', 'empty'])

export type MicrosoftEmulatorProfile = typeof MicrosoftEmulatorProfile.Type

/**
 * A typed seed. Start from `profile` (default `'default'`, the fixture entities); every other
 * key, when given, replaces that part of the profile.
 */
export const MicrosoftEmulatorSeed = Schema.Struct({
  profile: Schema.optionalKey(MicrosoftEmulatorProfile),
  user: Schema.optionalKey(MicrosoftEmulatorUser),
  mailFolders: Schema.optionalKey(Schema.Array(MicrosoftEmulatorMailFolder)),
  messages: Schema.optionalKey(Schema.Array(MicrosoftEmulatorMessageSeed)),
  attachments: Schema.optionalKey(Schema.Array(MicrosoftEmulatorAttachmentSeed)),
  calendars: Schema.optionalKey(Schema.Array(MicrosoftEmulatorCalendar)),
  events: Schema.optionalKey(Schema.Array(MicrosoftEmulatorEventSeed)),
  drive: Schema.optionalKey(MicrosoftEmulatorDrive),
  driveItems: Schema.optionalKey(Schema.Array(MicrosoftEmulatorDriveItemSeed))
})

export type MicrosoftEmulatorSeed = typeof MicrosoftEmulatorSeed.Type

const strict = { onExcessProperty: 'error' } as const

const decodeSeedInput = Schema.decodeUnknownResult(MicrosoftEmulatorSeed, strict)

const decodeStateInput = Schema.decodeUnknownResult(MicrosoftEmulatorStateSchema, strict)

const issueMessage = (issue: Schema.SchemaError['issue']): string =>
  new Schema.SchemaError(issue).message

// Instants: 100-nanosecond ticks since the epoch (BigInt, so seven fractional digits stay exact).

const ticksPerMilli = BigInt(10_000)

const ticksPerSecond = BigInt(10_000_000)

const instantPattern =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,7}))?(Z|[+-]\d{2}:\d{2})?$/

/**
 * Ticks of an ISO-8601 date-time. `zone` `'required'` needs `Z` or an offset; `'forbidden'`
 * needs none (a Graph local date-time, read as UTC); `'optional'` reads a missing one as UTC.
 */
export const parseInstant = (
  value: string,
  zone: 'required' | 'forbidden' | 'optional'
): bigint | undefined => {
  const match = instantPattern.exec(value)

  if (match === null) return undefined

  const [, year, month, day, hour, minute, second, fraction = '', offset] = match

  if (
    (zone === 'required' && offset === undefined) ||
    (zone === 'forbidden' && offset !== undefined)
  ) {
    return undefined
  }

  const wholeMillis = Date.UTC(
    Number(year),
    Number(month) - 1,
    Number(day),
    Number(hour),
    Number(minute),
    Number(second)
  )

  const check = new Date(wholeMillis)

  // Reject rollovers such as 2026-02-30 or 25:00.
  if (
    !Number.isFinite(wholeMillis) ||
    check.getUTCFullYear() !== Number(year) ||
    check.getUTCMonth() !== Number(month) - 1 ||
    check.getUTCDate() !== Number(day) ||
    check.getUTCHours() !== Number(hour) ||
    check.getUTCMinutes() !== Number(minute)
  ) {
    return undefined
  }

  const offsetMinutes =
    offset === undefined || offset === 'Z'
      ? 0
      : (offset.startsWith('-') ? -1 : 1) *
        (Number(offset.slice(1, 3)) * 60 + Number(offset.slice(4, 6)))

  return (
    BigInt(wholeMillis - offsetMinutes * 60_000) * ticksPerMilli + BigInt(fraction.padEnd(7, '0'))
  )
}

const pad = (value: number, width: number): string => String(value).padStart(width, '0')

/** A UTC local date-time with `digits` fractional digits (Graph uses seven). */
export const formatLocalDateTime = (ticks: bigint, digits: number): string => {
  const millis = Number(ticks / ticksPerMilli)
  const date = new Date(millis)
  const fraction = pad(Number(((ticks % ticksPerSecond) + ticksPerSecond) % ticksPerSecond), 7)

  const whole = `${pad(date.getUTCFullYear(), 4)}-${pad(date.getUTCMonth() + 1, 2)}-${pad(
    date.getUTCDate(),
    2
  )}T${pad(date.getUTCHours(), 2)}:${pad(date.getUTCMinutes(), 2)}:${pad(date.getUTCSeconds(), 2)}`

  return digits === 0 ? whole : `${whole}.${fraction.slice(0, digits)}`
}

// Default entities. Fixture-derived: the mailbox, the calendar and its two events, the attachment
// message's two attachments, the paging folder's three messages, the Drafts and Deleted Items
// folder ids, the drive, the `Conformance` parent folder with its existing file, and the copy
// source file. Synthesized: the user id, the Inbox folder, the attachment message's own fields,
// the drive root, the `Sources` folder, and every default the `*FromSeed` builders fill in.

const ada: MicrosoftEmulatorUser = {
  id: '00000000-0000-4000-8000-00000000ada1',
  displayName: 'Ada Example',
  mail: 'ada@example.test',
  userPrincipalName: 'ada@example.test'
}

const grace: MicrosoftEmulatorRecipient = { name: 'Grace Example', address: 'grace@example.test' }

const adaRecipient: MicrosoftEmulatorRecipient = {
  name: 'Ada Example',
  address: 'ada@example.test'
}

const inboxId = 'AAMkAGI2-synthetic-inbox-folder='

const pagingFolderId = 'AAMkAGI2-synthetic-folder-0001='

const defaultMailFolders: ReadonlyArray<MicrosoftEmulatorMailFolder> = [
  { id: inboxId, displayName: 'Inbox', wellKnownName: 'inbox' },
  { id: 'AAMkAGI2-synthetic-drafts-folder=', displayName: 'Drafts', wellKnownName: 'drafts' },
  {
    id: 'AAMkAGI2-synthetic-deleteditems-folder=',
    displayName: 'Deleted Items',
    wellKnownName: 'deleteditems'
  },
  { id: pagingFolderId, displayName: 'Synthetic updates', wellKnownName: null }
]

const pagingMessage = (number: number, hour: number): MicrosoftEmulatorMessageSeed => {
  const id = `AAMkAGI2-synthetic-message-${pad(number, 4)}=`
  const at = `2026-09-22T${pad(hour, 2)}:00:00Z`

  return {
    id,
    parentFolderId: pagingFolderId,
    subject: `Synthetic update ${number - 100}`,
    bodyContent: 'Synthetic message body.',
    from: grace,
    sender: grace,
    toRecipients: [adaRecipient],
    isRead: true,
    isDraft: false,
    receivedDateTime: at,
    sentDateTime: at,
    createdDateTime: at,
    lastModifiedDateTime: at,
    conversationId: `AAQkAGI2-synthetic-conversation-${pad(number, 4)}=`,
    internetMessageId: `<synthetic-${pad(number, 4)}@example.test>`,
    changeKey: `CQAAABYAAAAsynthetic${pad(number, 4)}`
  }
}

const attachmentMessageId = 'AAMkAGI2-synthetic-message-0001='

const defaultMessages: ReadonlyArray<MicrosoftEmulatorMessageSeed> = [
  {
    id: attachmentMessageId,
    parentFolderId: inboxId,
    subject: 'Synthetic message with attachments',
    bodyContentType: 'html',
    bodyContent: '<p>Synthetic body <img src="cid:image001.png@01DD2E00.00000000"></p>',
    from: grace,
    sender: grace,
    toRecipients: [adaRecipient],
    isRead: false,
    isDraft: false,
    // Synthesized (no fixture lists this message): it has a regular (non-inline) attachment.
    hasAttachments: true,
    receivedDateTime: '2026-09-22T08:15:00Z',
    sentDateTime: '2026-09-22T08:15:00Z',
    createdDateTime: '2026-09-22T08:15:00Z',
    lastModifiedDateTime: '2026-09-22T08:15:00Z',
    conversationId: 'AAQkAGI2-synthetic-conversation-0001=',
    internetMessageId: '<synthetic-0001@example.test>',
    changeKey: 'CQAAABYAAAAsynthetic0001'
  },
  pagingMessage(101, 9),
  pagingMessage(102, 8),
  pagingMessage(103, 7)
]

const defaultAttachments: ReadonlyArray<MicrosoftEmulatorAttachmentSeed> = [
  {
    id: 'AAMkAGI2-synthetic-attachment-0001=',
    messageId: attachmentMessageId,
    name: 'image001.png',
    contentType: 'image/png',
    size: 1024,
    isInline: true,
    contentId: 'image001.png@01DD2E00.00000000',
    contentBytes: 'iVBORw0KGgo=',
    lastModifiedDateTime: '2026-09-22T08:15:00Z'
  },
  {
    id: 'AAMkAGI2-synthetic-attachment-0002=',
    messageId: attachmentMessageId,
    name: 'synthetic-report.pdf',
    contentType: 'application/pdf',
    size: 2048,
    isInline: false,
    contentId: null,
    contentBytes: 'JVBERi0xLjQK',
    lastModifiedDateTime: '2026-09-22T08:15:00Z'
  }
]

const calendarId = 'AAMkAGI2-synthetic-calendar-0001='

const defaultCalendars: ReadonlyArray<MicrosoftEmulatorCalendar> = [
  { id: calendarId, name: 'Calendar' }
]

const defaultEvents: ReadonlyArray<MicrosoftEmulatorEventSeed> = [
  {
    id: 'AAMkAGI2-synthetic-event-0001=',
    calendarId,
    subject: 'Synthetic planning session',
    start: '2026-09-23T12:00:00Z',
    end: '2026-09-23T13:00:00Z',
    changeKey: 'DwAAABYAAAAsynthetic0001'
  },
  {
    id: 'AAMkAGI2-synthetic-event-0002=',
    calendarId,
    subject: 'Synthetic review',
    start: '2026-09-24T08:30:00Z',
    end: '2026-09-24T09:00:00Z',
    changeKey: 'DwAAABYAAAAsynthetic0002'
  }
]

const defaultDrive: MicrosoftEmulatorDrive = {
  id: 'b!synthetic-drive-0001',
  driveType: 'business',
  rootId: '01SYNTHETICROOTFOLDER00000000001'
}

const quickXorHash = 'AAAAAAAAAAAAAAAAAAAAAAAAAAA='

const conformanceFolderId = '01SYNTHETICPARENTFOLDER0000000001'

const sourcesFolderId = '01SYNTHETICSOURCEPARENT000000001'

const rootItem: MicrosoftEmulatorDriveItemSeed = {
  id: defaultDrive.rootId,
  parentId: null,
  name: 'root',
  kind: 'folder'
}

const defaultDriveItems: ReadonlyArray<MicrosoftEmulatorDriveItemSeed> = [
  rootItem,
  { id: conformanceFolderId, parentId: defaultDrive.rootId, name: 'Conformance', kind: 'folder' },
  {
    id: '01SYNTHETICEXISTINGFILE000000001',
    parentId: conformanceFolderId,
    name: 'synthetic-existing.txt',
    kind: 'file',
    size: 12,
    mimeType: 'text/plain',
    quickXorHash
  },
  { id: sourcesFolderId, parentId: defaultDrive.rootId, name: 'Sources', kind: 'folder' },
  {
    id: '01SYNTHETICSOURCEFILE00000000001',
    parentId: sourcesFolderId,
    name: 'synthetic-notes.txt',
    kind: 'file',
    size: 24,
    mimeType: 'text/plain',
    quickXorHash
  }
]

type ProfileEntities = {
  readonly user: MicrosoftEmulatorUser
  readonly mailFolders: ReadonlyArray<MicrosoftEmulatorMailFolder>
  readonly messages: ReadonlyArray<MicrosoftEmulatorMessageSeed>
  readonly attachments: ReadonlyArray<MicrosoftEmulatorAttachmentSeed>
  readonly calendars: ReadonlyArray<MicrosoftEmulatorCalendar>
  readonly events: ReadonlyArray<MicrosoftEmulatorEventSeed>
  readonly drive: MicrosoftEmulatorDrive
  readonly driveItems: ReadonlyArray<MicrosoftEmulatorDriveItemSeed>
}

const profileEntities = (profile: MicrosoftEmulatorProfile): ProfileEntities => {
  switch (profile) {
    case 'default':
      return {
        user: ada,
        mailFolders: defaultMailFolders,
        messages: defaultMessages,
        attachments: defaultAttachments,
        calendars: defaultCalendars,
        events: defaultEvents,
        drive: defaultDrive,
        driveItems: defaultDriveItems
      }
    case 'empty':
      return {
        user: ada,
        mailFolders: defaultMailFolders.filter(folder => folder.wellKnownName !== null),
        messages: [],
        attachments: [],
        calendars: defaultCalendars,
        events: [],
        drive: defaultDrive,
        driveItems: [rootItem]
      }
  }
}

const defaultTimestamp = '2026-09-29T10:00:00Z'

const messageFromSeed = (
  seed: MicrosoftEmulatorMessageSeed,
  user: MicrosoftEmulatorUser
): MicrosoftEmulatorMessage => {
  const owner: MicrosoftEmulatorRecipient = { name: user.displayName, address: user.mail }
  const created = seed.createdDateTime ?? defaultTimestamp

  return {
    id: seed.id,
    parentFolderId: seed.parentFolderId,
    subject: seed.subject,
    bodyContentType: seed.bodyContentType ?? 'text',
    bodyContent: seed.bodyContent ?? '',
    from: seed.from === undefined ? owner : seed.from,
    sender: seed.sender === undefined ? owner : seed.sender,
    toRecipients: seed.toRecipients ?? [],
    ccRecipients: seed.ccRecipients ?? [],
    bccRecipients: seed.bccRecipients ?? [],
    replyTo: seed.replyTo ?? [],
    isRead: seed.isRead ?? true,
    isDraft: seed.isDraft ?? false,
    importance: seed.importance ?? 'normal',
    flagStatus: seed.flagStatus ?? 'notFlagged',
    categories: seed.categories ?? [],
    hasAttachments: seed.hasAttachments ?? false,
    createdDateTime: created,
    lastModifiedDateTime: seed.lastModifiedDateTime ?? created,
    receivedDateTime: seed.receivedDateTime ?? created,
    sentDateTime: seed.sentDateTime ?? created,
    conversationId: seed.conversationId ?? `AAQkAGI2-synthetic-conversation-${seed.id}`,
    internetMessageId: seed.internetMessageId ?? `<${seed.id}@example.test>`,
    changeKey: seed.changeKey ?? 'CQAAABYAAAAsynthetic0000'
  }
}

/** Decoded size of a base64 string (no validation beyond the padding count). */
const base64Size = (value: string): number =>
  Math.max(0, Math.floor((value.length * 3) / 4) - (value.match(/=+$/)?.[0].length ?? 0))

const attachmentFromSeed = (seed: MicrosoftEmulatorAttachmentSeed): MicrosoftEmulatorAttachment => {
  const contentBytes = seed.contentBytes ?? ''

  return {
    id: seed.id,
    messageId: seed.messageId,
    name: seed.name,
    contentType: seed.contentType ?? 'application/octet-stream',
    size: seed.size ?? base64Size(contentBytes),
    isInline: seed.isInline ?? false,
    contentId: seed.contentId ?? null,
    contentLocation: seed.contentLocation ?? null,
    contentBytes,
    lastModifiedDateTime: seed.lastModifiedDateTime ?? defaultTimestamp
  }
}

/** A seeded start/end as a seven-digit UTC local date-time, or `undefined` when unreadable. */
const seedDateTime = (value: string): string | undefined => {
  const ticks = value.endsWith('Z')
    ? parseInstant(value, 'required')
    : parseInstant(value, 'forbidden')

  return ticks === undefined ? undefined : formatLocalDateTime(ticks, 7)
}

const eventFromSeed = (
  seed: MicrosoftEmulatorEventSeed,
  start: string,
  end: string
): MicrosoftEmulatorEvent => ({
  id: seed.id,
  calendarId: seed.calendarId,
  subject: seed.subject,
  bodyContentType: seed.bodyContentType ?? 'text',
  bodyContent: seed.bodyContent ?? '',
  start,
  end,
  isCancelled: seed.isCancelled ?? false,
  isReminderOn: seed.isReminderOn ?? false,
  showAs: seed.showAs ?? 'busy',
  changeKey: seed.changeKey ?? 'DwAAABYAAAAsynthetic0000',
  createdDateTime: seed.createdDateTime ?? defaultTimestamp,
  lastModifiedDateTime: seed.lastModifiedDateTime ?? seed.createdDateTime ?? defaultTimestamp
})

const driveItemFromSeed = (seed: MicrosoftEmulatorDriveItemSeed): MicrosoftEmulatorDriveItem => ({
  id: seed.id,
  parentId: seed.parentId,
  name: seed.name,
  kind: seed.kind,
  size: seed.kind === 'folder' ? 0 : (seed.size ?? 0),
  mimeType: seed.kind === 'folder' ? null : (seed.mimeType ?? 'application/octet-stream'),
  quickXorHash: seed.kind === 'folder' ? null : (seed.quickXorHash ?? null),
  createdDateTime: seed.createdDateTime ?? defaultTimestamp,
  lastModifiedDateTime: seed.lastModifiedDateTime ?? seed.createdDateTime ?? defaultTimestamp
})

const duplicate = (values: ReadonlyArray<string>): string | undefined =>
  values.find((value, index) => values.indexOf(value) !== index)

/** Integrity problems a decoded seed can still have (duplicates, dangling references, cycles). */
const seedProblem = (entities: ProfileEntities): string | undefined => {
  const folderIds = entities.mailFolders.map(folder => folder.id)
  const messageIds = entities.messages.map(message => message.id)
  const calendarIds = entities.calendars.map(calendar => calendar.id)
  const itemIds = entities.driveItems.map(item => item.id)

  const duplicates: ReadonlyArray<readonly [string, string | undefined]> = [
    ['mail folder id', duplicate(folderIds)],
    [
      'well-known folder',
      duplicate(entities.mailFolders.flatMap(folder => folder.wellKnownName ?? []))
    ],
    ['message id', duplicate(messageIds)],
    ['attachment id', duplicate(entities.attachments.map(attachment => attachment.id))],
    ['calendar id', duplicate(calendarIds)],
    ['event id', duplicate(entities.events.map(event => event.id))],
    ['drive item id', duplicate(itemIds)]
  ]

  for (const [label, value] of duplicates) {
    if (value !== undefined) return `duplicate ${label} ${value}`
  }

  for (const wellKnown of ['drafts', 'deleteditems'] as const) {
    if (!entities.mailFolders.some(folder => folder.wellKnownName === wellKnown)) {
      return `the mail folders need a ${wellKnown} folder`
    }
  }

  const message = entities.messages.find(candidate => !folderIds.includes(candidate.parentFolderId))

  if (message !== undefined) {
    return `message ${message.id} references missing folder ${message.parentFolderId}`
  }

  const attachment = entities.attachments.find(
    candidate => !messageIds.includes(candidate.messageId)
  )

  if (attachment !== undefined) {
    return `attachment ${attachment.id} references missing message ${attachment.messageId}`
  }

  const event = entities.events.find(candidate => !calendarIds.includes(candidate.calendarId))

  if (event !== undefined) {
    return `event ${event.id} references missing calendar ${event.calendarId}`
  }

  const roots = entities.driveItems.filter(item => item.parentId === null)

  if (roots.length !== 1 || roots[0]?.id !== entities.drive.rootId || roots[0].kind !== 'folder') {
    return `the drive items need exactly one root folder with id ${entities.drive.rootId}`
  }

  const byId = new Map(entities.driveItems.map(item => [item.id, item]))

  for (const item of entities.driveItems) {
    let parentId = item.parentId
    let steps = 0

    while (parentId !== null) {
      const parent = byId.get(parentId)

      if (parent === undefined || parent.kind !== 'folder') {
        return `drive item ${item.id} has a missing or non-folder parent ${parentId}`
      }

      steps += 1

      if (steps > entities.driveItems.length) return `drive item ${item.id} is in a parent cycle`

      parentId = parent.parentId
    }
  }

  return undefined
}

/** Build the emulator state for a decoded seed; a string is an integrity problem. */
const stateFromSeed = (seed: MicrosoftEmulatorSeed): MicrosoftEmulatorState | string => {
  const profile = profileEntities(seed.profile ?? 'default')

  const entities: ProfileEntities = {
    user: seed.user ?? profile.user,
    mailFolders: seed.mailFolders ?? profile.mailFolders,
    messages: seed.messages ?? profile.messages,
    attachments: seed.attachments ?? profile.attachments,
    calendars: seed.calendars ?? profile.calendars,
    events: seed.events ?? profile.events,
    drive: seed.drive ?? profile.drive,
    driveItems: seed.driveItems ?? profile.driveItems
  }

  const problem = seedProblem(entities)

  if (problem !== undefined) return problem

  const events: Array<MicrosoftEmulatorEvent> = []

  for (const event of entities.events) {
    const start = seedDateTime(event.start)
    const end = seedDateTime(event.end)

    if (start === undefined || end === undefined || end < start) {
      return `event ${event.id} needs readable UTC start and end, with end not before start`
    }

    events.push(eventFromSeed(event, start, end))
  }

  return {
    user: entities.user,
    mailFolders: entities.mailFolders,
    messages: entities.messages.map(message => messageFromSeed(message, entities.user)),
    attachments: entities.attachments.map(attachmentFromSeed),
    calendars: entities.calendars,
    events,
    drive: entities.drive,
    driveItems: entities.driveItems.map(driveItemFromSeed),
    counters: {
      nextEventNumber: 101,
      nextMessageNumber: 1,
      nextChangeKeyNumber: 1001,
      nextItemNumber: 1
    }
  }
}

/** Decode and build a seed; a string is the reason it is invalid. */
export const buildSeedState = (input: unknown): MicrosoftEmulatorState | string => {
  const decoded = decodeSeedInput(input)

  return Result.isFailure(decoded)
    ? issueMessage(decoded.failure.issue)
    : stateFromSeed(decoded.success)
}

/** Decode a full state (a restored snapshot); a string is the reason it is invalid. */
export const decodeState = (input: unknown): MicrosoftEmulatorState | string => {
  const decoded = decodeStateInput(input)

  return Result.isFailure(decoded) ? issueMessage(decoded.failure.issue) : { ...decoded.success }
}
