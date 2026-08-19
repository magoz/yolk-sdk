import { Chunk, Effect, Layer } from 'effect'
import * as Schema from 'effect/Schema'
import { describe, expect, it } from '@effect/vitest'
import { resolveTools } from '@yolk-sdk/agent/tools'
import {
  ConnectorHttpClient,
  ConnectorHttpResponse,
  CredentialResolver,
  makeCredentialBinding,
  makeIntegration,
  OAuthCredential
} from '@yolk-sdk/connectors'
import type { ConnectorHttpRequest } from '@yolk-sdk/connectors'
import { makeConnectorToolModule } from '@yolk-sdk/connectors/agent'
import {
  GoogleCombinedOAuthCredentialSlot,
  GoogleConnector,
  GoogleDriveFileOAuthCredentialSlot,
  googleDriveFileFields,
  googleDriveFileScope,
  googleDriveCreateFolderAction,
  googleDriveDeleteFileAction,
  googleDriveFolderMimeType,
  googleDriveGetFileAction,
  googleDriveListFilesAction,
  GoogleDriveListFilesOutput,
  GoogleDriveMetadataReadonlyOAuthCredentialSlot,
  googleDriveMetadataReadonlyScope,
  googleDriveSearchFilesAction,
  googleDriveTrashFileAction,
  GoogleOAuthCredentialSlot,
  googleOAuthSlotId
} from '@yolk-sdk/connectors/google'

const googleDriveIntegration = makeIntegration({
  connectorId: 'google',
  credentialBindings: [
    makeCredentialBinding({
      slotId: GoogleOAuthCredentialSlot.id,
      credentialRef: 'google-oauth-credential'
    })
  ]
})

const jsonResponse = (body: string, status = 200) =>
  ConnectorHttpResponse.make({
    status,
    headers: { 'content-type': 'application/json' },
    body
  })

const makeHttpLayer = (
  requests: Array<ConnectorHttpRequest>,
  responses: ReadonlyArray<ConnectorHttpResponse>
) => {
  let index = 0
  return Layer.succeed(
    ConnectorHttpClient,
    ConnectorHttpClient.of({
      request: request => {
        requests.push(request)
        const response = responses.at(index)
        index += 1
        return response === undefined
          ? Effect.die(new Error('Missing Google Drive test response'))
          : Effect.succeed(response)
      }
    })
  )
}

const makeCredentialLayer = (requestedScopes: Array<ReadonlyArray<string> | undefined>) =>
  Layer.succeed(
    CredentialResolver,
    CredentialResolver.of({
      resolve: request => {
        requestedScopes.push(request.slot.requiredScopes)
        return Effect.succeed(
          OAuthCredential.make({
            _tag: 'OAuthCredential',
            provider: 'google',
            accessToken: 'google_access_token',
            expiresAt: Date.now() + 60_000
          })
        )
      }
    })
  )

describe('Google Drive connector', () => {
  it('exports Drive actions with action-scoped access and least-privilege slots', () => {
    const driveAccess = GoogleConnector.actions
      .filter(action => action.id.startsWith('drive.'))
      .map(action => ({ id: action.id, access: action.access ?? 'read' }))
    expect(driveAccess).toEqual([
      { id: 'drive.list_files', access: 'read' },
      { id: 'drive.search_files', access: 'read' },
      { id: 'drive.get_file', access: 'read' },
      { id: 'drive.create_folder', access: 'write' },
      { id: 'drive.trash_file', access: 'destructive' },
      { id: 'drive.delete_file', access: 'destructive' }
    ])

    expect(GoogleDriveMetadataReadonlyOAuthCredentialSlot).toMatchObject({
      id: googleOAuthSlotId,
      kind: 'oauth',
      requiredScopes: [googleDriveMetadataReadonlyScope]
    })
    expect(GoogleDriveFileOAuthCredentialSlot).toMatchObject({
      id: googleOAuthSlotId,
      kind: 'oauth',
      requiredScopes: [googleDriveFileScope]
    })
    expect(GoogleCombinedOAuthCredentialSlot.requiredScopes).toEqual(
      expect.arrayContaining([googleDriveMetadataReadonlyScope, googleDriveFileScope])
    )
    expect(GoogleCombinedOAuthCredentialSlot.requiredScopes).not.toContain(
      'https://www.googleapis.com/auth/drive'
    )
  })

  it.effect('generates provider-facing object schemas for every Drive action', () =>
    Effect.gen(function* () {
      const layer = Layer.mergeAll(makeCredentialLayer([]), makeHttpLayer([], []))
      const toolSet = yield* resolveTools(
        [makeConnectorToolModule(GoogleConnector, { integration: googleDriveIntegration, layer })],
        {}
      )
      const driveTools = toolSet.tools.filter(tool => tool.name.startsWith('drive.'))

      expect(driveTools.map(tool => tool.name)).toEqual([
        'drive.list_files',
        'drive.search_files',
        'drive.get_file',
        'drive.create_folder',
        'drive.trash_file',
        'drive.delete_file'
      ])
      for (const tool of driveTools) {
        expect(tool.parameters).toMatchObject({ type: 'object' })
      }
    })
  )

  it.effect(
    'lists and searches metadata with paging, shared-drive parameters, and read scope',
    () =>
      Effect.gen(function* () {
        const requests: Array<ConnectorHttpRequest> = []
        const requestedScopes: Array<ReadonlyArray<string> | undefined> = []
        const layer = Layer.mergeAll(
          makeCredentialLayer(requestedScopes),
          makeHttpLayer(requests, [
            jsonResponse(
              JSON.stringify({
                files: [
                  {
                    id: 'file_1',
                    name: 'Quarterly plan',
                    mimeType: 'application/vnd.google-apps.document',
                    parents: ['folder_1'],
                    size: '42',
                    modifiedTime: '2026-08-19T12:00:00Z',
                    owners: [{ displayName: 'Alice', emailAddress: 'alice@example.com' }],
                    capabilities: { canEdit: true, canTrash: true }
                  }
                ],
                nextPageToken: 'page_2',
                incompleteSearch: false
              })
            ),
            jsonResponse('{"incompleteSearch":false}')
          ])
        )

        const listResult = yield* googleDriveListFilesAction
          .execute({
            integration: googleDriveIntegration,
            input: {
              parentId: 'folder/root',
              parentResourceKey: 'folder_resource_key',
              driveId: 'shared/drive',
              pageSize: 25,
              pageToken: 'page_1',
              orderBy: 'modifiedTime desc'
            }
          })
          .pipe(Effect.provide(layer))
        const searchResult = yield* googleDriveSearchFilesAction
          .execute({
            integration: googleDriveIntegration,
            input: { query: "quarterly's \\plan", includeTrashed: true }
          })
          .pipe(Effect.provide(layer))

        expect(listResult).toMatchObject({
          _tag: 'Success',
          value: { nextPageToken: 'page_2', incompleteSearch: false }
        })
        if (listResult._tag === 'Failure') throw new Error('Expected Google Drive list success')
        const listOutput = yield* Schema.decodeUnknownEffect(GoogleDriveListFilesOutput)(
          listResult.value
        )
        const files = Chunk.toReadonlyArray(listOutput.files)
        expect(files).toHaveLength(1)
        expect(files.at(0)).toMatchObject({
          id: 'file_1',
          name: 'Quarterly plan',
          size: '42',
          capabilities: { canEdit: true, canTrash: true }
        })
        expect(Chunk.toReadonlyArray(files.at(0)?.owners ?? Chunk.empty())).toMatchObject([
          { displayName: 'Alice' }
        ])
        expect(searchResult).toMatchObject({
          _tag: 'Success',
          value: { incompleteSearch: false }
        })
        if (searchResult._tag === 'Failure') throw new Error('Expected Google Drive search success')
        const searchOutput = yield* Schema.decodeUnknownEffect(GoogleDriveListFilesOutput)(
          searchResult.value
        )
        expect(Chunk.isEmpty(searchOutput.files)).toBe(true)

        const listRequest = requests.at(0)
        const searchRequest = requests.at(1)
        if (listRequest === undefined || searchRequest === undefined) {
          throw new Error('Expected Google Drive list and search requests')
        }
        const listUrl = new URL(listRequest.url)
        const searchUrl = new URL(searchRequest.url)

        expect(listRequest).toMatchObject({
          method: 'GET',
          headers: {
            authorization: 'Bearer google_access_token',
            accept: 'application/json',
            'x-goog-drive-resource-keys': 'folder/root/folder_resource_key'
          }
        })
        expect(listUrl.pathname).toBe('/drive/v3/files')
        expect(listUrl.searchParams.get('q')).toBe("'folder/root' in parents and trashed = false")
        expect(listUrl.searchParams.get('pageSize')).toBe('25')
        expect(listUrl.searchParams.get('pageToken')).toBe('page_1')
        expect(listUrl.searchParams.get('orderBy')).toBe('modifiedTime desc')
        expect(listUrl.searchParams.get('spaces')).toBe('drive')
        expect(listUrl.searchParams.get('supportsAllDrives')).toBe('true')
        expect(listUrl.searchParams.get('includeItemsFromAllDrives')).toBe('true')
        expect(listUrl.searchParams.get('corpora')).toBe('drive')
        expect(listUrl.searchParams.get('driveId')).toBe('shared/drive')
        expect(listUrl.searchParams.get('fields')).toContain(
          'nextPageToken,incompleteSearch,files('
        )
        expect(searchUrl.searchParams.get('q')).toContain("name contains 'quarterly\\'s \\\\plan'")
        expect(searchUrl.searchParams.get('q')).not.toContain('trashed = false')
        expect(searchUrl.searchParams.get('corpora')).toBe('user')
        expect(requestedScopes).toEqual([
          [googleDriveMetadataReadonlyScope],
          [googleDriveMetadataReadonlyScope]
        ])
      })
  )

  it.effect('gets metadata, creates folders, trashes files, and permanently deletes files', () =>
    Effect.gen(function* () {
      const requests: Array<ConnectorHttpRequest> = []
      const requestedScopes: Array<ReadonlyArray<string> | undefined> = []
      const layer = Layer.mergeAll(
        makeCredentialLayer(requestedScopes),
        makeHttpLayer(requests, [
          jsonResponse(
            '{"id":"file_1","name":"Budget.xlsx","mimeType":"application/vnd.openxmlformats-officedocument.spreadsheetml.sheet","md5Checksum":"abc123"}'
          ),
          jsonResponse(
            `{"id":"folder_1","name":"Reports","mimeType":"${googleDriveFolderMimeType}","parents":["parent_1"]}`,
            201
          ),
          jsonResponse(
            '{"id":"file_2","name":"Old plan","mimeType":"application/pdf","trashed":true,"explicitlyTrashed":true}'
          ),
          ConnectorHttpResponse.make({ status: 204, headers: {}, body: '' })
        ])
      )

      const getResult = yield* googleDriveGetFileAction
        .execute({
          integration: googleDriveIntegration,
          input: { fileId: 'file/1', resourceKey: 'file_1_resource_key' }
        })
        .pipe(Effect.provide(layer))
      const createResult = yield* googleDriveCreateFolderAction
        .execute({
          integration: googleDriveIntegration,
          input: {
            name: 'Reports',
            parentId: 'parent_1',
            parentResourceKey: 'parent_resource_key'
          }
        })
        .pipe(Effect.provide(layer))
      const trashResult = yield* googleDriveTrashFileAction
        .execute({
          integration: googleDriveIntegration,
          input: { fileId: 'file/2', resourceKey: 'file_2_resource_key' }
        })
        .pipe(Effect.provide(layer))
      const deleteResult = yield* googleDriveDeleteFileAction
        .execute({
          integration: googleDriveIntegration,
          input: { fileId: 'file/3', resourceKey: 'file_3_resource_key' }
        })
        .pipe(Effect.provide(layer))

      expect(getResult).toMatchObject({
        _tag: 'Success',
        value: { id: 'file_1', name: 'Budget.xlsx', md5Checksum: 'abc123' }
      })
      expect(createResult).toMatchObject({
        _tag: 'Success',
        value: { id: 'folder_1', mimeType: googleDriveFolderMimeType }
      })
      expect(trashResult).toMatchObject({
        _tag: 'Success',
        value: { id: 'file_2', trashed: true, explicitlyTrashed: true }
      })
      expect(deleteResult).toEqual({
        _tag: 'Success',
        value: { deleted: true, fileId: 'file/3' }
      })

      const getRequest = requests.at(0)
      const createRequest = requests.at(1)
      const trashRequest = requests.at(2)
      const deleteRequest = requests.at(3)
      if (
        getRequest === undefined ||
        createRequest === undefined ||
        trashRequest === undefined ||
        deleteRequest === undefined
      ) {
        throw new Error('Expected Google Drive metadata and mutation requests')
      }
      const getUrl = new URL(getRequest.url)
      const createUrl = new URL(createRequest.url)
      const trashUrl = new URL(trashRequest.url)
      const deleteUrl = new URL(deleteRequest.url)

      expect(getRequest).toMatchObject({
        method: 'GET',
        headers: {
          authorization: 'Bearer google_access_token',
          accept: 'application/json',
          'x-goog-drive-resource-keys': 'file/1/file_1_resource_key'
        }
      })
      expect(getUrl.pathname).toBe('/drive/v3/files/file%2F1')
      expect(getUrl.searchParams.get('supportsAllDrives')).toBe('true')
      expect(getUrl.searchParams.get('fields')).toBe(googleDriveFileFields)

      expect(createRequest).toMatchObject({
        method: 'POST',
        headers: {
          authorization: 'Bearer google_access_token',
          accept: 'application/json',
          'content-type': 'application/json',
          'x-goog-drive-resource-keys': 'parent_1/parent_resource_key'
        },
        body: JSON.stringify({
          name: 'Reports',
          mimeType: googleDriveFolderMimeType,
          parents: ['parent_1']
        })
      })
      expect(createUrl.pathname).toBe('/drive/v3/files')
      expect(createUrl.searchParams.get('supportsAllDrives')).toBe('true')
      expect(createUrl.searchParams.get('fields')).toBe(googleDriveFileFields)

      expect(trashRequest).toMatchObject({
        method: 'PATCH',
        headers: {
          authorization: 'Bearer google_access_token',
          accept: 'application/json',
          'content-type': 'application/json',
          'x-goog-drive-resource-keys': 'file/2/file_2_resource_key'
        },
        body: JSON.stringify({ trashed: true })
      })
      expect(trashUrl.pathname).toBe('/drive/v3/files/file%2F2')
      expect(trashUrl.searchParams.get('supportsAllDrives')).toBe('true')
      expect(trashUrl.searchParams.get('fields')).toBe(googleDriveFileFields)

      expect(deleteRequest).toMatchObject({
        method: 'DELETE',
        headers: {
          authorization: 'Bearer google_access_token',
          accept: 'application/json',
          'x-goog-drive-resource-keys': 'file/3/file_3_resource_key'
        }
      })
      expect(deleteRequest.body).toBeUndefined()
      expect(deleteUrl.pathname).toBe('/drive/v3/files/file%2F3')
      expect(deleteUrl.searchParams.get('supportsAllDrives')).toBe('true')
      expect(requestedScopes).toEqual([
        [googleDriveMetadataReadonlyScope],
        [googleDriveFileScope],
        [googleDriveFileScope],
        [googleDriveFileScope]
      ])
    })
  )

  it.effect('validates inputs and maps provider and malformed-success failures', () =>
    Effect.gen(function* () {
      const requests: Array<ConnectorHttpRequest> = []
      const requestedScopes: Array<ReadonlyArray<string> | undefined> = []
      const layer = Layer.mergeAll(
        makeCredentialLayer(requestedScopes),
        makeHttpLayer(requests, [
          jsonResponse('{"error":{"message":"File not found"}}', 404),
          ConnectorHttpResponse.make({
            status: 403,
            headers: { 'content-type': 'application/json', 'retry-after': '2' },
            body: JSON.stringify({
              error: {
                message: 'User rate limit exceeded',
                errors: [{ reason: 'userRateLimitExceeded' }]
              }
            })
          }),
          jsonResponse(
            '{"error":{"message":"Insufficient permissions","errors":[{"reason":"insufficientFilePermissions"}]}}',
            403
          ),
          jsonResponse('{"id":"file_without_required_metadata"}')
        ])
      )

      const invalidList = yield* googleDriveListFilesAction
        .execute({ integration: googleDriveIntegration, input: { pageSize: 1001 } })
        .pipe(Effect.provide(layer), Effect.result)
      const invalidSearch = yield* googleDriveSearchFilesAction
        .execute({ integration: googleDriveIntegration, input: { query: '   ' } })
        .pipe(Effect.provide(layer), Effect.result)
      const orphanedParentResourceKey = yield* googleDriveListFilesAction
        .execute({ integration: googleDriveIntegration, input: { parentResourceKey: 'orphaned' } })
        .pipe(Effect.provide(layer), Effect.result)
      const invalidFileIdHeader = yield* googleDriveGetFileAction
        .execute({
          integration: googleDriveIntegration,
          input: { fileId: 'file\r\nx-injected: yes' }
        })
        .pipe(Effect.provide(layer), Effect.result)
      const invalidResourceKeyHeader = yield* googleDriveGetFileAction
        .execute({
          integration: googleDriveIntegration,
          input: { fileId: 'file', resourceKey: 'key\nx-injected: yes' }
        })
        .pipe(Effect.provide(layer), Effect.result)
      const providerResult = yield* googleDriveGetFileAction
        .execute({ integration: googleDriveIntegration, input: { fileId: 'missing' } })
        .pipe(Effect.provide(layer))
      const rateLimitResult = yield* googleDriveGetFileAction
        .execute({ integration: googleDriveIntegration, input: { fileId: 'rate-limited' } })
        .pipe(Effect.provide(layer))
      const permissionResult = yield* googleDriveGetFileAction
        .execute({ integration: googleDriveIntegration, input: { fileId: 'forbidden' } })
        .pipe(Effect.provide(layer))
      const malformedResult = yield* googleDriveGetFileAction
        .execute({ integration: googleDriveIntegration, input: { fileId: 'malformed' } })
        .pipe(Effect.provide(layer), Effect.result)

      expect(invalidList).toMatchObject({
        _tag: 'Failure',
        failure: { _tag: 'ConnectorError', cause: 'validation_failed' }
      })
      expect(invalidSearch).toMatchObject({
        _tag: 'Failure',
        failure: { _tag: 'ConnectorError', cause: 'validation_failed' }
      })
      expect(orphanedParentResourceKey).toMatchObject({
        _tag: 'Failure',
        failure: { _tag: 'ConnectorError', cause: 'validation_failed' }
      })
      expect(invalidFileIdHeader).toMatchObject({
        _tag: 'Failure',
        failure: { _tag: 'ConnectorError', cause: 'validation_failed' }
      })
      expect(invalidResourceKeyHeader).toMatchObject({
        _tag: 'Failure',
        failure: { _tag: 'ConnectorError', cause: 'validation_failed' }
      })
      expect(providerResult).toMatchObject({
        _tag: 'Failure',
        error: {
          code: 'google_not_found',
          message: 'Google Drive get file failed: File not found',
          status: 404
        }
      })
      expect(rateLimitResult).toMatchObject({
        _tag: 'Failure',
        error: {
          code: 'google_rate_limited',
          message: 'Google Drive get file failed: User rate limit exceeded',
          status: 403,
          retryAfterMs: 2_000
        }
      })
      expect(permissionResult).toMatchObject({
        _tag: 'Failure',
        error: {
          code: 'google_unauthorized',
          message: 'Google Drive get file failed: Insufficient permissions',
          status: 403
        }
      })
      expect(malformedResult).toMatchObject({
        _tag: 'Failure',
        failure: { _tag: 'ConnectorError', cause: 'validation_failed' }
      })
      expect(requests).toHaveLength(4)
    })
  )
})
