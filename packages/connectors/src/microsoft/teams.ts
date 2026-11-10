import { Effect } from 'effect'
import * as Schema from 'effect/Schema'
import { defineAction } from '../action.ts'
import type { CredentialSlot } from '../credential.ts'
import { ConnectorError } from '../error.ts'
import { ConnectorHttpClient, ConnectorHttpRequest, decodeJsonResponse } from '../http.ts'
import type { ConnectorIntegration } from '../integration.ts'
import { ActionResult } from '../result.ts'
import {
  microsoftAuthorizationHeaders,
  microsoftConnectorId,
  MicrosoftTeamsChannelMessageReadOAuthCredentialSlot,
  MicrosoftTeamsChannelMessageSendOAuthCredentialSlot,
  MicrosoftTeamsChannelReadOAuthCredentialSlot,
  MicrosoftTeamsChatReadOAuthCredentialSlot,
  MicrosoftTeamsChatSendOAuthCredentialSlot,
  MicrosoftTeamsMeetingReadOAuthCredentialSlot,
  MicrosoftTeamsTeamReadOAuthCredentialSlot,
  MicrosoftTeamsTranscriptReadOAuthCredentialSlot
} from './oauth.ts'
import {
  isMicrosoftSuccessStatus,
  isTrustedGraphUrl,
  microsoftGraphApiBaseUrl,
  microsoftProviderFailure,
  resolveMicrosoftAccessToken
} from './shared.ts'

// Graph ids of chats (`19:…@thread.v2`), channels, teams, messages and meetings are opaque. A
// dot-only id would be normalized away; separators, controls and lone surrogates fail validation.
export const TeamsId = Schema.Trimmed.check(
  Schema.isNonEmpty(),
  Schema.isMaxLength(1024),
  Schema.makeFilter(
    value =>
      !/^\.+$/.test(value) &&
      !/[\s/\\?#]/.test(value) &&
      !/[\u0000-\u001f\u007f]/.test(value) &&
      !/[\ud800-\udfff]/u.test(value)
  )
)

// Meeting and transcript ids are base64 and may hold `/`, `+` or `=`; the path encodes them whole.
export const TeamsMeetingId = Schema.Trimmed.check(
  Schema.isNonEmpty(),
  Schema.isMaxLength(2048),
  Schema.makeFilter(
    value =>
      !/^[./]+$/.test(value) &&
      !/[\s\\?#]/.test(value) &&
      !/[\u0000-\u001f\u007f]/.test(value) &&
      !/[\ud800-\udfff]/u.test(value)
  )
)

const TeamsPageSize = Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 50 }))

/**
 * Upper bound of a sent message's HTML body in UTF-8 bytes. Teams accepts about 100 KB per post
 * (80 KB recommended, mentions and reactions included); the margin keeps an approved send from
 * failing on size.
 */
export const teamsMessageMaxBytes = 28 * 1024

const escapeHtmlCharacter = (character: string) => {
  switch (character) {
    case '&':
      return '&amp;'
    case '<':
      return '&lt;'
    case '>':
      return '&gt;'
    case '"':
      return '&quot;'
    default:
      return '&#39;'
  }
}

/**
 * The HTML body a plain-text Teams message is sent as: every markup character escaped and every
 * line break a `<br>`, since Graph documents no line-break handling for `text` bodies.
 */
export const teamsMessageHtml = (text: string) =>
  text.replace(/[&<>"']/g, escapeHtmlCharacter).replace(/\r\n|\r|\n/g, '<br>')

const utf8Bytes = (text: string) => new TextEncoder().encode(text).byteLength

/** A plain-text message: not blank, well-formed, and within `teamsMessageMaxBytes` once escaped. */
export const TeamsMessageText = Schema.String.check(
  Schema.makeFilter(value =>
    value.trim().length === 0
      ? 'A Teams message needs text'
      : /[\ud800-\udfff]/u.test(value)
        ? 'Invalid Unicode text'
        : utf8Bytes(teamsMessageHtml(value)) > teamsMessageMaxBytes
          ? `A Teams message is limited to ${teamsMessageMaxBytes} bytes once HTML-escaped`
          : undefined
  )
)

const TeamsSubject = Schema.Trimmed.check(Schema.isNonEmpty(), Schema.isMaxLength(255))

// Graph sends null for many unset properties; the public shapes omit them.
const OptionalWireString = Schema.optional(Schema.NullOr(Schema.String))

const OptionalWireBoolean = Schema.optional(Schema.NullOr(Schema.Boolean))

const present = <A>(value: A | null | undefined) => (value === null ? undefined : value)

type Mutable<T> = { -readonly [K in keyof T]: T[K] }

/** The present (non-null) string properties `keys` of a decoded wire object. */
const stringFields = <K extends string>(
  wire: { readonly [P in K]?: string | null | undefined },
  keys: ReadonlyArray<K>
) => {
  const fields: { [P in K]?: string } = {}

  for (const key of keys) {
    const value = wire[key]

    if (value !== null && value !== undefined) fields[key] = value
  }

  return fields
}

// ---------------------------------------------------------------------------------------------
// Public shapes
// ---------------------------------------------------------------------------------------------

export class TeamsIdentity extends Schema.Class<TeamsIdentity>('TeamsIdentity')({
  kind: Schema.Literals(['user', 'application', 'device']),
  id: Schema.optional(Schema.String),
  displayName: Schema.optional(Schema.String)
}) {}

export class TeamsMessageBody extends Schema.Class<TeamsMessageBody>('TeamsMessageBody')({
  contentType: Schema.String,
  content: Schema.String
}) {}

export class TeamsMessageAttachment extends Schema.Class<TeamsMessageAttachment>(
  'TeamsMessageAttachment'
)({
  id: Schema.optional(Schema.String),
  name: Schema.optional(Schema.String),
  contentType: Schema.optional(Schema.String),
  contentUrl: Schema.optional(Schema.String)
}) {}

export class TeamsMessageMention extends Schema.Class<TeamsMessageMention>('TeamsMessageMention')({
  mentionText: Schema.optional(Schema.String),
  mentioned: Schema.optional(TeamsIdentity)
}) {}

export class TeamsChannelIdentity extends Schema.Class<TeamsChannelIdentity>(
  'TeamsChannelIdentity'
)({
  teamId: Schema.optional(Schema.String),
  channelId: Schema.optional(Schema.String)
}) {}

export class TeamsMessage extends Schema.Class<TeamsMessage>('TeamsMessage')({
  id: Schema.String,
  replyToId: Schema.optional(Schema.String),
  messageType: Schema.optional(Schema.String),
  createdDateTime: Schema.optional(Schema.String),
  lastModifiedDateTime: Schema.optional(Schema.String),
  lastEditedDateTime: Schema.optional(Schema.String),
  deletedDateTime: Schema.optional(Schema.String),
  subject: Schema.optional(Schema.String),
  importance: Schema.optional(Schema.String),
  from: Schema.optional(TeamsIdentity),
  body: Schema.optional(TeamsMessageBody),
  attachments: Schema.optional(Schema.Array(TeamsMessageAttachment)),
  mentions: Schema.optional(Schema.Array(TeamsMessageMention)),
  chatId: Schema.optional(Schema.String),
  channelIdentity: Schema.optional(TeamsChannelIdentity),
  webUrl: Schema.optional(Schema.String)
}) {}

export class TeamsChatMember extends Schema.Class<TeamsChatMember>('TeamsChatMember')({
  displayName: Schema.optional(Schema.String),
  email: Schema.optional(Schema.String),
  userId: Schema.optional(Schema.String),
  roles: Schema.optional(Schema.Array(Schema.String))
}) {}

export class TeamsChatMessagePreview extends Schema.Class<TeamsChatMessagePreview>(
  'TeamsChatMessagePreview'
)({
  id: Schema.optional(Schema.String),
  createdDateTime: Schema.optional(Schema.String),
  isDeleted: Schema.optional(Schema.Boolean),
  messageType: Schema.optional(Schema.String),
  from: Schema.optional(TeamsIdentity),
  body: Schema.optional(TeamsMessageBody)
}) {}

export class TeamsChat extends Schema.Class<TeamsChat>('TeamsChat')({
  id: Schema.String,
  topic: Schema.optional(Schema.String),
  chatType: Schema.optional(Schema.String),
  createdDateTime: Schema.optional(Schema.String),
  lastUpdatedDateTime: Schema.optional(Schema.String),
  webUrl: Schema.optional(Schema.String),
  onlineMeetingJoinWebUrl: Schema.optional(Schema.String),
  members: Schema.optional(Schema.Array(TeamsChatMember)),
  lastMessagePreview: Schema.optional(TeamsChatMessagePreview)
}) {}

export class TeamsTeam extends Schema.Class<TeamsTeam>('TeamsTeam')({
  id: Schema.String,
  displayName: Schema.optional(Schema.String),
  description: Schema.optional(Schema.String),
  isArchived: Schema.optional(Schema.Boolean),
  webUrl: Schema.optional(Schema.String)
}) {}

export class TeamsChannel extends Schema.Class<TeamsChannel>('TeamsChannel')({
  id: Schema.String,
  displayName: Schema.optional(Schema.String),
  description: Schema.optional(Schema.String),
  membershipType: Schema.optional(Schema.String),
  createdDateTime: Schema.optional(Schema.String),
  webUrl: Schema.optional(Schema.String)
}) {}

export class TeamsMeetingParticipant extends Schema.Class<TeamsMeetingParticipant>(
  'TeamsMeetingParticipant'
)({
  displayName: Schema.optional(Schema.String),
  userId: Schema.optional(Schema.String),
  upn: Schema.optional(Schema.String),
  role: Schema.optional(Schema.String)
}) {}

export class TeamsOnlineMeeting extends Schema.Class<TeamsOnlineMeeting>('TeamsOnlineMeeting')({
  id: Schema.String,
  subject: Schema.optional(Schema.String),
  startDateTime: Schema.optional(Schema.String),
  endDateTime: Schema.optional(Schema.String),
  joinWebUrl: Schema.optional(Schema.String),
  chatId: Schema.optional(Schema.String),
  organizer: Schema.optional(TeamsMeetingParticipant),
  attendees: Schema.optional(Schema.Array(TeamsMeetingParticipant))
}) {}

export class TeamsMeetingTranscript extends Schema.Class<TeamsMeetingTranscript>(
  'TeamsMeetingTranscript'
)({
  id: Schema.String,
  meetingId: Schema.optional(Schema.String),
  createdDateTime: Schema.optional(Schema.String),
  endDateTime: Schema.optional(Schema.String),
  organizer: Schema.optional(TeamsIdentity)
}) {}

// ---------------------------------------------------------------------------------------------
// Wire shapes
// ---------------------------------------------------------------------------------------------

const IdentityApi = Schema.Struct({
  id: OptionalWireString,
  displayName: OptionalWireString
})

const IdentitySetApi = Schema.Struct({
  user: Schema.optional(Schema.NullOr(IdentityApi)),
  application: Schema.optional(Schema.NullOr(IdentityApi)),
  device: Schema.optional(Schema.NullOr(IdentityApi))
})

const BodyApi = Schema.Struct({
  contentType: OptionalWireString,
  content: OptionalWireString
})

const AttachmentApi = Schema.Struct({
  id: OptionalWireString,
  name: OptionalWireString,
  contentType: OptionalWireString,
  contentUrl: OptionalWireString
})

const MentionApi = Schema.Struct({
  mentionText: OptionalWireString,
  mentioned: Schema.optional(Schema.NullOr(IdentitySetApi))
})

const MessageApi = Schema.Struct({
  id: Schema.String,
  replyToId: OptionalWireString,
  messageType: OptionalWireString,
  createdDateTime: OptionalWireString,
  lastModifiedDateTime: OptionalWireString,
  lastEditedDateTime: OptionalWireString,
  deletedDateTime: OptionalWireString,
  subject: OptionalWireString,
  importance: OptionalWireString,
  from: Schema.optional(Schema.NullOr(IdentitySetApi)),
  body: Schema.optional(Schema.NullOr(BodyApi)),
  attachments: Schema.optional(Schema.NullOr(Schema.Array(AttachmentApi))),
  mentions: Schema.optional(Schema.NullOr(Schema.Array(MentionApi))),
  chatId: OptionalWireString,
  channelIdentity: Schema.optional(
    Schema.NullOr(Schema.Struct({ teamId: OptionalWireString, channelId: OptionalWireString }))
  ),
  webUrl: OptionalWireString
})

const MemberApi = Schema.Struct({
  displayName: OptionalWireString,
  email: OptionalWireString,
  userId: OptionalWireString,
  roles: Schema.optional(Schema.NullOr(Schema.Array(Schema.String)))
})

const MessagePreviewApi = Schema.Struct({
  id: OptionalWireString,
  createdDateTime: OptionalWireString,
  isDeleted: OptionalWireBoolean,
  messageType: OptionalWireString,
  from: Schema.optional(Schema.NullOr(IdentitySetApi)),
  body: Schema.optional(Schema.NullOr(BodyApi))
})

const ChatApi = Schema.Struct({
  id: Schema.String,
  topic: OptionalWireString,
  chatType: OptionalWireString,
  createdDateTime: OptionalWireString,
  lastUpdatedDateTime: OptionalWireString,
  webUrl: OptionalWireString,
  onlineMeetingInfo: Schema.optional(
    Schema.NullOr(Schema.Struct({ joinWebUrl: OptionalWireString }))
  ),
  members: Schema.optional(Schema.NullOr(Schema.Array(MemberApi))),
  lastMessagePreview: Schema.optional(Schema.NullOr(MessagePreviewApi))
})

const TeamApi = Schema.Struct({
  id: Schema.String,
  displayName: OptionalWireString,
  description: OptionalWireString,
  isArchived: OptionalWireBoolean,
  webUrl: OptionalWireString
})

const ChannelApi = Schema.Struct({
  id: Schema.String,
  displayName: OptionalWireString,
  description: OptionalWireString,
  membershipType: OptionalWireString,
  createdDateTime: OptionalWireString,
  webUrl: OptionalWireString
})

const MeetingParticipantApi = Schema.Struct({
  upn: OptionalWireString,
  role: OptionalWireString,
  identity: Schema.optional(Schema.NullOr(IdentitySetApi))
})

const OnlineMeetingApi = Schema.Struct({
  id: Schema.String,
  subject: OptionalWireString,
  startDateTime: OptionalWireString,
  endDateTime: OptionalWireString,
  joinWebUrl: OptionalWireString,
  chatInfo: Schema.optional(Schema.NullOr(Schema.Struct({ threadId: OptionalWireString }))),
  participants: Schema.optional(
    Schema.NullOr(
      Schema.Struct({
        organizer: Schema.optional(Schema.NullOr(MeetingParticipantApi)),
        attendees: Schema.optional(Schema.NullOr(Schema.Array(MeetingParticipantApi)))
      })
    )
  )
})

const TranscriptApi = Schema.Struct({
  id: Schema.String,
  meetingId: OptionalWireString,
  createdDateTime: OptionalWireString,
  endDateTime: OptionalWireString,
  meetingOrganizer: Schema.optional(Schema.NullOr(IdentitySetApi))
})

const collectionApi = <S extends Schema.Top>(item: S) =>
  Schema.Struct({
    value: Schema.Array(item),
    '@odata.nextLink': Schema.optional(Schema.NullOr(Schema.String))
  })

// ---------------------------------------------------------------------------------------------
// Projections
// ---------------------------------------------------------------------------------------------

const identityKinds = ['user', 'application', 'device'] as const

const identity = (wire: typeof IdentitySetApi.Type | null | undefined) => {
  if (wire === null || wire === undefined) return undefined

  for (const kind of identityKinds) {
    const value = wire[kind]

    if (value !== null && value !== undefined) {
      return TeamsIdentity.make({ kind, ...stringFields(value, ['id', 'displayName']) })
    }
  }

  return undefined
}

const messageBody = (wire: typeof BodyApi.Type | null | undefined) => {
  const content = present(wire?.content)

  if (content === undefined) return undefined

  return TeamsMessageBody.make({ contentType: present(wire?.contentType) ?? 'text', content })
}

const teamsMessage = (wire: typeof MessageApi.Type) => {
  const fields: Mutable<TeamsMessage> = {
    id: wire.id,
    ...stringFields(wire, [
      'replyToId',
      'messageType',
      'createdDateTime',
      'lastModifiedDateTime',
      'lastEditedDateTime',
      'deletedDateTime',
      'subject',
      'importance',
      'chatId',
      'webUrl'
    ])
  }

  const from = identity(wire.from)

  if (from !== undefined) fields.from = from

  const body = messageBody(wire.body)

  if (body !== undefined) fields.body = body

  const attachments = present(wire.attachments)

  if (attachments !== undefined && attachments.length > 0) {
    fields.attachments = attachments.map(attachment =>
      TeamsMessageAttachment.make(
        stringFields(attachment, ['id', 'name', 'contentType', 'contentUrl'])
      )
    )
  }

  const mentions = present(wire.mentions)

  if (mentions !== undefined && mentions.length > 0) {
    fields.mentions = mentions.map(mention => {
      const mentionFields: Mutable<TeamsMessageMention> = stringFields(mention, ['mentionText'])
      const mentioned = identity(mention.mentioned)

      if (mentioned !== undefined) mentionFields.mentioned = mentioned

      return TeamsMessageMention.make(mentionFields)
    })
  }

  const channel = present(wire.channelIdentity)

  if (channel !== undefined) {
    fields.channelIdentity = TeamsChannelIdentity.make(
      stringFields(channel, ['teamId', 'channelId'])
    )
  }

  return TeamsMessage.make(fields)
}

const chatMessagePreview = (wire: typeof MessagePreviewApi.Type) => {
  const fields: Mutable<TeamsChatMessagePreview> = stringFields(wire, [
    'id',
    'createdDateTime',
    'messageType'
  ])

  const isDeleted = present(wire.isDeleted)

  if (isDeleted !== undefined) fields.isDeleted = isDeleted

  const from = identity(wire.from)

  if (from !== undefined) fields.from = from

  const body = messageBody(wire.body)

  if (body !== undefined) fields.body = body

  return TeamsChatMessagePreview.make(fields)
}

const chatMember = (wire: typeof MemberApi.Type) => {
  const fields: Mutable<TeamsChatMember> = stringFields(wire, ['displayName', 'email', 'userId'])

  const roles = present(wire.roles)

  if (roles !== undefined) fields.roles = roles

  return TeamsChatMember.make(fields)
}

const teamsChat = (wire: typeof ChatApi.Type) => {
  const fields: Mutable<TeamsChat> = {
    id: wire.id,
    ...stringFields(wire, ['topic', 'chatType', 'createdDateTime', 'lastUpdatedDateTime', 'webUrl'])
  }

  const joinWebUrl = present(present(wire.onlineMeetingInfo)?.joinWebUrl)

  if (joinWebUrl !== undefined) fields.onlineMeetingJoinWebUrl = joinWebUrl

  const members = present(wire.members)

  if (members !== undefined) fields.members = members.map(chatMember)

  const preview = present(wire.lastMessagePreview)

  if (preview !== undefined) fields.lastMessagePreview = chatMessagePreview(preview)

  return TeamsChat.make(fields)
}

const teamsTeam = (wire: typeof TeamApi.Type) => {
  const fields: Mutable<TeamsTeam> = {
    id: wire.id,
    ...stringFields(wire, ['displayName', 'description', 'webUrl'])
  }

  const isArchived = present(wire.isArchived)

  if (isArchived !== undefined) fields.isArchived = isArchived

  return TeamsTeam.make(fields)
}

const teamsChannel = (wire: typeof ChannelApi.Type) =>
  TeamsChannel.make({
    id: wire.id,
    ...stringFields(wire, [
      'displayName',
      'description',
      'membershipType',
      'createdDateTime',
      'webUrl'
    ])
  })

const meetingParticipant = (wire: typeof MeetingParticipantApi.Type) => {
  const user = present(present(wire.identity)?.user)

  const fields: Mutable<TeamsMeetingParticipant> = stringFields(wire, ['upn', 'role'])

  const displayName = present(user?.displayName)

  if (displayName !== undefined) fields.displayName = displayName

  const userId = present(user?.id)

  if (userId !== undefined) fields.userId = userId

  return TeamsMeetingParticipant.make(fields)
}

const teamsOnlineMeeting = (wire: typeof OnlineMeetingApi.Type) => {
  const fields: Mutable<TeamsOnlineMeeting> = {
    id: wire.id,
    ...stringFields(wire, ['subject', 'startDateTime', 'endDateTime', 'joinWebUrl'])
  }

  const chatId = present(present(wire.chatInfo)?.threadId)

  if (chatId !== undefined) fields.chatId = chatId

  const participants = present(wire.participants)
  const organizer = present(participants?.organizer)

  if (organizer !== undefined) fields.organizer = meetingParticipant(organizer)

  const attendees = present(participants?.attendees)

  if (attendees !== undefined) fields.attendees = attendees.map(meetingParticipant)

  return TeamsOnlineMeeting.make(fields)
}

const teamsTranscript = (wire: typeof TranscriptApi.Type) => {
  const fields: Mutable<TeamsMeetingTranscript> = {
    id: wire.id,
    ...stringFields(wire, ['meetingId', 'createdDateTime', 'endDateTime'])
  }

  const organizer = identity(wire.meetingOrganizer)

  if (organizer !== undefined) fields.organizer = organizer

  return TeamsMeetingTranscript.make(fields)
}

// ---------------------------------------------------------------------------------------------
// Inputs and outputs
// ---------------------------------------------------------------------------------------------

const NextLink = Schema.optional(Schema.String)

export const TeamsChatExpand = Schema.Literals(['members', 'lastMessagePreview'])

export class TeamsListChatsInput extends Schema.Class<TeamsListChatsInput>('TeamsListChatsInput')({
  expand: Schema.optional(TeamsChatExpand),
  top: Schema.optional(TeamsPageSize),
  nextLink: NextLink
}) {}

export class TeamsListChatsOutput extends Schema.Class<TeamsListChatsOutput>(
  'TeamsListChatsOutput'
)({
  chats: Schema.Array(TeamsChat),
  nextLink: Schema.optional(Schema.String)
}) {}

export class TeamsChatIdInput extends Schema.Class<TeamsChatIdInput>('TeamsChatIdInput')({
  chatId: TeamsId
}) {}

/** A UTC instant such as `2026-11-10T08:00:00Z`, as Graph's `$filter` compares them. */
export const TeamsUtcDateTime = Schema.String.check(
  Schema.isPattern(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,7})?)?Z$/u)
)

export class TeamsListChatMessagesInput extends Schema.Class<TeamsListChatMessagesInput>(
  'TeamsListChatMessagesInput'
)({
  chatId: TeamsId,
  modifiedSince: Schema.optional(TeamsUtcDateTime),
  top: Schema.optional(TeamsPageSize),
  nextLink: NextLink
}) {}

export class TeamsListMessagesOutput extends Schema.Class<TeamsListMessagesOutput>(
  'TeamsListMessagesOutput'
)({
  messages: Schema.Array(TeamsMessage),
  nextLink: Schema.optional(Schema.String)
}) {}

export class TeamsChatMessageIdInput extends Schema.Class<TeamsChatMessageIdInput>(
  'TeamsChatMessageIdInput'
)({
  chatId: TeamsId,
  messageId: TeamsId
}) {}

export class TeamsSendChatMessageInput extends Schema.Class<TeamsSendChatMessageInput>(
  'TeamsSendChatMessageInput'
)({
  chatId: TeamsId,
  content: TeamsMessageText
}) {}

export class TeamsListJoinedTeamsInput extends Schema.Class<TeamsListJoinedTeamsInput>(
  'TeamsListJoinedTeamsInput'
)({}) {}

export class TeamsListJoinedTeamsOutput extends Schema.Class<TeamsListJoinedTeamsOutput>(
  'TeamsListJoinedTeamsOutput'
)({
  teams: Schema.Array(TeamsTeam)
}) {}

export class TeamsTeamIdInput extends Schema.Class<TeamsTeamIdInput>('TeamsTeamIdInput')({
  teamId: TeamsId
}) {}

export class TeamsListChannelsInput extends Schema.Class<TeamsListChannelsInput>(
  'TeamsListChannelsInput'
)({
  teamId: TeamsId,
  nextLink: NextLink
}) {}

export class TeamsListChannelsOutput extends Schema.Class<TeamsListChannelsOutput>(
  'TeamsListChannelsOutput'
)({
  channels: Schema.Array(TeamsChannel),
  nextLink: Schema.optional(Schema.String)
}) {}

export class TeamsChannelIdInput extends Schema.Class<TeamsChannelIdInput>('TeamsChannelIdInput')({
  teamId: TeamsId,
  channelId: TeamsId
}) {}

export class TeamsListChannelMessagesInput extends Schema.Class<TeamsListChannelMessagesInput>(
  'TeamsListChannelMessagesInput'
)({
  teamId: TeamsId,
  channelId: TeamsId,
  top: Schema.optional(TeamsPageSize),
  nextLink: NextLink
}) {}

export class TeamsChannelMessageIdInput extends Schema.Class<TeamsChannelMessageIdInput>(
  'TeamsChannelMessageIdInput'
)({
  teamId: TeamsId,
  channelId: TeamsId,
  messageId: TeamsId
}) {}

export class TeamsListChannelMessageRepliesInput extends Schema.Class<TeamsListChannelMessageRepliesInput>(
  'TeamsListChannelMessageRepliesInput'
)({
  teamId: TeamsId,
  channelId: TeamsId,
  messageId: TeamsId,
  top: Schema.optional(TeamsPageSize),
  nextLink: NextLink
}) {}

export class TeamsSendChannelMessageInput extends Schema.Class<TeamsSendChannelMessageInput>(
  'TeamsSendChannelMessageInput'
)({
  teamId: TeamsId,
  channelId: TeamsId,
  subject: Schema.optional(TeamsSubject),
  content: TeamsMessageText
}) {}

export class TeamsReplyToChannelMessageInput extends Schema.Class<TeamsReplyToChannelMessageInput>(
  'TeamsReplyToChannelMessageInput'
)({
  teamId: TeamsId,
  channelId: TeamsId,
  messageId: TeamsId,
  content: TeamsMessageText
}) {}

export const teamsJoinWebUrlMaxLength = 2048

const isTeamsJoinWebUrl = (value: string) => {
  if (value.length > teamsJoinWebUrlMaxLength || !value.startsWith('https://')) return false

  if (/[\s\u0000-\u001f\u007f]/.test(value) || /[\ud800-\udfff]/u.test(value)) return false

  if (!URL.canParse(value)) return false

  const url = new URL(value)

  return (
    url.hostname === 'teams.microsoft.com' &&
    url.port === '' &&
    url.username === '' &&
    url.password === ''
  )
}

/** A Teams meeting join link on `https://teams.microsoft.com`, passed exactly as received. */
export const TeamsJoinWebUrl = Schema.String.check(
  Schema.makeFilter(value =>
    isTeamsJoinWebUrl(value)
      ? undefined
      : 'Expected a https://teams.microsoft.com meeting join link'
  )
)

export class TeamsFindOnlineMeetingInput extends Schema.Class<TeamsFindOnlineMeetingInput>(
  'TeamsFindOnlineMeetingInput'
)({
  joinWebUrl: TeamsJoinWebUrl
}) {}

export class TeamsFindOnlineMeetingOutput extends Schema.Class<TeamsFindOnlineMeetingOutput>(
  'TeamsFindOnlineMeetingOutput'
)({
  meeting: TeamsOnlineMeeting
}) {}

export class TeamsListMeetingTranscriptsInput extends Schema.Class<TeamsListMeetingTranscriptsInput>(
  'TeamsListMeetingTranscriptsInput'
)({
  meetingId: TeamsMeetingId,
  nextLink: NextLink
}) {}

export class TeamsListMeetingTranscriptsOutput extends Schema.Class<TeamsListMeetingTranscriptsOutput>(
  'TeamsListMeetingTranscriptsOutput'
)({
  transcripts: Schema.Array(TeamsMeetingTranscript),
  nextLink: Schema.optional(Schema.String)
}) {}

// ---------------------------------------------------------------------------------------------
// Requests
// ---------------------------------------------------------------------------------------------

const segment = encodeURIComponent

const invalidNextLink = (actionId: string) =>
  new ConnectorError({
    cause: 'validation_failed',
    message: 'Microsoft Graph nextLink must target the same Teams collection',
    connectorId: microsoftConnectorId,
    actionId
  })

const decodedPathname = (url: URL) => {
  try {
    return decodeURIComponent(url.pathname)
  } catch {
    return undefined
  }
}

/**
 * A page link is followed with the bearer token only on the global Graph origin and for the
 * collection the first page listed (`path` with raw ids; Graph may echo ids encoded or not, so
 * the link's path is compared decoded).
 */
const pageUrl = (input: {
  readonly actionId: string
  readonly nextLink: string | undefined
  readonly path: string
  readonly firstPage: () => string
}) => {
  if (input.nextLink === undefined) return Effect.succeed(input.firstPage())

  if (!URL.canParse(input.nextLink)) return Effect.fail(invalidNextLink(input.actionId))

  const parsed = new URL(input.nextLink)

  return isTrustedGraphUrl(parsed) && decodedPathname(parsed) === `/v1.0${input.path}`
    ? Effect.succeed(input.nextLink)
    : Effect.fail(invalidNextLink(input.actionId))
}

const graphUrl = (path: string, params: Readonly<Record<string, string | undefined>> = {}) => {
  const search = new URLSearchParams()

  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined) search.set(key, value)
  }

  const text = search.toString()

  return `${microsoftGraphApiBaseUrl}${path}${text === '' ? '' : `?${text}`}`
}

const topParam = (top: number | undefined) => (top === undefined ? undefined : String(top))

const chatPath = (chatId: string) => `/chats/${segment(chatId)}`

const channelPath = (teamId: string, channelId: string) =>
  `/teams/${segment(teamId)}/channels/${segment(channelId)}`

type GraphFailure = { readonly code: string; readonly message: string }

/** The Graph `chatMessage` a send posts: an HTML body and, for channel posts, a subject. */
type TeamsSendBody = {
  subject?: string
  readonly body: { readonly contentType: 'html'; readonly content: string }
}

const graphRequest = <Wire, Output>(input: {
  readonly integration: ConnectorIntegration
  readonly slot: CredentialSlot
  readonly url: Effect.Effect<string, ConnectorError>
  /** A message body makes the request a POST. */
  readonly body?: TeamsSendBody
  readonly schema: Schema.Schema<Wire> & { readonly DecodingServices: never }
  /** `undefined` answers `notFound` (a filtered lookup with no match). */
  readonly project: (decoded: Wire) => Output | undefined
  readonly failure: GraphFailure
  readonly notFound?: GraphFailure
}) =>
  Effect.gen(function* () {
    const token = yield* resolveMicrosoftAccessToken(input.integration, input.slot)
    const url = yield* input.url
    const http = yield* ConnectorHttpClient
    const read = { ...microsoftAuthorizationHeaders(token), accept: 'application/json' }

    const response = yield* http.request(
      input.body === undefined
        ? ConnectorHttpRequest.make({ method: 'GET', url, headers: read })
        : ConnectorHttpRequest.make({
            method: 'POST',
            url,
            headers: { ...read, 'content-type': 'application/json' },
            body: JSON.stringify(input.body)
          })
    )

    if (!isMicrosoftSuccessStatus(response.status)) {
      return yield* microsoftProviderFailure({
        code: input.failure.code,
        message: input.failure.message,
        status: response.status,
        headers: response.headers,
        body: response.body
      })
    }

    const decoded = yield* decodeJsonResponse(input.schema, response)
    const output = input.project(decoded)

    if (output === undefined) {
      const notFound = input.notFound ?? input.failure

      return yield* microsoftProviderFailure({
        code: notFound.code,
        message: notFound.message,
        status: 404,
        headers: {},
        body: ''
      })
    }

    return ActionResult.success(output)
  })

const nextLinkField = (nextLink: string | null | undefined) =>
  nextLink === null || nextLink === undefined ? {} : { nextLink }

const sendBody = (content: string, subject?: string): TeamsSendBody => {
  const body: TeamsSendBody = {
    body: { contentType: 'html', content: teamsMessageHtml(content) }
  }

  if (subject !== undefined) body.subject = subject

  return body
}

// ---------------------------------------------------------------------------------------------
// Actions
// ---------------------------------------------------------------------------------------------

export const teamsListChatsAction = defineAction({
  id: 'teams.list_chats',
  description:
    "List the signed-in user's Microsoft Teams chats (one-on-one, group and meeting chats), up to 50 per page. expand 'members' (default) adds up to 25 members per chat; 'lastMessagePreview' adds each chat's latest message instead and lists the most recently active chats first.",
  inputSchema: TeamsListChatsInput,
  outputSchema: TeamsListChatsOutput,
  execute: ({ integration, input }) =>
    graphRequest({
      integration,
      slot: MicrosoftTeamsChatReadOAuthCredentialSlot,
      url: pageUrl({
        actionId: 'teams.list_chats',
        nextLink: input.nextLink,
        path: '/me/chats',
        firstPage: () =>
          graphUrl(
            '/me/chats',
            input.expand === 'lastMessagePreview'
              ? {
                  $expand: 'lastMessagePreview',
                  $orderby: 'lastMessagePreview/createdDateTime desc',
                  $top: topParam(input.top)
                }
              : { $expand: 'members', $top: topParam(input.top) }
          )
      }),
      schema: collectionApi(ChatApi),
      project: output =>
        TeamsListChatsOutput.make({
          chats: output.value.map(teamsChat),
          ...nextLinkField(output['@odata.nextLink'])
        }),
      failure: { code: 'teams_list_chats_failed', message: 'Microsoft Teams list chats failed' }
    })
})

export const teamsGetChatAction = defineAction({
  id: 'teams.get_chat',
  description: 'Get one Microsoft Teams chat by id, with up to 25 of its members.',
  inputSchema: TeamsChatIdInput,
  outputSchema: TeamsChat,
  execute: ({ integration, input }) =>
    graphRequest({
      integration,
      slot: MicrosoftTeamsChatReadOAuthCredentialSlot,
      url: Effect.succeed(graphUrl(chatPath(input.chatId), { $expand: 'members' })),
      schema: ChatApi,
      project: teamsChat,
      failure: { code: 'teams_get_chat_failed', message: 'Microsoft Teams get chat failed' }
    })
})

export const teamsListChatMessagesAction = defineAction({
  id: 'teams.list_chat_messages',
  description:
    'List the messages of one Microsoft Teams chat, most recently changed first, up to 50 per page. Optional modifiedSince (a UTC time such as 2026-11-10T08:00:00Z) returns only messages changed after it.',
  inputSchema: TeamsListChatMessagesInput,
  outputSchema: TeamsListMessagesOutput,
  execute: ({ integration, input }) =>
    graphRequest({
      integration,
      slot: MicrosoftTeamsChatReadOAuthCredentialSlot,
      url: pageUrl({
        actionId: 'teams.list_chat_messages',
        nextLink: input.nextLink,
        path: `/chats/${input.chatId}/messages`,
        firstPage: () =>
          graphUrl(`${chatPath(input.chatId)}/messages`, {
            $top: topParam(input.top),
            $orderby: 'lastModifiedDateTime desc',
            $filter:
              input.modifiedSince === undefined
                ? undefined
                : `lastModifiedDateTime gt ${input.modifiedSince}`
          })
      }),
      schema: collectionApi(MessageApi),
      project: output =>
        TeamsListMessagesOutput.make({
          messages: output.value.map(teamsMessage),
          ...nextLinkField(output['@odata.nextLink'])
        }),
      failure: {
        code: 'teams_list_chat_messages_failed',
        message: 'Microsoft Teams list chat messages failed'
      }
    })
})

export const teamsGetChatMessageAction = defineAction({
  id: 'teams.get_chat_message',
  description: 'Get one message of a Microsoft Teams chat by chat id and message id.',
  inputSchema: TeamsChatMessageIdInput,
  outputSchema: TeamsMessage,
  execute: ({ integration, input }) =>
    graphRequest({
      integration,
      slot: MicrosoftTeamsChatReadOAuthCredentialSlot,
      url: Effect.succeed(
        graphUrl(`${chatPath(input.chatId)}/messages/${segment(input.messageId)}`)
      ),
      schema: MessageApi,
      project: teamsMessage,
      failure: {
        code: 'teams_get_chat_message_failed',
        message: 'Microsoft Teams get chat message failed'
      }
    })
})

export const teamsSendChatMessageAction = defineAction({
  id: 'teams.send_chat_message',
  description:
    'Send a plain-text message to an existing Microsoft Teams chat as the signed-in user. Line breaks are kept; markup is shown as literal text. Returns the created message.',
  access: 'destructive',
  inputSchema: TeamsSendChatMessageInput,
  outputSchema: TeamsMessage,
  execute: ({ integration, input }) =>
    graphRequest({
      integration,
      slot: MicrosoftTeamsChatSendOAuthCredentialSlot,
      url: Effect.succeed(graphUrl(`${chatPath(input.chatId)}/messages`)),
      body: sendBody(input.content),
      schema: MessageApi,
      project: teamsMessage,
      failure: {
        code: 'teams_send_chat_message_failed',
        message: 'Microsoft Teams send chat message failed'
      }
    })
})

export const teamsListJoinedTeamsAction = defineAction({
  id: 'teams.list_joined_teams',
  description: 'List the Microsoft Teams teams the signed-in user is a member of.',
  inputSchema: TeamsListJoinedTeamsInput,
  outputSchema: TeamsListJoinedTeamsOutput,
  execute: ({ integration }) =>
    graphRequest({
      integration,
      slot: MicrosoftTeamsTeamReadOAuthCredentialSlot,
      url: Effect.succeed(graphUrl('/me/joinedTeams')),
      schema: collectionApi(TeamApi),
      project: output => TeamsListJoinedTeamsOutput.make({ teams: output.value.map(teamsTeam) }),
      failure: {
        code: 'teams_list_joined_teams_failed',
        message: 'Microsoft Teams list joined teams failed'
      }
    })
})

export const teamsGetTeamAction = defineAction({
  id: 'teams.get_team',
  description: 'Get one Microsoft Teams team by id: its name, description and archived state.',
  inputSchema: TeamsTeamIdInput,
  outputSchema: TeamsTeam,
  execute: ({ integration, input }) =>
    graphRequest({
      integration,
      slot: MicrosoftTeamsTeamReadOAuthCredentialSlot,
      url: Effect.succeed(
        graphUrl(`/teams/${segment(input.teamId)}`, {
          $select: 'id,displayName,description,isArchived,webUrl'
        })
      ),
      schema: TeamApi,
      project: teamsTeam,
      failure: { code: 'teams_get_team_failed', message: 'Microsoft Teams get team failed' }
    })
})

const channelSelect = 'id,displayName,description,membershipType,createdDateTime,webUrl'

export const teamsListChannelsAction = defineAction({
  id: 'teams.list_channels',
  description:
    "List one team's channels: its standard channels, plus the private and shared channels the signed-in user is a member of.",
  inputSchema: TeamsListChannelsInput,
  outputSchema: TeamsListChannelsOutput,
  execute: ({ integration, input }) =>
    graphRequest({
      integration,
      slot: MicrosoftTeamsChannelReadOAuthCredentialSlot,
      url: pageUrl({
        actionId: 'teams.list_channels',
        nextLink: input.nextLink,
        path: `/teams/${input.teamId}/channels`,
        firstPage: () =>
          graphUrl(`/teams/${segment(input.teamId)}/channels`, { $select: channelSelect })
      }),
      schema: collectionApi(ChannelApi),
      project: output =>
        TeamsListChannelsOutput.make({
          channels: output.value.map(teamsChannel),
          ...nextLinkField(output['@odata.nextLink'])
        }),
      failure: {
        code: 'teams_list_channels_failed',
        message: 'Microsoft Teams list channels failed'
      }
    })
})

export const teamsGetChannelAction = defineAction({
  id: 'teams.get_channel',
  description: 'Get one channel of a Microsoft Teams team by team id and channel id.',
  inputSchema: TeamsChannelIdInput,
  outputSchema: TeamsChannel,
  execute: ({ integration, input }) =>
    graphRequest({
      integration,
      slot: MicrosoftTeamsChannelReadOAuthCredentialSlot,
      url: Effect.succeed(
        graphUrl(channelPath(input.teamId, input.channelId), { $select: channelSelect })
      ),
      schema: ChannelApi,
      project: teamsChannel,
      failure: { code: 'teams_get_channel_failed', message: 'Microsoft Teams get channel failed' }
    })
})

export const teamsListChannelMessagesAction = defineAction({
  id: 'teams.list_channel_messages',
  description:
    "List a Teams channel's top-level posts, up to 50 per page, ordered by their thread's latest activity. List a post's replies with teams.list_channel_message_replies.",
  inputSchema: TeamsListChannelMessagesInput,
  outputSchema: TeamsListMessagesOutput,
  execute: ({ integration, input }) =>
    graphRequest({
      integration,
      slot: MicrosoftTeamsChannelMessageReadOAuthCredentialSlot,
      url: pageUrl({
        actionId: 'teams.list_channel_messages',
        nextLink: input.nextLink,
        path: `/teams/${input.teamId}/channels/${input.channelId}/messages`,
        firstPage: () =>
          graphUrl(`${channelPath(input.teamId, input.channelId)}/messages`, {
            $top: topParam(input.top)
          })
      }),
      schema: collectionApi(MessageApi),
      project: output =>
        TeamsListMessagesOutput.make({
          messages: output.value.map(teamsMessage),
          ...nextLinkField(output['@odata.nextLink'])
        }),
      failure: {
        code: 'teams_list_channel_messages_failed',
        message: 'Microsoft Teams list channel messages failed'
      }
    })
})

export const teamsGetChannelMessageAction = defineAction({
  id: 'teams.get_channel_message',
  description: 'Get one top-level post of a Teams channel by team, channel and message id.',
  inputSchema: TeamsChannelMessageIdInput,
  outputSchema: TeamsMessage,
  execute: ({ integration, input }) =>
    graphRequest({
      integration,
      slot: MicrosoftTeamsChannelMessageReadOAuthCredentialSlot,
      url: Effect.succeed(
        graphUrl(
          `${channelPath(input.teamId, input.channelId)}/messages/${segment(input.messageId)}`
        )
      ),
      schema: MessageApi,
      project: teamsMessage,
      failure: {
        code: 'teams_get_channel_message_failed',
        message: 'Microsoft Teams get channel message failed'
      }
    })
})

export const teamsListChannelMessageRepliesAction = defineAction({
  id: 'teams.list_channel_message_replies',
  description: 'List the replies to one Teams channel post, up to 50 per page.',
  inputSchema: TeamsListChannelMessageRepliesInput,
  outputSchema: TeamsListMessagesOutput,
  execute: ({ integration, input }) =>
    graphRequest({
      integration,
      slot: MicrosoftTeamsChannelMessageReadOAuthCredentialSlot,
      url: pageUrl({
        actionId: 'teams.list_channel_message_replies',
        nextLink: input.nextLink,
        path: `/teams/${input.teamId}/channels/${input.channelId}/messages/${input.messageId}/replies`,
        firstPage: () =>
          graphUrl(
            `${channelPath(input.teamId, input.channelId)}/messages/${segment(input.messageId)}/replies`,
            { $top: topParam(input.top) }
          )
      }),
      schema: collectionApi(MessageApi),
      project: output =>
        TeamsListMessagesOutput.make({
          messages: output.value.map(teamsMessage),
          ...nextLinkField(output['@odata.nextLink'])
        }),
      failure: {
        code: 'teams_list_channel_message_replies_failed',
        message: 'Microsoft Teams list channel message replies failed'
      }
    })
})

export const teamsSendChannelMessageAction = defineAction({
  id: 'teams.send_channel_message',
  description:
    'Post a new plain-text message, with an optional subject, to a Teams channel as the signed-in user. Line breaks are kept; markup is shown as literal text. Returns the created post.',
  access: 'destructive',
  inputSchema: TeamsSendChannelMessageInput,
  outputSchema: TeamsMessage,
  execute: ({ integration, input }) =>
    graphRequest({
      integration,
      slot: MicrosoftTeamsChannelMessageSendOAuthCredentialSlot,
      url: Effect.succeed(graphUrl(`${channelPath(input.teamId, input.channelId)}/messages`)),
      body: sendBody(input.content, input.subject),
      schema: MessageApi,
      project: teamsMessage,
      failure: {
        code: 'teams_send_channel_message_failed',
        message: 'Microsoft Teams send channel message failed'
      }
    })
})

export const teamsReplyToChannelMessageAction = defineAction({
  id: 'teams.reply_to_channel_message',
  description:
    'Reply in plain text to a Teams channel post as the signed-in user. Line breaks are kept; markup is shown as literal text. Returns the created reply.',
  access: 'destructive',
  inputSchema: TeamsReplyToChannelMessageInput,
  outputSchema: TeamsMessage,
  execute: ({ integration, input }) =>
    graphRequest({
      integration,
      slot: MicrosoftTeamsChannelMessageSendOAuthCredentialSlot,
      url: Effect.succeed(
        graphUrl(
          `${channelPath(input.teamId, input.channelId)}/messages/${segment(input.messageId)}/replies`
        )
      ),
      body: sendBody(input.content),
      schema: MessageApi,
      project: teamsMessage,
      failure: {
        code: 'teams_reply_to_channel_message_failed',
        message: 'Microsoft Teams reply to channel message failed'
      }
    })
})

// OData string literals double their single quotes.
const odataString = (value: string) => `'${value.replaceAll("'", "''")}'`

export const teamsFindOnlineMeetingAction = defineAction({
  id: 'teams.find_online_meeting',
  description:
    "Find a Teams meeting the signed-in user organized or was invited to by its join link: a calendar event's onlineMeeting.joinUrl or a meeting chat's onlineMeetingJoinWebUrl, passed exactly as received. Returns its meeting id, subject, times and participants.",
  inputSchema: TeamsFindOnlineMeetingInput,
  outputSchema: TeamsFindOnlineMeetingOutput,
  execute: ({ integration, input }) =>
    graphRequest({
      integration,
      slot: MicrosoftTeamsMeetingReadOAuthCredentialSlot,
      url: Effect.succeed(
        graphUrl('/me/onlineMeetings', {
          $filter: `JoinWebUrl eq ${odataString(input.joinWebUrl)}`
        })
      ),
      schema: collectionApi(OnlineMeetingApi),
      project: output => {
        const [first] = output.value

        return first === undefined
          ? undefined
          : TeamsFindOnlineMeetingOutput.make({ meeting: teamsOnlineMeeting(first) })
      },
      failure: {
        code: 'teams_find_online_meeting_failed',
        message: 'Microsoft Teams find online meeting failed'
      },
      notFound: {
        code: 'microsoft_not_found',
        message: 'No Teams meeting with this join link is visible to the signed-in user'
      }
    })
})

export const teamsListMeetingTranscriptsAction = defineAction({
  id: 'teams.list_meeting_transcripts',
  description:
    'List the transcripts of one Teams meeting by its meeting id from teams.find_online_meeting. The organizer and invitees can read them while the meeting has not expired, when the meeting was transcribed.',
  inputSchema: TeamsListMeetingTranscriptsInput,
  outputSchema: TeamsListMeetingTranscriptsOutput,
  execute: ({ integration, input }) =>
    graphRequest({
      integration,
      slot: MicrosoftTeamsTranscriptReadOAuthCredentialSlot,
      url: pageUrl({
        actionId: 'teams.list_meeting_transcripts',
        nextLink: input.nextLink,
        path: `/me/onlineMeetings/${input.meetingId}/transcripts`,
        firstPage: () => graphUrl(`/me/onlineMeetings/${segment(input.meetingId)}/transcripts`)
      }),
      schema: collectionApi(TranscriptApi),
      project: output =>
        TeamsListMeetingTranscriptsOutput.make({
          transcripts: output.value.map(teamsTranscript),
          ...nextLinkField(output['@odata.nextLink'])
        }),
      failure: {
        code: 'teams_list_meeting_transcripts_failed',
        message: 'Microsoft Teams list meeting transcripts failed'
      }
    })
})

export const teamsActions = [
  teamsListChatsAction,
  teamsGetChatAction,
  teamsListChatMessagesAction,
  teamsGetChatMessageAction,
  teamsSendChatMessageAction,
  teamsListJoinedTeamsAction,
  teamsGetTeamAction,
  teamsListChannelsAction,
  teamsGetChannelAction,
  teamsListChannelMessagesAction,
  teamsGetChannelMessageAction,
  teamsListChannelMessageRepliesAction,
  teamsSendChannelMessageAction,
  teamsReplyToChannelMessageAction,
  teamsFindOnlineMeetingAction,
  teamsListMeetingTranscriptsAction
]
