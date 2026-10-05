import { describe, expect, it } from '@effect/vitest'
import { Arbitrary, Effect, Layer, Predicate, Result } from 'effect'
import * as Schema from 'effect/Schema'
import { resolveTools } from '@yolk-sdk/agent/tools'
import {
  ConnectorError,
  ConnectorHttpClient,
  ConnectorHttpResponse,
  CredentialResolver,
  makeCredentialBinding,
  makeIntegration,
  OAuthCredential,
  type ConnectorHttpRequest
} from '@yolk-sdk/connectors'
import { makeConnectorToolModule } from '@yolk-sdk/connectors/agent'
import {
  gmailGetMessageAction,
  GmailGetMessageInput,
  gmailGetThreadAction,
  GmailGetThreadInput,
  gmailListThreadsAction,
  GmailListThreadsInput,
  GmailListThreadsOutput,
  GmailMetadataHeaderName,
  GmailMetadataHeaders,
  gmailMetadataHeadersMaxItems,
  GoogleConnector,
  googleGmailReadonlyScopes,
  googleOAuthSlotId
} from '@yolk-sdk/connectors/google'

const integration = makeIntegration({
  connectorId: 'google',
  credentialBindings: [
    makeCredentialBinding({ slotId: googleOAuthSlotId, credentialRef: 'google-account' })
  ]
})

type Host = {
  readonly layer: Layer.Layer<ConnectorHttpClient | CredentialResolver>
  readonly requests: Array<ConnectorHttpRequest>
  readonly scopes: Array<ReadonlyArray<string> | undefined>
}

const makeHost = (status: number, body: string): Host => {
  const requests: Array<ConnectorHttpRequest> = []
  const scopes: Array<ReadonlyArray<string> | undefined> = []

  const layer = Layer.mergeAll(
    Layer.succeed(CredentialResolver, {
      resolve: request => {
        scopes.push(request.slot.requiredScopes)

        return Effect.succeed(
          OAuthCredential.make({
            provider: 'google',
            accessToken: 'token',
            expiresAt: 4_000_000_000_000
          })
        )
      }
    }),
    Layer.succeed(ConnectorHttpClient, {
      request: request => {
        requests.push(request)

        return Effect.succeed(ConnectorHttpResponse.make({ status, headers: {}, body }))
      }
    })
  )

  return { layer, requests, scopes }
}

const gmailApi = 'https://gmail.googleapis.com/gmail/v1/users/me'

const queryOf = (request: ConnectorHttpRequest | undefined) =>
  new URL(request?.url ?? 'https://invalid.test').searchParams

const message = {
  id: 'm1',
  threadId: 't1',
  labelIds: ['INBOX'],
  payload: {
    mimeType: 'text/plain',
    headers: [
      { name: 'From', value: 'sender@example.test' },
      { name: 'Subject', value: 'Hello' },
      { name: 'List-Unsubscribe', value: '<https://example.test/u>' },
      { name: 'X-Mailer', value: 'synthetic' }
    ]
  }
}

describe('gmail.list_threads', () => {
  it.effect('lists threads with the gmail.list filters and decodes the page', () =>
    Effect.gen(function* () {
      const host = makeHost(
        200,
        JSON.stringify({
          threads: [
            { id: 't1', snippet: 'First', historyId: '11', extra: 'dropped' },
            { id: 't2' }
          ],
          nextPageToken: 'page-2',
          resultSizeEstimate: 7
        })
      )

      const result = yield* gmailListThreadsAction
        .execute({
          integration,
          input: {
            query: 'from:a OR from:b',
            labelId: 'INBOX',
            maxResults: 2,
            pageToken: 'page-1',
            isRead: false,
            isFlagged: true
          }
        })
        .pipe(Effect.provide(host.layer))

      if (!Predicate.isTagged(result, 'Success')) return expect.fail('expected a success')

      expect(result.value).toBeInstanceOf(GmailListThreadsOutput)
      expect(result.value).toEqual({
        threads: [{ id: 't1', snippet: 'First', historyId: '11' }, { id: 't2' }],
        nextPageToken: 'page-2',
        resultSizeEstimate: 7
      })
      expect(host.requests).toHaveLength(1)
      expect(host.requests[0]).toMatchObject({
        method: 'GET',
        url: `${gmailApi}/threads?q=%28from%3Aa+OR+from%3Ab%29+is%3Aunread+is%3Astarred&labelIds=INBOX&maxResults=2&pageToken=page-1`
      })
      expect(host.scopes).toEqual([[...googleGmailReadonlyScopes]])
    })
  )

  it.effect('sends no query without filters and accepts an empty mailbox', () =>
    Effect.gen(function* () {
      const host = makeHost(200, JSON.stringify({ resultSizeEstimate: 0 }))

      const result = yield* gmailListThreadsAction
        .executeTyped({ integration, input: GmailListThreadsInput.make({}) })
        .pipe(Effect.provide(host.layer))

      expect(result).toMatchObject({ _tag: 'Success', value: { resultSizeEstimate: 0 } })
      expect(host.requests[0]?.url).toBe(`${gmailApi}/threads`)
    })
  )

  it.effect('maps provider failures like the other Gmail reads', () =>
    Effect.gen(function* () {
      const cases: ReadonlyArray<readonly [number, string]> = [
        [401, 'google_unauthorized'],
        [404, 'google_not_found'],
        [429, 'google_rate_limited'],
        [500, 'gmail_list_threads_failed']
      ]

      for (const [status, code] of cases) {
        const host = makeHost(status, JSON.stringify({ error: { message: 'Nope' } }))

        const result = yield* gmailListThreadsAction
          .execute({ integration, input: {} })
          .pipe(Effect.provide(host.layer))

        expect(result).toMatchObject({
          _tag: 'Failure',
          error: { code, status, message: 'Gmail list threads failed: Nope' }
        })
      }
    })
  )

  it.effect('fails validation on a page that does not decode', () =>
    Effect.gen(function* () {
      const host = makeHost(200, JSON.stringify({ threads: [{ snippet: 'no id' }] }))

      const error = yield* gmailListThreadsAction
        .execute({ integration, input: {} })
        .pipe(Effect.provide(host.layer), Effect.flip)

      expect(error).toBeInstanceOf(ConnectorError)
      expect(error).toMatchObject({ cause: 'validation_failed' })
    })
  )

  it.effect('is a read action registered on the connector with an object schema', () =>
    Effect.gen(function* () {
      const host = makeHost(200, '{}')

      const tools = yield* resolveTools(
        [makeConnectorToolModule(GoogleConnector, { integration, layer: host.layer })],
        {}
      )

      expect(GoogleConnector.actions).toContain(gmailListThreadsAction)
      expect(gmailListThreadsAction.access ?? 'read').toBe('read')
      expect(
        tools.tools.find(tool => tool.name === 'gmail.list_threads')?.parameters
      ).toMatchObject({ type: 'object' })
    })
  )
})

describe('Gmail metadataHeaders', () => {
  it.effect('sends one metadataHeaders parameter per name on get_message', () =>
    Effect.gen(function* () {
      const host = makeHost(200, JSON.stringify(message))

      const result = yield* gmailGetMessageAction
        .execute({
          integration,
          input: { id: 'm/1', format: 'metadata', metadataHeaders: ['From', 'List-Unsubscribe'] }
        })
        .pipe(Effect.provide(host.layer))

      expect(result._tag).toBe('Success')
      expect(host.requests[0]?.url).toBe(
        `${gmailApi}/messages/m%2F1?format=metadata&metadataHeaders=From&metadataHeaders=List-Unsubscribe`
      )
    })
  )

  it.effect('leaves get_message and get_thread requests unchanged without metadataHeaders', () =>
    Effect.gen(function* () {
      const host = makeHost(200, JSON.stringify(message))

      yield* gmailGetMessageAction
        .executeTyped({ integration, input: GmailGetMessageInput.make({ id: 'm1' }) })
        .pipe(Effect.provide(host.layer))

      yield* gmailGetMessageAction
        .executeTyped({
          integration,
          input: GmailGetMessageInput.make({ id: 'm1', format: 'metadata' })
        })
        .pipe(Effect.provide(host.layer))

      const thread = yield* gmailGetThreadAction
        .executeTyped({
          integration,
          input: GmailGetThreadInput.make({ threadId: 't1', format: 'metadata' })
        })
        .pipe(
          Effect.provide(makeHost(200, JSON.stringify({ id: 't1', messages: [message] })).layer)
        )

      expect(host.requests.map(request => request.url)).toEqual([
        `${gmailApi}/messages/m1`,
        `${gmailApi}/messages/m1?format=metadata`
      ])
      // The default conversation allowlist keeps From and Subject only.
      expect(thread).toMatchObject({
        _tag: 'Success',
        value: {
          messages: [
            {
              headers: [
                { name: 'From', value: 'sender@example.test' },
                { name: 'Subject', value: 'Hello' }
              ]
            }
          ]
        }
      })
    })
  )

  it.effect('keeps exactly the selected headers on get_thread', () =>
    Effect.gen(function* () {
      const host = makeHost(200, JSON.stringify({ id: 't1', historyId: '9', messages: [message] }))

      const result = yield* gmailGetThreadAction
        .execute({
          integration,
          input: {
            threadId: 't1',
            format: 'metadata',
            metadataHeaders: ['list-unsubscribe', 'From']
          }
        })
        .pipe(Effect.provide(host.layer))

      expect(host.requests[0]?.url).toBe(
        `${gmailApi}/threads/t1?format=metadata&metadataHeaders=list-unsubscribe&metadataHeaders=From`
      )
      expect(result).toMatchObject({
        _tag: 'Success',
        value: {
          id: 't1',
          messages: [
            {
              id: 'm1',
              headers: [
                { name: 'From', value: 'sender@example.test' },
                { name: 'List-Unsubscribe', value: '<https://example.test/u>' }
              ]
            }
          ]
        }
      })
    })
  )

  it.effect(
    'rejects metadataHeaders outside format metadata before any credential or request',
    () =>
      Effect.gen(function* () {
        const host = makeHost(200, JSON.stringify(message))

        const invalidMessages: ReadonlyArray<unknown> = [
          { id: 'm1', metadataHeaders: ['From'] },
          { id: 'm1', format: 'full', metadataHeaders: ['From'] },
          { id: 'm1', format: 'raw', metadataHeaders: ['From'] },
          { id: 'm1', format: 'minimal', metadataHeaders: ['From'] },
          { id: 'm1', format: 'metadata', metadataHeaders: [] },
          { id: 'm1', format: 'metadata', metadataHeaders: [''] },
          { id: 'm1', format: 'metadata', metadataHeaders: ['From:'] },
          { id: 'm1', format: 'metadata', metadataHeaders: ['Reply To'] },
          { id: 'm1', format: 'metadata', metadataHeaders: ['Fr\u00f6m'] },
          { id: 'm1', format: 'metadata', metadataHeaders: ['X'.repeat(129)] },
          {
            id: 'm1',
            format: 'metadata',
            metadataHeaders: Array.from(
              { length: gmailMetadataHeadersMaxItems + 1 },
              (_, index) => `X-${index}`
            )
          }
        ]

        for (const input of invalidMessages) {
          const error = yield* gmailGetMessageAction
            .execute({ integration, input })
            .pipe(Effect.provide(host.layer), Effect.flip)

          expect(error).toMatchObject({ cause: 'validation_failed' })
        }

        for (const format of ['full', 'minimal']) {
          const error = yield* gmailGetThreadAction
            .execute({ integration, input: { threadId: 't1', format, metadataHeaders: ['From'] } })
            .pipe(Effect.provide(host.layer), Effect.flip)

          expect(error).toMatchObject({ cause: 'validation_failed' })
        }

        expect(host.requests).toHaveLength(0)
        expect(host.scopes).toHaveLength(0)
      })
  )

  it('makes metadataHeaders outside format metadata unconstructible', () => {
    expect(() =>
      GmailGetMessageInput.make({ id: 'm1', format: 'full', metadataHeaders: ['From'] })
    ).toThrow()
    expect(() =>
      GmailGetThreadInput.make({ threadId: 't1', format: 'minimal', metadataHeaders: ['From'] })
    ).toThrow()

    const decoded = Schema.decodeUnknownResult(GmailGetMessageInput)({
      id: 'm1',
      metadataHeaders: ['From']
    })

    expect(Result.isFailure(decoded) ? decoded.failure.message : 'decoded').toContain(
      "metadataHeaders requires format 'metadata'"
    )
    expect(
      GmailGetMessageInput.make({ id: 'm1', format: 'metadata', metadataHeaders: ['From'] })
        .metadataHeaders
    ).toEqual(['From'])
  })

  it.effect(
    'treats a model-sent null metadataHeaders as omitted and rejects a bad combination',
    () =>
      Effect.gen(function* () {
        const host = makeHost(200, JSON.stringify(message))

        const tools = yield* resolveTools(
          [makeConnectorToolModule(GoogleConnector, { integration, layer: host.layer })],
          {}
        )

        const omitted = yield* tools.execute({
          id: 'call_1',
          name: 'gmail.get_message',
          params: { id: 'm1', format: 'full', metadataHeaders: null }
        })

        const rejected = yield* tools.execute({
          id: 'call_2',
          name: 'gmail.get_message',
          params: { id: 'm1', format: 'full', metadataHeaders: ['From'] }
        })

        expect(omitted.isError).not.toBe(true)
        expect(rejected.isError).toBe(true)
        expect(JSON.stringify(rejected)).toContain("metadataHeaders requires format 'metadata'")
        expect(host.requests.map(request => request.url)).toEqual([
          `${gmailApi}/messages/m1?format=full`
        ])
      })
  )
})

// Properties.

const isHeaderName = Schema.is(GmailMetadataHeaderName)

const nonMetadataFormat = Schema.Literals(['minimal', 'full', 'raw'])

const anyText = Arbitrary.schema(Schema.String)

const selection = Arbitrary.schema(GmailMetadataHeaders)

// Selections mixing the sample message's header names (in any case) with arbitrary names.
const mixedSelection = Arbitrary.schema(
  Schema.Array(
    Schema.Union([
      Schema.Literals(['From', 'from', 'SUBJECT', 'List-Unsubscribe', 'x-mailer', 'Date']),
      GmailMetadataHeaderName
    ])
  ).check(Schema.isBetweenLength(1, gmailMetadataHeadersMaxItems))
)

const propertyOptions = { arbitrary: { runs: 100 } }

describe('Gmail metadataHeaders properties', () => {
  it.prop(
    'accepts exactly the printable-ASCII names without a colon of 1 to 128 characters',
    [anyText],
    ([text]) => {
      expect(isHeaderName(text)).toBe(/^[\x21-\x39\x3b-\x7e]{1,128}$/.test(text))
    },
    propertyOptions
  )

  it.effect.prop(
    'sends every selected name once, in order, with format metadata',
    [selection],
    ([names]) =>
      Effect.gen(function* () {
        const host = makeHost(200, JSON.stringify(message))

        yield* gmailGetMessageAction
          .execute({ integration, input: { id: 'm1', format: 'metadata', metadataHeaders: names } })
          .pipe(Effect.provide(host.layer))

        const query = queryOf(host.requests[0])

        expect(host.requests).toHaveLength(1)
        expect(query.get('format')).toBe('metadata')
        expect(query.getAll('metadataHeaders')).toEqual([...names])
        expect([...query.keys()].filter(key => key !== 'metadataHeaders')).toEqual(['format'])
      }),
    propertyOptions
  )

  it.effect.prop(
    'rejects any selection with another format, sending nothing',
    [selection, Arbitrary.schema(nonMetadataFormat)],
    ([names, format]) =>
      Effect.gen(function* () {
        const host = makeHost(200, JSON.stringify(message))

        const result = yield* gmailGetMessageAction
          .execute({ integration, input: { id: 'm1', format, metadataHeaders: names } })
          .pipe(Effect.provide(host.layer), Effect.result)

        expect(Predicate.isTagged(result, 'Failure')).toBe(true)
        expect(host.requests).toHaveLength(0)
      }),
    propertyOptions
  )

  it.effect.prop(
    'keeps on get_thread exactly the returned headers whose names were selected',
    [mixedSelection],
    ([names]) =>
      Effect.gen(function* () {
        const host = makeHost(200, JSON.stringify({ id: 't1', messages: [message] }))

        const result = yield* gmailGetThreadAction
          .execute({
            integration,
            input: { threadId: 't1', format: 'metadata', metadataHeaders: names }
          })
          .pipe(Effect.provide(host.layer))

        const selected = new Set(names.map(name => name.toLowerCase()))

        expect(result).toMatchObject({
          _tag: 'Success',
          value: {
            messages: [
              {
                headers: message.payload.headers.filter(header =>
                  selected.has(header.name.toLowerCase())
                )
              }
            ]
          }
        })
      }),
    propertyOptions
  )
})
