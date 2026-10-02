/**
 * Telegram emulator unit tests: the manifest, every fixture replayed byte for byte against the
 * default seed (the drift test), the bot token never ledgered or echoed (including unknown-route
 * entries and not-emulated messages), fail-closed 400 not-emulated answers that write nothing,
 * faults through the real connector, clock-safe recovery, seeds, and the control plane. Tests may
 * import SDK packages; the emulator source never does.
 */
import { Effect, Layer, Predicate } from 'effect'
import { afterEach, describe, expect, it } from '@effect/vitest'
import { isWireBase64BodyResponse, isWireStreamResponse } from '@yolk-sdk/conformance/fixture'
import { ApiKeyCredential } from '@yolk-sdk/connectors'
import {
  connectorHttpClientsFromEffectHttpClientLayer,
  staticCredentialResolverLayer
} from '@yolk-sdk/connectors/conformance'
import { TelegramSendMessageInput, telegramSendMessageAction } from '@yolk-sdk/connectors/telegram'
import {
  telegramConformanceCases,
  telegramConformanceFixtureSeeds,
  telegramConformanceFixtures,
  telegramConformanceIntegration,
  telegramConformanceReplayBotToken
} from '@yolk-sdk/connectors/telegram/conformance'
import { EmulatorRoute, InProcessHttpClient } from '../src/router.ts'
import {
  TelegramEmulatorInputInvalid,
  emulatorEvidenceHeader,
  makeTelegramEmulator,
  telegramEmulatorRoutes,
  type TelegramEmulator,
  type TelegramEmulatorOptions
} from '../src/telegram.ts'

const origin = 'https://api.telegram.org'

/** A synthetic token whose secret part is distinctive, so any echo of it is found. */
const token = '777000:yolkEmulatorSecretPartQ9'

const secretPart = token.split(':')[1] ?? ''

/** The send fixture's `date`. */
const fixtureDateMs = 1_790_000_000_000

const open: Array<TelegramEmulator> = []

afterEach(async () => {
  await Promise.all(open.splice(0).map(emulator => emulator.close()))
})

const emulator = async (options: TelegramEmulatorOptions = {}): Promise<TelegramEmulator> => {
  const created = await makeTelegramEmulator({ now: () => fixtureDateMs, ...options })

  open.push(created)

  return created
}

type CallOptions = {
  readonly body?: unknown
  readonly rawBody?: string
  readonly contentType?: string | null
}

const call = (
  target: TelegramEmulator,
  method: string,
  path: string,
  options: CallOptions = {}
): Promise<Response> => {
  const headers = new Headers()

  const body =
    options.rawBody ?? (options.body === undefined ? undefined : JSON.stringify(options.body))

  const contentType = options.contentType === undefined ? 'application/json' : options.contentType

  if (body !== undefined && contentType !== null) headers.set('content-type', contentType)

  return target.fetch(new Request(`${origin}${path}`, { method, headers, body }))
}

const sendBody = {
  chat_id: '-1001000000001',
  text: 'synthetic text',
  disable_web_page_preview: true
}

/**
 * Nothing the emulator keeps or reports carries the token or its secret part: the JS API, every
 * `/_emulate/*` read, and the given response texts.
 */
const expectNoToken = async (target: TelegramEmulator, ...texts: ReadonlyArray<string>) => {
  const control = await Promise.all(
    ['ledger', 'state', 'coverage', 'faults'].map(path =>
      target.fetch(new Request(`${origin}/_emulate/${path}`)).then(response => response.text())
    )
  )

  const recorded = [
    JSON.stringify([
      target.ledger.entries(),
      target.snapshot(),
      target.coverage(),
      target.faults.list()
    ]),
    ...control,
    ...texts
  ].join('\n')

  expect(recorded).not.toContain(secretPart)
  expect(recorded).not.toContain(token)
  expect(recorded).not.toContain(encodeURIComponent(token))
}

const expectNotEmulated = async (response: Response, reason: string): Promise<string> => {
  expect(response.status).toBe(400)

  const text = await response.text()

  expect(JSON.parse(text)).toEqual({
    error: { type: 'not_emulated', message: expect.stringContaining(reason) }
  })

  return text
}

/**
 * Add a match-all fault, send the refused request, and prove: a 400 not-emulated with `reason`,
 * nothing written, the fault untouched, and the fault still answering the next valid request.
 * Answers the refusal's response text.
 */
const expectRefusedWithoutFault = async (
  target: TelegramEmulator,
  send: () => Promise<Response>,
  reason: string
): Promise<string> => {
  const seed = target.snapshot()

  target.faults.clear()
  target.faults.add({ kind: 'status', status: 503, count: 1 })

  const text = await expectNotEmulated(await send(), reason)
  const refused = target.ledger.entries().at(-1)

  expect(target.snapshot()).toEqual(seed)
  expect(target.faults.list()[0]).toMatchObject({ applied: 0, remaining: 1 })
  expect(refused).toMatchObject({ status: 400 })
  expect(refused?.notEmulated).toContain(reason)
  expect(refused?.fault).toBeUndefined()

  const next = await call(target, 'POST', `/bot${token}/getChat`, {
    body: { chat_id: '-1001000000001' }
  })

  expect(next.status).toBe(503)
  expect(target.faults.list()[0]).toMatchObject({ applied: 1, remaining: 0 })

  return text
}

/** A JSON text whose `\u0051` escape spells the token's last character only once parsed. */
const escapedToken = `${token.slice(0, -2)}\\u0051${token.slice(-1)}`

const escapedSecretPart = `${secretPart.slice(0, -2)}\\u0051${secretPart.slice(-1)}`

describe('manifest', () => {
  it('lists the four emulated routes, unverified connector routes citing every case', () => {
    expect(telegramEmulatorRoutes.map(route => [route.method, route.path, route.write])).toEqual([
      ['POST', '/bot{token}/getChat', false],
      ['GET', '/bot{token}/getFile', false],
      ['GET', '/file/bot{token}/{filePath}', false],
      ['POST', '/bot{token}/sendMessage', true]
    ])

    const caseIds = telegramConformanceCases.map(testCase => testCase.id)

    for (const route of telegramEmulatorRoutes) {
      expect(route.kind).toBe('connector')
      expect(route.evidence).toBe('unverified')
      expect(route.caseIds.length).toBeGreaterThan(0)
      expect(route.caseIds.every(id => caseIds.includes(id))).toBe(true)
    }

    expect(caseIds.every(id => telegramEmulatorRoutes.some(r => r.caseIds.includes(id)))).toBe(true)
  })

  it('seeds the fixture chat and file by default', async () => {
    const state = (await emulator()).snapshot()

    expect(state.chats.map(chat => String(chat.id))).toEqual([
      telegramConformanceFixtureSeeds.chatId
    ])
    expect(state.files.map(file => file.file_id)).toEqual([telegramConformanceFixtureSeeds.fileId])
    expect(state.sentMessages).toEqual([])
    expect(JSON.stringify(state)).not.toContain(telegramConformanceReplayBotToken)
  })
})

describe('drift: every fixture exchange answered byte for byte', () => {
  // Fixtures are copied as data; if a fixture changes, this fails until the emulator follows it.
  it.each(telegramConformanceFixtures.map(fixture => [fixture.id, fixture] as const))(
    '%s',
    async (_id, fixture) => {
      const target = await emulator()

      for (const [index, exchange] of fixture.exchanges.entries()) {
        const url = new URL(exchange.request.url)
        const body = exchange.request.body

        const response = await call(
          target,
          exchange.request.method,
          `${url.pathname}${url.search}`,
          body === undefined ? {} : { body }
        )

        const recorded = exchange.response

        if (isWireStreamResponse(recorded) || isWireBase64BodyResponse(recorded)) {
          throw new Error('Telegram fixtures record text bodies')
        }

        expect(response.status, `${fixture.id} #${index}`).toBe(recorded.status)
        expect(response.headers.get('content-type'), `${fixture.id} #${index}`).toBe(
          recorded.headers['content-type'] ?? null
        )
        expect(response.headers.get(emulatorEvidenceHeader)).toBe('unverified')
        expect(await response.text(), `${fixture.id} #${index}`).toBe(recorded.body)
      }

      expect(target.ledger.entries().every(entry => entry.notEmulated === undefined)).toBe(true)
      expect(JSON.stringify(target.ledger.entries())).not.toContain('yolk-synthetic-replay-token')
      expect(JSON.stringify(target.ledger.entries())).not.toContain(
        'yolk-conformance-invalid-token'
      )
    }
  )
})

describe('the bot token is required, never ledgered, and never echoed', () => {
  it.each([
    [
      'an unknown method',
      'POST',
      `/bot${token}/deleteMessage`,
      { body: { chat_id: '1' } },
      'no emulated Bot API route for this method and path'
    ],
    [
      'getMe',
      'GET',
      `/bot${token}/getMe`,
      {},
      'no emulated Bot API route for this method and path'
    ],
    [
      'a path without a method',
      'POST',
      `/bot${token}`,
      {},
      'no emulated Bot API route for this method and path'
    ],
    [
      'a path without a method, the token in its query value',
      'GET',
      `/bot${token}?q=${token}`,
      {},
      'no emulated Bot API route for this method and path'
    ],
    [
      'the secret part as the method segment',
      'POST',
      `/bot${token}/${secretPart}`,
      {},
      'no emulated Bot API route for this method and path'
    ],
    [
      'the secret part as a file path',
      'GET',
      `/file/bot${token}/${secretPart}`,
      {},
      'the request path repeats the credential'
    ],
    [
      'the secret part inside a file path',
      'GET',
      `/file/bot${token}/documents/${secretPart}.txt`,
      {},
      'the request path repeats the credential'
    ],
    ['a nested path', 'POST', `/bot${token}/getChat/extra`, {}, 'no emulated Bot API route'],
    [
      'GET getChat',
      'GET',
      `/bot${token}/getChat`,
      {},
      'no emulated Bot API route for this method and path'
    ],
    ['a file root', 'GET', `/file/bot${token}`, {}, 'no emulated Bot API route'],
    [
      'a token elsewhere in the path',
      'GET',
      `/api/${token}/getChat`,
      {},
      'no emulated Bot API route for this method and path'
    ],
    [
      'a token elsewhere in the path and in the query',
      'GET',
      `/api/${token}/getChat?q=${token}`,
      {},
      'no emulated Bot API route for this method and path'
    ],
    [
      'a percent-encoded token',
      'POST',
      `/bot${encodeURIComponent(token)}/deleteMessage`,
      {},
      'no emulated Bot API route for this method and path'
    ],
    [
      'the token in the query',
      'GET',
      `/bot${token}/getFile?file_id=${encodeURIComponent(token)}`,
      {},
      'the query repeats the credential'
    ],
    [
      'the token in a token query key',
      'POST',
      `/bot${token}/getChat?token=${token}`,
      { body: { chat_id: '1' } },
      'a query parameter this method does not take'
    ],
    [
      'the token as a query key',
      'POST',
      `/bot${token}/getChat?${token}=1`,
      { body: { chat_id: '1' } },
      'a query parameter this method does not take'
    ],
    [
      'the percent-encoded token as a query key',
      'POST',
      `/bot${token}/getChat?${encodeURIComponent(token)}=1`,
      { body: { chat_id: '1' } },
      'a query parameter this method does not take'
    ],
    [
      'the secret part as a query key on an unknown route',
      'GET',
      `/bot${token}/getMe?${secretPart}=1`,
      {},
      'no emulated Bot API route for this method and path'
    ],
    [
      'the token in the body',
      'POST',
      `/bot${token}/sendMessage`,
      { body: { ...sendBody, text: `hi ${token}` } },
      'the request body repeats the credential'
    ],
    [
      'the encoded token in the body',
      'POST',
      `/bot${token}/sendMessage`,
      { body: { ...sendBody, text: `hi ${encodeURIComponent(token)}` } },
      'the request body repeats the credential'
    ],
    [
      'the secret part in the body',
      'POST',
      `/bot${token}/sendMessage`,
      { body: { ...sendBody, text: `hi ${secretPart}` } },
      'the request body repeats the credential'
    ],
    [
      'a JSON-escaped token in a body value',
      'POST',
      `/bot${token}/sendMessage`,
      {
        rawBody: `{"chat_id":"-1001000000001","text":"hi ${escapedToken}","disable_web_page_preview":true}`
      },
      'the request body repeats the credential'
    ],
    [
      'a JSON-escaped secret part in a body value',
      'POST',
      `/bot${token}/sendMessage`,
      {
        rawBody: `{"chat_id":"-1001000000001","text":"hi ${escapedSecretPart}","disable_web_page_preview":true}`
      },
      'the request body repeats the credential'
    ],
    [
      'a JSON-escaped token as a body key',
      'POST',
      `/bot${token}/sendMessage`,
      {
        rawBody: `{"chat_id":"-1001000000001","text":"x","disable_web_page_preview":true,"${escapedToken}":1}`
      },
      'the request body repeats the credential'
    ],
    [
      'a JSON-escaped secret part as a body key on getChat',
      'POST',
      `/bot${token}/getChat`,
      { rawBody: `{"chat_id":"-1001000000001","${escapedSecretPart}":1}` },
      'the request body repeats the credential'
    ],
    [
      'a malformed token',
      'POST',
      `/botnot-a-token/getChat`,
      { body: { chat_id: '1' } },
      'no emulated Bot API route for this method and path'
    ],
    [
      'a token with a secret under 8 characters',
      'POST',
      `/bot1:abcdefg/getChat`,
      { body: { chat_id: '1' } },
      'no emulated Bot API route for this method and path'
    ],
    [
      'a missing token',
      'POST',
      '/bot/getChat',
      { body: { chat_id: '1' } },
      'no emulated Bot API route for this method and path'
    ],
    [
      'no bot prefix',
      'POST',
      '/getChat',
      { body: { chat_id: '1' } },
      'no emulated Bot API route for this method and path'
    ]
  ] as const)(
    '%s answers 400 not-emulated without the token and leaves the fault',
    async (_label, method, path, options, reason) => {
      const target = await emulator()

      const text = await expectRefusedWithoutFault(
        target,
        () => call(target, method, path, options),
        reason
      )

      // The refusal answered the constant or scrubbed reason; nothing was stored.
      expect(target.snapshot().sentMessages).toEqual([])
      expect(target.ledger.entries()[0]?.body).toBeUndefined()
      await expectNoToken(target, text)
    }
  )

  it('answers the recorded 401 for a token naming no bot on getChat only', async () => {
    const target = await emulator()
    const zero = '0:yolkZeroTokenSecretQ7'

    const unauthorized = await call(target, 'POST', `/bot${zero}/getChat`, {
      body: { chat_id: '-1001000000001' }
    })

    expect(unauthorized.status).toBe(401)
    expect(await unauthorized.json()).toEqual({
      ok: false,
      error_code: 401,
      description: 'Unauthorized'
    })

    await expectNotEmulated(
      await call(target, 'POST', `/bot${zero}/sendMessage`, { body: sendBody }),
      'names no bot'
    )
    await expectNotEmulated(
      await call(
        target,
        'GET',
        `/bot${zero}/getFile?file_id=BQACAgIAAxkDAAIC-yolk_synthetic_file_0001`
      ),
      'names no bot'
    )
    expect(target.snapshot().sentMessages).toEqual([])
    expect(JSON.stringify(target.ledger.entries())).not.toContain('yolkZeroTokenSecretQ7')
  })

  // Fail closed: a request whose raw path is not exactly an emulated route shape is unrecognised.
  // It is ledgered and answered with constant text only: the path `/<unrecognised>`, a standard
  // method or `<other>`, no query, no body, a constant reason. Nothing it carries is extracted.
  it.each([
    ['POST', `/bot${token}/deleteMessage`],
    ['POST', `/bot${token}`],
    ['POST', `/bot${token}/${secretPart}`],
    ['GET', `/api/${token}/getChat`],
    ['POST', `/bot${encodeURIComponent(token)}/deleteMessage`],
    ['GET', `//bot${token}/getChat?q=${secretPart}`],
    ['GET', `/api/bot${token}/x?q=${secretPart}`],
    // An encoded separator: no greedy search can swallow it, the path is simply not recognised.
    ['GET', `/api/${token}%2FgetChat?q=${token}`],
    ['GET', `/bot${token}%2FgetChat?q=${token}&${token}=1`],
    // A double-encoded separator.
    ['GET', `/api/${token}%252FgetChat?q=${token}`],
    ['POST', `/bot${token}%252FgetChat?q=${secretPart}`],
    // A malformed token ending in an encoded character (a token read with a trailing newline).
    ['POST', `/bot${token}%0A/getChat?q=${secretPart}`],
    ['GET', `/file/bot${token}%0A/documents/file_0.txt?q=${secretPart}`],
    // A malformed path carrying the token in the query only.
    ['POST', `/bot!/getChat?q=${token}&${encodeURIComponent(token)}=${secretPart}`],
    ['POST', `/bot${token}/getChat/extra?q=${token}`],
    // A percent-encoded file path character.
    ['GET', `/file/bot${token}/documents/file%200.txt?q=${token}`]
  ] as const)('%s %s is unrecognised and ledgered without request text', async (method, path) => {
    const target = await emulator()

    const text = await expectRefusedWithoutFault(
      target,
      () => call(target, method, path),
      'no emulated Bot API route for this method and path'
    )

    expect(target.ledger.entries()[0]).toEqual({
      seq: 1,
      method,
      path: '/<unrecognised>',
      query: {},
      status: 400,
      evidence: 'unknown-route',
      notEmulated: 'no emulated Bot API route for this method and path'
    })
    expect(target.coverage().unknownRouteRequests).toBe(1)
    await expectNoToken(target, text)
  })

  // The reviews' literal counterexamples, with their own tokens.
  it.each([
    [
      'GET',
      '/api/777000:Q7TelegramSecret%2FgetChat?q=777000:Q7TelegramSecret',
      '777000:Q7TelegramSecret'
    ],
    [
      'GET',
      '/api/777000:Q7TelegramSecret%252FgetChat?q=Q7TelegramSecret',
      '777000:Q7TelegramSecret'
    ],
    [
      'GET',
      '/bot777000:yolkEmulatorSecretPartQ9%0A/getChat?q=yolkEmulatorSecretPartQ9',
      '777000:yolkEmulatorSecretPartQ9'
    ],
    [
      'POST',
      '/bot%3F/sendMessage?777000:Q7TelegramSecret=Q7TelegramSecret',
      '777000:Q7TelegramSecret'
    ]
  ] as const)('%s %s leaks no part of %s', async (method, path, guarded) => {
    const target = await emulator()
    const secret = guarded.slice(guarded.indexOf(':') + 1)

    const text = await expectRefusedWithoutFault(
      target,
      () => call(target, method, path),
      'no emulated Bot API route for this method and path'
    )

    const control = await Promise.all(
      ['ledger', 'state', 'coverage', 'faults'].map(route =>
        target.fetch(new Request(`${origin}/_emulate/${route}`)).then(response => response.text())
      )
    )

    const recorded = [text, JSON.stringify(target.ledger.entries()), ...control].join('\n')

    expect(recorded).not.toContain(secret)
    expect(recorded).not.toContain(encodeURIComponent(guarded))
  })

  // A custom method is never quoted or recorded: an unrecognised request ledgers `<other>`.
  it('never records or quotes the method of an unrecognised request', async () => {
    const target = await emulator()
    const response = await call(target, secretPart, `/bot${token}/getChat`)

    const text = await expectNotEmulated(
      response,
      'no emulated Bot API route for this method and path'
    )

    expect(text.toLowerCase()).not.toContain(secretPart.toLowerCase())
    expect(target.ledger.entries()[0]).toMatchObject({ method: '<other>', path: '/<unrecognised>' })
    await expectNoToken(target, text)
  })

  // JSON numbers normalise (`1.2345678e7` parses to `12345678`): an all-digit secret part must
  // still never reach the ledger.
  it.each([
    ['getChat', { rawBody: '{"chat_id":8.7654321e7}' }],
    ['getChat', { rawBody: '{"chat_id":"-1001000000001","n":[8.7654321e7]}' }],
    [
      'sendMessage',
      {
        rawBody:
          '{"chat_id":"-1001000000001","text":"x","disable_web_page_preview":true,"n":87654321.0}'
      }
    ]
  ] as const)(
    'an exponent-notation number repeating a numeric secret part (%s %o)',
    async (method, options) => {
      // Digits that occur nowhere in the default seed, so any hit below is the leaked secret.
      const numericToken = '777000:87654321'
      const target = await emulator()
      const seed = target.snapshot()

      target.faults.add({
        kind: 'status',
        status: 503,
        count: 1,
        match: { route: `/bot{token}/${method}` }
      })

      await expectNotEmulated(
        await call(target, 'POST', `/bot${numericToken}/${method}`, options),
        'the request body repeats the credential'
      )

      expect(target.snapshot()).toEqual(seed)
      expect(target.ledger.entries()[0]?.body).toBeUndefined()
      expect(target.faults.list()[0]).toMatchObject({ applied: 0, remaining: 1 })

      const control = await Promise.all(
        ['ledger', 'state', 'coverage', 'faults'].map(path =>
          target.fetch(new Request(`${origin}/_emulate/${path}`)).then(response => response.text())
        )
      )

      expect(control.join('\n')).not.toContain('87654321')
    }
  )

  it('keeps every token out of the ledger, state, and coverage of a full session', async () => {
    const target = await emulator()
    const responses: Array<string> = []

    for (const [method, path, body] of [
      ['POST', `/bot${token}/getChat`, { chat_id: '-1001000000001' }],
      ['POST', `/bot${token}/getChat`, { chat_id: '-1009999999999' }],
      ['GET', `/bot${token}/getFile?file_id=BQACAgIAAxkDAAIC-yolk_synthetic_file_0001`, undefined],
      ['GET', `/file/bot${token}/documents/file_0.txt`, undefined],
      ['POST', `/bot${token}/sendMessage`, sendBody]
    ] as const) {
      const response = await call(target, method, path, body === undefined ? {} : { body })

      expect(response.status).toBeLessThan(500)
      responses.push(await response.text())
    }

    expect(target.ledger.entries().map(entry => entry.path)).toEqual([
      '/bot<redacted>/getChat',
      '/bot<redacted>/getChat',
      '/bot<redacted>/getFile',
      '/file/bot<redacted>/documents/file_0.txt',
      '/bot<redacted>/sendMessage'
    ])
    await expectNoToken(target, ...responses)
  })
})

describe('fail closed: 400 not-emulated, nothing written, a matching fault left unused', () => {
  it.each([
    [
      'getChat with an extra field',
      'POST',
      'getChat',
      { chat_id: '-1001000000001', x: 1 },
      'a body field this method does not take'
    ],
    ['getChat without chat_id', 'POST', 'getChat', {}, 'chat_id'],
    ['getChat with a numeric chat_id', 'POST', 'getChat', { chat_id: -1001000000001 }, 'chat_id'],
    ['getChat with a malformed chat_id', 'POST', 'getChat', { chat_id: 'not a chat' }, 'chat_id'],
    ['getFile of an unknown file', 'GET', 'getFile?file_id=unknown', undefined, 'did not receive'],
    ['getFile without file_id', 'GET', 'getFile', undefined, 'file_id'],
    [
      'getFile with an extra key',
      'GET',
      'getFile?file_id=a&x=1',
      undefined,
      'a query parameter this method does not take'
    ],
    ['getFile with a repeated key', 'GET', 'getFile?file_id=a&file_id=b', undefined, 'repeated'],
    [
      'sendMessage with previews on',
      'POST',
      'sendMessage',
      { ...sendBody, disable_web_page_preview: false },
      'disable_web_page_preview'
    ],
    [
      'sendMessage without the preview flag',
      'POST',
      'sendMessage',
      { chat_id: '-1001000000001', text: 'x' },
      'disable_web_page_preview'
    ],
    ['sendMessage with a token naming no bot', 'POST', 'sendMessage', sendBody, 'names no bot'],
    [
      'sendMessage with parse_mode',
      'POST',
      'sendMessage',
      { ...sendBody, parse_mode: 'HTML' },
      'a body field this method does not take'
    ],
    [
      'sendMessage with an empty text',
      'POST',
      'sendMessage',
      { ...sendBody, text: '' },
      'non-empty'
    ],
    [
      'sendMessage to an absent chat',
      'POST',
      'sendMessage',
      { ...sendBody, chat_id: '-1009999999999' },
      'not a member'
    ]
  ] as const)('%s', async (label, method, path, body, reason) => {
    const target = await emulator()
    const bot = label.includes('naming no bot') ? '0:yolkZeroTokenSecretQ7' : token

    await expectRefusedWithoutFault(
      target,
      () => call(target, method, `/bot${bot}/${path}`, body === undefined ? {} : { body }),
      reason
    )
    expect(target.snapshot().sentMessages).toEqual([])
  })

  it('refuses other content types, bodies on GET routes, and unknown file paths', async () => {
    const target = await emulator()

    await expectRefusedWithoutFault(
      target,
      () =>
        call(target, 'POST', `/bot${token}/sendMessage`, {
          rawBody: 'chat_id=1&text=x',
          contentType: 'application/x-www-form-urlencoded'
        }),
      'not JSON'
    )
    await expectRefusedWithoutFault(
      target,
      () =>
        call(target, 'POST', `/bot${token}/sendMessage`, {
          body: sendBody,
          contentType: 'text/plain'
        }),
      'application/json'
    )
    target.faults.clear()
    await expectNotEmulated(
      await call(target, 'GET', `/file/bot${token}/documents/other.txt`),
      'getFile did not answer'
    )
    expect(target.snapshot().sentMessages).toEqual([])
  })

  it('accepts content-type parameters and any non-empty text; sends are recorded in state', async () => {
    const target = await emulator()

    const sent = await call(target, 'POST', `/bot${token}/sendMessage`, {
      body: { ...sendBody, text: 'Another synthetic text' },
      contentType: 'application/json; charset=utf-8'
    })

    expect(sent.status).toBe(200)
    expect(await sent.json()).toMatchObject({
      ok: true,
      result: { message_id: 101, text: 'Another synthetic text', date: 1_790_000_000 }
    })
    expect(target.snapshot().sentMessages.map(message => message.message_id)).toEqual([101])
  })
})

const portsOver = (target: TelegramEmulator) =>
  Layer.mergeAll(
    connectorHttpClientsFromEffectHttpClientLayer.pipe(
      Layer.provide(InProcessHttpClient.layer([EmulatorRoute.handler(origin, target.fetch)]))
    ),
    staticCredentialResolverLayer(ApiKeyCredential.make({ key: token }))
  )

const sendThroughConnector = (target: TelegramEmulator) =>
  telegramSendMessageAction
    .executeTyped({
      integration: telegramConformanceIntegration('-1001000000001'),
      input: TelegramSendMessageInput.make({ message: 'synthetic text' })
    })
    .pipe(Effect.provide(portsOver(target)))

describe('faults', () => {
  it.effect('a 429 fault reaches the connector as telegram_rate_limited and sends nothing', () =>
    Effect.gen(function* () {
      const target = yield* Effect.promise(() => emulator())

      target.faults.add({
        kind: 'status',
        status: 429,
        headers: { 'retry-after': '2' },
        match: { route: '/bot{token}/sendMessage' },
        count: 1
      })

      const limited = yield* sendThroughConnector(target)

      expect(
        Predicate.isTagged(limited, 'Failure') ? [limited.error.code, limited.error.status] : []
      ).toEqual(['telegram_rate_limited', 429])
      expect(target.snapshot().sentMessages).toEqual([])
      expect(target.ledger.entries()[0]).toMatchObject({ status: 429, fault: 'status' })

      const sent = yield* sendThroughConnector(target)

      expect(Predicate.isTagged(sent, 'Success')).toBe(true)
      expect(target.snapshot().sentMessages).toHaveLength(1)
      yield* Effect.promise(() => expectNoToken(target))
    })
  )

  it('matches faults on the redacted path, and rejects invalid faults', async () => {
    const target = await emulator()

    target.faults.add({ kind: 'status', status: 502, match: { path: '/bot<redacted>/getChat' } })

    const faulted = await call(target, 'POST', `/bot${token}/getChat`, {
      body: { chat_id: '-1001000000001' }
    })

    expect(faulted.status).toBe(502)
    expect(await faulted.json()).toEqual({
      error: { type: 'emulator_fault', message: 'Emulator fault: status 502.' }
    })

    for (const fault of [
      { kind: 'status', status: 200 },
      { kind: 'status', status: 399 },
      { kind: 'status', status: 429, headers: { Location: '/x' } },
      { kind: 'truncate-after-chunks', chunks: 1 }
    ]) {
      // @ts-expect-error -- invalid input on purpose
      expect(() => target.faults.add(fault)).toThrow(TelegramEmulatorInputInvalid)
    }
  })
})

describe('clock-safe recovery', () => {
  it('a throwing clock fails only sendMessage (500, nothing sent), never recovery', async () => {
    const target = await emulator({
      now: () => {
        throw new Error('synthetic clock failure')
      }
    })

    const failed = await call(target, 'POST', `/bot${token}/sendMessage`, { body: sendBody })

    expect(failed.status).toBe(500)
    expect(failed.headers.get(emulatorEvidenceHeader)).toBe('unverified')
    expect(await failed.json()).toMatchObject({ error: { type: 'emulator_error' } })
    expect(target.ledger.entries()[0]).toMatchObject({
      status: 500,
      responseError: 'the route handler failed'
    })
    expect(target.snapshot().sentMessages).toEqual([])
    expect(target.snapshot().counters).toEqual({ nextMessageId: 101 })

    const chat = await call(target, 'POST', `/bot${token}/getChat`, {
      body: { chat_id: '-1001000000001' }
    })

    expect(chat.status).toBe(200)
    await expectNotEmulated(
      await call(target, 'POST', `/bot${token}/deleteMessage`),
      'no emulated Bot API route for this method and path'
    )

    await target.close()

    expect((await call(target, 'POST', `/bot${token}/getChat`)).status).toBe(503)
    await expectNoToken(target)
  })
})

describe('seeds and control plane', () => {
  it.each([
    [
      {
        files: [
          { file_id: 'f', file_unique_id: 'u', file_size: 3, file_path: 'a.txt', content: 'ab' }
        ]
      },
      'byte length'
    ],
    [
      {
        files: [
          { file_id: 'f', file_unique_id: 'u', file_size: 2, file_path: '../a.txt', content: 'ab' }
        ]
      },
      'relative path'
    ],
    [{ chats: [sendChat(), sendChat()] }, 'duplicate chat id'],
    [{ bot: { id: 0, first_name: 'x', username: 'x' } }, 'positive'],
    [{ token: 'x' }, 'token']
  ])('rejects an invalid seed (%o)', async (seed, reason) => {
    // @ts-expect-error -- invalid input on purpose
    await expect(makeTelegramEmulator({ seed })).rejects.toThrow(reason)
  })

  it('serves the ledger, faults, state, seed, reset, and coverage; reset drops sent messages', async () => {
    const target = await emulator()

    const control = (method: string, path: string, body?: unknown) =>
      target.fetch(
        new Request(`${origin}/_emulate/${path}`, {
          method,
          body: body === undefined ? undefined : JSON.stringify(body)
        })
      )

    await call(target, 'POST', `/bot${token}/sendMessage`, { body: sendBody })
    await call(target, 'POST', `/bot${token}/deleteMessage`)

    expect(await (await control('GET', 'coverage')).json()).toMatchObject({
      unknownRouteRequests: 1,
      notEmulatedRequests: 1
    })

    const state: unknown = await (await control('GET', 'state')).json()

    expect(state).toMatchObject({
      state: { sentMessages: [{ message_id: 101 }] },
      ledgerEntries: 2
    })
    expect(JSON.stringify(state)).not.toContain(secretPart)

    expect(await (await control('POST', 'reset')).json()).toEqual({ reset: true })
    expect(target.snapshot().sentMessages).toEqual([])
    expect(target.snapshot().counters).toEqual({ nextMessageId: 101 })

    expect(await (await control('POST', 'seed', { profile: 'empty' })).json()).toEqual({
      seeded: true,
      chats: 0,
      files: 0
    })
    expect((await control('POST', 'seed', { profile: 'empty', extra: 1 })).status).toBe(400)
    expect((await control('GET', 'reset')).status).toBe(405)
    expect(target.ledger.entries()).toEqual([])
  })
})

function sendChat() {
  return {
    id: -1001000000001,
    title: 'Synthetic practice group',
    type: 'supergroup',
    permissions: { can_send_messages: true },
    accent_color_id: 0,
    max_reaction_count: 11
  }
}

describe('fault match.route', () => {
  it('rejects one naming no manifest row, at faults.add and over the control plane', async () => {
    const target = await emulator()
    const fault = { kind: 'status', status: 503, match: { route: '/bot{token}/getMe' } } as const

    expect(() => target.faults.add(fault)).toThrow(TelegramEmulatorInputInvalid)
    expect(() => target.faults.add(fault)).toThrow(
      'match.route must name a manifest row of this emulator'
    )

    const posted = await target.fetch(
      new Request(`${origin}/_emulate/faults`, { method: 'POST', body: JSON.stringify(fault) })
    )

    expect(posted.status).toBe(400)
    expect(await posted.json()).toEqual({
      error: {
        type: 'emulator_error',
        message: 'invalid fault: match.route must name a manifest row of this emulator'
      }
    })
    expect(target.faults.list()).toEqual([])
  })
})
