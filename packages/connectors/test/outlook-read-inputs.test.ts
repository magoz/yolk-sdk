import { describe, expect, it } from '@effect/vitest'
import { Effect, Layer, Schema } from 'effect'
import { resolveTools } from '@yolk-sdk/agent/tools'
import {
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
  MicrosoftConnector,
  microsoftOAuthSlotId,
  OutlookListMessagesInput,
  OutlookSearchMessagesInput
} from '@yolk-sdk/connectors/microsoft'

const integration = makeIntegration({
  connectorId: 'microsoft',
  credentialBindings: [
    makeCredentialBinding({ slotId: microsoftOAuthSlotId, credentialRef: 'microsoft-account' })
  ]
})

const makeHost = (body = '{"value":[{"id":"message-1","subject":"Car offer"}]}', status = 200) => {
  const requests: Array<ConnectorHttpRequest> = []
  const layer = Layer.mergeAll(
    Layer.succeed(CredentialResolver, {
      resolve: () =>
        Effect.succeed(
          OAuthCredential.make({
            _tag: 'OAuthCredential',
            provider: 'microsoft',
            accessToken: 'token',
            expiresAt: 4_000_000_000_000
          })
        )
    }),
    Layer.succeed(ConnectorHttpClient, {
      request: request => {
        requests.push(request)
        return Effect.succeed(ConnectorHttpResponse.make({ status, headers: {}, body }))
      }
    })
  )
  return { layer, requests }
}

const execute = (name: string, params: Record<string, unknown>, host = makeHost()) =>
  Effect.gen(function* () {
    const tools = yield* resolveTools(
      [makeConnectorToolModule(MicrosoftConnector, { integration, layer: host.layer })],
      {}
    )
    const result = yield* tools.execute({ id: 'call-1', name, params })
    return { result, requests: host.requests }
  })

const names = ['outlook.search_messages', 'outlook.list_messages']

describe('Outlook read input compatibility', () => {
  it.effect('registers provider-facing object schemas', () =>
    Effect.gen(function* () {
      const host = makeHost()
      const tools = yield* resolveTools(
        [makeConnectorToolModule(MicrosoftConnector, { integration, layer: host.layer })],
        {}
      )
      for (const name of names) {
        expect(tools.tools.find(tool => tool.name === name)?.parameters).toMatchObject({
          type: 'object'
        })
      }
    })
  )

  for (const name of names) {
    for (const absent of [undefined, null, '', '   ']) {
      it.effect(
        `${name} defaults absent mailbox, folder and cursor (${JSON.stringify(absent)})`,
        () =>
          Effect.gen(function* () {
            const { result, requests } = yield* execute(name, {
              query: 'car offer',
              ...(absent === undefined
                ? {}
                : { mailbox: absent, folderId: absent, nextLink: absent }),
              top: null
            })
            expect(result.isError).not.toBe(true)
            expect(result.structuredContent).toMatchObject({ messages: [{ id: 'message-1' }] })
            expect(requests).toHaveLength(1)
            const url = new URL(requests[0]?.url ?? '')
            expect(url.pathname).toBe('/v1.0/me/messages')
            expect(url.searchParams.has('$top')).toBe(false)
          })
      )
    }

    it.effect(`${name} also normalizes placeholders for direct connector callers`, () =>
      Effect.gen(function* () {
        const host = makeHost()
        const result = yield* MicrosoftConnector.invoke({
          integration,
          action: name,
          input: { query: 'car', mailbox: null, folderId: '', top: null, nextLink: null }
        }).pipe(Effect.provide(host.layer))
        expect(result).toMatchObject({
          _tag: 'Success',
          value: { messages: [{ id: 'message-1' }] }
        })
        expect(host.requests).toHaveLength(1)
        expect(new URL(host.requests[0]?.url ?? '').pathname).toBe('/v1.0/me/messages')
      })
    )

    it.effect(`${name} preserves an explicit mailbox, folder and page size`, () =>
      Effect.gen(function* () {
        const { result, requests } = yield* execute(name, {
          query: 'car offer',
          mailbox: 'shared@example.com',
          folderId: 'folder/id+1',
          top: 50,
          nextLink: null
        })
        expect(result.isError).not.toBe(true)
        expect(requests).toHaveLength(1)
        const url = new URL(requests[0]?.url ?? '')
        expect(url.pathname).toBe(
          '/v1.0/users/shared%40example.com/mailFolders/folder%2Fid%2B1/messages'
        )
        expect(url.searchParams.get('$top')).toBe('50')
        if (name === 'outlook.search_messages') {
          expect(url.searchParams.get('$search')).toBe('"car offer"')
        }
      })
    )

    it.effect(`${name} replays a returned pagination URL unchanged`, () =>
      Effect.gen(function* () {
        const nextLink =
          'https://graph.microsoft.com/v1.0/users/shared%40example.com/mailFolders/inbox/messages?$skiptoken=opaque%2B%2F%3D&$top=25'
        const params = { query: 'car', mailbox: 'shared@example.com', folderId: 'inbox' }
        const first = yield* execute(
          name,
          params,
          makeHost(JSON.stringify({ value: [], '@odata.nextLink': nextLink }))
        )
        expect(first.result.structuredContent).toMatchObject({ nextLink })
        const second = yield* execute(name, { ...params, nextLink })
        expect(second.result.isError).not.toBe(true)
        expect(second.requests).toMatchObject([{ method: 'GET', url: nextLink }])
        expect(second.requests).toHaveLength(1)
      })
    )

    for (const nextLink of [
      'not-a-url',
      'https://evil.example/v1.0/me/messages?$skip=25',
      'http://graph.microsoft.com/v1.0/me/messages?$skip=25',
      'https://graph.microsoft.com/beta/me/messages?$skip=25',
      'https://graph.microsoft.com/v1.0/users/other%40example.com/messages?$skip=25',
      'https://graph.microsoft.com/v1.0/me/mailFolders/inbox/messages?$skip=25',
      'https://graph.microsoft.com/v1.0/me/drive/root/children?$skip=25'
    ]) {
      it.effect(`${name} rejects invalid or mismatched cursors: ${nextLink}`, () =>
        Effect.gen(function* () {
          const host = makeHost()
          const result = yield* MicrosoftConnector.invoke({
            integration,
            action: name,
            input: { query: 'car', nextLink }
          }).pipe(Effect.provide(host.layer), Effect.result)
          expect(result).toMatchObject({ _tag: 'Failure', failure: { cause: 'validation_failed' } })
          expect(host.requests).toEqual([])
        })
      )
    }

    for (const params of [
      { nextLink: 1 },
      { folderId: false },
      { mailbox: {} },
      { top: 0 },
      { top: 1001 },
      { top: 1.5 },
      { top: '25' }
    ]) {
      it.effect(`${name} rejects invalid types and page sizes: ${JSON.stringify(params)}`, () =>
        Effect.gen(function* () {
          const { result, requests } = yield* execute(name, { query: 'car', ...params })
          expect(result.isError).toBe(true)
          expect(result.structuredContent).toMatchObject({ reason: 'validation' })
          expect(requests).toEqual([])
        })
      )
    }

    for (const mailbox of [null, '', '   ']) {
      it.effect(
        `${name} still requires a mailbox for application access (${JSON.stringify(mailbox)})`,
        () =>
          Effect.gen(function* () {
            const host = makeHost()
            const result = yield* MicrosoftConnector.invoke({
              integration: makeIntegration({
                connectorId: 'microsoft',
                credentialBindings: integration.credentialBindings,
                config: { mailboxAccessMode: 'application' }
              }),
              action: name,
              input: { query: 'car', mailbox }
            }).pipe(Effect.provide(host.layer), Effect.result)
            expect(result).toMatchObject({
              _tag: 'Failure',
              failure: { cause: 'validation_failed' }
            })
            expect(host.requests).toEqual([])
          })
      )
    }

    it.effect(`${name} preserves provider failures as error tool results`, () =>
      Effect.gen(function* () {
        const { result, requests } = yield* execute(
          name,
          { query: 'car', nextLink: null },
          makeHost('{"error":{"code":"ErrorAccessDenied","message":"Denied"}}', 403)
        )
        expect(requests).toHaveLength(1)
        expect(result.isError).toBe(true)
        expect(result.structuredContent).toMatchObject({
          code: 'microsoft_unauthorized',
          status: 403
        })
      })
    )
  }

  for (const absent of [null, '', '   ']) {
    it.effect(`list omits absent filters and ordering (${JSON.stringify(absent)})`, () =>
      Effect.gen(function* () {
        const { result, requests } = yield* execute('outlook.list_messages', {
          filter: absent,
          orderBy: absent
        })
        expect(result.isError).not.toBe(true)
        const url = new URL(requests[0]?.url ?? '')
        expect(url.searchParams.has('$filter')).toBe(false)
        expect(url.searchParams.has('$orderby')).toBe(false)
      })
    )
  }

  it.effect('list preserves real filters and ordering without trimming', () =>
    Effect.gen(function* () {
      const { result, requests } = yield* execute('outlook.list_messages', {
        filter: ' isRead eq false ',
        orderBy: ' receivedDateTime desc ',
        top: 25
      })
      expect(result.isError).not.toBe(true)
      const url = new URL(requests[0]?.url ?? '')
      expect(url.searchParams.get('$filter')).toBe(' isRead eq false ')
      expect(url.searchParams.get('$orderby')).toBe(' receivedDateTime desc ')
    })
  )

  for (const params of [{}, { query: null }]) {
    it.effect(`search still requires a string query: ${JSON.stringify(params)}`, () =>
      Effect.gen(function* () {
        const { result, requests } = yield* execute('outlook.search_messages', {
          ...params,
          nextLink: null
        })
        expect(result.isError).toBe(true)
        expect(requests).toEqual([])
      })
    )
  }

  for (const { name, decode } of [
    { name: 'list', decode: Schema.decodeUnknownEffect(OutlookListMessagesInput) },
    { name: 'search', decode: Schema.decodeUnknownEffect(OutlookSearchMessagesInput) }
  ]) {
    it.effect(`${name} decodes nulls to strict optional values`, () =>
      Effect.gen(function* () {
        const decoded = yield* decode({
          query: 'car',
          mailbox: null,
          folderId: null,
          top: null,
          nextLink: null
        })
        expect(decoded.mailbox).toBeUndefined()
        expect(decoded.folderId).toBeUndefined()
        expect(decoded.top).toBeUndefined()
        expect(decoded.nextLink).toBeUndefined()
      })
    )
  }
})
