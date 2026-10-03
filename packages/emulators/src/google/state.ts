/**
 * Google emulator state: the Gmail messages, labels, attachments, and drafts, the Calendar
 * calendars and events, and the Drive files, the seed input, the default seed, and the profiles
 * (internal; re-exported by `src/google.ts`).
 *
 * Entity shapes and the default entities follow the synthetic Google conformance fixtures and
 * `googleConformanceFixtureSeeds`, copied as data (the same ids, labels, payloads, timestamps, and
 * links), never imported from SDK code. Entities a fixture only names are implied: the paging
 * label (`impliedLabelIds`), the five messages its listing names by id (`impliedMessages`, which
 * only ever render as `{ id, threadId }` list entries), and the practice Drive folder
 * (`impliedFolderIds`, a parent whose own metadata no fixture shows). References resolve through
 * them, but no answer renders them.
 *
 * A stored Gmail message keeps only the renderings a fixture records for it: `minimal` (no
 * payload), and the `metadata` and `full` payloads. A `format` with no recorded rendering is not
 * emulated. Created labels and drafts are never seeded (they exist only once created here).
 *
 * Minted ids never collide with seeded ones: draft and sent message ids (`18f…d<n>`, `18f…e<n>`),
 * which a created draft also uses as its thread id, event ids (`syntheticconformance<nnnn>`), and
 * folder ids (`synthetic-conformance-folder-<nnnn>`) have reserved forms that no seeded message id,
 * thread id, event id, or Drive id may use. Created label ids (`Label_<n>`, `n` from 1 to
 * 999999999 without leading zeros) start above every seeded label number (at least `Label_9101`,
 * the value the label fixture records); a seeded `Label_<digits>` id must have that form, and a
 * create when no number is left is not emulated.
 *
 * @experimental
 */
import { Result } from 'effect'
import * as Schema from 'effect/Schema'
import { recordedInternalDate } from './shared.ts'

const JsonObject = Schema.Record(Schema.String, Schema.Json)

/** A Gmail message, thread, label, or attachment id as the fixtures use them. */
const GmailId = Schema.String.check(Schema.isPattern(/^[A-Za-z0-9_-]{1,100}$/u))

const NonNegativeInt = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))

/**
 * The practice account's own address: exactly one plain `local@domain` (the shape the send case's
 * `GooglePracticeAddress` seed takes). The fixtures use it as the sender, the only recipient, and
 * the event creator. A seed may set another one, but the send answers only while it is the
 * recorded `practice@example.test` (the recorded `sizeEstimate` of the sent message covers it).
 */
export const GoogleEmulatorPracticeAddress = Schema.String.check(
  Schema.isMaxLength(254),
  Schema.isPattern(
    /^[A-Za-z0-9_%+-]+(?:\.[A-Za-z0-9_%+-]+)*@[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?)+$/u
  ),
  Schema.makeFilter(value => value.indexOf('@') <= 64)
)

/**
 * A stored Gmail message with the renderings a fixture records for it: `minimal` (true when a
 * fixture records `format=minimal`), and the `metadata` and `full` payloads (null when none is
 * recorded). The head fields are answered as stored.
 */
export const GoogleEmulatorGmailMessage = Schema.Struct({
  id: GmailId,
  threadId: GmailId,
  labelIds: Schema.Array(Schema.String),
  snippet: Schema.String,
  sizeEstimate: NonNegativeInt,
  historyId: Schema.String,
  internalDate: Schema.String,
  minimal: Schema.Boolean,
  metadataPayload: Schema.NullOr(JsonObject),
  fullPayload: Schema.NullOr(JsonObject)
})

export type GoogleEmulatorGmailMessage = typeof GoogleEmulatorGmailMessage.Type

/** A message a fixture only names in a listing (`{ id, threadId }`), with the labels it carries. */
export const GoogleEmulatorImpliedMessage = Schema.Struct({
  id: GmailId,
  threadId: GmailId,
  labelIds: Schema.Array(Schema.String)
})

export type GoogleEmulatorImpliedMessage = typeof GoogleEmulatorImpliedMessage.Type

/** A label created here (`POST .../labels`), answered as the label fixture records it. */
export const GoogleEmulatorGmailLabel = Schema.Struct({
  id: GmailId,
  name: Schema.String,
  messageListVisibility: Schema.String,
  labelListVisibility: Schema.String,
  type: Schema.String
})

export type GoogleEmulatorGmailLabel = typeof GoogleEmulatorGmailLabel.Type

/** An attachment Gmail stores apart from its message: `size` bytes as base64url `data`. */
export const GoogleEmulatorAttachment = Schema.Struct({
  messageId: GmailId,
  attachmentId: GmailId,
  size: NonNegativeInt,
  data: Schema.String
})

export type GoogleEmulatorAttachment = typeof GoogleEmulatorAttachment.Type

/** A draft created here and its current message. */
export const GoogleEmulatorDraft = Schema.Struct({
  id: Schema.String,
  messageId: GmailId
})

export type GoogleEmulatorDraft = typeof GoogleEmulatorDraft.Type

/** A calendar the events live in, with the fields a listing page answers. */
export const GoogleEmulatorCalendar = Schema.Struct({
  id: Schema.String,
  summary: Schema.String,
  timeZone: Schema.String,
  accessRole: Schema.String
})

export type GoogleEmulatorCalendar = typeof GoogleEmulatorCalendar.Type

/** An event boundary: exactly one of `dateTime` (with an optional `timeZone`) or `date`. */
export const GoogleEmulatorEventBoundary = Schema.Union([
  Schema.Struct({ dateTime: Schema.String, timeZone: Schema.optionalKey(Schema.String) }),
  Schema.Struct({ date: Schema.String })
])

export type GoogleEmulatorEventBoundary = typeof GoogleEmulatorEventBoundary.Type

/** A stored calendar event with its wire fields (creator and organizer derive from the state). */
export const GoogleEmulatorCalendarEvent = Schema.Struct({
  calendarId: Schema.String,
  id: Schema.String.check(Schema.isPattern(/^[A-Za-z0-9_-]{1,1024}$/u)),
  etag: Schema.String,
  status: Schema.Literals(['confirmed', 'cancelled']),
  htmlLink: Schema.String,
  created: Schema.String,
  updated: Schema.String,
  summary: Schema.String,
  description: Schema.optionalKey(Schema.String),
  start: GoogleEmulatorEventBoundary,
  end: GoogleEmulatorEventBoundary,
  iCalUID: Schema.String,
  sequence: NonNegativeInt
})

export type GoogleEmulatorCalendarEvent = typeof GoogleEmulatorCalendarEvent.Type

/** A Drive file or folder with the fields the connector's `fields` selection answers. */
export const GoogleEmulatorDriveFile = Schema.Struct({
  id: Schema.String.check(Schema.isPattern(/^[A-Za-z0-9_-]{10,200}$/u)),
  name: Schema.String,
  mimeType: Schema.String,
  starred: Schema.Boolean,
  trashed: Schema.Boolean,
  explicitlyTrashed: Schema.Boolean,
  trashedTime: Schema.optionalKey(Schema.String),
  parents: Schema.Array(Schema.String),
  spaces: Schema.Array(Schema.String),
  version: Schema.String,
  webViewLink: Schema.String,
  iconLink: Schema.String,
  hasThumbnail: Schema.Boolean,
  viewedByMe: Schema.Boolean,
  createdTime: Schema.String,
  modifiedTime: Schema.String,
  ownedByMe: Schema.Boolean,
  shared: Schema.Boolean,
  writersCanShare: Schema.Boolean,
  capabilities: JsonObject
})

export type GoogleEmulatorDriveFile = typeof GoogleEmulatorDriveFile.Type

const Counter = Schema.Int.check(Schema.isGreaterThanOrEqualTo(1))

const Counters = Schema.Struct({
  /** Next created label number (`Label_<n>`). */
  nextLabelNumber: Counter,
  /** Next created draft number (`r-8<n, 18 digits>`). */
  nextDraftNumber: Counter,
  /** Next draft message number (`18f…d<n>`). */
  nextDraftMessageNumber: Counter,
  /** Next sent message number (`18f…e<n>`, and the `Message-ID` header). */
  nextSentNumber: Counter,
  /** Next created event number (`syntheticconformance<nnnn>`). */
  nextEventNumber: Counter,
  /** Next created folder number (`synthetic-conformance-folder-<nnnn>`). */
  nextFolderNumber: Counter
})

/** The whole emulator state (JSON-compatible; what `snapshot()` returns). */
export const GoogleEmulatorStateSchema = Schema.Struct({
  practiceAddress: GoogleEmulatorPracticeAddress,
  messages: Schema.Array(GoogleEmulatorGmailMessage),
  impliedMessages: Schema.Array(GoogleEmulatorImpliedMessage),
  impliedLabelIds: Schema.Array(GmailId),
  labels: Schema.Array(GoogleEmulatorGmailLabel),
  attachments: Schema.Array(GoogleEmulatorAttachment),
  drafts: Schema.Array(GoogleEmulatorDraft),
  calendars: Schema.Array(GoogleEmulatorCalendar),
  events: Schema.Array(GoogleEmulatorCalendarEvent),
  files: Schema.Array(GoogleEmulatorDriveFile),
  impliedFolderIds: Schema.Array(Schema.String),
  counters: Counters
})

/**
 * The emulator state. The container is mutable (routes replace whole lists); every entity is
 * replaced, never edited in place.
 */
export type GoogleEmulatorState = {
  practiceAddress: string
  messages: ReadonlyArray<GoogleEmulatorGmailMessage>
  impliedMessages: ReadonlyArray<GoogleEmulatorImpliedMessage>
  impliedLabelIds: ReadonlyArray<string>
  labels: ReadonlyArray<GoogleEmulatorGmailLabel>
  attachments: ReadonlyArray<GoogleEmulatorAttachment>
  drafts: ReadonlyArray<GoogleEmulatorDraft>
  calendars: ReadonlyArray<GoogleEmulatorCalendar>
  events: ReadonlyArray<GoogleEmulatorCalendarEvent>
  files: ReadonlyArray<GoogleEmulatorDriveFile>
  impliedFolderIds: ReadonlyArray<string>
  counters: typeof Counters.Type
}

/** Account-variance profiles for the default seed. */
export const GoogleEmulatorProfile = Schema.Literals(['default', 'empty'])

export type GoogleEmulatorProfile = typeof GoogleEmulatorProfile.Type

/**
 * A typed seed. Start from `profile` (default `'default'`, the fixture entities); every other key,
 * when given, replaces that part of the profile. Created labels and drafts are never seeded.
 */
export const GoogleEmulatorSeed = Schema.Struct({
  profile: Schema.optionalKey(GoogleEmulatorProfile),
  practiceAddress: Schema.optionalKey(GoogleEmulatorPracticeAddress),
  messages: Schema.optionalKey(Schema.Array(GoogleEmulatorGmailMessage)),
  impliedMessages: Schema.optionalKey(Schema.Array(GoogleEmulatorImpliedMessage)),
  impliedLabelIds: Schema.optionalKey(Schema.Array(GmailId)),
  attachments: Schema.optionalKey(Schema.Array(GoogleEmulatorAttachment)),
  calendars: Schema.optionalKey(Schema.Array(GoogleEmulatorCalendar)),
  events: Schema.optionalKey(Schema.Array(GoogleEmulatorCalendarEvent)),
  files: Schema.optionalKey(Schema.Array(GoogleEmulatorDriveFile)),
  impliedFolderIds: Schema.optionalKey(Schema.Array(Schema.String))
})

export type GoogleEmulatorSeed = typeof GoogleEmulatorSeed.Type

const strict = { onExcessProperty: 'error' } as const

const decodeSeedInput = Schema.decodeUnknownResult(GoogleEmulatorSeed, strict)

const decodeStateInput = Schema.decodeUnknownResult(GoogleEmulatorStateSchema, strict)

const issueMessage = (issue: Schema.SchemaError['issue']): string =>
  new Schema.SchemaError(issue).message

// Minted forms (reserved: a seed may not use them).

export const pad = (value: number, width: number): string => String(value).padStart(width, '0')

/** A minted message id: `18f`, then `d<n>` (draft) or `e<n>` (sent), zero-padded to 16. */
export const mintedMessageId = (kind: 'd' | 'e', number: number): string =>
  `18f${`${kind}${number}`.padStart(13, '0')}`

export const mintedMessageIdPattern = /^18f0*[de]\d+$/

/** A minted draft id: `r-8` and 18 digits (`r-8000000000000000001` first). */
export const mintedDraftId = (number: number): string => `r-8${pad(number, 18)}`

export const mintedEventId = (number: number): string => `syntheticconformance${pad(number, 4)}`

export const mintedEventIdPattern = /^syntheticconformance\d+$/

export const mintedFolderId = (number: number): string =>
  `synthetic-conformance-folder-${pad(number, 4)}`

export const mintedFolderIdPattern = /^synthetic-conformance-folder-\d+$/

/** The label number the label fixture records for the first created label. */
const firstLabelNumber = 9101

/** The highest label number a created (minted) label id may carry: `Label_999999999`. */
export const lastLabelNumber = 999_999_999

/**
 * The minted label id form, `Label_<1 to 999999999>` without leading zeros. A seeded label id of
 * the `Label_<digits>` shape must have this form, so the created-label counter, which starts above
 * every seeded label number, never mints an id a seed holds.
 */
export const mintedLabelIdPattern = /^Label_([1-9]\d{0,8})$/

const labelDigitsPattern = /^Label_\d+$/

/** A Gmail system label (upper case), as opposed to a user label id such as `Label_9001`. */
export const isSystemLabel = (id: string): boolean => /^[A-Z][A-Z_]*$/.test(id)

// Default entities, copied from the fixtures and `googleConformanceFixtureSeeds`.

/** The practice account (`practice@example.test`) of every fixture. */
export const googleEmulatorDefaultPracticeAddress = 'practice@example.test'

/** Base64url without padding of UTF-8 text, as the fixtures encode message parts. */
export const base64UrlOfText = (text: string): string => {
  let binary = ''

  for (const byte of new TextEncoder().encode(text)) {
    binary += String.fromCharCode(byte)
  }

  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '')
}

/** The seeded work message (`format=minimal`, as the label and trash fixtures read it). */
const workMessage: GoogleEmulatorGmailMessage = {
  id: '18f00000000000b1',
  threadId: '18f00000000000b1',
  labelIds: ['INBOX', 'IMPORTANT'],
  snippet: 'Synthetic practice message.',
  sizeEstimate: 2048,
  historyId: '900001',
  internalDate: recordedInternalDate,
  minimal: true,
  metadataPayload: null,
  fullPayload: null
}

const attachmentText = 'Synthetic practice message with an attachment.'

const attachmentId = 'ANGjdJ_synthetic_attachment_0001'

/** The seeded attachment message (`format=full`, as the attachment fixture reads it). */
const attachmentMessage: GoogleEmulatorGmailMessage = {
  id: '18f00000000000a1',
  threadId: '18f00000000000a1',
  labelIds: ['INBOX'],
  snippet: attachmentText,
  sizeEstimate: 4096,
  historyId: '900010',
  internalDate: recordedInternalDate,
  minimal: false,
  metadataPayload: null,
  fullPayload: {
    partId: '',
    mimeType: 'multipart/mixed',
    filename: '',
    headers: [
      { name: 'Subject', value: 'Synthetic practice attachment' },
      { name: 'Content-Type', value: 'multipart/mixed; boundary="synthetic"' }
    ],
    body: { size: 0 },
    parts: [
      {
        partId: '0',
        mimeType: 'text/plain',
        filename: '',
        headers: [{ name: 'Content-Type', value: 'text/plain; charset="UTF-8"' }],
        body: { size: attachmentText.length, data: base64UrlOfText(attachmentText) }
      },
      {
        partId: '1',
        mimeType: 'application/octet-stream',
        filename: 'synthetic.bin',
        headers: [
          { name: 'Content-Type', value: 'application/octet-stream; name="synthetic.bin"' },
          { name: 'Content-Disposition', value: 'attachment; filename="synthetic.bin"' },
          { name: 'Content-Transfer-Encoding', value: 'base64' }
        ],
        body: { attachmentId, size: 6 }
      }
    ]
  }
}

const pagingLabelId = 'Label_9001'

/** The five messages the paging fixture names (listing entries only). */
const pagingMessages: ReadonlyArray<GoogleEmulatorImpliedMessage> = [1, 2, 3, 4, 5].map(index => ({
  id: `18f00000000000c${index}`,
  threadId: `18f00000000000c${index}`,
  labelIds: [pagingLabelId]
}))

const calendarId = 'practice-calendar@example.test'

const practiceCalendar: GoogleEmulatorCalendar = {
  id: calendarId,
  summary: 'Synthetic practice calendar',
  timeZone: 'UTC',
  accessRole: 'owner'
}

const seededAt = '2026-09-30T12:00:00.000Z'

/** An event with the fixture's derived fields (`etag`, `htmlLink`, `iCalUID`). */
export const eventFields = (
  id: string
): Pick<GoogleEmulatorCalendarEvent, 'etag' | 'htmlLink' | 'iCalUID'> => ({
  etag: `"3${id.length}000000000000"`,
  htmlLink: `https://www.google.com/calendar/event?eid=${id}`,
  iCalUID: `${id}@google.com`
})

const rangeEvent = (
  id: string,
  summary: string,
  start: GoogleEmulatorEventBoundary,
  end: GoogleEmulatorEventBoundary
): GoogleEmulatorCalendarEvent => ({
  calendarId,
  id,
  ...eventFields(id),
  status: 'confirmed',
  created: seededAt,
  updated: seededAt,
  summary,
  start,
  end,
  sequence: 0
})

const utc = (dateTime: string): GoogleEmulatorEventBoundary => ({ dateTime, timeZone: 'UTC' })

/** The five events of the range fixture (one all-day, two crossing the range edges). */
const rangeEvents: ReadonlyArray<GoogleEmulatorCalendarEvent> = [
  rangeEvent(
    'syntheticrange0001',
    'Synthetic overnight',
    utc('2026-08-31T23:30:00Z'),
    utc('2026-09-01T00:30:00Z')
  ),
  rangeEvent(
    'syntheticrange0002',
    'Synthetic standup',
    utc('2026-09-02T09:00:00Z'),
    utc('2026-09-02T09:15:00Z')
  ),
  rangeEvent(
    'syntheticrange0003',
    'Synthetic review',
    utc('2026-09-03T14:00:00Z'),
    utc('2026-09-03T15:00:00Z')
  ),
  rangeEvent(
    'syntheticrange0004',
    'Synthetic all-day',
    { date: '2026-09-05' },
    { date: '2026-09-06' }
  ),
  rangeEvent(
    'syntheticrange0005',
    'Synthetic late',
    utc('2026-09-07T23:00:00Z'),
    utc('2026-09-08T01:00:00Z')
  )
]

/** The folder mime type Drive answers. */
export const driveFolderMimeType = 'application/vnd.google-apps.folder'

const practiceFolderId = 'synthetic-practice-folder-0001'

/** A Drive item with the fixture's derived and constant fields. */
export const driveFile = (fields: {
  readonly id: string
  readonly name: string
  readonly mimeType: string
  readonly parents: ReadonlyArray<string>
  readonly createdTime: string
}): GoogleEmulatorDriveFile => ({
  id: fields.id,
  name: fields.name,
  mimeType: fields.mimeType,
  starred: false,
  trashed: false,
  explicitlyTrashed: false,
  parents: [...fields.parents],
  spaces: ['drive'],
  version: '3',
  webViewLink: `https://drive.google.com/drive/folders/${fields.id}`,
  iconLink: `https://drive-thirdparty.googleusercontent.com/16/type/${fields.mimeType}`,
  hasThumbnail: false,
  viewedByMe: true,
  createdTime: fields.createdTime,
  modifiedTime: fields.createdTime,
  ownedByMe: true,
  shared: false,
  writersCanShare: true,
  capabilities: {
    canAddChildren: fields.mimeType === driveFolderMimeType,
    canDelete: true,
    canEdit: true,
    canRename: true,
    canTrash: true,
    canUntrash: true
  }
})

const child = (id: string, name: string, mimeType: string) =>
  driveFile({ id, name, mimeType, parents: [practiceFolderId], createdTime: seededAt })

/** The five children of the practice folder (the first is the seeded practice file). */
const practiceChildren: ReadonlyArray<GoogleEmulatorDriveFile> = [
  child('synthetic-practice-file-0001', 'Synthetic practice notes.txt', 'text/plain'),
  child('synthetic-practice-file-0002', 'Synthetic practice sheet.csv', 'text/csv'),
  child('synthetic-practice-file-0003', 'Synthetic practice image.png', 'image/png'),
  child('synthetic-practice-folder-0002', 'Synthetic practice subfolder', driveFolderMimeType),
  child('synthetic-practice-file-0004', 'Synthetic practice report.pdf', 'application/pdf')
]

type ProfileEntities = Omit<GoogleEmulatorState, 'counters' | 'labels' | 'drafts'>

const profileEntities = (profile: GoogleEmulatorProfile): ProfileEntities =>
  profile === 'default'
    ? {
        practiceAddress: googleEmulatorDefaultPracticeAddress,
        messages: [attachmentMessage, workMessage],
        impliedMessages: pagingMessages,
        impliedLabelIds: [pagingLabelId],
        attachments: [{ messageId: attachmentMessage.id, attachmentId, size: 6, data: '-_-_Pj_-' }],
        calendars: [practiceCalendar],
        events: rangeEvents,
        files: practiceChildren,
        impliedFolderIds: [practiceFolderId]
      }
    : {
        practiceAddress: googleEmulatorDefaultPracticeAddress,
        messages: [],
        impliedMessages: [],
        impliedLabelIds: [],
        attachments: [],
        calendars: [],
        events: [],
        files: [],
        impliedFolderIds: []
      }

const duplicate = (values: ReadonlyArray<string>): string | undefined =>
  values.find((value, index) => values.indexOf(value) !== index)

/** Integrity problems a decoded seed can still have (duplicates, minted forms, references). */
const seedProblem = (entities: ProfileEntities): string | undefined => {
  const messageIds = [
    ...entities.messages.map(message => message.id),
    ...entities.impliedMessages.map(message => message.id)
  ]

  const fileIds = entities.files.map(file => file.id)

  const duplicates: ReadonlyArray<readonly [string, string | undefined]> = [
    ['message id', duplicate(messageIds)],
    ['label id', duplicate(entities.impliedLabelIds)],
    [
      'attachment',
      duplicate(entities.attachments.map(item => `${item.messageId} ${item.attachmentId}`))
    ],
    ['calendar id', duplicate(entities.calendars.map(calendar => calendar.id))],
    ['event', duplicate(entities.events.map(event => `${event.calendarId} ${event.id}`))],
    ['Drive id', duplicate([...fileIds, ...entities.impliedFolderIds])]
  ]

  for (const [label, value] of duplicates) {
    if (value !== undefined) return `duplicate ${label} ${value}`
  }

  const minted =
    messageIds.find(id => mintedMessageIdPattern.test(id)) ??
    entities.events.map(event => event.id).find(id => mintedEventIdPattern.test(id)) ??
    [...fileIds, ...entities.impliedFolderIds].find(id => mintedFolderIdPattern.test(id))

  if (minted !== undefined) return `seed id ${minted} uses a form reserved for minted ids`

  // A thread id shares the minted message id forms (a created draft is its own thread).
  const mintedThread = [...entities.messages, ...entities.impliedMessages]
    .map(message => message.threadId)
    .find(id => mintedMessageIdPattern.test(id))

  if (mintedThread !== undefined) {
    return `seed thread id ${mintedThread} uses a form reserved for minted ids`
  }

  const outsideRange = [
    ...entities.impliedLabelIds,
    ...[...entities.messages, ...entities.impliedMessages].flatMap(message => message.labelIds)
  ].find(id => labelDigitsPattern.test(id) && !mintedLabelIdPattern.test(id))

  if (outsideRange !== undefined) {
    return `seed label id ${outsideRange} is outside the Label_<1 to ${lastLabelNumber}> form`
  }

  const knownLabels = new Set(entities.impliedLabelIds)

  for (const message of [...entities.messages, ...entities.impliedMessages]) {
    const unknown = message.labelIds.find(id => !isSystemLabel(id) && !knownLabels.has(id))

    if (unknown !== undefined) {
      return `message ${message.id} carries label ${unknown}, which is not in impliedLabelIds`
    }
  }

  const attachment = entities.attachments.find(
    item => !entities.messages.some(message => message.id === item.messageId)
  )

  if (attachment !== undefined) {
    return `attachment ${attachment.attachmentId} references missing message ${attachment.messageId}`
  }

  const event = entities.events.find(
    item => !entities.calendars.some(calendar => calendar.id === item.calendarId)
  )

  if (event !== undefined) {
    return `event ${event.id} references missing calendar ${event.calendarId}`
  }

  const folders = new Set([
    ...entities.files.filter(file => file.mimeType === driveFolderMimeType).map(file => file.id),
    ...entities.impliedFolderIds
  ])

  const orphan = entities.files.find(file => file.parents.some(parent => !folders.has(parent)))

  return orphan === undefined
    ? undefined
    : `Drive item ${orphan.id} references a missing parent folder`
}

/** Build the emulator state for a decoded seed; a string is an integrity problem. */
const stateFromSeed = (seed: GoogleEmulatorSeed): GoogleEmulatorState | string => {
  const profile = profileEntities(seed.profile ?? 'default')

  const entities: ProfileEntities = {
    practiceAddress: seed.practiceAddress ?? profile.practiceAddress,
    messages: seed.messages ?? profile.messages,
    impliedMessages: seed.impliedMessages ?? profile.impliedMessages,
    impliedLabelIds: seed.impliedLabelIds ?? profile.impliedLabelIds,
    attachments: seed.attachments ?? profile.attachments,
    calendars: seed.calendars ?? profile.calendars,
    events: seed.events ?? profile.events,
    files: seed.files ?? profile.files,
    impliedFolderIds: seed.impliedFolderIds ?? profile.impliedFolderIds
  }

  const problem = seedProblem(entities)

  if (problem !== undefined) return problem

  // Above every seeded label number and never below the recorded one (each at most nine digits,
  // checked in `seedProblem`).
  const highestLabel = Math.max(
    firstLabelNumber - 1,
    ...entities.impliedLabelIds.map(id => Number(mintedLabelIdPattern.exec(id)?.[1] ?? 0))
  )

  return {
    ...entities,
    labels: [],
    drafts: [],
    counters: {
      nextLabelNumber: highestLabel + 1,
      nextDraftNumber: 1,
      nextDraftMessageNumber: 1,
      nextSentNumber: 1,
      nextEventNumber: 1,
      nextFolderNumber: 1
    }
  }
}

/** Decode and build a seed; a string is the reason it is invalid. */
export const buildSeedState = (input: unknown): GoogleEmulatorState | string => {
  const decoded = decodeSeedInput(input)

  return Result.isFailure(decoded)
    ? issueMessage(decoded.failure.issue)
    : stateFromSeed(decoded.success)
}

/** Decode a full state (a restored snapshot); a string is the reason it is invalid. */
export const decodeState = (input: unknown): GoogleEmulatorState | string => {
  const decoded = decodeStateInput(input)

  return Result.isFailure(decoded) ? issueMessage(decoded.failure.issue) : { ...decoded.success }
}
