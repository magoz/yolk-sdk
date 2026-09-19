import { describe, expect, it } from '@effect/vitest'
import { Chunk, Effect, Layer, Predicate, Schema } from 'effect'
import {
  ConnectorHttpClient,
  ConnectorHttpResponse,
  CredentialResolver,
  makeCredentialBinding,
  makeIntegration,
  OAuthCredential,
  type ConnectorHttpRequest
} from '@yolk-sdk/connectors'
import {
  MicrosoftConnector,
  microsoftGraphMailboxSettingsReadScope,
  microsoftGraphMailboxSettingsReadWriteScope,
  microsoftOAuthSlotId,
  outlookCreateCategoryAction,
  outlookDeleteCategoryAction,
  outlookListCategoriesAction,
  outlookModifyCategoriesAction,
  outlookSetCategoriesAction,
  OutlookListCategoriesOutput
} from '@yolk-sdk/connectors/microsoft'

const integration = makeIntegration({
  connectorId: 'microsoft',
  credentialBindings: [
    makeCredentialBinding({ slotId: microsoftOAuthSlotId, credentialRef: 'microsoft-account' })
  ]
})

const makeHost = (body = '{}', status = 200) => {
  const requests: Array<ConnectorHttpRequest> = []
  const scopes: Array<ReadonlyArray<string> | undefined> = []

  const layer = Layer.mergeAll(
    Layer.succeed(CredentialResolver, {
      resolve: request => {
        scopes.push(request.slot.requiredScopes)

        return Effect.succeed(
          OAuthCredential.make({
            provider: 'microsoft',
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

const makeQueuedHost = (
  responses: ReadonlyArray<{ readonly body: string; readonly status: number }>
) => {
  const requests: Array<ConnectorHttpRequest> = []
  const scopes: Array<ReadonlyArray<string> | undefined> = []
  let index = 0

  const layer = Layer.mergeAll(
    Layer.succeed(CredentialResolver, {
      resolve: request => {
        scopes.push(request.slot.requiredScopes)

        return Effect.succeed(
          OAuthCredential.make({
            provider: 'microsoft',
            accessToken: 'token',
            expiresAt: 4_000_000_000_000
          })
        )
      }
    }),
    Layer.succeed(ConnectorHttpClient, {
      request: request => {
        requests.push(request)
        const response = responses[index] ?? { body: '{}', status: 200 }
        index += 1

        return Effect.succeed(
          ConnectorHttpResponse.make({ status: response.status, headers: {}, body: response.body })
        )
      }
    })
  )

  return { layer, requests, scopes }
}

const categoryActions = [
  outlookListCategoriesAction,
  outlookCreateCategoryAction,
  outlookDeleteCategoryAction,
  outlookSetCategoriesAction,
  outlookModifyCategoriesAction
]

describe('Outlook category actions', () => {
  it.effect('registers category actions with explicit access metadata', () =>
    Effect.gen(function* () {
      expect(categoryActions.map(action => action.id)).toEqual([
        'outlook.list_categories',
        'outlook.create_category',
        'outlook.delete_category',
        'outlook.set_categories',
        'outlook.modify_categories'
      ])
      expect(categoryActions.map(action => action.access)).toEqual([
        'read',
        'write',
        'destructive',
        'write',
        'write'
      ])

      for (const action of categoryActions) {
        expect(MicrosoftConnector.actions).toContain(action)
      }
    })
  )

  it.effect('lists master categories with MailboxSettings.Read and preserves nextLink', () =>
    Effect.gen(function* () {
      const host = makeHost(
        JSON.stringify({
          value: [{ id: 'cat_1', displayName: 'Receipts', color: 'preset0' }],
          '@odata.nextLink': 'https://graph.microsoft.com/v1.0/me/outlook/masterCategories?$skip=1'
        })
      )

      const result = yield* outlookListCategoriesAction
        .execute({ integration, input: {} })
        .pipe(Effect.provide(host.layer))

      expect(result._tag).toBe('Success')
      expect(result).toMatchObject({
        value: {
          nextLink: 'https://graph.microsoft.com/v1.0/me/outlook/masterCategories?$skip=1'
        }
      })

      if (Predicate.isTagged(result, 'Success')) {
        const output = yield* Schema.decodeUnknownEffect(OutlookListCategoriesOutput)(result.value)

        expect(Chunk.toReadonlyArray(output.categories)).toMatchObject([
          { id: 'cat_1', displayName: 'Receipts', color: 'preset0' }
        ])
      }

      expect(host.requests).toMatchObject([
        {
          method: 'GET',
          url: 'https://graph.microsoft.com/v1.0/me/outlook/masterCategories',
          headers: {
            authorization: 'Bearer token',
            prefer: 'IdType="ImmutableId"'
          }
        }
      ])
      expect(host.scopes).toEqual([[microsoftGraphMailboxSettingsReadScope]])
    })
  )

  it.effect('lists explicit mailbox categories through /users without Shared settings scopes', () =>
    Effect.gen(function* () {
      const host = makeHost('{"value":[]}')

      const result = yield* outlookListCategoriesAction
        .execute({
          integration,
          input: { mailbox: 'shared@example.com', top: 25 }
        })
        .pipe(Effect.provide(host.layer))

      expect(result._tag).toBe('Success')
      expect(host.requests.at(0)?.url).toBe(
        'https://graph.microsoft.com/v1.0/users/shared%40example.com/outlook/masterCategories?%24top=25'
      )
      // No `.Shared` mailbox-settings scopes exist: delegated access to another
      // mailbox keeps the ordinary category slot and stays subject to Graph
      // authorization.
      expect(host.scopes).toEqual([[microsoftGraphMailboxSettingsReadScope]])
    })
  )

  it.effect('replays only the configured master-category collection and origin', () =>
    Effect.gen(function* () {
      const nextLink =
        'https://graph.microsoft.com/v1.0/me/outlook/masterCategories?%24top=5&%24skip=5'

      const host = makeHost('{"value":[]}')

      const result = yield* outlookListCategoriesAction
        .execute({ integration, input: { nextLink } })
        .pipe(Effect.provide(host.layer))

      expect(result._tag).toBe('Success')
      expect(host.requests.at(0)?.url).toBe(nextLink)
    })
  )

  it.effect('rejects category nextLink values outside the selected collection', () =>
    Effect.gen(function* () {
      const host = makeHost()

      for (const nextLink of [
        'https://graph.microsoft.com/v1.0/me/messages?$top=5',
        'https://graph.microsoft.com/v1.0/me/outlook/masterCategories?$top=5',
        'https://example.com/v1.0/me/outlook/masterCategories'
      ]) {
        // The middle link targets /me while the action targets an explicit
        // mailbox, so it must be rejected like the other foreign links.
        const result = yield* outlookListCategoriesAction
          .execute({
            integration,
            input: { mailbox: 'shared@example.com', nextLink }
          })
          .pipe(Effect.provide(host.layer), Effect.result)

        expect(result._tag).toBe('Failure')
        expect(result).toMatchObject({
          failure: {
            cause: 'validation_failed',
            message:
              'Microsoft Graph nextLink must target the selected v1.0 master category collection',
            connectorId: 'microsoft',
            actionId: 'outlook.list_categories'
          }
        })
      }

      expect(host.requests).toEqual([])
      // Credential resolution precedes nextLink validation, matching the
      // existing message lists: no HTTP is sent, but the read slot resolves.
      expect(host.scopes).toEqual([
        [microsoftGraphMailboxSettingsReadScope],
        [microsoftGraphMailboxSettingsReadScope],
        [microsoftGraphMailboxSettingsReadScope]
      ])
    })
  )

  it.effect('requires an explicit mailbox for application category operations before IO', () =>
    Effect.gen(function* () {
      const host = makeHost()

      const application = makeIntegration({
        connectorId: 'microsoft',
        config: { mailboxAccessMode: 'application' },
        credentialBindings: integration.credentialBindings
      })

      for (const effect of [
        outlookListCategoriesAction.execute({ integration: application, input: {} }),
        outlookCreateCategoryAction.execute({
          integration: application,
          input: { displayName: 'Receipts' }
        }),
        outlookDeleteCategoryAction.execute({
          integration: application,
          input: { categoryId: 'cat_1' }
        })
      ]) {
        const result = yield* effect.pipe(Effect.provide(host.layer), Effect.result)

        expect(result._tag).toBe('Failure')
        expect(result).toMatchObject({ failure: { cause: 'validation_failed' } })
      }

      expect(host.requests).toEqual([])
      expect(host.scopes).toEqual([])
    })
  )

  it.effect('creates a category with displayName/color and MailboxSettings.ReadWrite', () =>
    Effect.gen(function* () {
      const host = makeHost(
        JSON.stringify({ id: 'cat_2', displayName: 'Invoices', color: 'preset5' })
      )

      const result = yield* outlookCreateCategoryAction
        .execute({
          integration,
          input: { displayName: 'Invoices', color: 'preset5' }
        })
        .pipe(Effect.provide(host.layer))

      expect(result._tag).toBe('Success')
      expect(result).toMatchObject({
        value: { id: 'cat_2', displayName: 'Invoices', color: 'preset5' }
      })
      expect(host.requests).toMatchObject([
        {
          method: 'POST',
          url: 'https://graph.microsoft.com/v1.0/me/outlook/masterCategories',
          body: JSON.stringify({ displayName: 'Invoices', color: 'preset5' }),
          headers: {
            authorization: 'Bearer token',
            'content-type': 'application/json',
            prefer: 'IdType="ImmutableId"'
          }
        }
      ])
      expect(host.scopes).toEqual([[microsoftGraphMailboxSettingsReadWriteScope]])
    })
  )

  it.effect('omits an absent category color from the create body', () =>
    Effect.gen(function* () {
      const host = makeHost(JSON.stringify({ id: 'cat_3', displayName: 'Receipts' }))

      yield* outlookCreateCategoryAction
        .execute({ integration, input: { displayName: 'Receipts' } })
        .pipe(Effect.provide(host.layer))

      expect(host.requests.at(0)?.body).toBe(JSON.stringify({ displayName: 'Receipts' }))
    })
  )

  it.effect('deletes a category without decoding the empty 204 body', () =>
    Effect.gen(function* () {
      const host = makeHost('', 204)

      const result = yield* outlookDeleteCategoryAction
        .execute({ integration, input: { categoryId: 'cat/1' } })
        .pipe(Effect.provide(host.layer))

      expect(result._tag).toBe('Success')
      expect(result).toMatchObject({ value: { id: 'cat/1', deleted: true } })
      expect(host.requests).toMatchObject([
        {
          method: 'DELETE',
          url: 'https://graph.microsoft.com/v1.0/me/outlook/masterCategories/cat%2F1'
        }
      ])
      expect(host.scopes).toEqual([[microsoftGraphMailboxSettingsReadWriteScope]])
    })
  )

  it.effect('replaces message categories with PATCH and Mail.ReadWrite, [] clears', () =>
    Effect.gen(function* () {
      const host = makeHost(JSON.stringify({ id: 'message_1', categories: [] }))

      const result = yield* outlookSetCategoriesAction
        .execute({
          integration,
          input: { messageId: 'message/1', categories: [] }
        })
        .pipe(Effect.provide(host.layer))

      expect(result._tag).toBe('Success')
      expect(result).toMatchObject({ value: { id: 'message_1', categories: [] } })
      expect(host.requests).toMatchObject([
        {
          method: 'PATCH',
          url: 'https://graph.microsoft.com/v1.0/me/messages/message%2F1',
          body: JSON.stringify({ categories: [] }),
          headers: {
            authorization: 'Bearer token',
            'content-type': 'application/json',
            prefer: 'IdType="ImmutableId"'
          }
        }
      ])
      expect(host.scopes).toEqual([['https://graph.microsoft.com/Mail.ReadWrite']])
    })
  )

  it.effect('assigns displayName strings on shared mailboxes through the Shared message slot', () =>
    Effect.gen(function* () {
      const host = makeHost(JSON.stringify({ id: 'm', categories: ['Receipts'] }))

      const result = yield* outlookSetCategoriesAction
        .execute({
          integration,
          input: {
            mailbox: 'shared@example.com',
            messageId: 'm',
            categories: ['Receipts', 'Invoices']
          }
        })
        .pipe(Effect.provide(host.layer))

      expect(result._tag).toBe('Success')
      expect(host.requests.at(0)?.url).toContain('/users/shared%40example.com/messages/m')
      expect(host.requests.at(0)?.body).toBe(
        JSON.stringify({ categories: ['Receipts', 'Invoices'] })
      )
      expect(host.scopes).toEqual([
        undefined,
        ['https://graph.microsoft.com/Mail.ReadWrite.Shared']
      ])
    })
  )

  it.effect('merges added categories while remove wins and dedupes', () =>
    Effect.gen(function* () {
      const host = makeQueuedHost([
        { body: JSON.stringify({ id: 'm1', categories: ['A', 'A', 'B'] }), status: 200 },
        { body: JSON.stringify({ id: 'm1', categories: ['A', 'C'] }), status: 200 }
      ])

      const result = yield* outlookModifyCategoriesAction
        .execute({
          integration,
          input: { messageId: 'm1', addCategories: ['B', 'C', 'C'], removeCategories: ['B'] }
        })
        .pipe(Effect.provide(host.layer))

      expect(result._tag).toBe('Success')
      expect(result).toMatchObject({ value: { id: 'm1', categories: ['A', 'C'] } })
      expect(host.requests).toMatchObject([
        {
          method: 'GET',
          url: 'https://graph.microsoft.com/v1.0/me/messages/m1?%24select=id%2Ccategories'
        },
        {
          method: 'PATCH',
          url: 'https://graph.microsoft.com/v1.0/me/messages/m1',
          body: JSON.stringify({ categories: ['A', 'C'] })
        }
      ])
      expect(host.scopes).toEqual([
        ['https://graph.microsoft.com/Mail.ReadWrite'],
        ['https://graph.microsoft.com/Mail.ReadWrite']
      ])
    })
  )

  it.effect('modifies shared and application mailboxes with the matching write scopes', () =>
    Effect.gen(function* () {
      for (const mode of ['delegated', 'application']) {
        const host = makeQueuedHost([
          { body: JSON.stringify({ id: 'm/1', categories: ['Keep'] }), status: 200 },
          { body: JSON.stringify({ id: 'm/1', categories: ['Keep', 'New'] }), status: 200 }
        ])

        const target = makeIntegration({
          connectorId: 'microsoft',
          config: { mailboxAccessMode: mode },
          credentialBindings: integration.credentialBindings
        })

        const result = yield* outlookModifyCategoriesAction
          .execute({
            integration: target,
            input: { mailbox: 'shared@example.com', messageId: 'm/1', addCategories: ['New'] }
          })
          .pipe(Effect.provide(host.layer))

        expect(result._tag).toBe('Success')
        expect(host.requests.map(request => request.url)).toEqual([
          'https://graph.microsoft.com/v1.0/users/shared%40example.com/messages/m%2F1?%24select=id%2Ccategories',
          'https://graph.microsoft.com/v1.0/users/shared%40example.com/messages/m%2F1'
        ])
        expect(host.requests.map(request => request.headers?.prefer)).toEqual([
          'IdType="ImmutableId"',
          'IdType="ImmutableId"'
        ])
        expect(host.scopes).toEqual(
          mode === 'application'
            ? [
                ['https://graph.microsoft.com/Mail.ReadWrite'],
                ['https://graph.microsoft.com/Mail.ReadWrite']
              ]
            : [
                undefined,
                ['https://graph.microsoft.com/Mail.ReadWrite.Shared'],
                undefined,
                ['https://graph.microsoft.com/Mail.ReadWrite.Shared']
              ]
        )
      }
    })
  )

  it.effect('requires a mailbox for application category assignment before IO', () =>
    Effect.gen(function* () {
      const host = makeHost()

      const application = makeIntegration({
        connectorId: 'microsoft',
        config: { mailboxAccessMode: 'application' },
        credentialBindings: integration.credentialBindings
      })

      for (const action of [
        outlookSetCategoriesAction.execute({
          integration: application,
          input: { messageId: 'm1', categories: [] }
        }),
        outlookModifyCategoriesAction.execute({
          integration: application,
          input: { messageId: 'm1', addCategories: ['A'] }
        })
      ]) {
        const result = yield* action.pipe(Effect.provide(host.layer), Effect.result)

        expect(result).toMatchObject({ failure: { cause: 'validation_failed' } })
      }

      expect(host.requests).toEqual([])
      expect(host.scopes).toEqual([])
    })
  )

  it.effect('uses the modify action error code when its PATCH fails', () =>
    Effect.gen(function* () {
      const host = makeQueuedHost([
        { body: JSON.stringify({ id: 'm1', categories: [] }), status: 200 },
        { body: '{}', status: 500 }
      ])

      const result = yield* outlookModifyCategoriesAction
        .execute({
          integration,
          input: { messageId: 'm1', addCategories: ['A'] }
        })
        .pipe(Effect.provide(host.layer))

      expect(result).toMatchObject({
        error: { code: 'outlook_modify_categories_failed', status: 500 }
      })
    })
  )

  it.effect('removing every category clears the assignment', () =>
    Effect.gen(function* () {
      const host = makeQueuedHost([
        { body: JSON.stringify({ id: 'm1', categories: ['A', 'B'] }), status: 200 },
        { body: JSON.stringify({ id: 'm1', categories: [] }), status: 200 }
      ])

      const result = yield* outlookModifyCategoriesAction
        .execute({
          integration,
          input: { messageId: 'm1', removeCategories: ['A', 'B'] }
        })
        .pipe(Effect.provide(host.layer))

      expect(result._tag).toBe('Success')
      expect(host.requests.at(1)?.body).toBe(JSON.stringify({ categories: [] }))
    })
  )

  it.effect('sends no PATCH when the categories read fails', () =>
    Effect.gen(function* () {
      const host = makeQueuedHost([
        { body: '{"error":{"code":"ErrorAccessDenied","message":"Denied"}}', status: 403 }
      ])

      const result = yield* outlookModifyCategoriesAction
        .execute({
          integration,
          input: { messageId: 'm1', addCategories: ['A'] }
        })
        .pipe(Effect.provide(host.layer))

      expect(result._tag).toBe('Failure')
      expect(result).toMatchObject({ error: { code: 'microsoft_unauthorized', status: 403 } })
      expect(host.requests).toHaveLength(1)
      expect(host.requests.at(0)?.method).toBe('GET')
    })
  )

  it.effect('rejects omitted malformed read categories instead of erasing them', () =>
    Effect.gen(function* () {
      for (const body of [
        '{"id":"m1"}',
        '{"id":"m1","categories":null}',
        '{"id":"m1","categories":"A"}'
      ]) {
        const host = makeQueuedHost([{ body, status: 200 }])

        const result = yield* outlookModifyCategoriesAction
          .execute({
            integration,
            input: { messageId: 'm1', addCategories: ['A'] }
          })
          .pipe(Effect.provide(host.layer), Effect.result)

        expect(result._tag).toBe('Failure')
        expect(result).toMatchObject({ failure: { cause: 'validation_failed' } })
        expect(host.requests).toHaveLength(1)
      }
    })
  )

  it.effect('preserves provider failure when the modify PATCH fails', () =>
    Effect.gen(function* () {
      const host = makeQueuedHost([
        { body: JSON.stringify({ id: 'm1', categories: ['A'] }), status: 200 },
        { body: '{"error":{"code":"ErrorQuotaExceeded","message":"Throttled"}}', status: 429 }
      ])

      const result = yield* outlookModifyCategoriesAction
        .execute({
          integration,
          input: { messageId: 'm1', addCategories: ['B'] }
        })
        .pipe(Effect.provide(host.layer))

      expect(result._tag).toBe('Failure')
      expect(result).toMatchObject({ error: { code: 'microsoft_rate_limited', status: 429 } })
      expect(host.requests).toHaveLength(2)
    })
  )

  it.effect('rejects invalid category inputs before credentials or HTTP', () =>
    Effect.gen(function* () {
      const host = makeHost()

      for (const id of ['.', '..', 'bad\r\nid']) {
        for (const action of [
          outlookDeleteCategoryAction.execute({ integration, input: { categoryId: id } }),
          outlookListCategoriesAction.execute({ integration, input: { mailbox: id } }),
          outlookSetCategoriesAction.execute({
            integration,
            input: { messageId: id, categories: [] }
          }),
          outlookModifyCategoriesAction.execute({
            integration,
            input: { mailbox: id, messageId: 'm1', addCategories: ['A'] }
          })
        ]) {
          const result = yield* action.pipe(Effect.provide(host.layer), Effect.result)
          expect(result).toMatchObject({ failure: { cause: 'validation_failed' } })
        }
      }

      const cases: ReadonlyArray<{
        readonly execute: Effect.Effect<unknown, unknown, CredentialResolver | ConnectorHttpClient>
      }> = [
        {
          execute: outlookCreateCategoryAction.execute({
            integration,
            input: { displayName: '' }
          })
        },
        {
          execute: outlookCreateCategoryAction.execute({
            integration,
            input: { displayName: '   ' }
          })
        },
        {
          execute: outlookCreateCategoryAction.execute({
            integration,
            input: { displayName: 'Receipts', color: 'blue' }
          })
        },
        {
          execute: outlookDeleteCategoryAction.execute({
            integration,
            input: { categoryId: '' }
          })
        },
        {
          execute: outlookSetCategoriesAction.execute({
            integration,
            input: { messageId: '', categories: ['A'] }
          })
        },
        {
          execute: outlookSetCategoriesAction.execute({
            integration,
            input: { messageId: 'm1', categories: [''] }
          })
        },
        {
          execute: outlookSetCategoriesAction.execute({
            integration,
            input: { messageId: 'm1' }
          })
        },
        {
          execute: outlookModifyCategoriesAction.execute({
            integration,
            input: { messageId: 'm1' }
          })
        },
        {
          execute: outlookModifyCategoriesAction.execute({
            integration,
            input: { messageId: 'm1', addCategories: [''] }
          })
        }
      ]

      for (const testCase of cases) {
        const result = yield* testCase.execute.pipe(Effect.provide(host.layer), Effect.result)

        expect(result._tag).toBe('Failure')
        expect(result).toMatchObject({ failure: { cause: 'validation_failed' } })
      }

      expect(host.requests).toEqual([])
      expect(host.scopes).toEqual([])
    })
  )

  it.effect('fails malformed category outputs as validation errors', () =>
    Effect.gen(function* () {
      const listHost = makeHost('{"value":[{"displayName":"Receipts"}]}')
      const createHost = makeHost('{"displayName":"Receipts"}')

      const listResult = yield* outlookListCategoriesAction
        .execute({ integration, input: {} })
        .pipe(Effect.provide(listHost.layer), Effect.result)

      const createResult = yield* outlookCreateCategoryAction
        .execute({ integration, input: { displayName: 'Receipts' } })
        .pipe(Effect.provide(createHost.layer), Effect.result)

      expect(listResult._tag).toBe('Failure')
      expect(listResult).toMatchObject({ failure: { cause: 'validation_failed' } })
      expect(createResult._tag).toBe('Failure')
      expect(createResult).toMatchObject({ failure: { cause: 'validation_failed' } })
    })
  )

  for (const [actionId, execute] of [
    [
      'outlook.list_categories',
      (host: ReturnType<typeof makeHost>) =>
        outlookListCategoriesAction
          .execute({ integration, input: {} })
          .pipe(Effect.provide(host.layer))
    ],
    [
      'outlook.create_category',
      (host: ReturnType<typeof makeHost>) =>
        outlookCreateCategoryAction
          .execute({
            integration,
            input: { displayName: 'Receipts' }
          })
          .pipe(Effect.provide(host.layer))
    ],
    [
      'outlook.delete_category',
      (host: ReturnType<typeof makeHost>) =>
        outlookDeleteCategoryAction
          .execute({
            integration,
            input: { categoryId: 'cat_1' }
          })
          .pipe(Effect.provide(host.layer))
    ],
    [
      'outlook.set_categories',
      (host: ReturnType<typeof makeHost>) =>
        outlookSetCategoriesAction
          .execute({
            integration,
            input: { messageId: 'm1', categories: ['A'] }
          })
          .pipe(Effect.provide(host.layer))
    ]
  ] as const) {
    for (const [status, code] of [
      [401, 'microsoft_unauthorized'],
      [404, 'microsoft_not_found'],
      [429, 'microsoft_rate_limited'],
      [500, `${actionId.replace('.', '_')}_failed`]
    ] as const) {
      it.effect(`${actionId} preserves provider failure at HTTP ${status}`, () =>
        Effect.gen(function* () {
          const host = makeHost('{"error":{"code":"ErrorAccessDenied","message":"Denied"}}', status)

          const result = yield* execute(host)

          expect(result._tag).toBe('Failure')
          expect(result).toMatchObject({ error: { code, status } })
        })
      )
    }
  }
})
