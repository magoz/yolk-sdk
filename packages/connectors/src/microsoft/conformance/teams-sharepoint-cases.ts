/**
 * Microsoft Graph conformance cases for the SharePoint site and Microsoft Teams actions (internal;
 * `cases.ts` lists them last in `microsoftConformanceCases`, and `index.ts` exports them).
 *
 * Every case runs the REAL connector actions over the connector ports plus the host-supplied
 * `MicrosoftConformanceConfig` seeds, and claims only what the connector reads. None is observed
 * live yet: the fixtures are synthetic placeholders shaped from the Microsoft Graph v1.0 docs
 * examples (each fixture's note names its pages).
 *
 * The read cases change nothing. `microsoft.teams.send-chat-message` posts a real message to the
 * seeded practice chat that the connector cannot remove (Graph's soft delete needs another
 * permission and no connector action exists), so it is write-irreversible: it runs live only when
 * named by its exact id. Its text names the per-invocation `runId`; the send and its
 * classification run uninterruptibly, and an ambiguous send (the shared `classifyWriteExit`: a
 * transport or decoding failure, no status, HTTP 408, or HTTP 5xx) fails with
 * `MicrosoftConformanceActionFailed` (`sendOutcome: 'unknown'`) naming the run id to look for, also
 * through `ConformanceCleanupReporter` when the case is being interrupted.
 */
import { Effect } from 'effect'
import * as Schema from 'effect/Schema'
import {
  ConformanceMismatch,
  defineConformanceCase,
  expectConformance,
  expectEqual
} from '@yolk-sdk/conformance/case'
import { classifyWriteExit, failReporting } from '../../conformance/cleanup-reporter.ts'
import type { ActionResult } from '../../result.ts'
import {
  SharePointListSiteDrivesInput,
  SharePointSearchSitesInput,
  sharePointListSiteDrivesAction,
  sharePointSearchSitesAction
} from '../sites.ts'
import {
  TeamsChannelIdInput,
  TeamsChannelMessageIdInput,
  TeamsChatIdInput,
  TeamsChatMessageIdInput,
  TeamsFindOnlineMeetingInput,
  TeamsListChannelMessageRepliesInput,
  TeamsListChannelMessagesInput,
  TeamsListChannelsInput,
  TeamsListChatMessagesInput,
  TeamsListChatsInput,
  TeamsListJoinedTeamsInput,
  TeamsListMeetingTranscriptsInput,
  TeamsSendChatMessageInput,
  TeamsTeamIdInput,
  teamsFindOnlineMeetingAction,
  teamsGetChannelAction,
  teamsGetChannelMessageAction,
  teamsGetChatAction,
  teamsGetChatMessageAction,
  teamsGetTeamAction,
  teamsListChannelMessageRepliesAction,
  teamsListChannelMessagesAction,
  teamsListChannelsAction,
  teamsListChatMessagesAction,
  teamsListChatsAction,
  teamsListJoinedTeamsAction,
  teamsListMeetingTranscriptsAction,
  teamsMessageHtml,
  teamsSendChatMessageAction
} from '../teams.ts'
import { isNonEmptyString } from './calendar.ts'
import { microsoftSharePointSearchSitesFixture } from './sharepoint-search-sites.ts'
import { microsoftSharePointSiteDrivesFixture } from './sharepoint-site-drives.ts'
import {
  MicrosoftConformanceActionFailed,
  microsoftConformanceIntegration,
  microsoftConformanceMarker,
  requireSeed,
  successValue,
  type MicrosoftConformanceCase
} from './shared.ts'
import { microsoftTeamsChannelMessageRepliesFixture } from './teams-channel-replies.ts'
import { microsoftTeamsChatMessagesPagingFixture } from './teams-chat-messages-paging.ts'
import { microsoftTeamsChatsListMembersFixture } from './teams-chats-list.ts'
import { microsoftTeamsMeetingTranscriptsFixture } from './teams-meeting-transcripts.ts'
import { microsoftTeamsSendChatMessageFixture } from './teams-send-chat-message.ts'
import { microsoftTeamsTeamChannelsFixture } from './teams-team-channels.ts'

const integration = microsoftConformanceIntegration

/** The success value of an action, or its failure as `MicrosoftConformanceActionFailed`. */
const succeeded = <A, E, R>(
  actionId: string,
  action: Effect.Effect<ActionResult<A>, E, R>
): Effect.Effect<A, E | MicrosoftConformanceActionFailed, R> =>
  action.pipe(Effect.flatMap(result => successValue(actionId, result)))

/**
 * An action input decoded from seeds or from an earlier answer: a value the input schema refuses is
 * a `ConformanceMismatch` with `message` (a `precondition:` one for seeds), never a defect.
 */
const decodedInput = <A>(
  schema: Schema.Codec<A, unknown>,
  value: unknown,
  message: string
): Effect.Effect<A, ConformanceMismatch> =>
  Schema.decodeUnknownEffect(schema)(value).pipe(
    Effect.mapError(() => new ConformanceMismatch({ message }))
  )

// SharePoint sites.

/** A site id with the three non-empty parts `{hostname},{site-collection-id},{web-id}`. */
const isSiteId = (id: string) => /^[^,]+,[^,]+,[^,]+$/u.test(id)

export const microsoftSharePointSearchSitesCase: MicrosoftConformanceCase = defineConformanceCase({
  id: 'microsoft.sharepoint.search-finds-site',
  title: 'A keyword site search lists the seeded site by its comma-separated id',
  safety: 'read',
  docs: 'GET /sites?search={query} searches the SharePoint sites the signed-in user can access across the tenant and answers a `value` array of sites; a site id is `{hostname},{site-collection-id},{web-id}`.',
  wire: '`sharepoint.search_sites` with the seeded keyword answers the seeded `siteId` among the sites of its first page (the seeded site must be on it), and every returned id has the three non-empty comma-separated parts that `sharepoint.list_site_drives` sends literally in its path (unverified: no live run has shown a search answer yet).',
  fixtures: [microsoftSharePointSearchSitesFixture.id],
  run: Effect.gen(function* () {
    const query = yield* requireSeed('siteSearchQuery')
    const siteId = yield* requireSeed('siteId')

    const { sites } = yield* succeeded(
      sharePointSearchSitesAction.id,
      sharePointSearchSitesAction.executeTyped({
        integration,
        input: SharePointSearchSitesInput.make({ query })
      })
    )

    yield* expectConformance(
      sites.some(site => site.id === siteId),
      'expected the seeded siteId among the sites the keyword search answers',
      { actual: sites.length }
    )

    const malformed = sites.filter(site => !isSiteId(site.id))

    yield* expectConformance(
      malformed.length === 0,
      'expected every searched site id as {hostname},{site-collection-id},{web-id}',
      { actual: malformed.map(site => site.id) }
    )
  })
})

export const microsoftSharePointSiteDrivesCase: MicrosoftConformanceCase = defineConformanceCase({
  id: 'microsoft.sharepoint.site-drives-libraries',
  title: "A site's drives include its document libraries, each with an id",
  safety: 'read',
  docs: 'GET /sites/{site-id}/drives lists the document libraries of a site as drive resources (`driveType` `documentLibrary`); unset drive properties may be `null`.',
  wire: '`sharepoint.list_site_drives` for the seeded site id (its commas sent literally in the path) answers at least one drive, every drive with a non-empty id, and at least one with `driveType: documentLibrary` (the id hosts pass as `driveId` to the OneDrive actions). A library without a description answers `description: null`, which must decode (the connector leaves it out).',
  fixtures: [microsoftSharePointSiteDrivesFixture.id],
  run: Effect.gen(function* () {
    const siteId = yield* requireSeed('siteId')

    const input = yield* decodedInput(
      SharePointListSiteDrivesInput,
      { siteId },
      'precondition: MicrosoftConformanceConfig.siteId is not a valid SharePoint site id'
    )

    const { drives } = yield* succeeded(
      sharePointListSiteDrivesAction.id,
      sharePointListSiteDrivesAction.executeTyped({ integration, input })
    )

    yield* expectConformance(
      drives.length > 0 && drives.every(drive => isNonEmptyString(drive.id)),
      'expected the seeded site to list its drives, each with an id',
      { actual: drives.length }
    )
    yield* expectConformance(
      drives.some(drive => drive.driveType === 'documentLibrary'),
      'expected a documentLibrary drive among the site drives',
      { actual: drives.map(drive => drive.driveType ?? null) }
    )
  })
})

// Teams chats.

/** Chats listed by the chats case: one page; the signed-in user's chats are not seeded. */
const chatsPageSize = 10

export const microsoftTeamsChatsListMembersCase: MicrosoftConformanceCase = defineConformanceCase({
  id: 'microsoft.teams.chats-list-members',
  title: 'Listed chats carry their members, and a listed id gets the same chat',
  safety: 'read',
  docs: "GET /me/chats?$expand=members lists the signed-in user's chats with up to 25 members each; GET /chats/{chat-id}?$expand=members gets one chat with its members.",
  wire: '`teams.list_chats` (its default `$expand=members`, `top: 10`) answers at least one chat, every listed chat carrying a `members` array (the expansion is honored), and `teams.get_chat` with the first listed id answers that chat (same id and `chatType`) with its members.',
  fixtures: [microsoftTeamsChatsListMembersFixture.id],
  run: Effect.gen(function* () {
    const { chats } = yield* succeeded(
      teamsListChatsAction.id,
      teamsListChatsAction.executeTyped({
        integration,
        input: TeamsListChatsInput.make({ top: chatsPageSize })
      })
    )

    const [first] = chats

    if (first === undefined) {
      return yield* new ConformanceMismatch({
        message: 'precondition: the signed-in user needs at least one Teams chat'
      })
    }

    const withoutMembers = chats.filter(chat => chat.members === undefined)

    yield* expectConformance(
      withoutMembers.length === 0,
      'expected every listed chat to carry its members ($expand=members)',
      { actual: withoutMembers.map(chat => chat.id) }
    )

    const input = yield* decodedInput(
      TeamsChatIdInput,
      { chatId: first.id },
      'expected the listed chat id to be a usable Teams id'
    )

    const fetched = yield* succeeded(
      teamsGetChatAction.id,
      teamsGetChatAction.executeTyped({ integration, input })
    )

    yield* expectEqual(
      [fetched.id, fetched.chatType ?? null],
      [first.id, first.chatType ?? null],
      'expected teams.get_chat with a listed id to return that chat'
    )
    yield* expectConformance(
      fetched.members !== undefined,
      'expected teams.get_chat to return the chat members ($expand=members)'
    )
  })
})

/** Page size of the chat paging case; the seeded chat holds more messages than this. */
const chatPageSize = 2

export const microsoftTeamsChatMessagesPagingCase: MicrosoftConformanceCase = defineConformanceCase(
  {
    id: 'microsoft.teams.chat-messages-paging',
    title: 'A chat larger than the page size returns a usable nextLink',
    safety: 'read',
    docs: 'GET /chats/{chat-id}/messages pages with `$top` (at most 50) and returns `@odata.nextLink` when more messages exist; the docs example names the chat id unencoded in that link.',
    wire: '`teams.list_chat_messages` with `top: 2` on a chat seeded with more than two messages answers two messages and a `nextLink` the connector accepts (the global Graph origin and the same chat collection, compared decoded, since Graph may name the chat id unencoded); following it answers at least one further message, none repeated from the first page; `teams.get_chat_message` with the first listed id answers that message with the same body.',
    fixtures: [microsoftTeamsChatMessagesPagingFixture.id],
    run: Effect.gen(function* () {
      const chatId = yield* requireSeed('chatId')
      const invalidChat = 'precondition: MicrosoftConformanceConfig.chatId is not a valid Teams id'

      const first = yield* succeeded(
        teamsListChatMessagesAction.id,
        teamsListChatMessagesAction.executeTyped({
          integration,
          input: yield* decodedInput(
            TeamsListChatMessagesInput,
            { chatId, top: chatPageSize },
            invalidChat
          )
        })
      )

      yield* expectEqual(
        first.messages.length,
        chatPageSize,
        'precondition: the seeded chat needs more than two messages'
      )

      if (first.nextLink === undefined) {
        return yield* new ConformanceMismatch({
          message: `expected @odata.nextLink for a page of ${chatPageSize} from a chat seeded with more messages`
        })
      }

      const second = yield* succeeded(
        teamsListChatMessagesAction.id,
        teamsListChatMessagesAction.executeTyped({
          integration,
          input: yield* decodedInput(
            TeamsListChatMessagesInput,
            { chatId, nextLink: first.nextLink },
            invalidChat
          )
        })
      )

      const firstIds = new Set(first.messages.map(message => message.id))

      yield* expectConformance(
        second.messages.length > 0,
        'expected the nextLink page to return further messages'
      )
      yield* expectConformance(
        second.messages.every(message => !firstIds.has(message.id)),
        'expected the nextLink page to repeat no message from the first page'
      )

      const [listed] = first.messages

      if (listed === undefined) {
        return yield* new ConformanceMismatch({ message: 'expected a listed chat message' })
      }

      const fetched = yield* succeeded(
        teamsGetChatMessageAction.id,
        teamsGetChatMessageAction.executeTyped({
          integration,
          input: yield* decodedInput(
            TeamsChatMessageIdInput,
            { chatId, messageId: listed.id },
            'expected the listed message id to be a usable Teams id'
          )
        })
      )

      yield* expectEqual(
        [fetched.id, fetched.body?.content ?? null],
        [listed.id, listed.body?.content ?? null],
        'expected teams.get_chat_message with a listed id to return that message and body'
      )
    })
  }
)

// Teams teams and channels.

export const microsoftTeamsTeamChannelsCase: MicrosoftConformanceCase = defineConformanceCase({
  id: 'microsoft.teams.team-channels',
  title: 'A joined team and its channel read back by id as listed',
  safety: 'read',
  docs: 'GET /me/joinedTeams lists the teams the signed-in user is a direct member of; GET /teams/{id}, GET /teams/{id}/channels, and GET /teams/{id}/channels/{id} read a team, its channels (standard ones plus the private and shared ones the user belongs to), and one channel.',
  wire: '`teams.list_joined_teams` lists the seeded `teamId`; `teams.get_team` answers it with the listed display name; `teams.list_channels` (first page) lists the seeded `channelId`; `teams.get_channel` answers that channel with the listed display name and membership type.',
  fixtures: [microsoftTeamsTeamChannelsFixture.id],
  run: Effect.gen(function* () {
    const teamId = yield* requireSeed('teamId')
    const channelId = yield* requireSeed('channelId')

    const { teams } = yield* succeeded(
      teamsListJoinedTeamsAction.id,
      teamsListJoinedTeamsAction.executeTyped({
        integration,
        input: TeamsListJoinedTeamsInput.make({})
      })
    )

    const listedTeam = teams.find(team => team.id === teamId)

    if (listedTeam === undefined) {
      return yield* new ConformanceMismatch({
        message: 'expected the seeded teamId among the joined teams'
      })
    }

    const team = yield* succeeded(
      teamsGetTeamAction.id,
      teamsGetTeamAction.executeTyped({
        integration,
        input: yield* decodedInput(
          TeamsTeamIdInput,
          { teamId },
          'precondition: MicrosoftConformanceConfig.teamId is not a valid Teams id'
        )
      })
    )

    yield* expectEqual(
      [team.id, team.displayName ?? null],
      [listedTeam.id, listedTeam.displayName ?? null],
      'expected teams.get_team to return the listed team'
    )

    const { channels, nextLink } = yield* succeeded(
      teamsListChannelsAction.id,
      teamsListChannelsAction.executeTyped({
        integration,
        input: TeamsListChannelsInput.make({ teamId: team.id })
      })
    )

    const listedChannel = channels.find(channel => channel.id === channelId)

    if (listedChannel === undefined) {
      return yield* new ConformanceMismatch({
        message:
          nextLink === undefined
            ? 'expected the seeded channelId among the team channels'
            : 'precondition: the seeded channelId is not on the first page of the team channels'
      })
    }

    const channel = yield* succeeded(
      teamsGetChannelAction.id,
      teamsGetChannelAction.executeTyped({
        integration,
        input: yield* decodedInput(
          TeamsChannelIdInput,
          { teamId, channelId },
          'precondition: MicrosoftConformanceConfig.channelId is not a valid Teams id'
        )
      })
    )

    yield* expectEqual(
      [channel.id, channel.displayName ?? null, channel.membershipType ?? null],
      [listedChannel.id, listedChannel.displayName ?? null, listedChannel.membershipType ?? null],
      'expected teams.get_channel to return the listed channel'
    )
  })
})

/** Page size of the channel post and reply listings; the seeded post has fewer replies. */
const channelPageSize = 50

export const microsoftTeamsChannelMessageRepliesCase: MicrosoftConformanceCase =
  defineConformanceCase({
    id: 'microsoft.teams.channel-message-replies',
    title: 'Channel listings hold top-level posts; replies name their post',
    safety: 'read',
    docs: 'GET /teams/{id}/channels/{id}/messages lists the top-level posts of a channel (replies are not included); GET .../messages/{id} gets one post and GET .../messages/{id}/replies lists its replies.',
    wire: '`teams.list_channel_messages` (`top: 50`) of the seeded channel answers posts without `replyToId`; `teams.get_channel_message` answers the seeded post with its id, no `replyToId`, and a `channelIdentity` naming the seeded team and channel; `teams.list_channel_message_replies` (`top: 50`) answers at least one reply, each with `replyToId` equal to the seeded post id.',
    fixtures: [microsoftTeamsChannelMessageRepliesFixture.id],
    run: Effect.gen(function* () {
      const teamId = yield* requireSeed('teamId')
      const channelId = yield* requireSeed('channelId')
      const messageId = yield* requireSeed('channelMessageId')

      const invalid =
        'precondition: the teamId, channelId, and channelMessageId seeds must be valid Teams ids'

      const { messages } = yield* succeeded(
        teamsListChannelMessagesAction.id,
        teamsListChannelMessagesAction.executeTyped({
          integration,
          input: yield* decodedInput(
            TeamsListChannelMessagesInput,
            { teamId, channelId, top: channelPageSize },
            invalid
          )
        })
      )

      yield* expectConformance(
        messages.length > 0,
        'precondition: the seeded channel needs at least one post'
      )

      const nested = messages.filter(message => message.replyToId !== undefined)

      yield* expectConformance(
        nested.length === 0,
        'expected the channel listing to hold top-level posts only (no replyToId)',
        { actual: nested.map(message => message.id) }
      )

      const post = yield* succeeded(
        teamsGetChannelMessageAction.id,
        teamsGetChannelMessageAction.executeTyped({
          integration,
          input: yield* decodedInput(
            TeamsChannelMessageIdInput,
            { teamId, channelId, messageId },
            invalid
          )
        })
      )

      yield* expectEqual(
        [post.id, post.replyToId ?? null],
        [messageId, null],
        'precondition: channelMessageId must be a top-level post of the seeded channel'
      )
      yield* expectEqual(
        [post.channelIdentity?.teamId ?? null, post.channelIdentity?.channelId ?? null],
        [teamId, channelId],
        'expected the post to name the seeded team and channel in channelIdentity'
      )

      const replies = yield* succeeded(
        teamsListChannelMessageRepliesAction.id,
        teamsListChannelMessageRepliesAction.executeTyped({
          integration,
          input: yield* decodedInput(
            TeamsListChannelMessageRepliesInput,
            { teamId, channelId, messageId, top: channelPageSize },
            invalid
          )
        })
      )

      yield* expectConformance(
        replies.messages.length > 0,
        'precondition: the seeded post needs at least one reply'
      )

      const strays = replies.messages.filter(
        reply => reply.replyToId !== messageId || reply.id === messageId
      )

      yield* expectConformance(
        strays.length === 0,
        'expected every reply to name the seeded post in replyToId',
        { actual: strays.map(reply => reply.replyToId ?? null) }
      )
    })
  })

// Teams meetings.

export const microsoftTeamsMeetingTranscriptsCase: MicrosoftConformanceCase = defineConformanceCase(
  {
    id: 'microsoft.teams.meeting-transcripts',
    title: 'A join link finds its meeting, whose transcripts name that meeting',
    safety: 'read',
    docs: "GET /me/onlineMeetings?$filter=JoinWebUrl eq '{joinWebUrl}' finds an online meeting the signed-in user organized or was invited to by its join link; GET /me/onlineMeetings/{meeting-id}/transcripts lists its transcripts.",
    wire: '`teams.find_online_meeting` with the seeded join link (single quotes doubled in the OData literal) answers a meeting whose `joinWebUrl` is the seeded link and whose base64 id `teams.list_meeting_transcripts` accepts; that listing answers at least one transcript, each with `meetingId` equal to the found meeting id.',
    fixtures: [microsoftTeamsMeetingTranscriptsFixture.id],
    run: Effect.gen(function* () {
      const joinWebUrl = yield* requireSeed('meetingJoinWebUrl')

      const { meeting } = yield* succeeded(
        teamsFindOnlineMeetingAction.id,
        teamsFindOnlineMeetingAction.executeTyped({
          integration,
          input: yield* decodedInput(
            TeamsFindOnlineMeetingInput,
            { joinWebUrl },
            'precondition: MicrosoftConformanceConfig.meetingJoinWebUrl must be a https://teams.microsoft.com join link'
          )
        })
      )

      yield* expectEqual(
        meeting.joinWebUrl ?? null,
        joinWebUrl,
        'expected the found meeting to carry the seeded join link'
      )

      const { transcripts } = yield* succeeded(
        teamsListMeetingTranscriptsAction.id,
        teamsListMeetingTranscriptsAction.executeTyped({
          integration,
          input: yield* decodedInput(
            TeamsListMeetingTranscriptsInput,
            { meetingId: meeting.id },
            'expected the found meeting id to be a base64 Teams meeting id'
          )
        })
      )

      yield* expectConformance(
        transcripts.length > 0,
        'precondition: the seeded meeting needs at least one transcript'
      )

      const others = transcripts.filter(transcript => transcript.meetingId !== meeting.id)

      yield* expectConformance(
        others.length === 0,
        'expected every transcript to name the found meeting id',
        { actual: others.map(transcript => transcript.id) }
      )
    })
  }
)

// Irreversible write case.

const sendCaseId = 'microsoft.teams.send-chat-message'

/**
 * The send case's plain text: the marker and the run id (so each invocation's message is
 * distinct), markup and an ampersand the connector must escape, and a line break it sends as
 * `<br>`.
 */
const sendText = (runId: string) =>
  `${microsoftConformanceMarker} ${runId}: <b>not bold</b> & safe to ignore\nsecond line`

/**
 * The send, classified by the shared `classifyWriteExit`: the created message; a definitive
 * rejection (any 4xx other than 408; nothing was posted); or an ambiguous failure (a transport or
 * decoding failure, no status, HTTP 408, or HTTP 5xx; the message may have been posted), which is
 * also reported through `ConformanceCleanupReporter` when the case is being interrupted.
 */
const sendOnce = (input: TeamsSendChatMessageInput, runId: string) =>
  Effect.uninterruptibleMask(unmask =>
    Effect.gen(function* () {
      const actionId = teamsSendChatMessageAction.id

      const outcome = classifyWriteExit(
        yield* Effect.exit(teamsSendChatMessageAction.executeTyped({ integration, input }))
      )

      switch (outcome.kind) {
        case 'success':
          return outcome.value
        case 'rejected':
          return yield* new MicrosoftConformanceActionFailed({ actionId, ...outcome.failure })
        case 'ambiguous':
          return yield* failReporting(
            unmask,
            new MicrosoftConformanceActionFailed({
              actionId,
              ...outcome.failure,
              sendOutcome: 'unknown',
              runId
            })
          )
      }
    })
  )

export const microsoftTeamsSendChatMessageCase: MicrosoftConformanceCase = defineConformanceCase({
  id: sendCaseId,
  title: 'A plain-text chat message is posted as escaped HTML and reads back by its id',
  safety: 'write-irreversible',
  docs: 'POST /chats/{chat-id}/messages with a `chatMessage` body sends a message to an existing chat and answers 201 Created with the created message. The connector sends plain text as an HTML body (markup escaped, line breaks as `<br>`) and has no delete action: a sent message cannot be undone through it.',
  wire: '`teams.send_chat_message` of a short text naming the run id (with markup, an ampersand, and a line break) to the seeded practice chat answers a message with a non-empty id that names the seeded chat, whose body is `html` and equals the escaped HTML the connector sent (unverified: Graph may normalize the HTML it stores); `teams.get_chat_message` with the returned id answers the same message and body. The message stays in the chat: this case is write-irreversible and runs only when requested by its exact id.',
  fixtures: [microsoftTeamsSendChatMessageFixture.id],
  run: Effect.gen(function* () {
    const chatId = yield* requireSeed('chatId')
    const runId = yield* requireSeed('runId')
    const text = sendText(runId)

    const input = yield* decodedInput(
      TeamsSendChatMessageInput,
      { chatId, content: text },
      'precondition: MicrosoftConformanceConfig.chatId is not a valid Teams id'
    )

    const sent = yield* sendOnce(input, runId)
    const html = teamsMessageHtml(text)

    yield* expectConformance(
      isNonEmptyString(sent.id),
      'expected the send to answer the created message id'
    )
    yield* expectEqual(
      sent.chatId ?? null,
      chatId,
      'expected the created message to name the seeded chat'
    )
    yield* expectEqual(
      [sent.body?.contentType ?? null, sent.body?.content ?? null],
      ['html', html],
      'expected the created message body to be the escaped HTML the connector sent'
    )

    const fetched = yield* succeeded(
      teamsGetChatMessageAction.id,
      teamsGetChatMessageAction.executeTyped({
        integration,
        input: yield* decodedInput(
          TeamsChatMessageIdInput,
          { chatId, messageId: sent.id },
          'expected the created message id to be a usable Teams id'
        )
      })
    )

    yield* expectEqual(
      [fetched.id, fetched.body?.content ?? null],
      [sent.id, html],
      'expected teams.get_chat_message with the returned id to answer the sent message'
    )
  })
})
