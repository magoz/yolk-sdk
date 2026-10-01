/**
 * Shared synthetic shapes of the Google fixtures (internal): the URLs and request headers the
 * connector sends, and Gmail, Calendar, and Drive answers shaped like the Google APIs. Synthetic
 * data only (`example.test` addresses, made-up ids); never recorded from a live account.
 */
import type * as Schema from 'effect/Schema'
import type { WireHeaders, WireResponse } from '@yolk-sdk/conformance/fixture'
import { googleDriveFileFields, googleDriveFolderMimeType } from '../drive.ts'

export const gmailSyntheticApi = 'https://gmail.googleapis.com/gmail/v1/users/me'

export const googleSyntheticPracticeAddress = 'practice@example.test'

export const calendarSyntheticId = 'practice-calendar@example.test'

export const calendarSyntheticEvents = `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(calendarSyntheticId)}/events`

export const driveSyntheticApi = 'https://www.googleapis.com/drive/v3'

export const driveSyntheticFolderId = 'synthetic-practice-folder-0001'

/** Recorded request headers of a JSON request body (credential headers are never recorded). */
export const googleJsonRequestHeaders: WireHeaders = { 'content-type': 'application/json' }

/** Recorded request headers of a Drive read (the connector asks for JSON). */
export const driveReadRequestHeaders: WireHeaders = { accept: 'application/json' }

/** Recorded request headers of a Drive write with a JSON body. */
export const driveWriteRequestHeaders: WireHeaders = {
  accept: 'application/json',
  'content-type': 'application/json'
}

export const googleJson = (status: number, body: Schema.Json): WireResponse => ({
  status,
  headers: { 'content-type': 'application/json; charset=UTF-8' },
  body: JSON.stringify(body)
})

export const googleNoContent: WireResponse = { status: 204, headers: {}, body: '' }

/** The Google JSON error envelope. */
export const googleErrorBody = (
  code: number,
  message: string,
  reason: string,
  status: string
): Schema.Json => ({
  error: { code, message, errors: [{ message, domain: 'global', reason }], status }
})

/** Base64url without padding of UTF-8 text, as the connector encodes MIME. */
export const base64UrlOfText = (text: string): string => {
  let binary = ''

  for (const byte of new TextEncoder().encode(text)) {
    binary += String.fromCharCode(byte)
  }

  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '')
}

/** A Gmail message as `format: "minimal"` answers it. */
export const gmailSyntheticMinimalMessage = (
  id: string,
  labelIds: ReadonlyArray<string>
): Schema.Json => ({
  id,
  threadId: id,
  labelIds: [...labelIds],
  snippet: 'Synthetic practice message.',
  sizeEstimate: 2048,
  historyId: '900001',
  internalDate: '1790000000000'
})

type SyntheticLabel = {
  readonly id: string
  readonly name: string
  readonly messageListVisibility: string
  readonly labelListVisibility: string
  readonly type: string
  messagesTotal?: number
  messagesUnread?: number
  threadsTotal?: number
  threadsUnread?: number
}

/** A label as the labels endpoints answer it. */
export const gmailSyntheticLabel = (
  id: string,
  name: string,
  counts: { readonly messagesTotal?: number } = {}
): Schema.Json => {
  const label: SyntheticLabel = {
    id,
    name,
    messageListVisibility: 'show',
    labelListVisibility: 'labelShow',
    type: 'user'
  }

  if (counts.messagesTotal !== undefined) {
    label.messagesTotal = counts.messagesTotal
    label.messagesUnread = 0
    label.threadsTotal = counts.messagesTotal
    label.threadsUnread = 0
  }

  return label
}

/** The Gmail not-found envelope. */
export const gmailNotFound: WireResponse = googleJson(
  404,
  googleErrorBody(404, 'Requested entity was not found.', 'notFound', 'NOT_FOUND')
)

/** The URL `calendar.list_events` builds (parameters in the connector's order). */
export const calendarListUrl = (query: {
  readonly timeMin?: string
  readonly timeMax?: string
  readonly q?: string
  readonly maxResults?: number
  readonly pageToken?: string
  readonly singleEvents?: boolean
  readonly orderBy?: string
}): string => {
  const params = new URLSearchParams()

  for (const [key, value] of [
    ['timeMin', query.timeMin],
    ['timeMax', query.timeMax],
    ['q', query.q],
    ['maxResults', query.maxResults],
    ['pageToken', query.pageToken],
    ['singleEvents', query.singleEvents],
    ['orderBy', query.orderBy]
  ] as const) {
    if (value !== undefined) {
      params.set(key, String(value))
    }
  }

  return `${calendarSyntheticEvents}?${params.toString()}`
}

type SyntheticBoundary =
  | { readonly dateTime: string; readonly timeZone?: string }
  | { readonly date: string }

type SyntheticEventHead = {
  readonly kind: string
  readonly etag: string
  readonly id: string
  readonly status: string
  readonly htmlLink: string
  readonly created: string
  readonly updated: string
  readonly summary: string
  description?: string
}

/** A calendar event as the events endpoints answer it. */
export const calendarSyntheticEvent = (fields: {
  readonly id: string
  readonly summary: string
  readonly start: SyntheticBoundary
  readonly end: SyntheticBoundary
  readonly description?: string
  readonly status?: string
  readonly updated?: string
}): Schema.Json => {
  const event: SyntheticEventHead = {
    kind: 'calendar#event',
    etag: `"3${fields.id.length}000000000000"`,
    id: fields.id,
    status: fields.status ?? 'confirmed',
    htmlLink: `https://www.google.com/calendar/event?eid=${fields.id}`,
    created: '2026-09-30T12:00:00.000Z',
    updated: fields.updated ?? '2026-09-30T12:00:00.000Z',
    summary: fields.summary
  }

  if (fields.description !== undefined) {
    event.description = fields.description
  }

  return {
    ...event,
    creator: { email: googleSyntheticPracticeAddress, self: true },
    organizer: {
      email: calendarSyntheticId,
      displayName: 'Synthetic practice calendar',
      self: true
    },
    start: { ...fields.start },
    end: { ...fields.end },
    iCalUID: `${fields.id}@google.com`,
    sequence: 0,
    reminders: { useDefault: true },
    eventType: 'default'
  }
}

/** The URL `drive.list_files` builds for `parentId` (parameters in the connector's order). */
export const driveListUrl = (
  parentId: string,
  query: { readonly pageSize: number; readonly pageToken?: string }
): string => {
  const params = new URLSearchParams()

  params.set('pageSize', String(query.pageSize))

  if (query.pageToken !== undefined) params.set('pageToken', query.pageToken)

  params.set('q', `'${parentId}' in parents and trashed = false`)
  params.set('spaces', 'drive')
  params.set('supportsAllDrives', 'true')
  params.set('includeItemsFromAllDrives', 'true')
  params.set('corpora', 'user')
  params.set('fields', `kind,nextPageToken,incompleteSearch,files(${googleDriveFileFields})`)

  return `${driveSyntheticApi}/files?${params.toString()}`
}

const driveFieldsQuery = new URLSearchParams({
  supportsAllDrives: 'true',
  fields: googleDriveFileFields
}).toString()

/** The URL `drive.get_file` and `drive.trash_file` build for `fileId`. */
export const driveFileUrl = (fileId: string): string =>
  `${driveSyntheticApi}/files/${fileId}?${driveFieldsQuery}`

/** The URL `drive.create_folder` builds. */
export const driveCreateUrl = `${driveSyntheticApi}/files?${driveFieldsQuery}`

/** The URL `drive.delete_file` builds for `fileId`. */
export const driveDeleteUrl = (fileId: string): string =>
  `${driveSyntheticApi}/files/${fileId}?supportsAllDrives=true`

type SyntheticFileHead = {
  readonly kind: string
  readonly id: string
  readonly name: string
  readonly mimeType: string
  readonly starred: boolean
  readonly trashed: boolean
  readonly explicitlyTrashed: boolean
  trashedTime?: string
}

/** A Drive file or folder as the files endpoints answer it (with the connector's `fields`). */
export const driveSyntheticFile = (fields: {
  readonly id: string
  readonly name: string
  readonly mimeType: string
  readonly parents?: ReadonlyArray<string>
  readonly trashed?: boolean
}): Schema.Json => {
  const trashed = fields.trashed ?? false

  const file: SyntheticFileHead = {
    kind: 'drive#file',
    id: fields.id,
    name: fields.name,
    mimeType: fields.mimeType,
    starred: false,
    trashed,
    explicitlyTrashed: trashed
  }

  // Drive answers `trashedTime` only for a trashed item.
  if (trashed) {
    file.trashedTime = '2026-09-30T12:00:02.000Z'
  }

  return {
    ...file,
    parents: [...(fields.parents ?? [driveSyntheticFolderId])],
    spaces: ['drive'],
    version: '3',
    webViewLink: `https://drive.google.com/drive/folders/${fields.id}`,
    iconLink: `https://drive-thirdparty.googleusercontent.com/16/type/${fields.mimeType}`,
    hasThumbnail: false,
    viewedByMe: true,
    createdTime: '2026-09-30T12:00:00.000Z',
    modifiedTime: '2026-09-30T12:00:00.000Z',
    ownedByMe: true,
    shared: false,
    writersCanShare: true,
    capabilities: {
      canAddChildren: fields.mimeType === googleDriveFolderMimeType,
      canDelete: true,
      canEdit: true,
      canRename: true,
      canTrash: true,
      canUntrash: true
    }
  }
}

/** The five children of the synthetic practice folder (the first is the seeded practice file). */
export const driveSyntheticChildren: ReadonlyArray<Schema.Json> = [
  driveSyntheticFile({
    id: 'synthetic-practice-file-0001',
    name: 'Synthetic practice notes.txt',
    mimeType: 'text/plain'
  }),
  driveSyntheticFile({
    id: 'synthetic-practice-file-0002',
    name: 'Synthetic practice sheet.csv',
    mimeType: 'text/csv'
  }),
  driveSyntheticFile({
    id: 'synthetic-practice-file-0003',
    name: 'Synthetic practice image.png',
    mimeType: 'image/png'
  }),
  driveSyntheticFile({
    id: 'synthetic-practice-folder-0002',
    name: 'Synthetic practice subfolder',
    mimeType: googleDriveFolderMimeType
  }),
  driveSyntheticFile({
    id: 'synthetic-practice-file-0004',
    name: 'Synthetic practice report.pdf',
    mimeType: 'application/pdf'
  })
]

type SyntheticFileListHead = {
  readonly kind: string
  readonly incompleteSearch: boolean
  nextPageToken?: string
}

export const driveSyntheticFileList = (
  files: ReadonlyArray<Schema.Json>,
  nextPageToken?: string
): WireResponse => {
  const list: SyntheticFileListHead = { kind: 'drive#fileList', incompleteSearch: false }

  if (nextPageToken !== undefined) {
    list.nextPageToken = nextPageToken
  }

  return googleJson(200, { ...list, files: [...files] })
}

/** Draft text with non-ASCII characters, so the UTF-8 bytes and the base64url decoding matter. */
export const gmailConformanceDraftText = 'Synthetic conformance draft, safe to delete: grüße ✓'

export const gmailConformanceUpdatedDraftText = 'Updated synthetic conformance draft: ¡hola! ✓'

/**
 * The 7-bit MIME message the send case submits: the practice address as the ONLY recipient header
 * (no Cc or Bcc), the run-scoped subject, and a synthetic text.
 */
export const gmailConformancePracticeMime = (practiceAddress: string, subject: string): string =>
  [
    `To: ${practiceAddress}`,
    `Subject: ${subject}`,
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset=us-ascii',
    '',
    'Synthetic conformance message sent to the seeded practice address only. Safe to delete.',
    ''
  ].join('\r\n')

/**
 * When the case events take place: a fixed synthetic half hour far from any practice range (keep
 * the seeded event range away from it).
 */
export const calendarConformanceEventStart = '2030-01-07T09:00:00Z'

export const calendarConformanceEventEnd = '2030-01-07T09:30:00Z'
