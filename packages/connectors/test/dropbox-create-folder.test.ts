import { Effect, Layer, Result } from 'effect'
import { describe, expect, it } from '@effect/vitest'
import {
  ConnectorError,
  ConnectorHttpClient,
  ConnectorHttpResponse,
  CredentialResolver,
  makeCredentialBinding,
  makeIntegration,
  OAuthCredential
} from '@yolk-sdk/connectors'
import type { ConnectorHttpRequest, CredentialResolveRequest } from '@yolk-sdk/connectors'
import {
  DropboxConnector,
  DropboxFolderMetadata,
  dropboxOAuthSlotId
} from '@yolk-sdk/connectors/dropbox'

const integration = makeIntegration({
  connectorId: 'dropbox',
  credentialBindings: [
    makeCredentialBinding({
      slotId: dropboxOAuthSlotId,
      credentialRef: 'dropbox-oauth-credential'
    })
  ]
})

const jsonResponse = (body: string) =>
  ConnectorHttpResponse.make({
    status: 200,
    headers: { 'content-type': 'application/json' },
    body
  })

const makeHost = (responses: ReadonlyArray<ConnectorHttpResponse>) => {
  const requests: Array<ConnectorHttpRequest> = []
  const credentialRequests: Array<CredentialResolveRequest> = []
  let responseIndex = 0

  const layer = Layer.mergeAll(
    Layer.succeed(
      CredentialResolver,
      CredentialResolver.of({
        resolve: request => {
          credentialRequests.push(request)

          return Effect.succeed(
            OAuthCredential.make({
              provider: 'dropbox',
              accessToken: 'dropbox_access_token',
              expiresAt: Date.now() + 60_000
            })
          )
        }
      })
    ),
    Layer.succeed(
      ConnectorHttpClient,
      ConnectorHttpClient.of({
        request: request => {
          requests.push(request)
          const response = responses.at(responseIndex)
          responseIndex += 1

          return response === undefined
            ? Effect.fail(
                new ConnectorError({
                  cause: 'transport_failed',
                  message: 'Unexpected Dropbox test request'
                })
              )
            : Effect.succeed(response)
        }
      })
    )
  )

  return { credentialRequests, layer, requests }
}

const invokeCreateFolder = (input: unknown, layer: ReturnType<typeof makeHost>['layer']) =>
  DropboxConnector.invoke({
    integration,
    action: 'dropbox.create_folder',
    input
  }).pipe(Effect.provide(layer))

describe('Dropbox create folder', () => {
  it.effect(
    'accepts official untagged metadata, tagged compatibility, and minimal optional fields',
    () =>
      Effect.gen(function* () {
        const host = makeHost([
          jsonResponse(
            JSON.stringify({
              metadata: {
                id: 'id:official',
                name: 'Official',
                path_lower: '/official',
                path_display: '/Official'
              }
            })
          ),
          jsonResponse(
            JSON.stringify({
              metadata: {
                '.tag': 'folder',
                id: 'id:tagged',
                name: 'Tagged',
                path_lower: null,
                path_display: null
              }
            })
          ),
          jsonResponse(JSON.stringify({ metadata: { id: 'id:minimal', name: 'Minimal' } }))
        ])

        const omitted = yield* invokeCreateFolder({ path: '/Official' }, host.layer)

        const disabled = yield* invokeCreateFolder(
          { path: '/Tagged', autorename: false },
          host.layer
        )

        const enabled = yield* invokeCreateFolder(
          { path: '/Minimal', autorename: true },
          host.layer
        )

        expect(omitted).toEqual(
          expect.objectContaining({
            _tag: 'Success',
            value: DropboxFolderMetadata.make({
              type: 'folder',
              id: 'id:official',
              name: 'Official',
              pathLower: '/official',
              pathDisplay: '/Official'
            })
          })
        )
        expect(disabled).toEqual(
          expect.objectContaining({
            _tag: 'Success',
            value: DropboxFolderMetadata.make({
              type: 'folder',
              id: 'id:tagged',
              name: 'Tagged',
              pathLower: null,
              pathDisplay: null
            })
          })
        )
        expect(enabled).toEqual(
          expect.objectContaining({
            _tag: 'Success',
            value: expect.objectContaining({
              type: 'folder',
              id: 'id:minimal',
              name: 'Minimal'
            })
          })
        )

        expect(host.requests).toHaveLength(3)
        expect(host.requests.map(request => request.method)).toEqual(['POST', 'POST', 'POST'])
        expect(host.requests.map(request => request.url)).toEqual([
          'https://api.dropboxapi.com/2/files/create_folder_v2',
          'https://api.dropboxapi.com/2/files/create_folder_v2',
          'https://api.dropboxapi.com/2/files/create_folder_v2'
        ])
        expect(host.requests.map(request => request.body)).toEqual([
          JSON.stringify({ path: '/Official' }),
          JSON.stringify({ path: '/Tagged', autorename: false }),
          JSON.stringify({ path: '/Minimal', autorename: true })
        ])
        expect(host.credentialRequests).toHaveLength(3)
      })
  )

  it.effect('rejects contradictory tags and missing required metadata fields', () =>
    Effect.gen(function* () {
      const malformedResponses = [
        { metadata: { '.tag': 'file', id: 'id:file', name: 'File' } },
        { metadata: { '.tag': 'deleted', id: 'id:deleted', name: 'Deleted' } },
        { metadata: { name: 'Missing id' } },
        { metadata: { id: 'id:missing-name' } }
      ]

      const host = makeHost(
        malformedResponses.map(response => jsonResponse(JSON.stringify(response)))
      )

      for (const [index] of malformedResponses.entries()) {
        const result = yield* invokeCreateFolder({ path: `/Malformed ${index}` }, host.layer).pipe(
          Effect.result
        )

        expect(Result.isFailure(result)).toBe(true)

        if (Result.isFailure(result)) {
          expect(result.failure).toMatchObject({
            cause: 'validation_failed',
            message: 'Invalid response shape'
          })
        }
      }

      expect(host.requests).toHaveLength(malformedResponses.length)
    })
  )

  it.effect('blocks invalid inputs before credentials and HTTP', () =>
    Effect.gen(function* () {
      const host = makeHost([])

      for (const input of [
        {},
        { path: '' },
        { path: '   ' },
        { path: '/Null autorename', autorename: null }
      ]) {
        const result = yield* invokeCreateFolder(input, host.layer).pipe(Effect.result)

        expect(Result.isFailure(result)).toBe(true)

        if (Result.isFailure(result)) {
          expect(result.failure).toMatchObject({
            cause: 'validation_failed',
            actionId: 'dropbox.create_folder'
          })
        }
      }

      expect(host.credentialRequests).toHaveLength(0)
      expect(host.requests).toHaveLength(0)
    })
  )

  it.effect('keeps tagged metadata unions strict for non-create actions', () =>
    Effect.gen(function* () {
      const untaggedFolder = { id: 'id:untagged', name: 'Untagged' }

      const cases = [
        {
          action: 'dropbox.list_folder',
          input: {},
          response: { entries: [untaggedFolder], cursor: 'cursor', has_more: false }
        },
        {
          action: 'dropbox.list_folder_continue',
          input: { cursor: 'cursor' },
          response: { entries: [untaggedFolder], cursor: 'cursor-2', has_more: false }
        },
        {
          action: 'dropbox.search',
          input: { query: 'untagged' },
          response: {
            matches: [{ metadata: { '.tag': 'metadata', metadata: untaggedFolder } }],
            has_more: false
          }
        },
        {
          action: 'dropbox.search_continue',
          input: { cursor: 'cursor' },
          response: {
            matches: [{ metadata: { '.tag': 'metadata', metadata: untaggedFolder } }],
            has_more: false
          }
        },
        {
          action: 'dropbox.get_metadata',
          input: { path: '/Untagged' },
          response: untaggedFolder
        },
        {
          action: 'dropbox.move',
          input: { fromPath: '/From', toPath: '/To' },
          response: { metadata: untaggedFolder }
        },
        {
          action: 'dropbox.copy',
          input: { fromPath: '/From', toPath: '/To' },
          response: { metadata: untaggedFolder }
        },
        {
          action: 'dropbox.delete',
          input: { path: '/Untagged' },
          response: { metadata: untaggedFolder }
        }
      ]

      const host = makeHost(cases.map(testCase => jsonResponse(JSON.stringify(testCase.response))))

      for (const testCase of cases) {
        const result = yield* DropboxConnector.invoke({
          integration,
          action: testCase.action,
          input: testCase.input
        }).pipe(Effect.provide(host.layer), Effect.result)

        expect(Result.isFailure(result)).toBe(true)

        if (Result.isFailure(result)) {
          expect(result.failure).toMatchObject({
            cause: 'validation_failed',
            message: 'Invalid response shape'
          })
        }
      }

      expect(host.requests).toHaveLength(cases.length)
    })
  )
})
