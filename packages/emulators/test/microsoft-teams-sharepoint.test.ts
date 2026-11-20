/**
 * The fixture-only SharePoint site and Teams routes of the Microsoft Graph emulator: the data copy
 * equals the connector fixtures, every recorded exchange is answered byte for byte (alone and in
 * suite order on one emulator), the send is recorded in the state under a minted id, and every
 * request no fixture records is refused (400) before anything is written or a fault is used.
 */
import { Effect, Option } from 'effect'
import * as Schema from 'effect/Schema'
import { afterEach, describe, expect, it } from '@effect/vitest'
import { microsoftConformanceFixtures } from '@yolk-sdk/connectors/microsoft/conformance'
import {
  emulatorEvidenceHeader,
  makeMicrosoftEmulator,
  MicrosoftEmulatorStateSchema,
  microsoftEmulatorErrorCodes,
  type MicrosoftEmulator,
  type MicrosoftEmulatorOptions
} from '../src/microsoft.ts'
import {
  microsoftTeamsSitesFixtures,
  type MicrosoftRecordedExchange
} from '../src/microsoft/teams-sites-recordings.ts'
import { sendTemplateOf } from '../src/microsoft/teams-sites.ts'

const now = Date.parse('2026-09-29T10:00:00.000Z')

const token = 'synthetic-unit-test-token'

const open: Array<MicrosoftEmulator> = []

afterEach(async () => {
  await Promise.all(open.splice(0).map(emulator => emulator.close()))
})

const emulator = async (options: MicrosoftEmulatorOptions = {}): Promise<MicrosoftEmulator> => {
  const created = await makeMicrosoftEmulator({ now: () => now, ...options })

  open.push(created)

  return created
}

const teamsSitesSource = microsoftConformanceFixtures.filter(
  fixture =>
    fixture.caseId.startsWith('microsoft.sharepoint.') ||
    fixture.caseId.startsWith('microsoft.teams.')
)

/** Send one recorded request (with a bearer the fixture never records). */
const send = (target: MicrosoftEmulator, request: MicrosoftRecordedExchange['request']) =>
  target.fetch(
    new Request(request.url, {
      method: request.method,
      headers: { ...request.headers, authorization: `Bearer ${token}` },
      body: request.body === undefined ? undefined : JSON.stringify(request.body)
    })
  )

const expectRecorded = async (response: Response, recorded: MicrosoftRecordedExchange) => {
  expect(response.status, recorded.request.url).toBe(recorded.response.status)
  expect(response.headers.get('content-type')).toBe(recorded.response.headers['content-type'])
  expect(response.headers.get(emulatorEvidenceHeader)).toBe('unverified')
  expect(await response.text(), recorded.request.url).toBe(recorded.response.body)
}

const sendFixture = microsoftTeamsSitesFixtures.find(
  fixture => fixture.caseId === 'microsoft.teams.send-chat-message'
)

const sendExchanges = () => {
  const [post, readback] = sendFixture?.exchanges ?? []

  if (post === undefined || readback === undefined) {
    return expect.fail('the send fixture records a POST and a readback')
  }

  return { post, readback }
}

/** The dedicated send chat's messages (the recorded send posts there). */
const chatMessages =
  'https://graph.microsoft.com/v1.0/chats/19%3Asynthetic-send-chat-0001%40thread.v2/messages'

/** The paging chat's messages: never written to. */
const pagingChatMessages =
  'https://graph.microsoft.com/v1.0/chats/19%3Asynthetic-chat-0001%40thread.v2/messages'

const sentContent =
  'yolk-conformance run-synthetic: &lt;b&gt;not bold&lt;/b&gt; &amp; safe to ignore<br>second line'

const sendBody = (content: string, extra: { readonly subject?: string } = {}) => ({
  body: { contentType: 'html', content },
  ...extra
})

const GraphErrorBody = Schema.Struct({ error: Schema.Struct({ code: Schema.String }) })

/** The Graph error envelope's `error.code`, or `undefined` for another body. */
const errorCode = async (response: Response): Promise<string | undefined> =>
  Option.getOrUndefined(
    Option.map(
      Schema.decodeUnknownOption(GraphErrorBody)(await response.json()),
      body => body.error.code
    )
  )

const decodeJson = Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Json))

/** `text` as a promoted live recording would name its run id. */
const promoted = (text: string): string => text.replaceAll('run-synthetic', 'run-0f3a9c12')

/** A recorded exchange with `rewrite` applied to its request body and its answer. */
const rewrittenExchange = (
  exchange: MicrosoftRecordedExchange,
  rewrite: (text: string) => string
): MicrosoftRecordedExchange => {
  const response = { ...exchange.response, body: rewrite(exchange.response.body) }
  const body = exchange.request.body

  if (body === undefined) return { request: exchange.request, response }

  const rewritten = Option.getOrUndefined(decodeJson(rewrite(JSON.stringify(body))))

  return rewritten === undefined
    ? expect.fail('expected a JSON request body')
    : { request: { ...exchange.request, body: rewritten }, response }
}

/** A recorded exchange with every run id promoted, in its body and its answer. */
const promotedExchange = (exchange: MicrosoftRecordedExchange): MicrosoftRecordedExchange =>
  rewrittenExchange(exchange, promoted)

describe('Microsoft Teams and SharePoint site routes', () => {
  it('copy the eight connector fixtures as data, in suite order', () => {
    expect(microsoftTeamsSitesFixtures).toEqual(teamsSitesSource)
    expect(microsoftTeamsSitesFixtures.map(fixture => fixture.caseId)).toEqual([
      'microsoft.sharepoint.search-finds-site',
      'microsoft.sharepoint.site-drives-libraries',
      'microsoft.teams.chats-list-members',
      'microsoft.teams.chat-messages-paging',
      'microsoft.teams.team-channels',
      'microsoft.teams.channel-message-replies',
      'microsoft.teams.meeting-transcripts',
      'microsoft.teams.send-chat-message'
    ])
  })

  it.effect('answer every fixture exchange byte for byte, each fixture on a fresh emulator', () =>
    Effect.promise(async () => {
      for (const fixture of microsoftTeamsSitesFixtures) {
        const target = await emulator()

        for (const exchange of fixture.exchanges) {
          await expectRecorded(await send(target, exchange.request), exchange)
        }
      }
    })
  )

  it.effect(
    'answer every fixture in suite order on one emulator, ending at the seed plus the one send',
    () =>
      Effect.promise(async () => {
        const target = await emulator()
        const seed = target.snapshot()

        for (const fixture of microsoftTeamsSitesFixtures) {
          for (const exchange of fixture.exchanges) {
            await expectRecorded(await send(target, exchange.request), exchange)
          }
        }

        expect(target.snapshot()).toEqual({
          ...seed,
          chatMessagesSent: [
            {
              chatId: '19:synthetic-send-chat-0001@thread.v2',
              id: '1790000000101',
              runId: 'run-synthetic'
            }
          ],
          counters: { ...seed.counters, nextChatMessageNumber: 102 }
        })
        expect(target.ledger.entries().every(entry => entry.status < 300)).toBe(true)
      })
  )

  it.effect('mint the next id for a later send and substitute only the run id and the id', () =>
    Effect.promise(async () => {
      const target = await emulator()
      const { post, readback } = sendExchanges()

      await expectRecorded(await send(target, post.request), post)

      const content = sentContent.replace('run-synthetic', 'run-0f3a9c')

      const second = await send(target, {
        ...post.request,
        body: sendBody(content)
      })

      const expected = (body: string) =>
        body.replaceAll('run-synthetic', 'run-0f3a9c').replaceAll('1790000000101', '1790000000102')

      expect(second.status).toBe(201)
      expect(await second.text()).toBe(expected(post.response.body))

      const read = await send(target, {
        ...readback.request,
        url: readback.request.url.replace('1790000000101', '1790000000102')
      })

      expect(await read.text()).toBe(expected(readback.response.body))
      expect(target.snapshot().chatMessagesSent.map(message => message.runId)).toEqual([
        'run-synthetic',
        'run-0f3a9c'
      ])
    })
  )

  it.effect(
    'keep a run id holding the recorded message id intact on a later send and its readback',
    () =>
      Effect.promise(async () => {
        const target = await emulator()
        const { post, readback } = sendExchanges()

        await expectRecorded(await send(target, post.request), post)

        const runId = 'run-1790000000101'
        const content = sentContent.replace('run-synthetic', runId)
        const second = await send(target, { ...post.request, body: sendBody(content) })
        const answered: unknown = await second.json()

        // The minted id replaces only the recorded message id, never text inside the run id.
        expect(answered).toMatchObject({
          id: '1790000000102',
          body: { contentType: 'html', content }
        })

        const read = await send(target, {
          ...readback.request,
          url: readback.request.url.replace('1790000000101', '1790000000102')
        })

        expect(await read.json()).toMatchObject({ id: '1790000000102', body: { content } })
        expect(target.snapshot().chatMessagesSent.at(-1)).toEqual({
          chatId: '19:synthetic-send-chat-0001@thread.v2',
          id: '1790000000102',
          runId
        })
      })
  )

  it('take the recorded run id from the copied send body, so a promoted recording still works', () => {
    const recorded = microsoftTeamsSitesFixtures.map(fixture => ({
      ...fixture,
      exchanges: fixture.exchanges.map(promotedExchange)
    }))

    const template = sendTemplateOf(recorded)

    expect(template?.runId).toBe('run-0f3a9c12')
    expect(template?.content.exec(sentContent.replace('run-synthetic', 'run-other'))?.[1]).toBe(
      'run-other'
    )
    expect(sendTemplateOf(microsoftTeamsSitesFixtures)?.runId).toBe('run-synthetic')
  })

  it('take the run id after the marker, not another run- word earlier in the text', () => {
    const earlier = (text: string) =>
      text.replaceAll('yolk-conformance run-synthetic', 'run-first yolk-conformance run-0f3a9c12')

    const recorded = microsoftTeamsSitesFixtures.map(fixture => ({
      ...fixture,
      exchanges: fixture.exchanges.map(exchange => rewrittenExchange(exchange, earlier))
    }))

    const template = sendTemplateOf(recorded)
    const sent = `run-first ${sentContent.replace('run-synthetic', 'run-other')}`

    expect(template?.runId).toBe('run-0f3a9c12')
    expect(template?.content.exec(sent)?.[1]).toBe('run-other')
    // The earlier word stays literal: only the marked run id varies.
    expect(template?.content.test(sent.replace('run-first', 'run-second'))).toBe(false)
  })
})

type Refusal = {
  readonly name: string
  readonly method: string
  readonly url: string
  readonly body?: unknown
  readonly code: string
}

const notEmulated = microsoftEmulatorErrorCodes.unsupportedValue

const refusals: ReadonlyArray<Refusal> = [
  {
    name: 'a site search for another keyword',
    method: 'GET',
    url: 'https://graph.microsoft.com/v1.0/sites?search=other',
    code: notEmulated
  },
  {
    name: 'a query parameter the route does not take',
    method: 'GET',
    url: 'https://graph.microsoft.com/v1.0/sites?search=synthetic&%24top=5',
    code: microsoftEmulatorErrorCodes.unsupportedQuery
  },
  {
    name: 'another chat page size',
    method: 'GET',
    url: `${chatMessages}?%24top=3&%24orderby=lastModifiedDateTime+desc`,
    code: notEmulated
  },
  {
    name: 'a chat message no fixture records',
    method: 'GET',
    url: `${chatMessages}/1789900000099`,
    code: notEmulated
  },
  {
    name: 'a send to the paging chat',
    method: 'POST',
    url: pagingChatMessages,
    body: sendBody(sentContent),
    code: notEmulated
  },
  {
    name: 'a send of other text',
    method: 'POST',
    url: chatMessages,
    body: sendBody('Hello'),
    code: notEmulated
  },
  {
    name: 'a send with a subject',
    method: 'POST',
    url: chatMessages,
    body: sendBody(sentContent, { subject: 'Synthetic' }),
    code: notEmulated
  },
  {
    name: 'a send of a text body',
    method: 'POST',
    url: chatMessages,
    body: { body: { contentType: 'text', content: sentContent } },
    code: notEmulated
  },
  {
    name: 'a send naming a run id over 40 characters',
    method: 'POST',
    url: chatMessages,
    body: sendBody(sentContent.replace('run-synthetic', `run-${'a'.repeat(40)}`)),
    code: notEmulated
  }
]

describe('Microsoft Teams and SharePoint site refusals', () => {
  for (const refusal of refusals) {
    it.effect(`refuse ${refusal.name} before any write or fault`, () =>
      Effect.promise(async () => {
        const target = await emulator()
        const seed = target.snapshot()

        target.faults.add({ kind: 'status', status: 503 })

        const response = await target.fetch(
          new Request(refusal.url, {
            method: refusal.method,
            headers: {
              accept: 'application/json',
              'content-type': 'application/json',
              authorization: `Bearer ${token}`
            },
            body: refusal.body === undefined ? undefined : JSON.stringify(refusal.body)
          })
        )

        expect(response.status).toBe(400)
        expect(await errorCode(response)).toBe(refusal.code)
        expect(target.snapshot()).toEqual(seed)
        expect(target.faults.list()).toEqual([
          expect.objectContaining({ applied: 0, remaining: undefined })
        ])
      })
    )
  }

  it.effect('keep answering the paging chat after a send to the dedicated send chat', () =>
    Effect.promise(async () => {
      const target = await emulator()
      const { post } = sendExchanges()

      const paging = microsoftTeamsSitesFixtures.find(
        fixture => fixture.caseId === 'microsoft.teams.chat-messages-paging'
      )

      const [firstPage] = paging?.exchanges ?? []

      if (firstPage === undefined) return expect.fail('expected the paging fixture')

      expect(firstPage.request.url.startsWith(pagingChatMessages)).toBe(true)
      expect(post.request.url).toBe(chatMessages)

      await expectRecorded(await send(target, post.request), post)
      // The send never touches the paging chat, so the suite does not depend on case order.
      await expectRecorded(await send(target, firstPage.request), firstPage)
    })
  )

  it.effect('refuse a state snapshot taken before the recordedTeamsSites flag', () =>
    Effect.promise(async () => {
      const target = await emulator()
      const { recordedTeamsSites: _flag, ...older } = target.snapshot()
      const decode = Schema.decodeUnknownOption(MicrosoftEmulatorStateSchema)

      expect(Option.isSome(decode(target.snapshot()))).toBe(true)
      expect(Option.isNone(decode(older))).toBe(true)
    })
  )

  it.effect('refuse every Teams and SharePoint request under the empty profile', () =>
    Effect.promise(async () => {
      const target = await emulator({ seed: { profile: 'empty' } })
      const seed = target.snapshot()

      expect(seed.recordedTeamsSites).toBe(false)
      target.faults.add({ kind: 'status', status: 503 })

      for (const fixture of microsoftTeamsSitesFixtures) {
        for (const exchange of fixture.exchanges) {
          const response = await send(target, exchange.request)

          expect(response.status, exchange.request.url).toBe(400)
          expect(await errorCode(response)).toBe(notEmulated)
        }
      }

      expect(target.snapshot()).toEqual(seed)
      expect(target.faults.list()).toEqual([expect.objectContaining({ applied: 0 })])
    })
  )

  it.effect('write nothing for a faulted send', () =>
    Effect.promise(async () => {
      const target = await emulator()
      const seed = target.snapshot()
      const { post } = sendExchanges()

      target.faults.add({ kind: 'status', status: 503, match: { method: 'POST' }, count: 1 })

      expect((await send(target, post.request)).status).toBe(503)
      expect(target.snapshot()).toEqual(seed)

      // The fault is used up: the same send now answers the recorded 201 under the first id.
      await expectRecorded(await send(target, post.request), post)
    })
  )

  it.effect('require a bearer and never ledger it', () =>
    Effect.promise(async () => {
      const target = await emulator()
      const { post } = sendExchanges()

      const response = await target.fetch(
        new Request(post.request.url, {
          method: 'POST',
          headers: post.request.headers,
          body: JSON.stringify(post.request.body)
        })
      )

      expect(response.status).toBe(401)
      expect(target.snapshot().chatMessagesSent).toEqual([])

      await send(target, post.request)

      expect(JSON.stringify(target.ledger.entries())).not.toContain(token)
    })
  )
})
