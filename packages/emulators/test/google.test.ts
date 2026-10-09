import { Effect, Layer, Predicate } from 'effect'
import { afterEach, describe, expect, it } from '@effect/vitest'
import { BearerTokenCredential } from '@yolk-sdk/connectors'
import {
  connectorHttpClientsFromEffectHttpClientLayer,
  staticCredentialResolverLayer
} from '@yolk-sdk/connectors/conformance'
import {
  GoogleDriveCreateFolderInput,
  googleDriveCreateFolderAction,
  googleDriveFileFields
} from '@yolk-sdk/connectors/google'
import {
  googleConformanceCases,
  googleConformanceFixtures,
  googleConformanceFixtureSeeds,
  googleConformanceIntegration,
  gmailAttachmentFixture
} from '@yolk-sdk/connectors/google/conformance'
import type { WireExchange, WireFixture } from '@yolk-sdk/conformance/fixture'
import {
  emulatorEvidenceHeader,
  GoogleEmulatorInputInvalid,
  googleEmulatorApisOrigin,
  googleEmulatorGmailOrigin,
  googleEmulatorRoutes,
  makeGoogleEmulator,
  type GoogleEmulator,
  type GoogleEmulatorOptions
} from '../src/google.ts'
import { EmulatorRoute, InProcessHttpClient } from '../src/router.ts'

const gmailOrigin = googleEmulatorGmailOrigin

const apisOrigin = googleEmulatorApisOrigin

const gm = `${gmailOrigin}/gmail/v1/users/me`

const cal = `${apisOrigin}/calendar/v3/calendars/practice-calendar%40example.test/events`

const drv = `${apisOrigin}/drive/v3/files`

const fileQuery = new URLSearchParams({
  supportsAllDrives: 'true',
  fields: googleDriveFileFields
}).toString()

const listQuery = (parent: string, pageSize: number, pageToken?: string) => {
  const params = new URLSearchParams()

  params.set('pageSize', String(pageSize))

  if (pageToken !== undefined) params.set('pageToken', pageToken)

  params.set('q', `'${parent}' in parents and trashed = false`)
  params.set('spaces', 'drive')
  params.set('supportsAllDrives', 'true')
  params.set('includeItemsFromAllDrives', 'true')
  params.set('corpora', 'user')
  params.set('fields', `kind,nextPageToken,incompleteSearch,files(${googleDriveFileFields})`)

  return params
}

const practiceFolder = 'synthetic-practice-folder-0001'

const workMessage = '18f00000000000b1'

const token = 'ya29.SyntheticUnitToken0001'

const now = Date.parse('2026-09-30T12:00:00.000Z')

const open: Array<GoogleEmulator> = []

afterEach(async () => {
  await Promise.all(open.splice(0).map(target => target.close()))
})

const emulator = async (options: GoogleEmulatorOptions = {}): Promise<GoogleEmulator> => {
  const created = await makeGoogleEmulator({ now: () => now, ...options })

  open.push(created)

  return created
}

type CallOptions = {
  readonly authorization?: string | null
  readonly headers?: Record<string, string>
  readonly body?: unknown
  readonly rawBody?: string
}

const call = (
  target: GoogleEmulator,
  method: string,
  url: string,
  options: CallOptions = {}
): Promise<Response> => {
  const headers = new Headers(options.headers)

  const authorization =
    options.authorization === undefined ? `Bearer ${token}` : options.authorization

  if (authorization !== null) headers.set('authorization', authorization)

  const body =
    options.rawBody ?? (options.body === undefined ? undefined : JSON.stringify(options.body))

  if (options.body !== undefined && !headers.has('content-type')) {
    headers.set('content-type', 'application/json')
  }

  return target.fetch(new Request(url, { method, headers, body }))
}

const json = { 'content-type': 'application/json' }

const accept = { accept: 'application/json' }

const driveWrite = { ...accept, ...json }

const readWork = (target: GoogleEmulator) =>
  call(target, 'GET', `${gm}/messages/${workMessage}?format=minimal`)

const notEmulatedBody = (reason?: string) => ({
  error: {
    type: 'not_emulated',
    message:
      reason === undefined ? expect.stringMatching(/^Not emulated: /) : `Not emulated: ${reason}`
  }
})

const expectNotEmulated = async (response: Response, label = '', reason?: string) => {
  const text = await response.text()

  expect(response.status, label).toBe(400)
  expect(JSON.parse(text), label).toEqual(notEmulatedBody(reason))

  return text
}

/**
 * Refused with a ledgered 400 not-emulated, writing nothing, and leaving a genuinely matching
 * match-all fault unused: the next valid request still gets it. Returns the response text.
 */
const expectRefusedWithoutFault = async (
  target: GoogleEmulator,
  run: () => Promise<Response>,
  label = '',
  reason?: string
): Promise<string> => {
  const before = target.snapshot()

  target.faults.clear()
  target.faults.add({ kind: 'status', status: 503, count: 1 })

  const text = await expectNotEmulated(await run(), label, reason)

  expect(target.snapshot(), label).toEqual(before)
  expect(target.faults.list()[0], label).toMatchObject({ applied: 0, remaining: 1 })
  expect(target.ledger.entries().at(-1)?.notEmulated, label).toBeDefined()
  expect((await readWork(target)).status, label).toBe(503)

  target.faults.clear()

  return text
}

const controlPlaneText = (target: GoogleEmulator) =>
  Promise.all(
    ['ledger', 'state', 'coverage', 'faults'].map(route =>
      target
        .fetch(new Request(`${gmailOrigin}/_emulate/${route}`))
        .then(response => response.text())
    )
  )

const field = (value: unknown, key: string): unknown =>
  Predicate.isObject(value) ? value[key] : undefined

const connectorLayer = (target: GoogleEmulator) =>
  Layer.mergeAll(
    connectorHttpClientsFromEffectHttpClientLayer.pipe(
      Layer.provide(
        InProcessHttpClient.layer([
          EmulatorRoute.handler(gmailOrigin, target.fetch),
          EmulatorRoute.handler(apisOrigin, target.fetch)
        ])
      )
    ),
    staticCredentialResolverLayer(BearerTokenCredential.make({ token }))
  )

describe('route evidence manifest', () => {
  it('lists every route as an unverified connector route linked to Google cases', () => {
    const caseIds = new Set(googleConformanceCases.map(testCase => testCase.id))

    expect(googleEmulatorRoutes.map(route => `${route.method} ${route.path}`)).toEqual([
      'GET /gmail/v1/users/me/messages',
      'GET /gmail/v1/users/me/threads',
      'GET /gmail/v1/users/me/messages/{messageId}',
      'GET /gmail/v1/users/me/messages/{messageId}/attachments/{attachmentId}',
      'POST /gmail/v1/users/me/messages/{messageId}/modify',
      'POST /gmail/v1/users/me/messages/{messageId}/trash',
      'POST /gmail/v1/users/me/messages/{messageId}/untrash',
      'POST /gmail/v1/users/me/labels',
      'GET /gmail/v1/users/me/labels/{labelId}',
      'DELETE /gmail/v1/users/me/labels/{labelId}',
      'POST /gmail/v1/users/me/drafts',
      'PUT /gmail/v1/users/me/drafts/{draftId}',
      'DELETE /gmail/v1/users/me/drafts/{draftId}',
      'GET /gmail/v1/users/me/threads/{threadId}',
      'POST /upload/gmail/v1/users/me/messages/send',
      'GET /calendar/v3/calendars/{calendarId}/events',
      'POST /calendar/v3/calendars/{calendarId}/events',
      'GET /calendar/v3/calendars/{calendarId}/events/{eventId}',
      'PATCH /calendar/v3/calendars/{calendarId}/events/{eventId}',
      'DELETE /calendar/v3/calendars/{calendarId}/events/{eventId}',
      'GET /drive/v3/files',
      'POST /drive/v3/files',
      'GET /drive/v3/files/{fileId}',
      'PATCH /drive/v3/files/{fileId}',
      'DELETE /drive/v3/files/{fileId}'
    ])
    expect(googleEmulatorRoutes.filter(route => route.write)).toHaveLength(15)

    for (const route of googleEmulatorRoutes) {
      expect(route).toMatchObject({ kind: 'connector', evidence: 'unverified' })
      expect(route.observedAt).toBeUndefined()
      expect(route.caseIds.length, route.path).toBeGreaterThan(0)
      expect(route.caseIds.every(caseId => caseIds.has(caseId))).toBe(true)
      expect(Object.keys(route).sort()).toEqual([
        'caseIds',
        'evidence',
        'kind',
        'method',
        'path',
        'write'
      ])
    }

    // Every case is followed by at least one route.
    expect(new Set(googleEmulatorRoutes.flatMap(route => route.caseIds))).toEqual(caseIds)
  })
})

describe('fixture data copies', () => {
  it('the default seed holds every fixture seed', async () => {
    const state = (await emulator()).snapshot()
    const seeds = googleConformanceFixtureSeeds

    expect(state.practiceAddress).toBe(seeds.practiceAddress)
    expect(state.impliedLabelIds).toEqual([seeds.pagingLabelId])
    expect(state.messages.map(message => message.id)).toEqual([
      seeds.attachmentMessageId,
      seeds.workMessageId
    ])
    expect(state.calendars.map(calendar => calendar.id)).toEqual([seeds.calendarId])
    expect(state.impliedFolderIds).toEqual([seeds.driveFolderId])
    expect(state.files[0]?.id).toBe(seeds.driveFileId)
    expect(state.labels).toEqual([])
    expect(state.drafts).toEqual([])
  })

  it('the attachment data equals the fixture answer', async () => {
    const recorded = gmailAttachmentFixture.exchanges[1]?.response
    const body = recorded !== undefined && 'body' in recorded ? (recorded.body ?? '') : ''

    expect((await emulator()).snapshot().attachments).toEqual([
      {
        messageId: '18f00000000000a1',
        attachmentId: 'ANGjdJ_synthetic_attachment_0001',
        ...JSON.parse(body)
      }
    ])
  })
})

// The clock each recorded write implies (the fixture timestamps); every other request reads
// the default instant.
const fixtureClock = new Map([
  [
    'google.calendar.event-lifecycle.synthetic',
    new Map([
      [2, '2026-09-30T12:00:03.000Z'],
      [4, '2026-09-30T12:00:05.000Z']
    ])
  ],
  ['google.calendar.deleted-event-gone.synthetic', new Map([[1, '2026-09-30T12:00:05.000Z']])],
  ['google.drive.folder-trash-delete.synthetic', new Map([[1, '2026-09-30T12:00:02.000Z']])]
])

const recordedRequest = (exchange: WireExchange, ids: ReadonlyMap<string, string>): Request => {
  const headers = new Headers(exchange.request.headers ?? {})

  headers.set('authorization', `Bearer ${token}`)

  const body = exchange.request.body

  let url = exchange.request.url

  for (const [from, to] of ids) url = url.split(from).join(to)

  return new Request(url, {
    method: exchange.request.method,
    headers,
    body: body === undefined ? undefined : Predicate.isString(body) ? body : JSON.stringify(body)
  })
}

/**
 * The minted event fields (`id` and the `htmlLink` and `iCalUID` derived from it) of an event
 * answer, at their exact paths, put back to the fixture's values: the only substitution.
 */
const withFixtureEventIds = (text: string, ids: ReadonlyMap<string, string>): string => {
  if (ids.size === 0 || text === '') return text

  const parsed: unknown = JSON.parse(text)

  if (!Predicate.isObject(parsed) || parsed.kind !== 'calendar#event') return text

  const minted = new Set(['id', 'htmlLink', 'iCalUID'])

  const restore = (value: string) =>
    [...ids].reduce((text, [from, to]) => text.split(to).join(from), value)

  return JSON.stringify(
    Object.fromEntries(
      Object.entries(parsed).map(([key, value]) => [
        key,
        minted.has(key) && Predicate.isString(value) ? restore(value) : value
      ])
    )
  )
}

/** Replay one fixture; answers the labels of the exchanges whose response differed. */
const replay = async (
  target: GoogleEmulator,
  clock: { at: number },
  fixture: WireFixture,
  substitute: boolean
): Promise<ReadonlyArray<string>> => {
  const ids = new Map<string, string>()
  const mismatches: Array<string> = []

  for (const [index, exchange] of fixture.exchanges.entries()) {
    clock.at = Date.parse(fixtureClock.get(fixture.id)?.get(index) ?? '2026-09-30T12:00:00.000Z')

    const response = await target.fetch(recordedRequest(exchange, ids))
    const text = await response.text()
    const expected = exchange.response
    const recorded = 'body' in expected ? (expected.body ?? '') : ''

    // Learned once, from the create answer: the event id this emulator minted.
    if (
      substitute &&
      exchange.request.method === 'POST' &&
      recorded !== '' &&
      field(JSON.parse(recorded), 'kind') === 'calendar#event'
    ) {
      const from = field(JSON.parse(recorded), 'id')
      const to = field(JSON.parse(text), 'id')

      if (Predicate.isString(from) && Predicate.isString(to) && from !== to) ids.set(from, to)
    }

    const same =
      response.status === expected.status &&
      response.headers.get('content-type') === (expected.headers['content-type'] ?? null) &&
      response.headers.get(emulatorEvidenceHeader) === 'unverified' &&
      (substitute ? withFixtureEventIds(text, ids) : text) === recorded

    if (!same)
      mismatches.push(`${fixture.id} #${index} ${exchange.request.method} ${response.status}`)
  }

  return mismatches
}

describe('drift: every fixture exchange answered as recorded', () => {
  // Every fixture, in suite order, on ONE emulator: each complete response (status, content type,
  // evidence header, and body) equals the fixture byte for byte, with no substitution at all (the
  // minted ids and page tokens are the fixtures' values on first issuance; the clock is set to the
  // instant each recorded write shows).
  it('replays every fixture in suite order on one emulator byte for byte', async () => {
    const clock = { at: now }
    const target = await emulator({ now: () => clock.at })
    const mismatches: Array<string> = []

    for (const fixture of googleConformanceFixtures) {
      mismatches.push(...(await replay(target, clock, fixture, false)))
    }

    expect(mismatches).toEqual([])
    expect(target.ledger.entries().every(entry => entry.notEmulated === undefined)).toBe(true)
    expect(target.ledger.entries()).toHaveLength(
      googleConformanceFixtures.reduce((total, fixture) => total + fixture.exchanges.length, 0)
    )
  })

  // Each fixture alone on a fresh emulator: byte for byte too, substituting only the minted event
  // id (and the `htmlLink` / `iCalUID` derived from it) at exact field paths, since a fresh
  // emulator mints `syntheticconformance0001` where the second event fixture records `0002`.
  for (const fixture of googleConformanceFixtures) {
    it(`${fixture.id} alone`, async () => {
      const clock = { at: now }
      const target = await emulator({ now: () => clock.at })

      expect(await replay(target, clock, fixture, true)).toEqual([])
    })
  }

  it('a drill that changes an answer fails the comparison', async () => {
    const clock = { at: now }
    const target = await emulator({ now: () => clock.at, drills: { notFoundWithoutMessage: true } })
    const mismatches: Array<string> = []

    for (const fixture of googleConformanceFixtures) {
      mismatches.push(...(await replay(target, clock, fixture, false)))
    }

    // The not-found fixture, the label read after its delete, and the draft case's three 404s.
    expect(mismatches).toHaveLength(5)
  })
})

describe('request-shape latitude', () => {
  it('accepts query parameters in any order, content-type parameters, extra headers, and sizes', async () => {
    const target = await emulator()

    const page = await call(target, 'GET', `${gm}/messages?maxResults=1&labelIds=Label_9001`, {
      headers: { 'x-extra': 'synthetic' }
    })

    expect(page.status).toBe(200)
    expect(await page.json()).toEqual({
      messages: [{ id: '18f00000000000c1', threadId: '18f00000000000c1' }],
      nextPageToken: 'synthetic-gmail-page-2',
      resultSizeEstimate: 5
    })

    const files = listQuery(practiceFolder, 1000)
    const reordered = new URLSearchParams([...files.entries()].reverse())

    expect((await call(target, 'GET', `${drv}?${reordered}`, { headers: accept })).status).toBe(200)

    const events = await call(
      target,
      'GET',
      `${cal}?orderBy=startTime&singleEvents=true&maxResults=2500&timeMax=2026-09-03T00:00:00%2B02:00&timeMin=2026-09-02T00:00:00Z`
    )

    expect(events.status).toBe(200)
    expect(field(await events.json(), 'items')).toHaveLength(1)

    const created = await call(target, 'POST', `${gm}/labels`, {
      headers: { 'content-type': 'application/json; charset=utf-8' },
      body: { name: 'yolk-conformance run-3f9a2c7d label' }
    })

    expect(created.status).toBe(200)
    expect(await created.json()).toEqual({
      id: 'Label_9101',
      name: 'yolk-conformance run-3f9a2c7d label',
      messageListVisibility: 'show',
      labelListVisibility: 'labelShow',
      type: 'user'
    })

    // JSON key order.
    const event = await call(target, 'POST', cal, {
      rawBody: JSON.stringify({
        end: { timeZone: 'UTC', dateTime: '2030-01-07T09:30:00Z' },
        start: { timeZone: 'UTC', dateTime: '2030-01-07T09:00:00Z' },
        description: 'Synthetic conformance event without attendees.',
        summary: 'yolk-conformance run-3f9a2c7d event: synthetic conformance event, safe to delete'
      }),
      headers: json
    })

    expect(event.status).toBe(200)
    expect(target.ledger.entries().every(entry => entry.notEmulated === undefined)).toBe(true)
  })

  it('records the practice send in the state only, for any boundary and run id', async () => {
    const target = await emulator()
    const boundary = 'yolk_gmail_send_0123456789abcdef0123456789abcdef'

    const subject =
      'yolk-conformance run-3f9a2c7d1 send: synthetic conformance message, safe to delete'

    const response = await call(
      target,
      'POST',
      `${gmailOrigin}/upload/gmail/v1/users/me/messages/send?uploadType=multipart`,
      {
        headers: { 'content-type': `multipart/related; boundary=${boundary}` },
        rawBody: sendBody(boundary, 'practice@example.test', subject)
      }
    )

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({
      id: '18f00000000000e1',
      threadId: '18f00000000000e1',
      labelIds: ['SENT']
    })

    const sent = target.snapshot().messages.at(-1)

    expect(sent?.labelIds).toEqual(['SENT', 'INBOX', 'UNREAD'])
    expect(sent?.metadataPayload?.headers).toEqual([
      { name: 'MIME-Version', value: '1.0' },
      { name: 'Date', value: 'Wed, 30 Sep 2026 12:00:00 +0000' },
      { name: 'Message-ID', value: '<synthetic-send-0001@example.test>' },
      { name: 'Subject', value: subject },
      { name: 'From', value: 'practice@example.test' },
      { name: 'To', value: 'practice@example.test' },
      { name: 'Content-Type', value: 'text/plain; charset=us-ascii' }
    ])
  })
})

/** The multipart body the connector sends for the practice message. */
const sendBody = (
  boundary: string,
  to: string,
  subject: string,
  extraHeaders: ReadonlyArray<string> = [],
  metadata = '{}'
) =>
  [
    `--${boundary}`,
    'Content-Type: application/json; charset=UTF-8',
    '',
    metadata,
    `--${boundary}`,
    'Content-Type: message/rfc822',
    '',
    [
      `To: ${to}`,
      ...extraHeaders,
      `Subject: ${subject}`,
      'MIME-Version: 1.0',
      'Content-Type: text/plain; charset=us-ascii',
      '',
      'Synthetic conformance message sent to the seeded practice address only. Safe to delete.',
      ''
    ].join('\r\n'),
    `--${boundary}--`
  ].join('\r\n')

const sendUrl = `${gmailOrigin}/upload/gmail/v1/users/me/messages/send?uploadType=multipart`

const sendSubject =
  'yolk-conformance run-synthetic send: synthetic conformance message, safe to delete'

const sendWith = (target: GoogleEmulator, body: string, boundary = 'b0undary', url = sendUrl) =>
  call(target, 'POST', url, {
    headers: { 'content-type': `multipart/related; boundary=${boundary}` },
    rawBody: body
  })

const base64Url = (text: string) => {
  let binary = ''

  for (const byte of new TextEncoder().encode(text)) binary += String.fromCharCode(byte)

  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '')
}

const draftSubject =
  'yolk-conformance run-synthetic draft: synthetic conformance draft, safe to delete'

const draftText = 'Synthetic conformance draft, safe to delete: grüße ✓'

const updatedDraftText = 'Updated synthetic conformance draft: ¡hola! ✓'

/**
 * The quoted-printable text/plain and text/html parts the draft fixture records for its two
 * texts; any other body is put in both parts unencoded (a draft the routes refuse anyway).
 */
const draftParts = (body: string): readonly [string, string] =>
  body === draftText
    ? [
        'Synthetic conformance draft, safe to delete: gr=C3=BC=C3=9Fe =E2=9C=93',
        '<div dir=3D"ltr">Synthetic conformance draft, safe to delete: gr=C3=BC=\r\n=C3=9Fe =E2=9C=93</div>'
      ]
    : body === updatedDraftText
      ? [
          'Updated synthetic conformance draft: =C2=A1hola! =E2=9C=93',
          '<div dir=3D"ltr">Updated synthetic conformance draft: =C2=A1hola! =E2=9C=93=\r\n</div>'
        ]
      : [body, body]

/** The draft MIME the connector writes (the recorded one for the fixture's texts). */
const draftMime = (subject: string, body: string) => {
  const [plain, html] = draftParts(body)

  const part = (type: string, content: string) =>
    `Content-Type: text/${type}; charset=UTF-8\r\nContent-Transfer-Encoding: quoted-printable\r\n\r\n${content}`

  return [
    `Subject: ${subject}`,
    'MIME-Version: 1.0',
    'Content-Type: multipart/alternative; boundary="=_yolk-draft-alternative"',
    '',
    '--=_yolk-draft-alternative',
    part('plain', plain),
    '--=_yolk-draft-alternative',
    part('html', html),
    '--=_yolk-draft-alternative--'
  ].join('\r\n')
}

const draftRaw = (subject: string, body: string, extra = '') =>
  base64Url(`${extra}${draftMime(subject, body)}`)

const runDraftSubject = (runId: string, kind = 'draft') =>
  `yolk-conformance ${runId} ${kind}: synthetic conformance draft, safe to delete`

const sizedRunIdReason = (what: string) =>
  `a ${what} subject whose run id is not 13 characters long (the fixtures' run-synthetic) is not emulated: the recorded sizeEstimate covers the subject`

const eventBody = {
  summary: 'yolk-conformance run-synthetic event: synthetic conformance event, safe to delete',
  description: 'Synthetic conformance event without attendees.',
  start: { dateTime: '2030-01-07T09:00:00Z', timeZone: 'UTC' },
  end: { dateTime: '2030-01-07T09:30:00Z', timeZone: 'UTC' }
}

const folderBody = {
  name: 'yolk-conformance run-synthetic folder',
  mimeType: 'application/vnd.google-apps.folder',
  parents: [practiceFolder]
}

describe('fail closed: 400 not-emulated, nothing written, a matching fault left unused', () => {
  type Row = readonly [string, (target: GoogleEmulator) => Promise<Response>]

  const rows: ReadonlyArray<Row> = [
    // Credentials and headers.
    ['no Authorization header', target => readWorkWith(target, { authorization: null })],
    [
      'X-Goog-Drive-Resource-Keys',
      target =>
        call(target, 'GET', `${drv}/synthetic-practice-file-0001?${fileQuery}`, {
          headers: { ...accept, 'x-goog-drive-resource-keys': 'synthetic-practice-file-0001/k' }
        })
    ],
    // Gmail reads.
    [
      'a format=raw read',
      target => call(target, 'GET', `${gm}/messages/${workMessage}?format=raw`)
    ],
    [
      'a repeated format',
      target => call(target, 'GET', `${gm}/messages/${workMessage}?format=minimal&format=minimal`)
    ],
    [
      'an extra query parameter',
      target => call(target, 'GET', `${gm}/messages/${workMessage}?format=minimal&x=1`)
    ],
    [
      'an unrecorded format',
      target => call(target, 'GET', `${gm}/messages/${workMessage}?format=full`)
    ],
    [
      'an implied message',
      target => call(target, 'GET', `${gm}/messages/18f00000000000c1?format=minimal`)
    ],
    [
      'an absent id other than 16 hex digits',
      target => call(target, 'GET', `${gm}/messages/notahexid?format=minimal`)
    ],
    [
      'a metadata read of an absent id',
      target => call(target, 'GET', `${gm}/messages/ffffffffffffffff?format=metadata`)
    ],
    [
      'an attachment the state does not hold',
      target => call(target, 'GET', `${gm}/messages/${workMessage}/attachments/ANGjdJ_absent`)
    ],
    [
      'a listing with q',
      target => call(target, 'GET', `${gm}/messages?labelIds=Label_9001&maxResults=2&q=x`)
    ],
    [
      'maxResults 0',
      target => call(target, 'GET', `${gm}/messages?labelIds=Label_9001&maxResults=0`)
    ],
    [
      'maxResults 501',
      target => call(target, 'GET', `${gm}/messages?labelIds=Label_9001&maxResults=501`)
    ],
    [
      'an unknown label listing',
      target => call(target, 'GET', `${gm}/messages?labelIds=Label_1&maxResults=2`)
    ],
    [
      'a listing of a system label the state does not hold',
      target => call(target, 'GET', `${gm}/messages?labelIds=INBOX&maxResults=2`)
    ],
    [
      'an unissued page token',
      target =>
        call(
          target,
          'GET',
          `${gm}/messages?labelIds=Label_9001&maxResults=2&pageToken=synthetic-gmail-page-2`
        )
    ],
    // Labels.
    ['a label read of the implied label', target => call(target, 'GET', `${gm}/labels/Label_9001`)],
    ['a label read of another id form', target => call(target, 'GET', `${gm}/labels/INBOX`)],
    ['a delete of the implied label', target => call(target, 'DELETE', `${gm}/labels/Label_9001`)],
    ['a delete of an absent label', target => call(target, 'DELETE', `${gm}/labels/Label_9999`)],
    [
      'another label name',
      target => call(target, 'POST', `${gm}/labels`, { body: { name: 'Work' } })
    ],
    [
      'an extra label key',
      target =>
        call(target, 'POST', `${gm}/labels`, {
          body: { name: 'yolk-conformance run-synthetic label', color: {} }
        })
    ],
    [
      'a text body',
      target =>
        call(target, 'POST', `${gm}/labels`, {
          headers: { 'content-type': 'text/plain' },
          rawBody: '{"name":"yolk-conformance run-synthetic label"}'
        })
    ],
    // Label changes, trash, untrash.
    [
      'a modify removing labels',
      target =>
        call(target, 'POST', `${gm}/messages/${workMessage}/modify`, {
          body: { removeLabelIds: ['INBOX'] }
        })
    ],
    [
      'a modify adding a system label',
      target =>
        call(target, 'POST', `${gm}/messages/${workMessage}/modify`, {
          body: { addLabelIds: ['STARRED'] }
        })
    ],
    [
      'a modify adding the implied label',
      target =>
        call(target, 'POST', `${gm}/messages/${workMessage}/modify`, {
          body: { addLabelIds: ['Label_9001'] }
        })
    ],
    [
      'a trash of an implied message',
      target => call(target, 'POST', `${gm}/messages/18f00000000000c1/trash`)
    ],
    [
      'an untrash outside Trash',
      target => call(target, 'POST', `${gm}/messages/${workMessage}/untrash`)
    ],
    [
      'a trash with a body',
      target => call(target, 'POST', `${gm}/messages/${workMessage}/trash`, { body: {} })
    ],
    // Drafts and threads.
    [
      'a draft with a recipient',
      target =>
        call(target, 'POST', `${gm}/drafts`, {
          body: {
            message: { raw: draftRaw(draftSubject, draftText, 'To: someone@example.test\r\n') }
          }
        })
    ],
    [
      'a draft whose subject has a 12-character run-<8 hex> id',
      target =>
        call(target, 'POST', `${gm}/drafts`, {
          body: { message: { raw: draftRaw(runDraftSubject('run-3f9a2c7d'), draftText) } }
        })
    ],
    [
      'a send whose subject has a 12-character run-<8 hex> id',
      target =>
        sendWith(
          target,
          sendBody(
            'b0undary',
            'practice@example.test',
            'yolk-conformance run-3f9a2c7d send: synthetic conformance message, safe to delete'
          )
        )
    ],
    [
      'a draft with another body',
      target =>
        call(target, 'POST', `${gm}/drafts`, {
          body: { message: { raw: draftRaw(draftSubject, 'Another body') } }
        })
    ],
    [
      'a padded raw',
      target =>
        call(target, 'POST', `${gm}/drafts`, {
          body: { message: { raw: `${draftRaw(draftSubject, draftText)}=` } }
        })
    ],
    [
      'an update of an absent draft',
      target =>
        call(target, 'PUT', `${gm}/drafts/r-8000000000000000009`, {
          body: { id: 'r-8000000000000000009', message: { raw: draftRaw(draftSubject, draftText) } }
        })
    ],
    ['a delete of another draft id form', target => call(target, 'DELETE', `${gm}/drafts/draft1`)],
    [
      'the thread of a seeded message',
      target => call(target, 'GET', `${gm}/threads/${workMessage}?format=full`)
    ],
    [
      'a thread with format=metadata',
      target => call(target, 'GET', `${gm}/threads/${workMessage}?format=metadata`)
    ],
    // The practice send.
    [
      'a send to another address',
      target => sendWith(target, sendBody('b0undary', 'someone@example.test', sendSubject))
    ],
    [
      'a send with a Cc',
      target =>
        sendWith(
          target,
          sendBody('b0undary', 'practice@example.test', sendSubject, ['Cc: someone@example.test'])
        )
    ],
    [
      'a send with two recipients',
      target =>
        sendWith(
          target,
          sendBody('b0undary', 'practice@example.test, someone@example.test', sendSubject)
        )
    ],
    [
      'a send with a threadId',
      target =>
        sendWith(
          target,
          sendBody('b0undary', 'practice@example.test', sendSubject, [], '{"threadId":"18f1"}')
        )
    ],
    [
      'a send with another subject',
      target => sendWith(target, sendBody('b0undary', 'practice@example.test', 'Hello'))
    ],
    [
      'a send body with another boundary',
      target => sendWith(target, sendBody('other', 'practice@example.test', sendSubject))
    ],
    [
      'uploadType=media',
      target =>
        sendWith(
          target,
          sendBody('b0undary', 'practice@example.test', sendSubject),
          'b0undary',
          `${gmailOrigin}/upload/gmail/v1/users/me/messages/send?uploadType=media`
        )
    ],
    [
      'a boundary with an = and more after it',
      target =>
        sendWith(
          target,
          sendBody('b0undary', 'practice@example.test', sendSubject),
          'b0undary=junk'
        )
    ],
    [
      'two boundary parameters',
      target =>
        sendWith(
          target,
          sendBody('b0undary', 'practice@example.test', sendSubject),
          'b0undary; boundary=b0undary'
        )
    ],
    [
      'another media-type parameter next to the boundary',
      target =>
        sendWith(
          target,
          sendBody('b0undary', 'practice@example.test', sendSubject),
          'b0undary; charset=utf-8'
        )
    ],
    [
      'a quoted boundary',
      target =>
        sendWith(target, sendBody('b0undary', 'practice@example.test', sendSubject), '"b0undary"')
    ],
    [
      'a trailing empty parameter',
      target =>
        sendWith(target, sendBody('b0undary', 'practice@example.test', sendSubject), 'b0undary;')
    ],
    [
      'a boundary longer than 70 characters',
      target =>
        sendWith(
          target,
          sendBody('b'.repeat(71), 'practice@example.test', sendSubject),
          'b'.repeat(71)
        )
    ],
    [
      'a send without a boundary',
      target =>
        call(target, 'POST', sendUrl, {
          headers: { 'content-type': 'multipart/related' },
          rawBody: sendBody('b0undary', 'practice@example.test', sendSubject)
        })
    ],
    // Calendar.
    [
      'a listing without singleEvents',
      target =>
        call(
          target,
          'GET',
          `${cal}?timeMin=2026-09-01T00:00:00Z&timeMax=2026-09-08T00:00:00Z&maxResults=2&orderBy=startTime`
        )
    ],
    [
      'singleEvents=false',
      target =>
        call(
          target,
          'GET',
          `${cal}?timeMin=2026-09-01T00:00:00Z&timeMax=2026-09-08T00:00:00Z&maxResults=2&singleEvents=false&orderBy=startTime`
        )
    ],
    [
      'a free-text query (the leftover lookup)',
      target => call(target, 'GET', `${cal}?q=yolk-conformance&maxResults=250`)
    ],
    [
      'a range without events',
      target =>
        call(
          target,
          'GET',
          `${cal}?timeMin=2027-01-01T00:00:00Z&timeMax=2027-01-02T00:00:00Z&maxResults=2&singleEvents=true&orderBy=startTime`
        )
    ],
    [
      'a rollover hour (24:00)',
      target =>
        call(
          target,
          'GET',
          `${cal}?timeMin=2026-09-01T24:00:00Z&timeMax=2026-09-08T00:00:00Z&maxResults=2&singleEvents=true&orderBy=startTime`
        )
    ],
    [
      'an invalid calendar date (February 30)',
      target =>
        call(
          target,
          'GET',
          `${cal}?timeMin=2026-02-30T00:00:00Z&timeMax=2026-09-08T00:00:00Z&maxResults=2&singleEvents=true&orderBy=startTime`
        )
    ],
    [
      'an out-of-range offset hour',
      target =>
        call(
          target,
          'GET',
          `${cal}?timeMin=2026-09-01T00:00:00%2B24:00&timeMax=2026-09-08T00:00:00Z&maxResults=2&singleEvents=true&orderBy=startTime`
        )
    ],
    [
      'timeMin after timeMax',
      target =>
        call(
          target,
          'GET',
          `${cal}?timeMin=2026-09-08T00:00:00Z&timeMax=2026-09-01T00:00:00Z&maxResults=2&singleEvents=true&orderBy=startTime`
        )
    ],
    [
      'an unknown calendar',
      target =>
        call(
          target,
          'GET',
          `${apisOrigin}/calendar/v3/calendars/other%40example.test/events?timeMin=2026-09-01T00:00:00Z&timeMax=2026-09-08T00:00:00Z&maxResults=2&singleEvents=true&orderBy=startTime`
        )
    ],
    [
      'an event with attendees',
      target => call(target, 'POST', cal, { body: { ...eventBody, attendees: [] } })
    ],
    [
      'an event at another time',
      target =>
        call(target, 'POST', cal, {
          body: { ...eventBody, start: { dateTime: '2030-01-08T09:00:00Z', timeZone: 'UTC' } }
        })
    ],
    ['an absent event read', target => call(target, 'GET', `${cal}/syntheticconformance0009`)],
    [
      'a patch of a seeded event',
      target =>
        call(target, 'PATCH', `${cal}/syntheticrange0001`, {
          body: {
            summary:
              'yolk-conformance run-synthetic event renamed: synthetic conformance event, safe to delete',
            description: 'Synthetic conformance event, renamed.'
          }
        })
    ],
    ['a delete of a seeded event', target => call(target, 'DELETE', `${cal}/syntheticrange0001`)],
    [
      'a delete of an absent event',
      target => call(target, 'DELETE', `${cal}/syntheticconformance0009`)
    ],
    // Drive.
    [
      'a listing without accept',
      target => call(target, 'GET', `${drv}?${listQuery(practiceFolder, 2)}`)
    ],
    [
      'a listing including trashed items (the leftover lookup)',
      target => {
        const query = listQuery(practiceFolder, 100)

        query.set('q', `'${practiceFolder}' in parents`)

        return call(target, 'GET', `${drv}?${query}`, { headers: accept })
      }
    ],
    [
      'an empty folder listing',
      target =>
        call(target, 'GET', `${drv}?${listQuery('synthetic-practice-folder-0002', 100)}`, {
          headers: accept
        })
    ],
    [
      'another fields selection',
      target =>
        call(
          target,
          'GET',
          `${drv}/synthetic-practice-file-0001?supportsAllDrives=true&fields=id`,
          {
            headers: accept
          }
        )
    ],
    [
      'a read of the implied folder',
      target => call(target, 'GET', `${drv}/${practiceFolder}?${fileQuery}`, { headers: accept })
    ],
    [
      'a file create',
      target =>
        call(target, 'POST', `${drv}?${fileQuery}`, {
          headers: driveWrite,
          body: { ...folderBody, mimeType: 'text/plain' }
        })
    ],
    [
      'a folder under a file',
      target =>
        call(target, 'POST', `${drv}?${fileQuery}`, {
          headers: driveWrite,
          body: { ...folderBody, parents: ['synthetic-practice-file-0001'] }
        })
    ],
    [
      'a trash of a seeded file',
      target =>
        call(target, 'PATCH', `${drv}/synthetic-practice-file-0001?${fileQuery}`, {
          headers: driveWrite,
          body: { trashed: true }
        })
    ],
    [
      'a delete of a seeded file',
      target =>
        call(target, 'DELETE', `${drv}/synthetic-practice-file-0001?supportsAllDrives=true`, {
          headers: accept
        })
    ],
    // Origins.
    [
      'a Gmail route on the Calendar and Drive origin',
      target =>
        call(
          target,
          'GET',
          `${apisOrigin}/gmail/v1/users/me/messages/${workMessage}?format=minimal`
        )
    ],
    [
      'a Calendar route on the Gmail origin',
      target =>
        call(
          target,
          'GET',
          `${gmailOrigin}/calendar/v3/calendars/practice-calendar%40example.test/events/syntheticrange0001`
        )
    ],
    [
      'the send upload on the Calendar and Drive origin',
      target =>
        sendWith(
          target,
          sendBody('b0undary', 'practice@example.test', sendSubject),
          'b0undary',
          `${apisOrigin}/upload/gmail/v1/users/me/messages/send?uploadType=multipart`
        )
    ],
    [
      'a Drive route on the Gmail origin',
      target =>
        call(
          target,
          'GET',
          `${gmailOrigin}/drive/v3/files/synthetic-practice-file-0001?${fileQuery}`,
          {
            headers: accept
          }
        )
    ]
  ]

  for (const [label, run] of rows) {
    it(label, async () => {
      const target = await emulator()

      await expectRefusedWithoutFault(target, () => run(target), label)
      expect(target.ledger.entries().at(-2)?.route, label).toBeDefined()
    })
  }

  it('refuses writes the state cannot answer as a fixture does', async () => {
    const target = await emulator()
    const label = { name: 'yolk-conformance run-synthetic label' }

    expect((await call(target, 'POST', `${gm}/labels`, { body: label })).status).toBe(200)
    await expectRefusedWithoutFault(
      target,
      () => call(target, 'POST', `${gm}/labels`, { body: label }),
      'a label whose name exists'
    )
    await expectRefusedWithoutFault(
      target,
      () => call(target, 'GET', `${gm}/labels/Label_9101`),
      'a read of an existing label'
    )

    expect(
      (
        await call(target, 'POST', `${gm}/messages/${workMessage}/modify`, {
          body: { addLabelIds: ['Label_9101'] }
        })
      ).status
    ).toBe(200)
    await expectRefusedWithoutFault(
      target,
      () =>
        call(target, 'POST', `${gm}/messages/${workMessage}/modify`, {
          body: { addLabelIds: ['Label_9101'] }
        }),
      'a label the message carries'
    )

    expect((await call(target, 'POST', `${gm}/messages/${workMessage}/trash`)).status).toBe(200)
    await expectRefusedWithoutFault(
      target,
      () => call(target, 'POST', `${gm}/messages/${workMessage}/trash`),
      'a trash in Trash'
    )
    // A listing would leave the trashed work message out: no fixture records that.
    await expectRefusedWithoutFault(
      target,
      () => call(target, 'GET', `${gm}/messages?labelIds=Label_9101&maxResults=2`),
      'a listing with a trashed message'
    )

    const created = await call(target, 'POST', cal, { body: eventBody })
    const eventId = String(field(await created.json(), 'id'))

    expect((await call(target, 'DELETE', `${cal}/${eventId}`)).status).toBe(204)
    await expectRefusedWithoutFault(
      target,
      () =>
        call(target, 'PATCH', `${cal}/${eventId}`, {
          body: {
            summary:
              'yolk-conformance run-synthetic event renamed: synthetic conformance event, safe to delete',
            description: 'Synthetic conformance event, renamed.'
          }
        }),
      'a patch of a cancelled event'
    )
    await expectRefusedWithoutFault(
      target,
      () =>
        call(
          target,
          'GET',
          `${cal}?timeMin=2030-01-01T00:00:00Z&timeMax=2030-02-01T00:00:00Z&maxResults=2&singleEvents=true&orderBy=startTime`
        ),
      'a range holding a cancelled event'
    )

    const folder = await call(target, 'POST', `${drv}?${fileQuery}`, {
      headers: driveWrite,
      body: folderBody
    })

    const folderId = String(field(await folder.json(), 'id'))

    const trash = () =>
      call(target, 'PATCH', `${drv}/${folderId}?${fileQuery}`, {
        headers: driveWrite,
        body: { trashed: true }
      })

    expect((await trash()).status).toBe(200)
    await expectRefusedWithoutFault(target, trash, 'a trash of a trashed folder')
    await expectRefusedWithoutFault(
      target,
      () =>
        call(target, 'POST', `${drv}?${fileQuery}`, {
          headers: driveWrite,
          body: { ...folderBody, parents: [folderId] }
        }),
      'a folder in a trashed folder'
    )
  })

  it('answers 503 after close, unledgered', async () => {
    const target = await makeGoogleEmulator()

    await target.close()

    const response = await readWork(target)

    expect(response.status).toBe(503)
    expect(await response.json()).toEqual({
      error: { message: 'the emulator is closed', type: 'emulator_error' }
    })
  })
})

const readWorkWith = (target: GoogleEmulator, options: CallOptions) =>
  call(target, 'GET', `${gm}/messages/${workMessage}?format=minimal`, options)

const unrecognisedReason = 'no emulated Google route for this method and path'

const unrecognisableReason = 'an unrecognisable Authorization header is not emulated'

/** The constant entry of a request repeating the bearer (before the next valid request). */
const expectConstantEntry = (target: GoogleEmulator, method: string) => {
  expect(target.ledger.entries().at(-2)).toEqual({
    seq: expect.any(Number),
    method,
    path: '/<unrecognised>',
    route: expect.stringMatching(/^\//),
    query: {},
    headers: {},
    status: 400,
    evidence: 'unverified',
    notEmulated: expect.stringMatching(/ repeats the credential$/)
  })
}

/** The constant entry of a body a decoded view refuses (before the next valid request). */
const expectViewRefusalEntry = (
  target: GoogleEmulator,
  method: string,
  route: string,
  reason: string
) => {
  expect(target.ledger.entries().at(-2)).toEqual({
    seq: expect.any(Number),
    method,
    path: '/<unrecognised>',
    route,
    query: {},
    headers: {},
    status: 400,
    evidence: 'unverified',
    notEmulated: reason
  })
}

/** The real response text, the ledger, and every `/_emulate/*` read (state included). */
const everythingSeen = async (target: GoogleEmulator, text: string): Promise<string> =>
  [text, JSON.stringify(target.ledger.entries()), ...(await controlPlaneText(target))].join('\n')

describe('unrecognised requests are ledgered with constant text only', () => {
  it.each([
    ['GET', `${gm}/labels?${token}=1`],
    ['GET', `${gm}/drafts?q=subject:yolk-conformance&maxResults=100`],
    ['GET', `${apisOrigin}/calendar/v3/users/me/calendarList`],
    ['POST', `${gm}/messages/batchModify`],
    ['GET', `${gm}/messages/${token}/extra/segment`],
    ['GET', `${gm}/messages/18f%2F00?format=minimal`],
    ['GET', `${gm}/messages/18f%252F00?format=minimal`],
    ['GET', `${apisOrigin}/calendar/v3/calendars/a%2Fb/events`],
    // An event id takes no `%`: a percent-encoded bearer beside `100%` is no route shape.
    ['GET', `${cal}/${encodeURIComponent(`${token.replace('S', '%53')}100%`)}`],
    ['HEAD', `${gm}/messages/${workMessage}?format=minimal`],
    ['PROPFIND', `${gm}/messages/${workMessage}`],
    // Draft attachments upload the draft MIME; no fixture records it, so it is not emulated.
    ['POST', `${gmailOrigin}/upload/gmail/v1/users/me/drafts?uploadType=multipart`],
    ['PUT', `${gmailOrigin}/upload/gmail/v1/users/me/drafts/r-1?uploadType=multipart`]
  ] as const)('%s %s', async (method, url) => {
    const target = await emulator()
    const before = target.snapshot()

    // A match-all fault: no unrecognised request may reach it.
    target.faults.add({ kind: 'status', status: 503, count: 1 })

    const response = await call(target, method, url)

    // A HEAD answer carries no body; every other one is the constant not-emulated body.
    const text =
      method === 'HEAD'
        ? String(response.status)
        : await expectNotEmulated(response, `${method} ${url}`, unrecognisedReason)

    expect(response.status).toBe(400)
    expect(target.snapshot()).toEqual(before)
    expect(target.faults.list()[0]).toMatchObject({ applied: 0, remaining: 1 })

    expect(target.ledger.entries()[0]).toEqual({
      seq: 1,
      method: method === 'PROPFIND' ? '<other>' : method,
      path: '/<unrecognised>',
      query: {},
      headers: {},
      status: 400,
      evidence: 'unknown-route',
      notEmulated: unrecognisedReason
    })

    const seen = await everythingSeen(target, text)

    expect(seen).not.toContain(token)
    expect(seen).not.toContain('batchModify')
    expect(target.coverage()).toMatchObject({ unknownRouteRequests: 1, notEmulatedRequests: 1 })
    // The unused fault still answers the next valid request.
    expect((await readWork(target)).status).toBe(503)
  })

  it('an unrecognised request uses no fault', async () => {
    const target = await emulator()

    await expectRefusedWithoutFault(
      target,
      () => call(target, 'GET', `${gm}/labels`),
      'the leftover label listing',
      unrecognisedReason
    )
  })
})

describe('an unrecognisable Authorization header is ledgered with constant text only', () => {
  const secret = 'Q7GoogleSecretValue'

  it.each([
    ['another scheme', `Basic ${secret}`],
    ['a short bearer', 'Bearer short'],
    ['a lower-case scheme', `bearer ${secret}`],
    ['two spaces after the scheme', `Bearer  ${secret}`],
    ['extra words', `Bearer ${secret} extra`],
    ['duplicated headers combined', `Bearer ${secret}, Bearer ${secret}`],
    ['a comma in the value', `Bearer ${secret},x`],
    ['an empty bearer', 'Bearer '],
    ['a bearer starting with a hex digit', 'Bearer 41SyntheticValue'],
    ['a bearer starting with n', 'Bearer nSyntheticValue'],
    ['a non-ASCII bearer', 'Bearer synth\u00e9tique-token']
  ] as const)('%s', async (_label, authorization) => {
    const target = await emulator()

    const text = await expectRefusedWithoutFault(
      target,
      () =>
        call(target, 'GET', `${gm}/messages/${secret}?format=minimal&${secret}=1`, {
          authorization
        }),
      authorization,
      unrecognisableReason
    )

    expect(target.ledger.entries()[0]).toEqual({
      seq: 1,
      method: 'GET',
      path: '/<unrecognised>',
      query: {},
      headers: {},
      status: 400,
      evidence: 'unknown-route',
      notEmulated: unrecognisableReason
    })
    expect(await everythingSeen(target, text)).not.toContain(secret)
  })

  // A bearer made only of JSON-number characters is unrecognisable, so no number's text (an
  // exponent form, any precision) can ever repeat a recognised one.
  it.each([
    [
      'an exponent in a JSON body',
      'POST',
      `${gm}/labels`,
      { rawBody: '{"name":1.2345678e7}', headers: json }
    ],
    ['an exponent query value', 'GET', `${gm}/messages/${workMessage}?format=1.2345678e7`, {}]
  ] as const)(
    'an all-number bearer is unrecognisable (%s)',
    async (_label, method, url, options) => {
      const target = await emulator()

      const text = await expectRefusedWithoutFault(
        target,
        () => call(target, method, url, { ...options, authorization: 'Bearer 12345678' }),
        'number',
        unrecognisableReason
      )

      const seen = await everythingSeen(target, text)

      for (const form of ['12345678', '1.2345678e7']) expect(seen).not.toContain(form)
    }
  )
})

describe('the bearer value is never ledgered or echoed', () => {
  // `token` is `ya29.SyntheticUnitToken0001`: `%53` is its `S` percent-encoded, `\u0053` its `S`
  // as a JSON escape. A path segment carries the label-id characters only (no `.`), so the path
  // rows use `pathToken`.
  const pathToken = 'ya29_SyntheticUnitToken0001'
  const escaped = token.replace('S', '\\u0053')
  const encoded = token.replace('S', '%53')
  const tail = 'yntheticUnitToken0001'

  const rows: ReadonlyArray<
    readonly [string, string, string, CallOptions, string, string | undefined]
  > = [
    [
      'in a query value',
      'GET',
      `${gm}/messages/${workMessage}?format=${token}`,
      {},
      'query',
      undefined
    ],
    [
      'as a query key',
      'GET',
      `${gm}/messages/${workMessage}?format=minimal&${token}=1`,
      {},
      'query',
      undefined
    ],
    [
      'percent-encoded in a query value',
      'GET',
      `${gm}/messages/${workMessage}?format=${encodeURIComponent(encoded)}`,
      {},
      'query',
      undefined
    ],
    [
      'JSON-escaped and percent-encoded next to 100% in a query value',
      'GET',
      `${gm}/messages/${workMessage}?format=${encodeURIComponent(`"${escaped}" (100% done)`)}`,
      {},
      'query',
      undefined
    ],
    ['in the path', 'DELETE', `${gm}/labels/${pathToken}`, {}, 'request path', pathToken],
    [
      'in a recorded header',
      'POST',
      `${gm}/labels`,
      {
        headers: { 'content-type': `application/json; note=${token}` },
        body: { name: 'yolk-conformance run-synthetic label' }
      },
      'recorded request header',
      undefined
    ],
    [
      'JSON-escaped next to 100% in a recorded header',
      'POST',
      `${gm}/labels`,
      {
        headers: { 'content-type': `application/json; note="${escaped} 100%"` },
        body: { name: 'yolk-conformance run-synthetic label' }
      },
      'recorded request header',
      undefined
    ],
    [
      'in a body value',
      'POST',
      `${gm}/labels`,
      { body: { name: `see ${token}` } },
      'request body',
      undefined
    ],
    [
      'JSON-escaped in a body value',
      'POST',
      `${gm}/labels`,
      { rawBody: `{"name":"${escaped}"}`, headers: json },
      'request body',
      undefined
    ],
    [
      'JSON-escaped as a body key',
      'POST',
      `${gm}/labels`,
      { rawBody: `{"name":"x","${escaped}":1}`, headers: json },
      'request body',
      undefined
    ],
    [
      'percent-encoded twice next to 100% in a body value',
      'POST',
      `${gm}/labels`,
      { body: { name: `${token.replace('S', '%2553')} (100% done)` } },
      'request body',
      undefined
    ],
    [
      'inside a draft raw',
      'POST',
      `${gm}/drafts`,
      { body: { message: { raw: pathToken } } },
      'request body',
      pathToken
    ],
    [
      'in the multipart send body',
      'POST',
      sendUrl,
      {
        rawBody: sendBody('b0undary', 'practice@example.test', `${sendSubject} ${token}`),
        headers: { 'content-type': 'multipart/related; boundary=b0undary' }
      },
      'request body',
      undefined
    ],
    [
      'JSON-escaped in the multipart send metadata part',
      'POST',
      sendUrl,
      {
        rawBody: sendBody(
          'b0undary',
          'practice@example.test',
          sendSubject,
          [],
          `{"threadId":"${escaped}"}`
        ),
        headers: { 'content-type': 'multipart/related; boundary=b0undary' }
      },
      'request body',
      undefined
    ]
  ]

  it.each(rows)('%s', async (_label, method, url, options, part, bearer = token) => {
    const target = await emulator()
    const before = target.snapshot()

    const text = await expectRefusedWithoutFault(
      target,
      () => call(target, method, url, { ...options, authorization: `Bearer ${bearer}` }),
      _label
    )

    expectConstantEntry(target, method)
    expect(target.ledger.entries().at(-2)?.notEmulated).toContain(part)
    expect(target.snapshot()).toEqual(before)

    const seen = await everythingSeen(target, text)

    // Neither the bearer nor any reversible encoding of it.
    for (const form of [bearer, tail, escaped, encoded]) expect(seen).not.toContain(form)
  })

  // A stray escape introducer immediately left of the bearer can only meet its first character
  // (`y`), which completes no escape; the first character is left as it is, or percent-encoded or
  // JSON-escaped once or twice; the rest follows unencoded.
  const rest = token.slice(1)
  const strays = ['%', '%7', '\\', '\\u', '\\u00', '%25', '%5C']

  const firsts = [
    ['unencoded', 'y'],
    ['percent-encoded once', '%79'],
    ['percent-encoded twice', '%2579'],
    ['JSON-escaped once', '\\u0079'],
    ['JSON-escaped twice', '\\\\u0079']
  ] as const

  const strayParts = [
    [
      'a query value',
      'GET',
      (text: string) => `${gm}/messages/${workMessage}?format=${encodeURIComponent(text)}`,
      (_text: string): CallOptions => ({}),
      'query'
    ],
    [
      'a JSON body string',
      'POST',
      (_text: string) => `${gm}/labels`,
      (text: string): CallOptions => ({ body: { name: text } }),
      'request body'
    ],
    [
      'the multipart send body',
      'POST',
      (_text: string) => sendUrl,
      (text: string): CallOptions => ({
        rawBody: sendBody('b0undary', 'practice@example.test', `${sendSubject} ${text}`),
        headers: { 'content-type': 'multipart/related; boundary=b0undary' }
      }),
      'request body'
    ]
  ] as const

  const strayRows = strayParts.flatMap(([part, method, url, options, reason]) =>
    strays.flatMap(stray =>
      firsts.map(
        ([encoding, first]) =>
          [
            `${part}, stray ${JSON.stringify(stray)}, first character ${encoding}`,
            method,
            url(`${stray}${first}${rest}`),
            options(`${stray}${first}${rest}`),
            reason
          ] as const
      )
    )
  )

  it.each(strayRows)('stray neighbour: %s', async (_label, method, url, options, reason) => {
    const target = await emulator()

    const text = await expectRefusedWithoutFault(
      target,
      () => call(target, method, url, options),
      _label
    )

    expectConstantEntry(target, method)
    expect(target.ledger.entries().at(-2)?.notEmulated).toContain(reason)

    const seen = await everythingSeen(target, text)

    expect(seen).not.toContain(token)
    expect(seen).not.toContain(rest)
  })

  it('answers valid requests without the bearer anywhere, recording no credential header', async () => {
    const target = await emulator()

    const responses = [
      await readWork(target),
      await call(target, 'POST', `${gm}/labels`, {
        body: { name: 'yolk-conformance run-synthetic label' }
      }),
      await call(target, 'GET', `${drv}/synthetic-practice-file-0001?${fileQuery}`, {
        headers: accept
      })
    ]

    const texts = await Promise.all(responses.map(response => response.text()))

    expect(responses.map(response => response.status)).toEqual([200, 200, 200])
    expect(await everythingSeen(target, texts.join('\n'))).not.toContain(tail)
    expect(target.ledger.entries().map(entry => entry.headers)).toEqual([
      {},
      { 'content-type': 'application/json' },
      {}
    ])
  })
})

describe('page tokens', () => {
  it('chains the recorded tokens and refuses tokens of another list or size', async () => {
    const target = await emulator()

    const list = (size: number, pageToken?: string) =>
      call(target, 'GET', `${drv}?${listQuery(practiceFolder, size, pageToken)}`, {
        headers: accept
      })

    const first = await (await list(2)).json()

    expect(field(first, 'nextPageToken')).toBe('synthetic-drive-page-2')

    await expectRefusedWithoutFault(target, () => list(3, 'synthetic-drive-page-2'), 'another size')
    await expectRefusedWithoutFault(
      target,
      () =>
        call(
          target,
          'GET',
          `${gm}/messages?labelIds=Label_9001&maxResults=2&pageToken=synthetic-drive-page-2`
        ),
      'another list'
    )

    expect((await list(2, 'synthetic-drive-page-2')).status).toBe(200)
  })

  it('refuses a token whose list changed since it was issued', async () => {
    const target = await emulator()

    const list = (pageToken?: string) =>
      call(target, 'GET', `${drv}?${listQuery(practiceFolder, 2, pageToken)}`, { headers: accept })

    expect((await list()).status).toBe(200)
    expect(
      (await call(target, 'POST', `${drv}?${fileQuery}`, { headers: driveWrite, body: folderBody }))
        .status
    ).toBe(200)

    await expectRefusedWithoutFault(
      target,
      () => list('synthetic-drive-page-2'),
      'a changed list',
      'continuing a list that changed since its pageToken was issued is not emulated'
    )
  })

  it('never rebinds a token: a first page reissued after a change gets a distinct token', async () => {
    const target = await emulator()

    const list = (pageToken?: string) =>
      call(target, 'GET', `${drv}?${listQuery(practiceFolder, 2, pageToken)}`, { headers: accept })

    const before = field(await (await list()).json(), 'nextPageToken')

    expect(before).toBe('synthetic-drive-page-2')
    expect(
      (await call(target, 'POST', `${drv}?${fileQuery}`, { headers: driveWrite, body: folderBody }))
        .status
    ).toBe(200)

    // The same first-page request on the changed list: a distinct token, never the old one.
    const after = field(await (await list()).json(), 'nextPageToken')

    expect(after).toBe('synthetic-drive-page-2.v2')

    // The stale token stays refused, before any fault.
    await expectRefusedWithoutFault(
      target,
      () => list('synthetic-drive-page-2'),
      'a stale token after a reissue',
      'continuing a list that changed since its pageToken was issued is not emulated'
    )

    expect((await list('synthetic-drive-page-2.v2')).status).toBe(200)

    // The same request on the unchanged list reuses the token it issued.
    expect(field(await (await list()).json(), 'nextPageToken')).toBe('synthetic-drive-page-2.v2')
  })

  it('token values are globally unique: another page size never gets the same value', async () => {
    const target = await emulator()

    const list = (size: number, pageToken?: string) =>
      call(
        target,
        'GET',
        `${gm}/messages?labelIds=Label_9001&maxResults=${size}${pageToken === undefined ? '' : `&pageToken=${pageToken}`}`
      )

    const one = field(await (await list(1)).json(), 'nextPageToken')
    const two = field(await (await list(2)).json(), 'nextPageToken')

    expect(one).toBe('synthetic-gmail-page-2')
    expect(two).toBe('synthetic-gmail-page-2.v2')

    // The first caller's token never continues the other page size, before any fault.
    await expectRefusedWithoutFault(
      target,
      () => list(2, 'synthetic-gmail-page-2'),
      'a token of another page size',
      'a pageToken this emulator did not issue for this list since the last reset is not emulated'
    )

    const continued = await (await list(1, 'synthetic-gmail-page-2')).json()

    expect(field(continued, 'messages')).toEqual([
      { id: '18f00000000000c2', threadId: '18f00000000000c2' }
    ])
    expect(field(await (await list(2, 'synthetic-gmail-page-2.v2')).json(), 'messages')).toEqual([
      { id: '18f00000000000c3', threadId: '18f00000000000c3' },
      { id: '18f00000000000c4', threadId: '18f00000000000c4' }
    ])
  })

  it('refuses tokens issued before a reset or seed, and never issues one again', async () => {
    const target = await emulator()

    const first = () =>
      call(target, 'GET', `${gm}/messages?labelIds=Label_9001&maxResults=2`).then(response =>
        response.json()
      )

    expect(field(await first(), 'nextPageToken')).toBe('synthetic-gmail-page-2')

    await target.reset()

    await expectRefusedWithoutFault(
      target,
      () =>
        call(
          target,
          'GET',
          `${gm}/messages?labelIds=Label_9001&maxResults=2&pageToken=synthetic-gmail-page-2`
        ),
      'a token from before the reset'
    )
    expect(field(await first(), 'nextPageToken')).toBe('synthetic-gmail-page-2.g1')

    await target.seed({})

    expect(field(await first(), 'nextPageToken')).toBe('synthetic-gmail-page-2.g2')
  })
})

describe('faults', () => {
  it.effect(
    'a 429 with retry-after reaches the connector as google_rate_limited, writing nothing',
    () =>
      Effect.gen(function* () {
        const target = yield* Effect.promise(() => emulator())
        const before = target.snapshot()

        target.faults.add({
          kind: 'status',
          status: 429,
          headers: { 'retry-after': '7' },
          match: { method: 'POST', path: '/drive/v3/files' },
          count: 1
        })

        const result = yield* googleDriveCreateFolderAction
          .executeTyped({
            integration: googleConformanceIntegration,
            input: GoogleDriveCreateFolderInput.make({
              name: 'yolk-conformance run-synthetic folder',
              parentId: practiceFolder
            })
          })
          .pipe(Effect.provide(connectorLayer(target)))

        expect(result).toMatchObject({
          _tag: 'Failure',
          error: { code: 'google_rate_limited', status: 429, retryAfterMs: 7000 }
        })
        expect(target.snapshot()).toEqual(before)
        expect(target.ledger.entries()[0]).toMatchObject({ status: 429, fault: 'status' })
      })
  )

  it('validates faults (400-599, strict keys)', async () => {
    const target = await emulator()

    expect(() => target.faults.add({ kind: 'status', status: 200 })).toThrow(
      GoogleEmulatorInputInvalid
    )

    const response = await target.fetch(
      new Request(`${gmailOrigin}/_emulate/faults`, {
        method: 'POST',
        body: JSON.stringify({ kind: 'status', status: 503, extra: true })
      })
    )

    expect(response.status).toBe(400)
  })
})

describe('clock-safe recovery', () => {
  it('a throwing clock fails only the writes that read it (500, ledgered), never recovery', async () => {
    const target = await emulator({
      now: () => {
        throw new Error('synthetic clock failure')
      }
    })

    const before = target.snapshot()

    for (const [label, run] of [
      ['event create', () => call(target, 'POST', cal, { body: eventBody })],
      [
        'folder create',
        () => call(target, 'POST', `${drv}?${fileQuery}`, { headers: driveWrite, body: folderBody })
      ],
      ['send', () => sendWith(target, sendBody('b0undary', 'practice@example.test', sendSubject))]
    ] as const) {
      const response = await run()

      expect(response.status, label).toBe(500)
      expect(await response.json(), label).toEqual({
        error: { message: 'the emulator could not build the response', type: 'emulator_error' }
      })
      expect(response.headers.get(emulatorEvidenceHeader), label).toBe('unverified')
      expect(target.ledger.entries().at(-1), label).toMatchObject({
        status: 500,
        responseError: 'the route handler failed'
      })
    }

    expect(target.snapshot()).toEqual(before)
    await expectNotEmulated(await call(target, 'GET', `${gm}/labels`))
    expect((await readWork(target)).status).toBe(200)
  })

  it.each([
    ['non-finite', Number.NaN],
    ['finite but outside the Date range', 8_640_000_000_000_001]
  ])(
    'a %s clock fails the send the same way (no Invalid Date is ever written)',
    async (_label, instant) => {
      const target = await emulator({ now: () => instant })
      const before = target.snapshot()

      for (const run of [
        () => sendWith(target, sendBody('b0undary', 'practice@example.test', sendSubject)),
        () => call(target, 'POST', cal, { body: eventBody }),
        () => call(target, 'POST', `${drv}?${fileQuery}`, { headers: driveWrite, body: folderBody })
      ]) {
        const response = await run()

        expect(response.status).toBe(500)
        expect(await response.text()).not.toContain('Invalid Date')
      }

      expect(target.snapshot()).toEqual(before)
      expect(JSON.stringify(target.snapshot())).not.toContain('Invalid Date')
    }
  )
})

describe('seeds, options, and minted ids', () => {
  it('rejects invalid seeds and options', async () => {
    // Parsed from JSON, as a host passing untyped input would.
    const options: ReadonlyArray<GoogleEmulatorOptions> = JSON.parse(
      JSON.stringify([
        { seed: { unknown: true } },
        { seed: { messages: [{ id: 'x' }] } },
        {
          seed: {
            impliedMessages: [
              { id: '18f00000000000d1', threadId: '18f00000000000d1', labelIds: [] }
            ]
          }
        },
        {
          seed: {
            events: [
              {
                calendarId: 'practice-calendar@example.test',
                id: 'syntheticconformance0001',
                etag: '"1"',
                status: 'confirmed',
                htmlLink: 'x',
                created: 'x',
                updated: 'x',
                summary: 'x',
                start: { date: '2030-01-01' },
                end: { date: '2030-01-02' },
                iCalUID: 'x',
                sequence: 0
              }
            ]
          }
        },
        { seed: { impliedFolderIds: ['synthetic-conformance-folder-0001'] } },
        { seed: { impliedLabelIds: [] } },
        // A label id outside the minted Label_<1 to 999999999> form, also on a message.
        { seed: { profile: 'empty', impliedLabelIds: ['Label_999999999', 'Label_1000000000'] } },
        { seed: { profile: 'empty', impliedLabelIds: ['Label_09101'] } },
        {
          seed: {
            profile: 'empty',
            impliedLabelIds: ['Label_9001'],
            impliedMessages: [
              { id: '18f00000000000c1', threadId: '18f00000000000c1', labelIds: ['Label_00'] }
            ]
          }
        },
        // A thread id in a minted message id form (a created draft is its own thread).
        {
          seed: {
            impliedMessages: [
              { id: '18f00000000000f1', threadId: '18f00000000000d1', labelIds: ['Label_9001'] }
            ]
          }
        },
        { seed: { practiceAddress: 'Practice <practice@example.test>' } },
        { seed: { practiceAddress: 'practice@example.test, someone@example.test' } },
        { drills: { unknown: true } },
        { drills: { gmailPageRepeats: 'yes' } }
      ])
    )

    for (const invalid of options) {
      await expect(makeGoogleEmulator(invalid), JSON.stringify(invalid)).rejects.toBeInstanceOf(
        GoogleEmulatorInputInvalid
      )
    }
  })

  it('refuses a label create once no minted id is left, before any fault', async () => {
    const target = await emulator({
      seed: { profile: 'empty', impliedLabelIds: ['Label_999999999'] }
    })

    expect(target.snapshot().counters.nextLabelNumber).toBe(1_000_000_000)

    await expectRefusedWithoutFault(
      target,
      () =>
        call(target, 'POST', `${gm}/labels`, {
          body: { name: 'yolk-conformance run-synthetic label' }
        }),
      'exhausted',
      'creating a label when no Label_<n> id is left is not emulated'
    )
  })

  it('answers the recorded 404 for every absent minted label id, and only those', async () => {
    const target = await emulator()

    for (const id of ['Label_1', 'Label_9101', 'Label_999999999']) {
      expect((await call(target, 'GET', `${gm}/labels/${id}`)).status, id).toBe(404)
    }

    for (const id of ['Label_0', 'Label_09101', 'Label_1000000000']) {
      await expectRefusedWithoutFault(
        target,
        () => call(target, 'GET', `${gm}/labels/${id}`),
        id,
        'only a read of an absent Label_<n> id is recorded'
      )
    }
  })

  it('answers no thread of a seeded draft message (only draft threads created here)', async () => {
    const draft = {
      id: '18f00000000000f7',
      threadId: '18f00000000000f7',
      labelIds: ['DRAFT'],
      snippet: 'x',
      sizeEstimate: 1,
      historyId: '1',
      internalDate: '1',
      minimal: false,
      metadataPayload: null,
      fullPayload: { partId: '', mimeType: 'text/plain', filename: '', headers: [], body: {} }
    }

    const target = await emulator({ seed: { messages: [draft], attachments: [] } })

    await expectRefusedWithoutFault(
      target,
      () => call(target, 'GET', `${gm}/threads/${draft.id}?format=full`),
      'seeded draft thread',
      'a thread other than a draft thread created here is not emulated'
    )
  })

  it('starts created label ids above every seeded label number', async () => {
    const target = await emulator({
      seed: {
        impliedLabelIds: ['Label_9001', 'Label_9500'],
        impliedMessages: [
          { id: '18f00000000000c1', threadId: '18f00000000000c1', labelIds: ['Label_9500'] }
        ]
      }
    })

    const created = await call(target, 'POST', `${gm}/labels`, {
      body: { name: 'yolk-conformance run-synthetic label' }
    })

    expect(field(await created.json(), 'id')).toBe('Label_9501')
  })

  it('builds the empty profile: absent ids answer the recorded 404, listings are not emulated', async () => {
    const target = await emulator({ seed: { profile: 'empty' } })

    expect(target.snapshot()).toMatchObject({ messages: [], events: [], files: [] })
    expect((await readWork(target)).status).toBe(404)
    await expectNotEmulated(
      await call(target, 'GET', `${drv}?${listQuery(practiceFolder, 100)}`, { headers: accept })
    )
  })
})

describe('empty listings are no fixture answer', () => {
  it('refuses a listing of a created label that no message carries', async () => {
    const target = await emulator()

    expect(
      (
        await call(target, 'POST', `${gm}/labels`, {
          body: { name: 'yolk-conformance run-synthetic label' }
        })
      ).status
    ).toBe(200)

    await expectRefusedWithoutFault(
      target,
      () => call(target, 'GET', `${gm}/messages?labelIds=Label_9101&maxResults=2`),
      'empty listing',
      'a listing without messages is not emulated (no fixture records one)'
    )
  })
})

describe('thread listings and metadataHeaders selections', () => {
  const attachmentMessage = '18f00000000000a1'

  const metadataUrl = (query: string) => `${gm}/messages/${attachmentMessage}?${query}`

  const headerNames = async (response: Response) => {
    expect(response.status).toBe(200)

    const body: unknown = await response.json()
    const payload = field(body, 'payload')
    const headers = field(payload, 'headers')

    return Array.isArray(headers) ? headers.map(header => field(header, 'name')) : []
  }

  it('lists the paging threads, paged with the recorded tokens', async () => {
    const target = await emulator()

    const all: unknown = await (
      await call(target, 'GET', `${gm}/threads?maxResults=100&labelIds=Label_9001`)
    ).json()

    expect(field(all, 'nextPageToken')).toBeUndefined()
    expect(field(all, 'resultSizeEstimate')).toBe(5)
    expect(field(all, 'threads')).toHaveLength(5)

    const first: unknown = await (
      await call(target, 'GET', `${gm}/threads?labelIds=Label_9001&maxResults=4`)
    ).json()

    expect(field(first, 'nextPageToken')).toBe('synthetic-gmail-threads-page-2')

    const second: unknown = await (
      await call(
        target,
        'GET',
        `${gm}/threads?labelIds=Label_9001&maxResults=4&pageToken=synthetic-gmail-threads-page-2`
      )
    ).json()

    expect(field(second, 'threads')).toEqual([
      { id: '18f00000000000c5', snippet: 'Synthetic paging message 5.', historyId: '900105' }
    ])
  })

  it('refuses thread listings no fixture records', async () => {
    const target = await emulator()

    const rows: ReadonlyArray<readonly [string, string, string]> = [
      [
        'a message token on the thread listing',
        `${gm}/threads?labelIds=Label_9001&maxResults=2&pageToken=synthetic-gmail-page-2`,
        'a pageToken this emulator did not issue for this list since the last reset is not emulated'
      ],
      [
        'a query',
        `${gm}/threads?labelIds=Label_9001&maxResults=2&q=is%3Aunread`,
        'a query parameter this route does not take is not emulated'
      ],
      [
        'no label',
        `${gm}/threads?maxResults=2`,
        'requests without query parameter labelIds are not emulated on this route'
      ],
      [
        'a system label the state does not list',
        `${gm}/threads?labelIds=INBOX&maxResults=2`,
        'listing a label the state does not hold is not emulated'
      ]
    ]

    for (const [label, url, reason] of rows) {
      await expectRefusedWithoutFault(target, () => call(target, 'GET', url), label, reason)
    }
  })

  it('refuses a listing naming a thread no thread listing fixture names', async () => {
    const target = await emulator({ seed: { impliedThreads: [] } })

    await expectRefusedWithoutFault(
      target,
      () => call(target, 'GET', `${gm}/threads?labelIds=Label_9001&maxResults=2`),
      'no implied threads',
      'listing a thread no thread listing fixture names is not emulated'
    )
  })

  it('keeps only the selected recorded headers, in recorded order, for any selection order', async () => {
    const target = await emulator()

    expect(await headerNames(await call(target, 'GET', metadataUrl('format=metadata')))).toEqual([
      'From',
      'Subject',
      'Content-Type'
    ])
    expect(
      await headerNames(
        await call(
          target,
          'GET',
          metadataUrl('metadataHeaders=Content-Type&format=metadata&metadataHeaders=From')
        )
      )
    ).toEqual(['From', 'Content-Type'])
    expect(
      await headerNames(
        await call(target, 'GET', metadataUrl('format=metadata&metadataHeaders=Subject'))
      )
    ).toEqual(['Subject'])
  })

  it('refuses selections no fixture records', async () => {
    const target = await emulator()

    const rows: ReadonlyArray<readonly [string, string, string]> = [
      [
        'with format=full',
        metadataUrl('format=full&metadataHeaders=From'),
        'metadataHeaders with a format other than metadata is not emulated'
      ],
      [
        'a repeated name',
        metadataUrl('format=metadata&metadataHeaders=From&metadataHeaders=From'),
        'metadataHeaders must be 1 to 50 distinct header names'
      ],
      [
        'an empty name',
        metadataUrl('format=metadata&metadataHeaders='),
        'metadataHeaders must be 1 to 50 distinct header names'
      ],
      [
        '51 names',
        metadataUrl(
          `format=metadata&${Array.from({ length: 51 }, (_, index) => `metadataHeaders=X-${index}`).join('&')}`
        ),
        'metadataHeaders must be 1 to 50 distinct header names'
      ],
      [
        'a header the rendering lacks',
        metadataUrl('format=metadata&metadataHeaders=Reply-To'),
        'a metadataHeaders selection naming a header the recorded rendering lacks is not emulated'
      ],
      [
        'a header in another case',
        metadataUrl('format=metadata&metadataHeaders=from'),
        'a metadataHeaders selection naming a header the recorded rendering lacks is not emulated'
      ],
      [
        'a repeated format',
        metadataUrl('format=metadata&format=metadata&metadataHeaders=From'),
        'repeated query parameters are not emulated'
      ],
      [
        'an absent message',
        `${gm}/messages/ffffffffffffffff?format=minimal&metadataHeaders=From`,
        'metadataHeaders with a format other than metadata is not emulated'
      ],
      [
        'a thread read with format=metadata and no selection',
        `${gm}/threads/${attachmentMessage}?format=metadata`,
        'a thread read other than format=full, or format=metadata with metadataHeaders, is not emulated'
      ],
      [
        'a full read of a seeded thread',
        `${gm}/threads/${attachmentMessage}?format=full`,
        'a thread other than a draft thread created here is not emulated'
      ],
      [
        'a thread of a message a fixture only names',
        `${gm}/threads/18f00000000000c1?format=metadata&metadataHeaders=From`,
        'a thread holding a message a fixture only names is not emulated'
      ],
      [
        'a thread whose message has no metadata rendering',
        `${gm}/threads/${workMessage}?format=metadata&metadataHeaders=From`,
        'a thread with a message without a metadata rendering is not emulated'
      ]
    ]

    for (const [label, url, reason] of rows) {
      await expectRefusedWithoutFault(target, () => call(target, 'GET', url), label, reason)
    }
  })
})

describe('a draft message.raw the route would refuse is never ledgered (fail closed)', () => {
  /** Base64 (standard alphabet) or base64url of bytes. */
  const base64Of = (bytes: Uint8Array, url: boolean) => {
    const standard = btoa(String.fromCharCode(...bytes))

    return url ? standard.replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '') : standard
  }

  const mime = (subject: string, body = draftText) => draftMime(subject, body)

  const utf8 = (text: string) => new TextEncoder().encode(text)

  const utf16 = (text: string) =>
    new Uint8Array([...text].flatMap(char => [char.charCodeAt(0) & 0xff, char.charCodeAt(0) >> 8]))

  const canonical = (text: string) => base64Of(utf8(text), true)

  // The bearer as the draft subject's run id (13 characters) or in the body, so the decoded MIME
  // would hold it if the raw were decoded leniently.
  const withBearer = mime(runDraftSubject('run-ghpsecret'), `see ${token}`)

  const lineWrapped = canonical(withBearer).replace(/(.{76})/g, '$1\r\n')

  // `???` at the start encodes to `Pz8/`: the standard alphabet's `/` is certain to appear.
  const standardAlphabet = base64Of(utf8(`???${withBearer}`), false)

  const rfc2047 = canonical(
    mime(`=?utf-8?B?${btoa(runDraftSubject('run-ghpsecret').replace('ghpsecret', token))}?=`)
  )

  const quotedPrintable = canonical(mime(draftSubject, `ya29.Synthetic=\r\nUnitToken0001`))

  // Each refusal is the route's own declared reason (a constant), or a credential repeat when the
  // raw decodes cleanly to text holding the bearer; never a reason derived from the request.
  const reasons = {
    canonical: () => 'message.raw must be canonical base64url UTF-8 MIME',
    other: (draft: string) => `a draft ${draft} other than the recorded run draft is not emulated`,
    repeat: () => 'the request body repeats the credential'
  }

  const rows: ReadonlyArray<readonly [string, string, string, 'canonical' | 'other' | 'repeat']> = [
    ['line-wrapped base64url (JSON \\r\\n every 76 characters)', token, lineWrapped, 'canonical'],
    ['the standard base64 alphabet', token, standardAlphabet, 'canonical'],
    ['canonical base64url with a trailing .', token, `${canonical(withBearer)}.`, 'canonical'],
    [
      'percent-encoded base64url',
      token,
      [...canonical(withBearer)]
        .map(char => `%${char.charCodeAt(0).toString(16).toUpperCase()}`)
        .join(''),
      'canonical'
    ],
    ['an RFC 2047 encoded-word subject', token, rfc2047, 'other'],
    ['a quoted-printable soft break inside the bearer', token, quotedPrintable, 'other'],
    ['UTF-16 content', token, base64Of(utf16(withBearer), true), 'other'],
    // The bearer in a non-run subject: the raw decodes cleanly to text holding it, a repeat.
    ['a non-run subject', token, canonical(mime(`Subject with ${token}`)), 'repeat'],
    [
      'escaped and percent-encoded forms beside 100% in the subject',
      token,
      canonical(mime(`${token.replace('S', '\\u0053')} and ${token.replace('S', '%53')} (100%)`)),
      'repeat'
    ],
    // No bearer at all: a malformed draft gets the route's reason, never "repeats".
    [
      'a malformed draft without the bearer',
      'ghpabsent0',
      lineWrapped.replace(/./, 'Q'),
      'canonical'
    ],
    [
      'a padded draft without the bearer',
      'ghpabsent0',
      `${canonical(mime(draftSubject))}==`,
      'canonical'
    ],
    ['a non-run draft without the bearer', 'ghpabsent0', canonical(mime('Hello')), 'other']
  ]

  const reasonOf = (kind: keyof typeof reasons, draft: 'compose' | 'update') => reasons[kind](draft)

  it.each(rows)('compose with %s', async (_label, bearer, raw, kind) => {
    const target = await emulator()

    const text = await expectRefusedWithoutFault(
      target,
      () =>
        call(target, 'POST', `${gm}/drafts`, {
          authorization: `Bearer ${bearer}`,
          body: { message: { raw } }
        }),
      _label,
      reasonOf(kind, 'compose')
    )

    expectViewRefusalEntry(target, 'POST', '/gmail/v1/users/me/drafts', reasonOf(kind, 'compose'))
    expect(target.snapshot().drafts).toEqual([])

    const seen = await everythingSeen(target, text)

    // No `raw` field reaches the ledger or any `/_emulate/*` read, and no part of this raw does
    // (past its first characters, which a recorded draft's raw may share).
    expect(seen).not.toContain('"raw"')
    expect(seen).not.toContain(raw.slice(48, 72))

    for (const form of [token, 'yntheticUnitToken0001', 'ghpsecret']) {
      expect(seen).not.toContain(form)
    }
  })

  // An extra key in `message`: a raw that decodes cleanly to text holding the bearer is still a
  // repeat; without the bearer, the route's own declared extra-key reason.
  it.each([
    [
      'with the bearer in a clean raw',
      token,
      canonical(mime(`Subject with ${token}`)),
      reasons.repeat()
    ],
    [
      'without the bearer',
      'ghpabsent0',
      canonical(mime(draftSubject)),
      'message has a key this route does not take'
    ]
  ] as const)('compose with an extra message key, %s', async (_label, bearer, raw, reason) => {
    const target = await emulator()

    const text = await expectRefusedWithoutFault(
      target,
      () =>
        call(target, 'POST', `${gm}/drafts`, {
          authorization: `Bearer ${bearer}`,
          body: { message: { raw, x: 1 } }
        }),
      _label,
      reason
    )

    expectViewRefusalEntry(target, 'POST', '/gmail/v1/users/me/drafts', reason)
    expect(target.snapshot().drafts).toEqual([])

    const seen = await everythingSeen(target, text)

    expect(seen).not.toContain('"raw"')
    expect(seen).not.toContain(token)
  })

  it.each(rows.slice(0, 3))('update with %s', async (_label, bearer, raw, kind) => {
    const target = await emulator()

    const composed = await call(target, 'POST', `${gm}/drafts`, {
      authorization: `Bearer ${bearer}`,
      body: { message: { raw: draftRaw(draftSubject, draftText) } }
    })

    const draftId = String(field(await composed.json(), 'id'))

    const text = await expectRefusedWithoutFault(
      target,
      () =>
        call(target, 'PUT', `${gm}/drafts/${draftId}`, {
          authorization: `Bearer ${bearer}`,
          body: { id: draftId, message: { raw } }
        }),
      _label,
      reasonOf(kind, 'update')
    )

    expectViewRefusalEntry(
      target,
      'PUT',
      '/gmail/v1/users/me/drafts/{draftId}',
      reasonOf(kind, 'update')
    )

    const seen = await everythingSeen(target, text)

    expect(seen).not.toContain(raw.slice(48, 72))
    expect(seen).not.toContain(token)
  })
})

describe('the bearer inside a draft base64url message.raw is found (decoded views)', () => {
  const draftCompose = (subject: string, text = draftText) => ({
    message: { raw: draftRaw(subject, text) }
  })

  const draftUpdate = (id: string, subject: string) => ({
    id,
    message: { raw: draftRaw(subject, updatedDraftText) }
  })

  // Recognisable bearers whose `run-<bearer>` run id is exactly 13 characters, so without the
  // decoded view the whole draft would be accepted and the bearer stored in its subject.
  it.each([
    ['ghpsecret', runDraftSubject('run-ghpsecret')],
    ['ghijklmno', runDraftSubject('run-ghijklmno')]
  ] as const)('compose with %s in the encoded subject', async (bearer, subject) => {
    const target = await emulator()
    const raw = draftRaw(subject, draftText)

    const text = await expectRefusedWithoutFault(
      target,
      () =>
        call(target, 'POST', `${gm}/drafts`, {
          authorization: `Bearer ${bearer}`,
          body: draftCompose(subject)
        }),
      subject
    )

    expectConstantEntry(target, 'POST')
    expect(target.ledger.entries().at(-2)?.notEmulated).toBe(
      'the request body repeats the credential'
    )
    expect(target.snapshot().drafts).toEqual([])

    const seen = await everythingSeen(target, text)

    for (const form of [bearer, raw]) expect(seen).not.toContain(form)
  })

  it.each([
    ['ghpsecret', runDraftSubject('run-ghpsecret', 'draft updated')],
    ['ghijklmno', runDraftSubject('run-ghijklmno', 'draft updated')]
  ] as const)('update with %s in the encoded subject', async (bearer, subject) => {
    const target = await emulator()
    const authorization = `Bearer ${bearer}`

    const composed = await call(target, 'POST', `${gm}/drafts`, {
      authorization,
      body: draftCompose(draftSubject)
    })

    expect(composed.status).toBe(200)

    const draftId = String(field(await composed.json(), 'id'))
    const raw = draftRaw(subject, updatedDraftText)

    const text = await expectRefusedWithoutFault(
      target,
      () =>
        call(target, 'PUT', `${gm}/drafts/${draftId}`, {
          authorization,
          body: draftUpdate(draftId, subject)
        }),
      subject
    )

    expectConstantEntry(target, 'PUT')

    // The draft keeps its composed message; nothing of the update was stored.
    expect(target.snapshot().messages.at(-1)?.metadataPayload).not.toBeNull()

    const seen = await everythingSeen(target, text)

    for (const form of [bearer, raw]) expect(seen).not.toContain(form)
  })

  it('a draft whose decoded subject holds no bearer is answered as before', async () => {
    const target = await emulator()

    const composed = await call(target, 'POST', `${gm}/drafts`, {
      authorization: 'Bearer ghpsecret',
      body: draftCompose(runDraftSubject('run-ghpsafe00'))
    })

    expect(composed.status).toBe(200)
  })
})

describe('recorded sizes: draft and send run ids of the fixture length, the recorded address', () => {
  it('accepts a 13-character non-fixture run id on a draft compose, update, and send', async () => {
    const target = await emulator()
    const runId = 'run-3f9a2c7d1'

    const composed = await call(target, 'POST', `${gm}/drafts`, {
      body: { message: { raw: draftRaw(runDraftSubject(runId), draftText) } }
    })

    expect(composed.status).toBe(200)

    const draftId = String(field(await composed.json(), 'id'))

    const metadata = await call(target, 'GET', `${gm}/messages/18f00000000000d1?format=metadata`)

    expect(field(await metadata.json(), 'sizeEstimate')).toBe(512)

    const updated = await call(target, 'PUT', `${gm}/drafts/${draftId}`, {
      body: {
        id: draftId,
        message: { raw: draftRaw(runDraftSubject(runId, 'draft updated'), updatedDraftText) }
      }
    })

    expect(updated.status).toBe(200)

    const sent = await sendWith(
      target,
      sendBody(
        'b0undary',
        'practice@example.test',
        `yolk-conformance ${runId} send: synthetic conformance message, safe to delete`
      )
    )

    expect(sent.status).toBe(200)
    expect(target.snapshot().messages.at(-1)?.sizeEstimate).toBe(640)
    expect(target.ledger.entries().every(entry => entry.notEmulated === undefined)).toBe(true)
  })

  it('refuses a draft update whose subject has a run id of another length', async () => {
    const target = await emulator()

    const composed = await call(target, 'POST', `${gm}/drafts`, {
      body: { message: { raw: draftRaw(draftSubject, draftText) } }
    })

    const draftId = String(field(await composed.json(), 'id'))

    for (const runId of ['run-3f9a2c7d', 'run-3f9a2c7d12']) {
      await expectRefusedWithoutFault(
        target,
        () =>
          call(target, 'PUT', `${gm}/drafts/${draftId}`, {
            body: {
              id: draftId,
              message: { raw: draftRaw(runDraftSubject(runId, 'draft updated'), updatedDraftText) }
            }
          }),
        runId,
        sizedRunIdReason('draft')
      )
    }
  })

  // A draft's run id is checked inside its `message.raw` by the credential guard's decoded view,
  // which refuses with the route's own declared reason.
  it('names the reason for a 12-character run id on a draft compose and a send', async () => {
    const target = await emulator()

    await expectRefusedWithoutFault(
      target,
      () =>
        call(target, 'POST', `${gm}/drafts`, {
          body: { message: { raw: draftRaw(runDraftSubject('run-3f9a2c7d'), draftText) } }
        }),
      'draft',
      sizedRunIdReason('draft')
    )
    await expectRefusedWithoutFault(
      target,
      () =>
        sendWith(
          target,
          sendBody(
            'b0undary',
            'practice@example.test',
            'yolk-conformance run-3f9a2c7d send: synthetic conformance message, safe to delete'
          )
        ),
      'send',
      sizedRunIdReason('send')
    )
  })

  it('refuses every send while a seed sets another practice address', async () => {
    const target = await emulator({ seed: { practiceAddress: 'other@example.test' } })

    const reason =
      'a send while the seeded practiceAddress is not the recorded practice@example.test is not emulated (the recorded sizeEstimate covers the address)'

    for (const to of ['other@example.test', 'practice@example.test']) {
      await expectRefusedWithoutFault(
        target,
        () => sendWith(target, sendBody('b0undary', to, sendSubject)),
        to,
        reason
      )
    }

    // The seeded address still applies where no recorded size covers it (the event creator).
    const event = await call(target, 'POST', cal, { body: eventBody })

    expect(field(await event.json(), 'creator')).toEqual({
      email: 'other@example.test',
      self: true
    })
  })
})

describe('control plane', () => {
  it('serves the ledger, faults, state, seed, reset, and coverage', async () => {
    const target = await emulator()

    const control = (method: string, route: string, body?: unknown) =>
      target.fetch(
        new Request(`${apisOrigin}/_emulate/${route}`, {
          method,
          body: body === undefined ? undefined : JSON.stringify(body)
        })
      )

    expect((await readWork(target)).status).toBe(200)
    expect(field(await (await control('GET', 'ledger')).json(), 'entries')).toHaveLength(1)
    expect((await control('POST', 'faults', { kind: 'status', status: 503 })).status).toBe(201)
    expect(field(await (await control('GET', 'state')).json(), 'ledgerEntries')).toBe(1)

    const coverage = await (await control('GET', 'coverage')).json()

    expect(field(coverage, 'routes')).toHaveLength(25)

    expect(await (await control('POST', 'seed', { profile: 'empty' })).json()).toEqual({
      seeded: true,
      messages: 0,
      events: 0,
      files: 0
    })
    expect(await (await control('POST', 'reset')).json()).toEqual({ reset: true })
    expect(target.snapshot().messages).toEqual([])
    expect(target.faults.list()).toEqual([])
    expect(target.ledger.entries()).toEqual([])
    expect((await control('PUT', 'reset')).status).toBe(405)
    expect((await control('GET', 'nothing')).status).toBe(404)
  })
})
