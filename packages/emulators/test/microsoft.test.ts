import { Effect, Layer, Predicate } from 'effect'
import { afterEach, describe, expect, it } from '@effect/vitest'
import { vi } from 'vitest'
import { OAuthCredential } from '@yolk-sdk/connectors'
import {
  connectorHttpClientsFromEffectHttpClientLayer,
  staticCredentialResolverLayer
} from '@yolk-sdk/connectors/conformance'
import {
  OneDriveCopyItemInput,
  OneDriveCopyStatusInput,
  OutlookListMessagesInput,
  microsoftGraphApiBaseUrl,
  oneDriveCopyItemAction,
  oneDriveGetCopyStatusAction,
  outlookListMessagesAction
} from '@yolk-sdk/connectors/microsoft'
import {
  microsoftConformanceCases,
  microsoftConformanceFixtureSeeds,
  microsoftConformanceFixtures,
  microsoftConformanceIntegration,
  microsoftOutlookPagingNextLinkFixture
} from '@yolk-sdk/connectors/microsoft/conformance'
import {
  MicrosoftEmulatorInputInvalid,
  emulatorEvidenceHeader,
  makeMicrosoftEmulator,
  microsoftEmulatorErrorCodes,
  microsoftEmulatorRoutes,
  type MicrosoftEmulator,
  type MicrosoftEmulatorOptions,
  type MicrosoftFault
} from '../src/microsoft.ts'
import { EmulatorRoute, InProcessHttpClient } from '../src/router.ts'

const origin = 'https://graph.microsoft.com'

const sharePoint = 'https://synthetic-my.sharepoint.com'

const token = 'synthetic-unit-test-token'

const now = Date.parse('2026-09-29T10:00:00.000Z')

const seeds = microsoftConformanceFixtureSeeds

const user = `/v1.0/users/${encodeURIComponent('ada@example.test')}`

const drive = `/v1.0/drives/${encodeURIComponent('b!synthetic-drive-0001')}`

const open: Array<MicrosoftEmulator> = []

afterEach(async () => {
  await Promise.all(open.splice(0).map(emulator => emulator.close()))
})

const emulator = async (options: MicrosoftEmulatorOptions = {}): Promise<MicrosoftEmulator> => {
  const created = await makeMicrosoftEmulator({ now: () => now, ...options })

  open.push(created)

  return created
}

type CallOptions = {
  readonly body?: unknown
  readonly rawBody?: string
  readonly authorization?: string | null
  readonly headers?: Record<string, string>
  readonly origin?: string
}

const call = (
  target: MicrosoftEmulator,
  method: string,
  path: string,
  options: CallOptions = {}
): Promise<Response> => {
  const headers = new Headers({ accept: 'application/json', ...options.headers })

  const authorization =
    options.authorization === undefined ? `Bearer ${token}` : options.authorization

  if (authorization !== null) headers.set('authorization', authorization)

  const body =
    options.rawBody ?? (options.body === undefined ? undefined : JSON.stringify(options.body))

  if (body !== undefined) headers.set('content-type', 'application/json')

  return target.fetch(new Request(`${options.origin ?? origin}${path}`, { method, headers, body }))
}

const immutable = { prefer: 'IdType="ImmutableId"' }

const field = (value: unknown, key: string): unknown =>
  Predicate.isObject(value) ? value[key] : undefined

const jsonOf = async (response: Response): Promise<unknown> => response.json()

const errorCode = async (response: Response): Promise<unknown> =>
  field(field(await jsonOf(response), 'error'), 'code')

const values = async (response: Response): Promise<ReadonlyArray<unknown>> => {
  const value = field(await jsonOf(response), 'value')

  return Array.isArray(value) ? value : []
}

const ids = async (response: Response): Promise<ReadonlyArray<unknown>> =>
  (await values(response)).map(item => field(item, 'id'))

const credentialLayer = staticCredentialResolverLayer(
  OAuthCredential.make({
    provider: 'microsoft',
    accessToken: token,
    expiresAt: 4_000_000_000_000,
    accountId: 'ada@example.test'
  })
)

const connectorLayer = (target: MicrosoftEmulator) =>
  Layer.mergeAll(
    connectorHttpClientsFromEffectHttpClientLayer.pipe(
      Layer.provide(
        InProcessHttpClient.layer([
          EmulatorRoute.handler(new URL(microsoftGraphApiBaseUrl).origin, target.fetch),
          EmulatorRoute.handler(target.sharePointOrigin, target.fetch)
        ])
      )
    ),
    credentialLayer
  )

describe('route evidence manifest', () => {
  it('lists every route as an unverified connector route linked to Microsoft cases', () => {
    const caseIds = new Set(microsoftConformanceCases.map(testCase => testCase.id))

    expect(
      microsoftEmulatorRoutes
        .filter(route => route.write)
        .map(route => `${route.method} ${route.path}`)
    ).toEqual([
      'POST /v1.0/users/{userId}/calendars/{calendarId}/events',
      'PATCH /v1.0/users/{userId}/events/{eventId}',
      'DELETE /v1.0/users/{userId}/events/{eventId}',
      'POST /v1.0/users/{userId}/events/{eventId}/cancel',
      'POST /v1.0/users/{userId}/messages',
      'PATCH /v1.0/users/{userId}/messages/{messageId}',
      'POST /v1.0/users/{userId}/messages/{messageId}/move',
      'POST /v1.0/$batch',
      'POST /v1.0/drives/{driveId}/items/{itemId}/children',
      'DELETE /v1.0/drives/{driveId}/items/{itemId}',
      'POST /v1.0/drives/{driveId}/items/{itemId}/copy'
    ])
    expect(microsoftEmulatorRoutes).toHaveLength(19)

    for (const route of microsoftEmulatorRoutes) {
      expect(route).toMatchObject({ kind: 'connector', evidence: 'unverified' })
      expect(route.observedAt).toBeUndefined()
      expect(route.caseIds.length, route.path).toBeGreaterThan(0)
      expect(route.caseIds.every(caseId => caseIds.has(caseId))).toBe(true)
    }

    // Every case is followed by at least one route.
    expect(new Set(microsoftEmulatorRoutes.flatMap(route => route.caseIds))).toEqual(caseIds)
  })

  it.effect('has a handler behind every manifest route', () =>
    Effect.promise(async () => {
      const target = await emulator()

      for (const route of microsoftEmulatorRoutes) {
        const path = route.path
          .replace('{userId}', encodeURIComponent('ada@example.test'))
          .replace('{calendarId}', encodeURIComponent(seeds.calendarId ?? ''))
          .replace('{eventId}', 'missing-event')
          .replace('{folderId}', 'inbox')
          .replace('{messageId}', 'missing-message')
          .replace('{attachmentId}', 'missing-attachment')
          .replace('{driveId}', encodeURIComponent('b!synthetic-drive-0001'))
          .replace('{itemId}', 'missing-item')
          .replace('{site}', 'ada_example_test')
          .replace('{monitorId}', 'missing-monitor')

        await call(target, route.method, path, {
          body: route.method === 'GET' || route.method === 'DELETE' ? undefined : {},
          origin: path.startsWith('/personal/') ? sharePoint : origin
        })
      }

      expect(target.coverage().routes.every(route => route.requests === 1)).toBe(true)
      expect(target.coverage().unknownRouteRequests).toBe(0)
      expect(target.ledger.entries().every(entry => entry.evidence === 'unverified')).toBe(true)
    })
  )
})

describe('fail closed', () => {
  it.effect('answers unknown routes and methods with a 404 Graph envelope and ledgers them', () =>
    Effect.promise(async () => {
      const target = await emulator()

      for (const [method, path] of [
        ['GET', '/v1.0/me/messages'],
        ['GET', `${user}/messages`],
        ['DELETE', `${user}/messages/x`],
        ['PUT', `${user}/events/x`],
        ['GET', '/beta/users/x'],
        ['POST', `${user}/messages/x/permanentDelete`],
        ['GET', `${drive}/root/children`]
      ] as const) {
        const response = await call(target, method, path)
        const body = await jsonOf(response)

        expect(response.status, `${method} ${path}`).toBe(404)
        expect(response.headers.get(emulatorEvidenceHeader)).toBeNull()
        expect(body).toEqual({
          error: {
            code: microsoftEmulatorErrorCodes.unknownRoute,
            message: expect.any(String),
            innerError: {
              date: '2026-09-29T10:00:00',
              'request-id': expect.stringMatching(/^00000000-0000-4000-8000-\d{12}$/),
              'client-request-id': expect.any(String)
            }
          }
        })
      }

      expect(target.ledger.entries().every(entry => entry.evidence === 'unknown-route')).toBe(true)
      expect(target.coverage().unknownRouteRequests).toBe(7)
    })
  )

  it.effect('rejects query keys a route does not emulate before the handler runs', () =>
    Effect.promise(async () => {
      const target = await emulator()
      const before = target.snapshot()

      for (const [method, path, body] of [
        ['GET', `${user}/mailFolders/inbox/messages?$filter=isRead eq false`, undefined],
        ['GET', `${user}/mailFolders/inbox/messages?$orderby=subject`, undefined],
        ['POST', `${user}/messages?unexpected=1`, { subject: 'x' }],
        [
          'PATCH',
          `${user}/messages/${encodeURIComponent('AAMkAGI2-synthetic-message-0101=')}?x=1`,
          { isRead: false }
        ],
        [
          'POST',
          `${drive}/items/01SYNTHETICPARENTFOLDER0000000001/children?x=1`,
          { name: 'n', folder: {} }
        ],
        ['GET', `${user}/events/x?$expand=attachments`, undefined],
        ['POST', `/v1.0/$batch?x=1`, { requests: [] }]
      ] as const) {
        const response = await call(target, method, path, { body })

        expect(response.status, `${method} ${path}`).toBe(400)
        expect(await errorCode(response)).toBe(microsoftEmulatorErrorCodes.unsupportedQuery)
        expect(response.headers.get(emulatorEvidenceHeader)).toBe('unverified')
      }

      expect(target.snapshot()).toEqual(before)
    })
  )

  it.effect('rejects $select fields, bodies, and values it does not emulate', () =>
    Effect.promise(async () => {
      const target = await emulator()
      const before = target.snapshot()
      const messageId = encodeURIComponent('AAMkAGI2-synthetic-message-0001=')

      const rejected: ReadonlyArray<readonly [string, string, unknown, Record<string, string>?]> = [
        // contentId is a fileAttachment property: not selectable on the listing.
        [
          'GET',
          `${user}/messages/${messageId}/attachments?$select=id,contentId`,
          undefined,
          immutable
        ],
        [
          'GET',
          `${user}/mailFolders/inbox/messages?$select=id,internetMessageHeaders`,
          undefined,
          immutable
        ],
        ['GET', `${user}/mailFolders/inbox/messages?$top=0`, undefined, immutable],
        ['GET', `${user}/mailFolders/inbox/messages?$top=abc`, undefined, immutable],
        [
          'GET',
          `${user}/calendars/${encodeURIComponent(seeds.calendarId ?? '')}/calendarView?startDateTime=2026-09-21T00:00:00Z&endDateTime=2026-09-28T00:00:00Z`,
          undefined,
          { prefer: 'outlook.timezone="Pacific Standard Time"' }
        ],
        [
          'POST',
          `${user}/calendars/${encodeURIComponent(seeds.calendarId ?? '')}/events`,
          {
            subject: 'x',
            start: { dateTime: '2026-01-05T09:00:00', timeZone: 'UTC' },
            end: { dateTime: '2026-01-05T09:30:00', timeZone: 'UTC' },
            attendees: [{ emailAddress: { address: 'grace@example.test' } }]
          }
        ],
        [
          'POST',
          `${user}/calendars/${encodeURIComponent(seeds.calendarId ?? '')}/events`,
          {
            subject: 'x',
            start: { dateTime: '2026-01-05T09:00:00', timeZone: 'W. Europe Standard Time' },
            end: { dateTime: '2026-01-05T09:30:00', timeZone: 'UTC' }
          }
        ],
        [
          'POST',
          `${user}/messages`,
          { subject: 'x', from: { emailAddress: { address: 'grace@example.test' } } },
          immutable
        ],
        // Fields no fixture writes: cc/bcc, flags, categories, read state on create.
        ['POST', `${user}/messages`, { subject: 'x', ccRecipients: [] }, immutable],
        ['POST', `${user}/messages`, { subject: 'x', isRead: false }, immutable],
        [
          'PATCH',
          `${user}/messages/${encodeURIComponent('AAMkAGI2-synthetic-message-0101=')}`,
          { flag: { flagStatus: 'flagged' } },
          immutable
        ],
        [
          'PATCH',
          `${user}/messages/${encodeURIComponent('AAMkAGI2-synthetic-message-0101=')}`,
          { categories: ['x'] },
          immutable
        ],
        // No fixture sends an Outlook request without the immutable-id preference.
        ['POST', `${user}/messages`, { subject: 'x' }],
        [
          'PATCH',
          `${user}/messages/${encodeURIComponent('AAMkAGI2-synthetic-message-0101=')}`,
          { isRead: false },
          { prefer: 'outlook.timezone="UTC"' }
        ],
        [
          'POST',
          `${user}/messages/${encodeURIComponent('AAMkAGI2-synthetic-message-0101=')}/move`,
          { destinationId: 'deleteditems' }
        ],
        ['GET', `${user}/mailFolders/inbox/messages`, undefined],
        ['GET', `${user}/messages/${messageId}/attachments`, undefined],
        [
          'GET',
          `${user}/messages/${messageId}/attachments/${encodeURIComponent('AAMkAGI2-synthetic-attachment-0001=')}`,
          undefined
        ],
        // HTML bodies: the fixtures write text bodies only.
        [
          'POST',
          `${user}/messages`,
          { subject: 'x', body: { contentType: 'HTML', content: '<p>x</p>' } },
          immutable
        ],
        // Conditional requests: no fixture sends If-Match.
        [
          'DELETE',
          `${drive}/items/01SYNTHETICEXISTINGFILE000000001`,
          undefined,
          { 'if-match': '"{00000001-0000-4000-8000-000000000000},1"' }
        ],
        [
          'PATCH',
          `${user}/messages/${encodeURIComponent('AAMkAGI2-synthetic-message-0101=')}`,
          { isRead: false },
          { ...immutable, 'if-match': 'W/"CQAAABYAAAAsynthetic0101"' }
        ],
        // Conflict behaviors other than fail (or none), and name conflicts, are not emulated.
        [
          'POST',
          `${drive}/items/01SYNTHETICPARENTFOLDER0000000001/children`,
          { name: 'x', folder: {}, '@microsoft.graph.conflictBehavior': 'replace' }
        ],
        [
          'POST',
          `${drive}/items/01SYNTHETICPARENTFOLDER0000000001/children`,
          { name: 'x', folder: {}, '@microsoft.graph.conflictBehavior': 'rename' }
        ],
        [
          'POST',
          `${drive}/items/01SYNTHETICPARENTFOLDER0000000001/children`,
          { name: 'x', folder: {} }
        ],
        [
          'POST',
          `${drive}/items/01SYNTHETICPARENTFOLDER0000000001/children`,
          {
            name: 'synthetic-existing.txt',
            folder: {},
            '@microsoft.graph.conflictBehavior': 'fail'
          }
        ],
        [
          'POST',
          `${drive}/items/01SYNTHETICPARENTFOLDER0000000001/children`,
          { name: 'file.txt', file: {}, '@microsoft.graph.conflictBehavior': 'fail' }
        ],
        [
          'POST',
          `${drive}/items/01SYNTHETICSOURCEFILE00000000001/copy?@microsoft.graph.conflictBehavior=replace`,
          { parentReference: { id: '01SYNTHETICPARENTFOLDER0000000001' } }
        ],
        [
          'POST',
          `${drive}/items/01SYNTHETICSOURCEFILE00000000001/copy?@microsoft.graph.conflictBehavior=rename`,
          { parentReference: { id: '01SYNTHETICPARENTFOLDER0000000001' } }
        ],
        [
          'POST',
          `${drive}/items/01SYNTHETICSOURCEFILE00000000001/copy`,
          { parentReference: { id: '01SYNTHETICPARENTFOLDER0000000001' } }
        ],
        [
          'POST',
          `${drive}/items/01SYNTHETICSOURCEFILE00000000001/copy?@microsoft.graph.conflictBehavior=fail`,
          { parentReference: { driveId: 'b!other-drive', id: '01SYNTHETICPARENTFOLDER0000000001' } }
        ],
        [
          'POST',
          '/v1.0/$batch',
          { requests: [{ id: '1', method: 'GET', url: `/users/ada%40example.test/messages` }] }
        ],
        [
          'POST',
          '/v1.0/$batch',
          {
            requests: [
              {
                id: '1',
                method: 'POST',
                url: `/users/ada%40example.test/messages/${messageId}/permanentDelete`
              },
              { id: '2', method: 'POST', url: '/users/ada%40example.test/sendMail' }
            ]
          }
        ]
      ]

      for (const [method, path, body, headers] of rejected) {
        const response = await call(target, method, path, { body, headers })

        expect(response.status, `${method} ${path} ${JSON.stringify(body)}`).toBe(400)
      }

      // A refused batch runs none of its subrequests; nothing refused wrote anything.
      expect(target.snapshot()).toEqual(before)
      expect(target.monitors()).toEqual([])

      const invalidJson = await call(target, 'PATCH', `${user}/messages/x`, {
        rawBody: '{not json'
      })

      expect(invalidJson.status).toBe(400)
      expect(await errorCode(invalidJson)).toBe(microsoftEmulatorErrorCodes.invalidBody)
    })
  )

  it.effect('rejects unknown nested body keys with 400 before any write', () =>
    Effect.promise(async () => {
      const target = await emulator()
      const before = target.snapshot()
      const events = `${user}/calendars/${encodeURIComponent(seeds.calendarId ?? '')}/events`

      const event = {
        subject: 'x',
        start: { dateTime: '2026-01-05T09:00:00', timeZone: 'UTC' },
        end: { dateTime: '2026-01-05T09:30:00', timeZone: 'UTC' }
      }

      const rejected: ReadonlyArray<readonly [string, string, unknown, Record<string, string>?]> = [
        [
          'POST',
          `${user}/messages`,
          { subject: 'x', body: { contentType: 'Text', content: 'x', unexpected: 1 } },
          immutable
        ],
        [
          'POST',
          `${user}/messages`,
          { toRecipients: [{ emailAddress: { address: 'grace@example.test' }, type: 'to' }] },
          immutable
        ],
        [
          'POST',
          `${user}/messages`,
          { toRecipients: [{ emailAddress: { address: 'grace@example.test', extra: 'x' } }] },
          immutable
        ],
        [
          'POST',
          `${user}/messages`,
          { from: { emailAddress: { address: 'ada@example.test' }, extra: 'x' } },
          immutable
        ],
        [
          'POST',
          `${user}/messages`,
          { from: { emailAddress: { address: 'ada@example.test', extra: 'x' } } },
          immutable
        ],
        ['POST', events, { ...event, body: { contentType: 'text', content: 'x', unexpected: 1 } }],
        [
          'POST',
          events,
          { ...event, start: { dateTime: '2026-01-05T09:00:00', timeZone: 'UTC', extra: 1 } }
        ],
        [
          'POST',
          `${drive}/items/01SYNTHETICSOURCEFILE00000000001/copy?@microsoft.graph.conflictBehavior=fail`,
          { parentReference: { id: '01SYNTHETICPARENTFOLDER0000000001', path: '/drive/root:' } }
        ],
        [
          'POST',
          `${drive}/items/01SYNTHETICPARENTFOLDER0000000001/children`,
          { name: 'x', folder: { childCount: 0 }, '@microsoft.graph.conflictBehavior': 'fail' }
        ],
        [
          'POST',
          '/v1.0/$batch',
          {
            requests: [
              {
                id: '1',
                method: 'POST',
                url: `/users/ada%40example.test/messages/${encodeURIComponent('AAMkAGI2-synthetic-message-0101=')}/permanentDelete`,
                headers: { Prefer: 'IdType="ImmutableId"', 'x-extra': '1' }
              }
            ]
          }
        ]
      ]

      for (const [method, path, body, headers] of rejected) {
        const response = await call(target, method, path, { body, headers })

        expect(response.status, `${method} ${path} ${JSON.stringify(body)}`).toBe(400)
        expect(response.headers.get(emulatorEvidenceHeader)).toBe('unverified')
      }

      // Nothing was written: not even a counter advanced, and no copy monitor exists.
      expect(target.snapshot()).toEqual(before)
      expect(target.monitors()).toEqual([])
    })
  )

  it.effect('answers 503 after close', () =>
    Effect.promise(async () => {
      const target = await makeMicrosoftEmulator()

      await target.close()
      await target.close()

      expect((await call(target, 'GET', `${user}/mailFolders/inbox/messages`)).status).toBe(503)
    })
  )
})

describe('authorization', () => {
  it.effect('needs a non-empty bearer on Graph routes, never on the monitor, and stores none', () =>
    Effect.promise(async () => {
      const target = await emulator()

      for (const authorization of [null, 'Bearer ', 'Basic abc']) {
        const response = await call(target, 'GET', `${user}/mailFolders/inbox/messages`, {
          authorization
        })

        expect(response.status).toBe(401)
        expect(response.headers.get(emulatorEvidenceHeader)).toBe('unverified')
        expect(await jsonOf(response)).toEqual({
          error: {
            code: 'InvalidAuthenticationToken',
            message: 'Access token is empty.',
            innerError: expect.objectContaining({ date: '2026-09-29T10:00:00' })
          }
        })
      }

      const copied = await call(
        target,
        'POST',
        `${drive}/items/01SYNTHETICSOURCEFILE00000000001/copy?@microsoft.graph.conflictBehavior=fail`,
        {
          body: { parentReference: { id: '01SYNTHETICPARENTFOLDER0000000001' } },
          headers: { 'client-request-id': 'synthetic-client-1' }
        }
      )

      const location = copied.headers.get('location') ?? ''

      expect(copied.status).toBe(202)
      expect(location).toMatch(
        /^https:\/\/synthetic-my\.sharepoint\.com\/personal\/ada_example_test\/_api\/v2\.0\/monitor\/[0-9a-f-]{36}$/
      )

      const monitor = await target.fetch(new Request(location))

      expect(monitor.status).toBe(200)

      const everything = JSON.stringify([
        target.ledger.entries(),
        target.snapshot(),
        await jsonOf(await target.fetch(new Request(`${origin}/_emulate/state`)))
      ])

      expect(everything).not.toContain(token)
      expect(everything.toLowerCase()).not.toContain('bearer')
      expect(everything.toLowerCase()).not.toContain('authorization')
    })
  )
})

describe('calendar', () => {
  const calendarView = (start: string, end: string, extra = '') =>
    `${user}/calendars/${encodeURIComponent(seeds.calendarId ?? '')}/calendarView?startDateTime=${start}&endDateTime=${end}${extra}`

  it.effect('filters by overlap with [start, end) and answers seven-digit UTC times', () =>
    Effect.promise(async () => {
      const target = await emulator()

      const view = (start: string, end: string) =>
        call(target, 'GET', calendarView(start, end), {
          headers: { prefer: 'outlook.timezone="UTC"' }
        }).then(ids)

      // Event 1 is 12:00-13:00 on 2026-09-23; event 2 is 08:30-09:00 on 2026-09-24.
      expect(await view('2026-09-21T00:00:00Z', '2026-09-28T00:00:00Z')).toEqual([
        'AAMkAGI2-synthetic-event-0001=',
        'AAMkAGI2-synthetic-event-0002='
      ])
      expect(await view('2026-09-23T12:30:00Z', '2026-09-23T12:31:00Z')).toEqual([
        'AAMkAGI2-synthetic-event-0001='
      ])
      // Touching ranges do not overlap: the range ends as event 1 starts, or starts as it ends.
      expect(await view('2026-09-23T11:00:00Z', '2026-09-23T12:00:00Z')).toEqual([])
      expect(await view('2026-09-23T13:00:00Z', '2026-09-24T08:30:00Z')).toEqual([])
      expect(await view('2026-09-23T14:00:00%2B02:00', '2026-09-23T14:00:01%2B02:00')).toEqual([
        'AAMkAGI2-synthetic-event-0001='
      ])

      const response = await call(
        target,
        'GET',
        calendarView('2026-09-21T00:00:00Z', '2026-09-28T00:00:00Z', '&$select=id,start&$top=1'),
        {
          headers: { prefer: 'outlook.timezone="UTC"' }
        }
      )

      expect(response.headers.get('preference-applied')).toBe('outlook.timezone="UTC"')

      const body = await jsonOf(response)

      expect(field(body, 'value')).toEqual([
        {
          '@odata.etag': 'W/"DwAAABYAAAAsynthetic0001"',
          id: 'AAMkAGI2-synthetic-event-0001=',
          start: { dateTime: '2026-09-23T12:00:00.0000000', timeZone: 'UTC' }
        }
      ])
      expect(field(body, '@odata.nextLink')).toBe(
        `${origin}${user}/calendars/${encodeURIComponent(seeds.calendarId ?? '')}/calendarView?startDateTime=2026-09-21T00%3A00%3A00Z&endDateTime=2026-09-28T00%3A00%3A00Z&%24select=id%2Cstart&%24top=1&%24skip=1`
      )

      expect(
        (
          await call(
            target,
            'GET',
            `${user}/calendars/${encodeURIComponent(seeds.calendarId ?? '')}/calendarView`
          )
        ).status
      ).toBe(400)
    })
  )

  it.effect('creates, reads, updates, deletes, and cancels events', () =>
    Effect.promise(async () => {
      const target = await emulator()
      const before = target.snapshot()

      const create = (subject: string) =>
        call(
          target,
          'POST',
          `${user}/calendars/${encodeURIComponent(seeds.calendarId ?? '')}/events`,
          {
            body: {
              subject,
              body: { contentType: 'text', content: 'Synthetic.' },
              start: { dateTime: '2026-01-05T09:00:00', timeZone: 'UTC' },
              end: { dateTime: '2026-01-05T09:30:00', timeZone: 'UTC' },
              isReminderOn: false,
              showAs: 'free'
            }
          }
        )

      const created = await create('Synthetic event')
      const event = await jsonOf(created)
      const eventPath = `${user}/events/${encodeURIComponent(String(field(event, 'id')))}`

      expect(created.status).toBe(201)
      expect(event).toMatchObject({
        id: 'AAMkAGI2-synthetic-event-0101=',
        subject: 'Synthetic event',
        start: { dateTime: '2026-01-05T09:00:00.0000000', timeZone: 'UTC' },
        isCancelled: false
      })

      const patched = await call(target, 'PATCH', eventPath, { body: { subject: 'Renamed' } })

      expect(field(await jsonOf(patched), 'subject')).toBe('Renamed')
      expect((await call(target, 'GET', eventPath)).status).toBe(200)
      expect((await call(target, 'DELETE', eventPath)).status).toBe(204)
      expect(await errorCode(await call(target, 'GET', eventPath))).toBe('ErrorItemNotFound')

      const second = await jsonOf(await create('Cancel me'))
      const secondPath = `${user}/events/${encodeURIComponent(String(field(second, 'id')))}`

      const cancelled = await call(target, 'POST', `${secondPath}/cancel`, {
        body: { comment: 'x' }
      })

      expect(cancelled.status).toBe(202)
      expect(await cancelled.text()).toBe('')
      expect((await call(target, 'GET', secondPath)).status).toBe(404)
      expect((await call(target, 'DELETE', secondPath)).status).toBe(404)
      expect(target.snapshot().events).toEqual(before.events)
    })
  )

  it.effect('drill knobs change only what they name', () =>
    Effect.promise(async () => {
      const view = calendarView('2026-09-21T00:00:00Z', '2026-09-28T00:00:00Z')

      const empty = await emulator({ drills: { calendarRangeEmpty: true } })

      expect(await ids(await call(empty, 'GET', view))).toEqual([])

      const coarse = await emulator({ drills: { timestampPrecisionDigits: 3 } })

      expect(
        field(field((await values(await call(coarse, 'GET', view)))[0], 'start'), 'dateTime')
      ).toBe('2026-09-23T12:00:00.000')

      const noId = await emulator({ drills: { createOmitsId: true } })

      const created = await call(
        noId,
        'POST',
        `${user}/calendars/${encodeURIComponent(seeds.calendarId ?? '')}/events`,
        {
          body: {
            subject: 'x',
            start: { dateTime: '2026-01-05T09:00:00', timeZone: 'UTC' },
            end: { dateTime: '2026-01-05T09:30:00', timeZone: 'UTC' }
          }
        }
      )

      const withoutId = await jsonOf(created)

      expect(created.status).toBe(201)
      expect(field(withoutId, 'id')).toBeUndefined()
      expect(field(withoutId, 'subject')).toBe('x')
      // The event is still created: only the answer drops its id.
      expect(noId.snapshot().events).toHaveLength(3)

      await expect(
        makeMicrosoftEmulator({ drills: { timestampPrecisionDigits: 8 } })
      ).rejects.toBeInstanceOf(MicrosoftEmulatorInputInvalid)
    })
  )
})

describe('outlook', () => {
  it.effect('pages a folder with envelopes and an opaque nextLink identical to the fixture', () =>
    Effect.promise(async () => {
      const target = await emulator()
      const [first, second] = microsoftOutlookPagingNextLinkFixture.exchanges

      const bodyOf = (exchange: typeof first): unknown =>
        JSON.parse(
          exchange !== undefined && 'body' in exchange.response
            ? (exchange.response.body ?? '')
            : ''
        )

      const firstUrl = new URL(first?.request.url ?? '')

      const firstPage = await jsonOf(
        await call(target, 'GET', firstUrl.pathname + firstUrl.search, { headers: immutable })
      )

      // The whole envelope: @odata.context, value, and the byte-identical @odata.nextLink.
      expect(firstPage).toEqual(bodyOf(first))

      const nextLink = new URL(String(field(firstPage, '@odata.nextLink')))

      const secondPage = await jsonOf(
        await call(target, 'GET', nextLink.pathname + nextLink.search, { headers: immutable })
      )

      expect(secondPage).toEqual(bodyOf(second))
    })
  )

  it.effect('follows the nextLink through the real connector action on another origin', () =>
    Effect.gen(function* () {
      const target = yield* Effect.promise(() =>
        emulator({ baseUrl: 'https://graph.example.test' })
      )

      const page = yield* outlookListMessagesAction
        .executeTyped({
          integration: microsoftConformanceIntegration,
          input: OutlookListMessagesInput.make({
            mailbox: 'ada@example.test',
            folderId: seeds.pagingFolderId,
            top: 2
          })
        })
        .pipe(Effect.provide(connectorLayer(target)))

      // The connector only replays nextLinks on graph.microsoft.com: the configured origin shows.
      expect(Predicate.isTagged(page, 'Success')).toBe(true)

      if (Predicate.isTagged(page, 'Success')) {
        expect(
          page.value.nextLink?.startsWith(
            'https://graph.example.test/v1.0/users/ada%40example.test/'
          )
        ).toBe(true)
      }
    })
  )

  it.effect(
    'keeps the immutable id across moves; requests without the preference fail closed',
    () =>
      Effect.promise(async () => {
        const target = await emulator()

        const created = await jsonOf(
          await call(target, 'POST', `${user}/messages`, {
            body: {
              subject: 'Draft',
              body: { contentType: 'Text', content: 'x' },
              toRecipients: []
            },
            headers: immutable
          })
        )

        const immutableId = String(field(created, 'id'))
        const path = `${user}/messages/${encodeURIComponent(immutableId)}`

        expect(immutableId).toMatch(/synthetic-immutable-0001=$/)
        expect(field(created, 'isDraft')).toBe(true)

        for (const destinationId of ['deleteditems', 'drafts']) {
          const moved = await jsonOf(
            await call(target, 'POST', `${path}/move`, {
              body: { destinationId },
              headers: immutable
            })
          )

          expect(field(moved, 'id')).toBe(immutableId)
        }

        expect(
          (await call(target, 'PATCH', path, { body: { isRead: false }, headers: immutable }))
            .status
        ).toBe(200)

        // No fixture sends an Outlook request without IdType="ImmutableId": no default ids.
        const plain = await call(target, 'POST', `${path}/move`, {
          body: { destinationId: 'inbox' }
        })

        expect(plain.status).toBe(400)
        expect(await errorCode(plain)).toBe(microsoftEmulatorErrorCodes.unsupportedValue)
        expect(
          target.snapshot().messages.find(message => message.id === immutableId)?.parentFolderId
        ).toBe('AAMkAGI2-synthetic-drafts-folder=')
      })
  )

  it.effect(
    'the first of two overlapping writes wins; the other gets 409 and changes nothing',
    () =>
      Effect.promise(async () => {
        const target = await emulator({ conflictWindowMs: 50 })

        const draft = await jsonOf(
          await call(target, 'POST', `${user}/messages`, {
            body: { subject: 'Draft' },
            headers: immutable
          })
        )

        const path = `${user}/messages/${encodeURIComponent(String(field(draft, 'id')))}`

        const [first, second] = await Promise.all([
          call(target, 'PATCH', path, { body: { subject: 'A' }, headers: immutable }),
          call(target, 'PATCH', path, { body: { subject: 'B' }, headers: immutable })
        ])

        expect(first?.status).toBe(200)
        expect(second?.status).toBe(409)
        expect(await errorCode(second)).toBe('ErrorIrresolvableConflict')
        expect(
          target.snapshot().messages.find(message => message.id === field(draft, 'id'))?.subject
        ).toBe('A')

        // Non-overlapping writes both apply (an emulator extrapolation the immutable-id case's
        // move-then-update sequence needs).
        for (const subject of ['C', 'D']) {
          expect(
            (await call(target, 'PATCH', path, { body: { subject }, headers: immutable })).status
          ).toBe(200)
        }

        expect(
          target.snapshot().messages.find(message => message.id === field(draft, 'id'))?.subject
        ).toBe('D')
      })
  )

  it.effect('lists inline attachments without contentId; retrieval has it', () =>
    Effect.promise(async () => {
      const target = await emulator()
      const messagePath = `${user}/messages/${encodeURIComponent(seeds.attachmentMessageId ?? '')}`

      const listed = await values(
        await call(
          target,
          'GET',
          `${messagePath}/attachments?$select=id,name,contentType,size,isInline,lastModifiedDateTime`,
          {
            headers: immutable
          }
        )
      )

      expect(
        listed.map(item => [field(item, 'id'), field(item, 'isInline'), field(item, 'contentId')])
      ).toEqual([
        ['AAMkAGI2-synthetic-attachment-0001=', true, undefined],
        ['AAMkAGI2-synthetic-attachment-0002=', false, undefined]
      ])

      const inline = await jsonOf(
        await call(
          target,
          'GET',
          `${messagePath}/attachments/${encodeURIComponent('AAMkAGI2-synthetic-attachment-0001=')}`,
          { headers: immutable }
        )
      )

      expect(inline).toMatchObject({
        '@odata.type': '#microsoft.graph.fileAttachment',
        contentId: 'image001.png@01DD2E00.00000000',
        contentBytes: 'iVBORw0KGgo='
      })
      expect(
        (await call(target, 'GET', `${messagePath}/attachments/missing`, { headers: immutable }))
          .status
      ).toBe(404)
    })
  )

  it.effect(
    'permanently deletes through $batch; any subrequest it cannot run refuses the batch',
    () =>
      Effect.promise(async () => {
        const target = await emulator()
        const before = target.snapshot()
        const messageId = encodeURIComponent('AAMkAGI2-synthetic-message-0001=')

        const deleteRequest = (
          id: string,
          headers: unknown = { Prefer: 'IdType="ImmutableId"' }
        ) => ({
          id,
          method: 'POST',
          url: `/users/ada%40example.test/messages/${messageId}/permanentDelete`,
          headers
        })

        // The same message twice, a subrequest without the preference, or none at all: refused.
        for (const requests of [
          [deleteRequest('req-1'), deleteRequest('req-2')],
          [deleteRequest('req-1', {})],
          [
            {
              id: 'req-1',
              method: 'POST',
              url: `/users/ada%40example.test/messages/${messageId}/permanentDelete`
            }
          ]
        ]) {
          const refused = await call(target, 'POST', '/v1.0/$batch', { body: { requests } })

          expect(refused.status, JSON.stringify(requests)).toBe(400)
        }

        expect(target.snapshot()).toEqual(before)

        const response = await call(target, 'POST', '/v1.0/$batch', {
          body: { requests: [deleteRequest('req-1')] }
        })

        expect(response.status).toBe(200)
        expect(await jsonOf(response)).toEqual({
          responses: [{ id: 'req-1', status: 204, headers: {} }]
        })
        expect(target.snapshot().attachments).toEqual([])

        // The message is gone: deleting it again refuses the whole batch (no failed subrequests).
        expect(
          (
            await call(target, 'POST', '/v1.0/$batch', {
              body: { requests: [deleteRequest('req-1')] }
            })
          ).status
        ).toBe(400)
      })
  )

  it.effect('never ledgers a credential sent inside a rejected $batch body', () =>
    Effect.promise(async () => {
      const target = await emulator()
      const before = target.snapshot()
      const secret = 'synthetic-subrequest-secret-token'

      const rejected = await call(target, 'POST', '/v1.0/$batch', {
        body: {
          requests: [
            {
              id: 'req-1',
              method: 'POST',
              url: `/users/ada%40example.test/messages/${encodeURIComponent('AAMkAGI2-synthetic-message-0001=')}/permanentDelete`,
              headers: {
                Prefer: 'IdType="ImmutableId"',
                Authorization: `Bearer ${secret}`,
                Cookie: `session=${secret}`,
                'Proxy-Authorization': `Basic ${secret}`,
                'X-Api-Key': secret
              }
            }
          ]
        }
      })

      expect(rejected.status).toBe(400)
      expect(target.snapshot()).toEqual(before)

      const [entry] = target.ledger.entries()

      expect(entry?.body).toEqual({
        requests: [
          {
            id: 'req-1',
            method: 'POST',
            url: expect.any(String),
            headers: {
              Prefer: 'IdType="ImmutableId"',
              Authorization: '<redacted>',
              Cookie: '<redacted>',
              'Proxy-Authorization': '<redacted>',
              'X-Api-Key': '<redacted>'
            }
          }
        ]
      })

      const recorded = JSON.stringify([
        target.ledger.entries(),
        await jsonOf(await target.fetch(new Request(`${origin}/_emulate/ledger`)))
      ])

      expect(recorded).not.toContain(secret)
      expect(recorded.toLowerCase()).not.toContain('bearer')
    })
  )
})

describe('onedrive', () => {
  it.effect('creates, lists, and deletes folders (then 404); a name conflict fails closed', () =>
    Effect.promise(async () => {
      const target = await emulator()
      const before = target.snapshot()
      const children = `${drive}/items/01SYNTHETICPARENTFOLDER0000000001/children`

      const create = (name: string) =>
        call(target, 'POST', children, {
          body: { name, folder: {}, '@microsoft.graph.conflictBehavior': 'fail' }
        })

      const created = await jsonOf(await create('New folder'))

      expect(created).toMatchObject({
        id: '01SYNTHETICITEM00000000000000001',
        name: 'New folder',
        size: 0,
        webUrl: `${sharePoint}/personal/ada_example_test/Documents/Conformance/New%20folder`,
        parentReference: {
          driveType: 'business',
          driveId: 'b!synthetic-drive-0001',
          id: '01SYNTHETICPARENTFOLDER0000000001',
          path: '/drive/root:/Conformance'
        },
        folder: { childCount: 0 }
      })

      // No fixture records a name conflict: fail closed instead of inventing its answer.
      const conflict = await create('new FOLDER')

      expect(conflict.status).toBe(400)
      expect(await errorCode(conflict)).toBe(microsoftEmulatorErrorCodes.unsupportedValue)
      expect(field(await jsonOf(await create('Other folder')), 'name')).toBe('Other folder')

      expect(await ids(await call(target, 'GET', `${children}?$top=1`))).toEqual([
        '01SYNTHETICITEM00000000000000001'
      ])
      expect(await ids(await call(target, 'GET', children))).toEqual([
        '01SYNTHETICITEM00000000000000001',
        '01SYNTHETICITEM00000000000000002',
        '01SYNTHETICEXISTINGFILE000000001'
      ])

      for (const id of ['01SYNTHETICITEM00000000000000001', '01SYNTHETICITEM00000000000000002']) {
        expect((await call(target, 'DELETE', `${drive}/items/${id}`)).status).toBe(204)
        expect(await errorCode(await call(target, 'GET', `${drive}/items/${id}`))).toBe(
          'itemNotFound'
        )
      }

      expect(target.snapshot().driveItems).toEqual(before.driveItems)
    })
  )

  it.effect('copy: one monitor Location, in progress, then completed with a resourceId', () =>
    Effect.gen(function* () {
      const target = yield* Effect.promise(() => emulator({ copyInProgressPolls: 2 }))
      const layer = connectorLayer(target)

      const accepted = yield* oneDriveCopyItemAction
        .executeTyped({
          integration: microsoftConformanceIntegration,
          input: OneDriveCopyItemInput.make({
            itemId: seeds.copySourceItemId ?? '',
            driveId: seeds.driveId,
            destinationDriveId: seeds.driveId ?? '',
            destinationParentItemId: seeds.driveParentItemId ?? '',
            conflictBehavior: 'fail'
          })
        })
        .pipe(Effect.provide(layer))

      expect(Predicate.isTagged(accepted, 'Success')).toBe(true)

      if (!Predicate.isTagged(accepted, 'Success')) return

      const poll = oneDriveGetCopyStatusAction
        .executeTyped({
          integration: microsoftConformanceIntegration,
          input: OneDriveCopyStatusInput.make({
            monitorUrl: accepted.value.monitorUrl,
            driveId: seeds.driveId
          })
        })
        .pipe(Effect.provide(layer))

      const statuses = []

      for (let attempt = 0; attempt < 4; attempt++) {
        const polled = yield* poll

        statuses.push(
          Predicate.isTagged(polled, 'Success')
            ? [polled.value.status, polled.value.itemId]
            : ['failure']
        )
      }

      const copyId = target
        .snapshot()
        .driveItems.find(
          item => item.name === 'synthetic-notes.txt' && item.parentId === seeds.driveParentItemId
        )?.id

      expect(statuses).toEqual([
        ['inProgress', undefined],
        ['inProgress', undefined],
        ['completed', copyId],
        ['completed', copyId]
      ])
      expect(copyId).toBeDefined()

      // A second copy under the same name cannot run: no fixture records a failed copy, so the
      // monitor fails closed (400) instead of inventing a failed status, and nothing is copied.
      yield* oneDriveCopyItemAction
        .executeTyped({
          integration: microsoftConformanceIntegration,
          input: OneDriveCopyItemInput.make({
            itemId: seeds.copySourceItemId ?? '',
            driveId: seeds.driveId,
            destinationDriveId: seeds.driveId ?? '',
            destinationParentItemId: seeds.driveParentItemId ?? '',
            conflictBehavior: 'fail'
          })
        })
        .pipe(Effect.provide(layer))

      const [, second] = target.monitors()

      expect(second).toMatchObject({ status: 'inProgress', pollsLeft: 2 })

      const location = `${sharePoint}/personal/ada_example_test/_api/v2.0/monitor/${second?.id ?? ''}`
      const itemsBefore = target.snapshot().driveItems

      const secondStatuses = []

      for (let attempt = 0; attempt < 3; attempt++) {
        const response = yield* Effect.promise(() => target.fetch(new Request(location)))

        secondStatuses.push(response.status)
      }

      expect(secondStatuses).toEqual([202, 202, 400])
      expect(target.monitors()[1]).toMatchObject({ status: 'inProgress', pollsLeft: 0 })
      expect(target.snapshot().driveItems).toEqual(itemsBefore)
      expect(
        yield* Effect.promise(() =>
          target
            .fetch(
              new Request(
                `${sharePoint}/personal/someone_else/_api/v2.0/monitor/${second?.id ?? ''}`
              )
            )
            .then(response => response.status)
        )
      ).toBe(404)
    })
  )
})

describe('handler failures', () => {
  it.effect('a route handler that throws answers a tagged 500 Graph envelope, ledgered', () =>
    Effect.promise(async () => {
      // Throws once, on the first clock read after arming: the draft handler's timestamp (the
      // wrapper and the route registration read the clock only to answer an error).
      let armed = false

      const target = await emulator({
        now: () => {
          if (armed) {
            armed = false
            throw new Error('synthetic clock failure')
          }

          return now
        }
      })

      armed = true

      // The core's own error handler (which logs and answers a non-Graph body) is never reached.
      const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined)
      let logged = 0

      const failed = await call(target, 'POST', `${user}/messages`, {
        body: { subject: 'x' },
        headers: immutable
      }).finally(() => {
        logged = consoleError.mock.calls.length
        consoleError.mockRestore()
      })

      expect(armed).toBe(false)
      expect(logged).toBe(0)
      expect(failed.status).toBe(500)
      expect(failed.headers.get(emulatorEvidenceHeader)).toBe('unverified')
      expect(failed.headers.get('x-emulator-handler-failed')).toBeNull()
      expect(await jsonOf(failed)).toEqual({
        error: {
          code: microsoftEmulatorErrorCodes.upstreamError,
          message: expect.any(String),
          innerError: {
            date: '2026-09-29T10:00:00',
            'request-id': '00000000-0000-4000-8000-000000000001',
            'client-request-id': '00000000-0000-4000-8000-000000000001'
          }
        }
      })
      expect(target.ledger.entries()).toEqual([
        expect.objectContaining({
          route: '/v1.0/users/{userId}/messages',
          status: 500,
          evidence: 'unverified',
          responseError: 'the route handler failed'
        })
      ])
      expect(
        (
          await call(target, 'POST', `${user}/messages`, {
            body: { subject: 'x' },
            headers: immutable
          })
        ).status
      ).toBe(201)
    })
  )
})

// Values the emulator generates itself, so they cannot equal a synthetic fixture's: version
// tags (change keys, etags), the ids Graph mints for a new draft (conversation and internet
// message ids), and the `innerError` request ids and dates (the emulator ledger and clock).
// Everything else in a fixture body must match exactly, after the ids the emulator minted for
// created entities replace the fixture's.
const dynamicKeys: ReadonlySet<string> = new Set([
  '@odata.etag',
  'changeKey',
  'eTag',
  'cTag',
  'conversationId',
  'internetMessageId',
  'date',
  'request-id',
  'client-request-id'
])

const normalized = (value: unknown): unknown =>
  Array.isArray(value)
    ? value.map(normalized)
    : Predicate.isObject(value)
      ? Object.fromEntries(
          Object.entries(value).map(([key, entry]) => [
            key,
            dynamicKeys.has(key) ? '<dynamic>' : normalized(entry)
          ])
        )
      : value

const substituted = (text: string, ids: ReadonlyMap<string, string>): string => {
  let result = text

  for (const [from, to] of ids) {
    result = result
      .split(from)
      .join(to)
      .split(encodeURIComponent(from))
      .join(encodeURIComponent(to))
  }

  return result
}

describe('fixture envelopes', () => {
  // Replays every Microsoft fixture's requests, in order, against a fresh emulator and compares
  // each complete response (status, recorded headers, and the whole JSON body including
  // `@odata.context`) with the fixture. The two concurrent PATCHes (the second recorded as 409)
  // are sent together.
  for (const fixture of microsoftConformanceFixtures) {
    it.effect(fixture.id, () =>
      Effect.promise(async () => {
        const target = await emulator({ conflictWindowMs: 200 })
        const ids = new Map<string, string>()
        const exchanges = fixture.exchanges

        const send = (exchange: (typeof exchanges)[number]) => {
          const url = new URL(substituted(exchange.request.url, ids))
          const headers = new Headers(exchange.request.headers)

          if (url.origin === origin) headers.set('authorization', `Bearer ${token}`)

          const body = exchange.request.body

          return target.fetch(
            new Request(url, {
              method: exchange.request.method,
              headers,
              body: body === undefined ? undefined : substituted(JSON.stringify(body), ids)
            })
          )
        }

        const compare = async (exchange: (typeof exchanges)[number], response: Response) => {
          const label = `${exchange.request.method} ${exchange.request.url}`
          const expected = exchange.response

          expect(response.status, label).toBe(expected.status)

          const location = expected.headers.location
          const actualLocation = response.headers.get('location')

          if (location !== undefined && actualLocation !== null) {
            // Monitor URLs differ only in the monitor id.
            expect(actualLocation.slice(0, actualLocation.lastIndexOf('/')), label).toBe(
              location.slice(0, location.lastIndexOf('/'))
            )
            ids.set(location, actualLocation)
          }

          for (const [name, value] of Object.entries(expected.headers)) {
            if (name !== 'location')
              expect(response.headers.get(name), `${label} ${name}`).toBe(value)
          }

          const text = await response.text()
          const recorded = 'body' in expected ? (expected.body ?? '') : ''

          if (recorded === '') {
            expect(text, label).toBe('')

            return
          }

          const actual: unknown = JSON.parse(text)
          const original: unknown = JSON.parse(recorded)

          for (const key of ['id', 'resourceId']) {
            const from = field(original, key)
            const to = field(actual, key)

            if (Predicate.isString(from) && Predicate.isString(to) && from !== to) ids.set(from, to)
          }

          expect(normalized(actual), label).toEqual(
            normalized(JSON.parse(substituted(recorded, ids)))
          )
        }

        for (let index = 0; index < exchanges.length; index++) {
          const exchange = exchanges[index]
          const next = exchanges[index + 1]

          if (exchange === undefined) continue

          if (
            next !== undefined &&
            next.response.status === 409 &&
            next.request.method === exchange.request.method &&
            next.request.url === exchange.request.url
          ) {
            const [first, second] = await Promise.all([send(exchange), send(next)])

            await compare(exchange, first)
            await compare(next, second)
            index += 1
          } else {
            await compare(exchange, await send(exchange))
          }
        }
      })
    )
  }
})

describe('faults', () => {
  it.effect('answer matching requests by method and path, with a count, before any write', () =>
    Effect.promise(async () => {
      const target = await emulator()
      const before = target.snapshot()

      target.faults.add({
        kind: 'status',
        status: 503,
        match: { method: 'POST', path: `${user}/*` },
        count: 1
      })

      const faulted = await call(target, 'POST', `${user}/messages`, {
        body: { subject: 'x' },
        headers: immutable
      })

      expect(faulted.status).toBe(503)
      expect(faulted.headers.get(emulatorEvidenceHeader)).toBe('unverified')
      expect(await errorCode(faulted)).toBe(microsoftEmulatorErrorCodes.upstreamError)
      expect(target.snapshot()).toEqual(before)
      expect(
        (
          await call(target, 'POST', `${user}/messages`, {
            body: { subject: 'x' },
            headers: immutable
          })
        ).status
      ).toBe(201)
      expect(target.faults.list()).toEqual([expect.objectContaining({ remaining: 0, applied: 1 })])
      expect(target.ledger.entries().map(entry => entry.fault)).toEqual(['status', undefined])
    })
  )

  it.effect('rejects bodiless, redirecting, and framing faults (JS API and control plane)', () =>
    Effect.promise(async () => {
      const target = await emulator()
      const kept = target.faults.add({ kind: 'status', status: 503, count: 2 })

      const invalid: ReadonlyArray<MicrosoftFault> = [
        { kind: 'status', status: 204 },
        { kind: 'status', status: 205 },
        { kind: 'status', status: 101 },
        { kind: 'status', status: 304 },
        { kind: 'status', status: 302, headers: { location: 'https://example.test/' } },
        { kind: 'status', status: 500, headers: { Location: 'https://example.test/' } },
        { kind: 'status', status: 500, headers: { 'content-length': '1' } },
        { kind: 'status', status: 500, headers: { 'bad name': 'x' } }
      ]

      const control = (body: unknown) =>
        target.fetch(
          new Request(`${origin}/_emulate/faults`, { method: 'POST', body: JSON.stringify(body) })
        )

      for (const fault of invalid) {
        expect(() => target.faults.add(fault), JSON.stringify(fault)).toThrow(
          MicrosoftEmulatorInputInvalid
        )
        expect((await control(fault)).status, JSON.stringify(fault)).toBe(400)
      }

      expect(target.faults.list()).toEqual([kept])
    })
  )

  it.effect('a fault response that cannot be built answers a tagged 500 and is not consumed', () =>
    Effect.promise(async () => {
      const target = await emulator()

      target.faults.add({ kind: 'status', status: 503, count: 1 })

      const RealResponse = globalThis.Response

      class UnbuildableResponse extends RealResponse {
        constructor(bodyInit?: BodyInit | null, init?: ResponseInit) {
          if (init?.status === 503) {
            throw new TypeError('synthetic: cannot build a 503 response')
          }

          super(bodyInit, init)
        }
      }

      vi.stubGlobal('Response', UnbuildableResponse)

      const failed = await call(target, 'GET', `${user}/mailFolders/inbox/messages`).finally(() =>
        vi.unstubAllGlobals()
      )

      expect(failed.status).toBe(500)
      expect(failed.headers.get(emulatorEvidenceHeader)).toBe('unverified')
      expect(await errorCode(failed)).toBe(microsoftEmulatorErrorCodes.upstreamError)
      expect(target.ledger.entries()).toEqual([
        expect.objectContaining({
          status: 500,
          evidence: 'unverified',
          responseError: expect.any(String)
        })
      ])
      expect(target.faults.list()[0]).toMatchObject({ remaining: 1, applied: 0 })
      expect((await call(target, 'GET', `${user}/mailFolders/inbox/messages`)).status).toBe(503)
    })
  )

  it.effect('a 429 with retry-after reaches the connector as microsoft_rate_limited', () =>
    Effect.gen(function* () {
      const target = yield* Effect.promise(() => emulator())

      target.faults.add({
        kind: 'status',
        status: 429,
        headers: { 'retry-after': '2' },
        match: { path: `${user}/mailFolders/*` }
      })

      const result = yield* outlookListMessagesAction
        .executeTyped({
          integration: microsoftConformanceIntegration,
          input: OutlookListMessagesInput.make({ mailbox: 'ada@example.test', folderId: 'inbox' })
        })
        .pipe(Effect.provide(connectorLayer(target)))

      expect(Predicate.isTagged(result, 'Failure')).toBe(true)

      if (Predicate.isTagged(result, 'Failure')) {
        expect(result.error).toMatchObject({
          code: 'microsoft_rate_limited',
          status: 429,
          retryAfterMs: 2000
        })
      }
    })
  )
})

describe('seeds and the control plane', () => {
  it.effect('default seed carries the conformance seed identities', () =>
    Effect.promise(async () => {
      const state = (await emulator()).snapshot()

      expect(state.user.mail).toBe(seeds.mailbox)
      expect(state.calendars.map(calendar => calendar.id)).toContain(seeds.calendarId)
      expect(state.events.find(event => event.id === seeds.calendarEventId)?.start).toBe(
        '2026-09-23T12:00:00.0000000'
      )
      expect(state.messages.map(message => message.id)).toContain(seeds.attachmentMessageId)
      expect(
        state.messages.filter(message => message.parentFolderId === seeds.pagingFolderId)
      ).toHaveLength(3)
      expect(state.drive.id).toBe(seeds.driveId)
      expect(state.driveItems.map(item => item.id)).toEqual(
        expect.arrayContaining([seeds.driveParentItemId, seeds.copySourceItemId])
      )
    })
  )

  it.effect('rejects invalid seeds and options', () =>
    Effect.promise(async () => {
      for (const options of [
        { seed: { messages: [{ id: 'm', parentFolderId: 'missing', subject: 'x' }] } },
        {
          seed: {
            events: [
              {
                id: 'e',
                calendarId: 'AAMkAGI2-synthetic-calendar-0001=',
                subject: 'x',
                start: '2026-09-23T13:00:00Z',
                end: '2026-09-23T12:00:00Z'
              }
            ]
          }
        },
        { seed: { driveItems: [] } },
        { seed: { mailFolders: [] } },
        { baseUrl: 'https://graph.microsoft.com/v1.0' },
        { sharePointOrigin: 'ftp://example.test' },
        { copyInProgressPolls: -1 },
        { conflictWindowMs: 1.5 }
      ] satisfies ReadonlyArray<MicrosoftEmulatorOptions>) {
        await expect(
          makeMicrosoftEmulator(options),
          JSON.stringify(options)
        ).rejects.toBeInstanceOf(MicrosoftEmulatorInputInvalid)
      }

      const target = await emulator()

      await expect(
        target.seed({ attachments: [{ id: 'a', messageId: 'missing', name: 'x' }] })
      ).rejects.toBeInstanceOf(MicrosoftEmulatorInputInvalid)
    })
  )

  it.effect('reset restores the seed and clears the ledger, faults, and monitors', () =>
    Effect.promise(async () => {
      const target = await emulator()
      const seeded = target.snapshot()

      await call(target, 'POST', `${user}/messages`, {
        body: { subject: 'x' },
        headers: immutable
      })
      await call(
        target,
        'POST',
        `${drive}/items/01SYNTHETICSOURCEFILE00000000001/copy?@microsoft.graph.conflictBehavior=fail`,
        { body: { parentReference: { id: '01SYNTHETICPARENTFOLDER0000000001' } } }
      )
      target.faults.add({ kind: 'status', status: 503 })

      expect(target.snapshot()).not.toEqual(seeded)
      expect(target.monitors()).toHaveLength(1)

      await target.reset()

      expect(target.snapshot()).toEqual(seeded)
      expect(target.ledger.entries()).toEqual([])
      expect(target.faults.list()).toEqual([])
      expect(target.monitors()).toEqual([])

      await target.seed({ profile: 'empty' })
      await target.reset()

      expect(target.snapshot().messages).toEqual([])
    })
  )

  it.effect('serves ledger, faults, reset, state, seed, and coverage under /_emulate', () =>
    Effect.promise(async () => {
      const target = await emulator()

      const control = (method: string, path: string, body?: unknown) =>
        target.fetch(
          new Request(`${origin}/_emulate/${path}`, {
            method,
            body: body === undefined ? undefined : JSON.stringify(body)
          })
        )

      expect(
        (await control('POST', 'faults', { faults: [{ kind: 'status', status: 429, count: 1 }] }))
          .status
      ).toBe(201)
      expect((await call(target, 'GET', `${user}/mailFolders/inbox/messages`)).status).toBe(429)
      expect(field(await jsonOf(await control('GET', 'ledger')), 'entries')).toEqual([
        expect.objectContaining({ method: 'GET', status: 429, fault: 'status' })
      ])
      expect(await jsonOf(await control('GET', 'coverage'))).toMatchObject({
        unknownRouteRequests: 0
      })
      expect(await jsonOf(await control('DELETE', 'ledger'))).toEqual({ cleared: 1 })
      expect(await jsonOf(await control('DELETE', 'faults'))).toEqual({ cleared: 1 })
      expect(
        (await control('POST', 'faults', { kind: 'status', status: 429, extra: 1 })).status
      ).toBe(400)
      expect(await jsonOf(await control('POST', 'seed', { profile: 'empty' }))).toEqual({
        seeded: true,
        messages: 0,
        events: 0,
        driveItems: 1
      })
      expect(
        field(field(await jsonOf(await control('GET', 'state')), 'state'), 'messages')
      ).toEqual([])
      expect((await control('POST', 'seed', { profile: 'nope' })).status).toBe(400)
      expect(await jsonOf(await control('POST', 'reset'))).toEqual({ reset: true })
      expect((await control('GET', 'reset')).status).toBe(405)
      expect((await control('GET', 'nope')).status).toBe(404)
    })
  )
})
