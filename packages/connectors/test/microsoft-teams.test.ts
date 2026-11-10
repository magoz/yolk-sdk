import { describe, expect, it } from '@effect/vitest'
import { Effect, Layer, Schema } from 'effect'
import {
  ConnectorBinaryHttpClient,
  ConnectorBinaryHttpError,
  ConnectorError,
  ConnectorHttpClient,
  ConnectorHttpResponse,
  CredentialResolver,
  makeCredentialBinding,
  makeIntegration,
  OAuthCredential
} from '@yolk-sdk/connectors'
import type {
  ConnectorBinaryHttpRequest,
  ConnectorBinaryHttpResponse,
  ConnectorHttpRequest,
  CredentialResolveRequest
} from '@yolk-sdk/connectors'
import {
  downloadTeamsMeetingTranscript,
  MicrosoftCombinedOAuthCredentialSlot,
  MicrosoftConnector,
  microsoftGraphChannelMessageReadAllScope,
  microsoftGraphChannelMessageSendScope,
  microsoftGraphChatMessageSendScope,
  microsoftGraphChannelReadBasicAllScope,
  microsoftGraphChatReadScope,
  microsoftGraphOnlineMeetingsReadScope,
  microsoftGraphOnlineMeetingTranscriptReadAllScope,
  microsoftGraphTeamReadBasicAllScope,
  microsoftOAuthSlotId,
  microsoftTeamsScopes,
  teamsActions,
  teamsMessageHtml,
  teamsMessageMaxBytes,
  TeamsChatMessageIdInput,
  TeamsListMeetingTranscriptsInput,
  TeamsFindOnlineMeetingInput,
  TeamsSendChatMessageInput
} from '@yolk-sdk/connectors/microsoft'

const bindings = [
  makeCredentialBinding({ slotId: microsoftOAuthSlotId, credentialRef: 'microsoft-oauth' })
]

const integration = makeIntegration({ connectorId: 'microsoft', credentialBindings: bindings })

const chatId = '19:2da4c29f6d7041eca70b638b43d45437@thread.v2'

const teamId = '893075dd-2487-4122-925f-022c42e20265'

const channelId = '19:4a95f7d8db4c4e7fae857bcebe0623e6@thread.tacv2'

const meetingId = 'MSo1N2Y5ZGFjYy03MWJm+LTQ3NDMtYjQxMy01M2Ed/FGkdRWHJlQ=='

const joinWebUrl =
  "https://teams.microsoft.com/l/meetup-join/19%3ameeting_MTE3NDY0YWE@thread.v2/0?context=%7b%22Tid%22%3a%22o'brien%22%7d"

type GraphJson = Schema.Json

const response = (status: number, body: GraphJson) =>
  ConnectorHttpResponse.make({ status, headers: {}, body: JSON.stringify(body) })

const makeHost = (responses: ReadonlyArray<ConnectorHttpResponse>) => {
  const requests: Array<ConnectorHttpRequest> = []
  const credentialRequests: Array<CredentialResolveRequest> = []

  const layer = Layer.mergeAll(
    Layer.succeed(CredentialResolver, {
      resolve: request => {
        credentialRequests.push(request)

        return Effect.succeed(
          OAuthCredential.make({
            provider: 'microsoft',
            accessToken: 'FAKE-MICROSOFT-TOKEN',
            expiresAt: Date.now() + 60_000
          })
        )
      }
    }),
    Layer.succeed(ConnectorHttpClient, {
      request: request => {
        const next = responses[requests.length]
        requests.push(request)

        return next === undefined
          ? Effect.fail(
              new ConnectorError({
                cause: 'transport_failed',
                message: 'Unexpected Microsoft test request'
              })
            )
          : Effect.succeed(next)
      }
    })
  )

  return { credentialRequests, layer, requests }
}

const invoke = (action: string, input: unknown, layer: ReturnType<typeof makeHost>['layer']) =>
  MicrosoftConnector.invoke({ action, input, integration }).pipe(Effect.provide(layer))

const requestUrl = (request: ConnectorHttpRequest | undefined) => new URL(request?.url ?? '')

const scopesOf = (host: ReturnType<typeof makeHost>) =>
  host.credentialRequests.map(request => request.slot.requiredScopes)

describe('Microsoft Teams actions', () => {
  it('registers the Teams actions on the Microsoft connector; only sends are destructive', () => {
    for (const action of teamsActions) expect(MicrosoftConnector.actions).toContain(action)

    expect(
      teamsActions
        .filter(action => action.access !== undefined)
        .map(action => [action.id, action.access])
    ).toEqual([
      ['teams.send_chat_message', 'destructive'],
      ['teams.send_channel_message', 'destructive'],
      ['teams.reply_to_channel_message', 'destructive']
    ])
  })

  it('keeps every Teams scope out of the combined slot', () => {
    for (const scope of microsoftTeamsScopes) {
      expect(MicrosoftCombinedOAuthCredentialSlot.requiredScopes).not.toContain(scope)
    }

    expect(microsoftTeamsScopes).toHaveLength(8)
  })

  it.effect('lists chats with members under Chat.Read and drops Graph nulls', () =>
    Effect.gen(function* () {
      const host = makeHost([
        response(200, {
          value: [
            {
              id: chatId,
              topic: null,
              chatType: 'oneOnOne',
              webUrl: 'https://teams.microsoft.com/l/chat/19%3A2da4/0',
              onlineMeetingInfo: null,
              members: [
                {
                  displayName: 'Erik Lind',
                  email: 'erik@powerheat.example',
                  userId: 'user-erik',
                  roles: ['owner']
                },
                { displayName: null, email: null, userId: 'user-me', roles: null }
              ]
            }
          ],
          '@odata.nextLink': `https://graph.microsoft.com/v1.0/me/chats?$skiptoken=abc`
        })
      ])

      const result = yield* invoke('teams.list_chats', { top: 20 }, host.layer)

      expect(result).toMatchObject({
        _tag: 'Success',
        value: {
          chats: [
            {
              id: chatId,
              chatType: 'oneOnOne',
              members: [
                {
                  displayName: 'Erik Lind',
                  email: 'erik@powerheat.example',
                  userId: 'user-erik',
                  roles: ['owner']
                },
                { userId: 'user-me' }
              ]
            }
          ],
          nextLink: 'https://graph.microsoft.com/v1.0/me/chats?$skiptoken=abc'
        }
      })
      expect(JSON.stringify(result)).not.toContain('null')

      const url = requestUrl(host.requests[0])

      expect(url.pathname).toBe('/v1.0/me/chats')
      expect(url.searchParams.get('$expand')).toBe('members')
      expect(url.searchParams.get('$top')).toBe('20')
      expect(scopesOf(host)).toEqual([[microsoftGraphChatReadScope]])
    })
  )

  it.effect('orders chats by their latest message when it expands the preview', () =>
    Effect.gen(function* () {
      const host = makeHost([
        response(200, {
          value: [
            {
              id: chatId,
              onlineMeetingInfo: { joinWebUrl },
              lastMessagePreview: {
                id: '1700000000000',
                isDeleted: false,
                messageType: 'message',
                from: { user: { id: 'user-erik', displayName: 'Erik Lind' }, application: null },
                body: { contentType: 'text', content: 'Hej!' }
              }
            }
          ]
        })
      ])

      const result = yield* invoke('teams.list_chats', { expand: 'lastMessagePreview' }, host.layer)

      expect(result).toMatchObject({
        _tag: 'Success',
        value: {
          chats: [
            {
              id: chatId,
              onlineMeetingJoinWebUrl: joinWebUrl,
              lastMessagePreview: {
                id: '1700000000000',
                isDeleted: false,
                from: { kind: 'user', id: 'user-erik', displayName: 'Erik Lind' },
                body: { contentType: 'text', content: 'Hej!' }
              }
            }
          ]
        }
      })

      const url = requestUrl(host.requests[0])

      expect(url.searchParams.get('$expand')).toBe('lastMessagePreview')
      expect(url.searchParams.get('$orderby')).toBe('lastMessagePreview/createdDateTime desc')
    })
  )

  it.effect('lists chat messages since a time, newest first, with senders and attachments', () =>
    Effect.gen(function* () {
      const host = makeHost([
        response(200, {
          value: [
            {
              id: '1700000000001',
              messageType: 'message',
              createdDateTime: '2026-11-10T09:00:00.000Z',
              deletedDateTime: null,
              from: { user: null, application: { id: 'bot-1', displayName: 'Planner' } },
              body: { contentType: 'html', content: '<p>Plan ready</p>' },
              attachments: [
                {
                  id: 'att-1',
                  name: 'plan.xlsx',
                  contentType: 'reference',
                  contentUrl: 'https://powerheat.sharepoint.com/sites/x/plan.xlsx',
                  content: null
                }
              ],
              mentions: [],
              chatId
            }
          ]
        })
      ])

      const result = yield* invoke(
        'teams.list_chat_messages',
        { chatId, modifiedSince: '2026-11-10T08:00:00Z' },
        host.layer
      )

      expect(result).toMatchObject({
        _tag: 'Success',
        value: {
          messages: [
            {
              id: '1700000000001',
              from: { kind: 'application', id: 'bot-1', displayName: 'Planner' },
              body: { contentType: 'html', content: '<p>Plan ready</p>' },
              attachments: [{ id: 'att-1', name: 'plan.xlsx', contentType: 'reference' }],
              chatId
            }
          ]
        }
      })

      const url = requestUrl(host.requests[0])

      expect(decodeURIComponent(url.pathname)).toBe(`/v1.0/chats/${chatId}/messages`)
      expect(url.searchParams.get('$orderby')).toBe('lastModifiedDateTime desc')
      expect(url.searchParams.get('$filter')).toBe('lastModifiedDateTime gt 2026-11-10T08:00:00Z')
    })
  )

  it.effect('follows a nextLink only for the same Graph collection', () =>
    Effect.gen(function* () {
      const sameEncoded = `https://graph.microsoft.com/v1.0/chats/${encodeURIComponent(chatId)}/messages?$skiptoken=x`
      const sameRaw = `https://graph.microsoft.com/v1.0/chats/${chatId}/messages?$skiptoken=y`
      const host = makeHost([response(200, { value: [] }), response(200, { value: [] })])

      for (const nextLink of [sameEncoded, sameRaw]) {
        const result = yield* invoke('teams.list_chat_messages', { chatId, nextLink }, host.layer)

        expect(result).toMatchObject({ _tag: 'Success' })
      }

      expect(host.requests.map(request => request.url)).toEqual([sameEncoded, sameRaw])

      for (const nextLink of [
        `https://graph.microsoft.com/v1.0/chats/19:other@thread.v2/messages?$skiptoken=x`,
        `https://evil.example.test/v1.0/chats/${chatId}/messages`,
        `https://graph.microsoft.com/v1.0/me/chats?$skiptoken=x`,
        'not a url'
      ]) {
        const failed = yield* invoke(
          'teams.list_chat_messages',
          { chatId, nextLink },
          host.layer
        ).pipe(Effect.flip)

        expect(failed).toMatchObject({ cause: 'validation_failed' })
      }

      expect(host.requests).toHaveLength(2)
    })
  )

  it.effect.each<{
    readonly action: string
    readonly input: Readonly<Record<string, string>>
    readonly path: string
    readonly scope: string
    readonly body: GraphJson
  }>([
    {
      action: 'teams.get_chat',
      input: { chatId },
      path: `/v1.0/chats/${chatId}`,
      scope: microsoftGraphChatReadScope,
      body: { id: 'x' }
    },
    {
      action: 'teams.get_chat_message',
      input: { chatId, messageId: '1700000000001' },
      path: `/v1.0/chats/${chatId}/messages/1700000000001`,
      scope: microsoftGraphChatReadScope,
      body: { id: 'x' }
    },
    {
      action: 'teams.list_joined_teams',
      input: {},
      path: '/v1.0/me/joinedTeams',
      scope: microsoftGraphTeamReadBasicAllScope,
      body: { value: [] }
    },
    {
      action: 'teams.get_team',
      input: { teamId },
      path: `/v1.0/teams/${teamId}`,
      scope: microsoftGraphTeamReadBasicAllScope,
      body: { id: 'x' }
    },
    {
      action: 'teams.list_channels',
      input: { teamId },
      path: `/v1.0/teams/${teamId}/channels`,
      scope: microsoftGraphChannelReadBasicAllScope,
      body: { value: [] }
    },
    {
      action: 'teams.get_channel',
      input: { teamId, channelId },
      path: `/v1.0/teams/${teamId}/channels/${channelId}`,
      scope: microsoftGraphChannelReadBasicAllScope,
      body: { id: 'x' }
    },
    {
      action: 'teams.get_channel_message',
      input: { teamId, channelId, messageId: '1700000000003' },
      path: `/v1.0/teams/${teamId}/channels/${channelId}/messages/1700000000003`,
      scope: microsoftGraphChannelMessageReadAllScope,
      body: { id: 'x' }
    }
  ])('$action reads $path under its own scope', ({ action, input, path, scope, body }) =>
    Effect.gen(function* () {
      const host = makeHost([response(200, body)])

      const result = yield* invoke(action, input, host.layer)

      expect(result).toMatchObject({ _tag: 'Success' })
      expect(host.requests[0]?.method).toBe('GET')
      expect(decodeURIComponent(requestUrl(host.requests[0]).pathname)).toBe(path)
      expect(scopesOf(host)).toEqual([[scope]])
    })
  )

  it.each<string>(['..', '.', 'a/b', 'a?b', 'a#b', 'a%2Fb', 'a\tb', ' a', 'a b', '\ud800'])(
    'rejects a Teams id that is not one opaque path segment (%j)',
    messageId => {
      expect(Schema.decodeUnknownResult(TeamsChatMessageIdInput)({ chatId, messageId })._tag).toBe(
        'Failure'
      )
    }
  )

  it.each<string>(['/', '..', './.', 'a?b', 'a%2Fb', 'a b', 'a#b'])(
    'rejects a meeting id outside base64 (%j)',
    id => {
      expect(
        Schema.decodeUnknownResult(TeamsListMeetingTranscriptsInput)({ meetingId: id })._tag
      ).toBe('Failure')
    }
  )

  it.each<string>([
    'https://teams.microsoft.com:8443/l/meetup-join/x',
    'https://teams.microsoft.com.evil.test/l/meetup-join/x',
    'https://teams.live.com/meet/123'
  ])('rejects the join link %s', joinWebUrl => {
    expect(Schema.decodeUnknownResult(TeamsFindOnlineMeetingInput)({ joinWebUrl })._tag).toBe(
      'Failure'
    )
  })

  it.effect('pages a meeting id holding / and accepts /users/{id} links for /me collections', () =>
    Effect.gen(function* () {
      const transcripts = `https://graph.microsoft.com/v1.0/users/user-anna/onlineMeetings/${encodeURIComponent(meetingId)}/transcripts?$skiptoken=x`
      const chats = 'https://graph.microsoft.com/v1.0/users/7f3e1c2a/chats?$skiptoken=y'
      const host = makeHost([response(200, { value: [] }), response(200, { value: [] })])

      expect(
        yield* invoke(
          'teams.list_meeting_transcripts',
          { meetingId, nextLink: transcripts },
          host.layer
        )
      ).toMatchObject({ _tag: 'Success' })
      expect(yield* invoke('teams.list_chats', { nextLink: chats }, host.layer)).toMatchObject({
        _tag: 'Success'
      })
      expect(host.requests.map(request => request.url)).toEqual([transcripts, chats])

      for (const nextLink of [
        'https://graph.microsoft.com/v1.0/users/a/b/chats?$skiptoken=y',
        'https://graph.microsoft.com/v1.0/users/a/chats/extra',
        'https://graph.microsoft.com/beta/me/chats?$skiptoken=y',
        'https://graph.microsoft.com/v1.0/teams/x/chats',
        'https://user@graph.microsoft.com/v1.0/me/chats',
        'https://graph.microsoft.com:444/v1.0/me/chats',
        'https://graph.microsoft.com/v1.0/me/chats#x',
        'http://graph.microsoft.com/v1.0/me/chats'
      ]) {
        const failed = yield* invoke('teams.list_chats', { nextLink }, host.layer).pipe(Effect.flip)

        expect(failed).toMatchObject({ cause: 'validation_failed' })
      }

      expect(host.requests).toHaveLength(2)
      expect(host.credentialRequests).toHaveLength(2)
    })
  )

  it('sends plain text as escaped HTML with line breaks', () => {
    expect(teamsMessageHtml(`Hej <Erik> & "team"\nRad två\r\nTre's`)).toBe(
      'Hej &lt;Erik&gt; &amp; &quot;team&quot;<br>Rad två<br>Tre&#39;s'
    )
  })

  it.each<string>([
    '',
    '   \n ',
    'x'.repeat(teamsMessageMaxBytes + 1),
    '<'.repeat(8_000),
    '\ud800'
  ])('rejects a message that is blank, malformed or over the escaped size limit (%#)', content => {
    expect(Schema.decodeUnknownResult(TeamsSendChatMessageInput)({ chatId, content })._tag).toBe(
      'Failure'
    )
  })

  it.effect('sends a chat message under ChatMessage.Send and returns the created message', () =>
    Effect.gen(function* () {
      const host = makeHost([
        response(201, {
          id: '1700000000002',
          messageType: 'message',
          from: { user: { id: 'user-me', displayName: 'Me' } },
          body: { contentType: 'html', content: 'Hej<br>då' },
          chatId
        })
      ])

      const result = yield* invoke(
        'teams.send_chat_message',
        { chatId, content: 'Hej\nda <3' },
        host.layer
      )

      expect(result).toMatchObject({
        _tag: 'Success',
        value: { id: '1700000000002', chatId, from: { kind: 'user', id: 'user-me' } }
      })
      expect(host.requests[0]?.method).toBe('POST')
      expect(decodeURIComponent(requestUrl(host.requests[0]).pathname)).toBe(
        `/v1.0/chats/${chatId}/messages`
      )
      expect(JSON.parse(host.requests[0]?.body ?? '')).toEqual({
        body: { contentType: 'html', content: 'Hej<br>da &lt;3' }
      })
      expect(scopesOf(host)).toEqual([[microsoftGraphChatMessageSendScope]])
    })
  )

  it.effect('reads and posts in channels under the channel message scopes', () =>
    Effect.gen(function* () {
      const post = {
        id: '1700000000003',
        replyToId: null,
        channelIdentity: { teamId, channelId },
        body: { contentType: 'html', content: 'Status' }
      }

      const host = makeHost([
        response(200, { value: [post] }),
        response(200, { value: [{ ...post, id: '1700000000004', replyToId: post.id }] }),
        response(201, post),
        response(201, { ...post, id: '1700000000005', replyToId: post.id })
      ])

      const listed = yield* invoke(
        'teams.list_channel_messages',
        { teamId, channelId, top: 10 },
        host.layer
      )

      expect(listed).toMatchObject({
        _tag: 'Success',
        value: { messages: [{ id: post.id, channelIdentity: { teamId, channelId } }] }
      })

      const replies = yield* invoke(
        'teams.list_channel_message_replies',
        { teamId, channelId, messageId: post.id },
        host.layer
      )

      expect(replies).toMatchObject({
        _tag: 'Success',
        value: { messages: [{ id: '1700000000004', replyToId: post.id }] }
      })

      yield* invoke(
        'teams.send_channel_message',
        { teamId, channelId, subject: 'Veckorapport', content: 'Klart' },
        host.layer
      )

      yield* invoke(
        'teams.reply_to_channel_message',
        { teamId, channelId, messageId: post.id, content: 'Tack' },
        host.layer
      )

      expect(
        host.requests.map(request => [
          request.method,
          decodeURIComponent(requestUrl(request).pathname)
        ])
      ).toEqual([
        ['GET', `/v1.0/teams/${teamId}/channels/${channelId}/messages`],
        ['GET', `/v1.0/teams/${teamId}/channels/${channelId}/messages/${post.id}/replies`],
        ['POST', `/v1.0/teams/${teamId}/channels/${channelId}/messages`],
        ['POST', `/v1.0/teams/${teamId}/channels/${channelId}/messages/${post.id}/replies`]
      ])
      expect(JSON.parse(host.requests[2]?.body ?? '')).toEqual({
        subject: 'Veckorapport',
        body: { contentType: 'html', content: 'Klart' }
      })
      expect(scopesOf(host)).toEqual([
        [microsoftGraphChannelMessageReadAllScope],
        [microsoftGraphChannelMessageReadAllScope],
        [microsoftGraphChannelMessageSendScope],
        [microsoftGraphChannelMessageSendScope]
      ])
    })
  )

  it.effect('finds a meeting by its quoted join link and lists its transcripts', () =>
    Effect.gen(function* () {
      const host = makeHost([
        response(200, {
          value: [
            {
              id: meetingId,
              subject: 'Projektmöte',
              startDateTime: '2026-11-09T09:00:00Z',
              joinWebUrl,
              chatInfo: { threadId: '19:meeting_abc@thread.v2' },
              participants: {
                organizer: {
                  upn: 'anna@powerheat.example',
                  role: 'presenter',
                  identity: { user: { id: 'user-anna', displayName: 'Anna' } }
                },
                attendees: [{ upn: 'erik@powerheat.example', role: 'attendee', identity: null }]
              }
            }
          ]
        }),
        response(200, {
          value: [
            {
              id: 'transcript-1',
              meetingId,
              createdDateTime: '2026-11-09T10:00:00Z',
              meetingOrganizer: { user: { id: 'user-anna', displayName: null } }
            }
          ]
        })
      ])

      const found = yield* invoke('teams.find_online_meeting', { joinWebUrl }, host.layer)

      expect(found).toMatchObject({
        _tag: 'Success',
        value: {
          meeting: {
            id: meetingId,
            subject: 'Projektmöte',
            chatId: '19:meeting_abc@thread.v2',
            organizer: { upn: 'anna@powerheat.example', userId: 'user-anna', displayName: 'Anna' },
            attendees: [{ upn: 'erik@powerheat.example', role: 'attendee' }]
          }
        }
      })
      expect(requestUrl(host.requests[0]).searchParams.get('$filter')).toBe(
        `JoinWebUrl eq '${joinWebUrl.replaceAll("'", "''")}'`
      )

      const transcripts = yield* invoke('teams.list_meeting_transcripts', { meetingId }, host.layer)

      expect(transcripts).toMatchObject({
        _tag: 'Success',
        value: {
          transcripts: [
            { id: 'transcript-1', meetingId, organizer: { kind: 'user', id: 'user-anna' } }
          ]
        }
      })
      expect(requestUrl(host.requests[1]).pathname).toBe(
        `/v1.0/me/onlineMeetings/${encodeURIComponent(meetingId)}/transcripts`
      )
      expect(scopesOf(host)).toEqual([
        [microsoftGraphOnlineMeetingsReadScope],
        [microsoftGraphOnlineMeetingTranscriptReadAllScope]
      ])
    })
  )

  it.effect('answers not found for a join link without a visible meeting', () =>
    Effect.gen(function* () {
      const host = makeHost([response(200, { value: [] })])

      const result = yield* invoke('teams.find_online_meeting', { joinWebUrl }, host.layer)

      expect(result).toMatchObject({
        _tag: 'Failure',
        error: { code: 'microsoft_not_found', status: 404 }
      })
    })
  )

  it.effect('rejects a join link outside teams.microsoft.com before any request', () =>
    Effect.gen(function* () {
      const host = makeHost([])

      for (const link of [
        'https://evil.example.test/l/meetup-join/x',
        'http://teams.microsoft.com/l/meetup-join/x',
        'https://user@teams.microsoft.com/l/meetup-join/x'
      ]) {
        const failed = yield* invoke(
          'teams.find_online_meeting',
          { joinWebUrl: link },
          host.layer
        ).pipe(Effect.flip)

        expect(failed).toMatchObject({ cause: 'validation_failed' })
      }

      expect(host.requests).toEqual([])
    })
  )

  it.effect('maps a refused channel read to a sanitized Microsoft failure with retry time', () =>
    Effect.gen(function* () {
      const host = makeHost([
        ConnectorHttpResponse.make({
          status: 429,
          headers: { 'Retry-After': '7' },
          body: JSON.stringify({ error: { code: 'TooManyRequests', message: 'Slow down' } })
        })
      ])

      const result = yield* invoke('teams.list_channels', { teamId }, host.layer)

      expect(result).toMatchObject({
        _tag: 'Failure',
        error: { code: 'microsoft_rate_limited', status: 429, retryAfterMs: 7_000 }
      })
    })
  )
})

describe('host-only Teams transcript download', () => {
  const budget = { maxBytes: 1024, maxMetadataBytes: 1024, maxErrorBodyBytes: 256 }

  const binary = (status: number, body: string): ConnectorBinaryHttpResponse => ({
    status,
    headers: {},
    bytes: new TextEncoder().encode(body),
    bodyComplete: true
  })

  const makeBinaryHost = (responses: ReadonlyArray<ConnectorBinaryHttpResponse>) => {
    const requests: Array<ConnectorBinaryHttpRequest> = []
    const slots: Array<ReadonlyArray<string> | undefined> = []

    const layer = Layer.mergeAll(
      Layer.succeed(CredentialResolver, {
        resolve: request => {
          slots.push(request.slot.requiredScopes)

          return Effect.succeed(
            OAuthCredential.make({
              provider: 'microsoft',
              accessToken: 'FAKE-MICROSOFT-TOKEN',
              expiresAt: Date.now() + 60_000
            })
          )
        }
      }),
      Layer.succeed(ConnectorBinaryHttpClient, {
        request: request => {
          const next = responses[requests.length]
          requests.push(request)

          return next === undefined
            ? Effect.fail(new ConnectorBinaryHttpError({ code: 'transport_failed' }))
            : Effect.succeed(next)
        }
      })
    )

    return { layer, requests, slots }
  }

  const vtt = 'WEBVTT\n\n00:00:00.000 --> 00:00:02.000\n<v Anna>Hej allihop</v>\n'

  it.effect('reads the metadata, then the WebVTT content, without following redirects', () =>
    Effect.gen(function* () {
      const host = makeBinaryHost([
        binary(200, JSON.stringify({ id: 'transcript-1', meetingId, endDateTime: null })),
        binary(200, vtt)
      ])

      const result = yield* downloadTeamsMeetingTranscript(
        integration,
        { meetingId, transcriptId: 'transcript-1' },
        budget
      ).pipe(Effect.provide(host.layer))

      expect(new TextDecoder().decode(result.bytes)).toBe(vtt)
      expect(result).toMatchObject({
        mimeType: 'text/vtt',
        source: { meetingId, transcriptId: 'transcript-1' }
      })
      expect(
        host.requests.map(request => [request.url, request.redirect, request.headers.accept])
      ).toEqual([
        [
          `https://graph.microsoft.com/v1.0/me/onlineMeetings/${encodeURIComponent(meetingId)}/transcripts/transcript-1`,
          'manual',
          'application/json'
        ],
        [
          `https://graph.microsoft.com/v1.0/me/onlineMeetings/${encodeURIComponent(meetingId)}/transcripts/transcript-1/content?$format=text/vtt`,
          'manual',
          'text/vtt'
        ]
      ])
      expect(host.slots).toEqual([[microsoftGraphOnlineMeetingTranscriptReadAllScope]])
    })
  )

  it.effect.each<{
    readonly name: string
    readonly responses: ReadonlyArray<ConnectorBinaryHttpResponse>
    readonly code: string
  }>([
    {
      name: 'a transcript id mismatch',
      responses: [binary(200, JSON.stringify({ id: 'other' }))],
      code: 'invalid_metadata'
    },
    {
      name: 'a tenant that disabled Graph transcript access',
      responses: [binary(403, '{"error":{"code":"GraphAccessToTranscriptsDisabled"}}')],
      code: 'forbidden'
    },
    {
      name: 'a content redirect',
      responses: [binary(200, JSON.stringify({ id: 'transcript-1' })), binary(302, '')],
      code: 'unexpected_redirect'
    }
  ])('fails with a typed code for $name', ({ responses, code }) =>
    Effect.gen(function* () {
      const host = makeBinaryHost(responses)

      const error = yield* downloadTeamsMeetingTranscript(
        integration,
        { meetingId, transcriptId: 'transcript-1' },
        budget
      ).pipe(Effect.provide(host.layer), Effect.flip)

      expect(error).toMatchObject({ _tag: 'ConnectorFileTransferError', code })
      expect(JSON.stringify(error)).not.toContain('FAKE-MICROSOFT-TOKEN')
    })
  )
})
