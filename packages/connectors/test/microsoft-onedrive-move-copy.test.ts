import { describe, expect, it } from '@effect/vitest'
import { Effect, Layer, Result } from 'effect'
import { resolveTools } from '@yolk-sdk/agent/tools'
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
import { makeConnectorToolModule } from '@yolk-sdk/connectors/agent'
import {
  MicrosoftConnector,
  microsoftGraphFilesReadWriteAllScope,
  microsoftGraphFilesReadWriteScope,
  microsoftOAuthSlotId,
  oneDriveCopyItemAction,
  oneDriveGetCopyStatusAction,
  oneDriveMoveItemAction
} from '@yolk-sdk/connectors/microsoft'

const integration = makeIntegration({
  connectorId: 'microsoft',
  credentialBindings: [
    makeCredentialBinding({ slotId: microsoftOAuthSlotId, credentialRef: 'microsoft-oauth' })
  ]
})

const applicationIntegration = makeIntegration({
  connectorId: 'microsoft',
  config: { oneDriveAccessMode: 'application' },
  credentialBindings: [
    makeCredentialBinding({ slotId: microsoftOAuthSlotId, credentialRef: 'microsoft-oauth' })
  ]
})

const monitorId = '4A3407B5-88FC-4504-8B21-0AABD3412717'

const monitorUrl = `https://contoso.sharepoint.com/sites/source/_api/v2.1/monitor/${monitorId}`

const response = (status: number, body: string, headers: Readonly<Record<string, string>> = {}) =>
  ConnectorHttpResponse.make({ status, headers, body })

const makeHost = (responses: ReadonlyArray<ConnectorHttpResponse>) => {
  const requests: Array<ConnectorHttpRequest> = []
  const credentialRequests: Array<CredentialResolveRequest> = []
  let responseIndex = 0

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
        requests.push(request)
        const next = responses.at(responseIndex)
        responseIndex += 1

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

const invoke = (
  action: string,
  input: unknown,
  layer: ReturnType<typeof makeHost>['layer'],
  selectedIntegration = integration
) =>
  MicrosoftConnector.invoke({ action, input, integration: selectedIntegration }).pipe(
    Effect.provide(layer)
  )

describe('Microsoft OneDrive move and copy', () => {
  it.effect('registers write move/copy actions and a read-only polling action', () =>
    Effect.gen(function* () {
      const host = makeHost([])

      const tools = yield* resolveTools(
        [makeConnectorToolModule(MicrosoftConnector, { integration, layer: host.layer })],
        {}
      )

      expect(oneDriveMoveItemAction.access).toBe('write')
      expect(oneDriveCopyItemAction.access).toBe('write')
      expect(oneDriveGetCopyStatusAction.access).toBeUndefined()
      expect(MicrosoftConnector.actions).toContain(oneDriveMoveItemAction)
      expect(MicrosoftConnector.actions).toContain(oneDriveCopyItemAction)
      expect(MicrosoftConnector.actions).toContain(oneDriveGetCopyStatusAction)
      expect(
        tools.tools.find(tool => tool.name === 'onedrive.move_item')?.parameters
      ).toMatchObject({
        type: 'object',
        required: expect.arrayContaining(['itemId', 'destinationParentItemId'])
      })
      expect(
        tools.tools.find(tool => tool.name === 'onedrive.copy_item')?.parameters
      ).toMatchObject({
        type: 'object',
        required: expect.arrayContaining([
          'itemId',
          'destinationDriveId',
          'destinationParentItemId'
        ])
      })
      expect(
        tools.tools.find(tool => tool.name === 'onedrive.get_copy_status')?.parameters
      ).toMatchObject({ type: 'object', required: expect.arrayContaining(['monitorUrl']) })
    })
  )

  it.effect('moves within one drive with an optional revision precondition', () =>
    Effect.gen(function* () {
      const host = makeHost([
        response(
          200,
          JSON.stringify({
            id: 'item/1',
            name: 'Renamed.txt',
            parentReference: { driveId: 'drive/1', id: 'folder/2' },
            file: {}
          })
        )
      ])

      const result = yield* invoke(
        'onedrive.move_item',
        {
          driveId: 'drive/1',
          itemId: 'item/1',
          destinationParentItemId: 'folder/2',
          name: 'Renamed.txt',
          ifMatch: '"etag-1"'
        },
        host.layer
      )

      expect(result).toMatchObject({
        _tag: 'Success',
        value: {
          id: 'item/1',
          name: 'Renamed.txt',
          parentReference: { driveId: 'drive/1', id: 'folder/2' }
        }
      })
      expect(host.requests).toEqual([
        expect.objectContaining({
          method: 'PATCH',
          url: 'https://graph.microsoft.com/v1.0/drives/drive%2F1/items/item%2F1',
          headers: {
            authorization: 'Bearer FAKE-MICROSOFT-TOKEN',
            accept: 'application/json',
            'content-type': 'application/json',
            'if-match': '"etag-1"'
          },
          body: JSON.stringify({
            parentReference: { id: 'folder/2' },
            name: 'Renamed.txt'
          }),
          redirect: 'manual',
          credentials: 'omit'
        })
      ])
      expect(host.credentialRequests[0]?.slot.requiredScopes).toEqual([
        microsoftGraphFilesReadWriteScope
      ])
    })
  )

  it.effect(
    'returns accepted for copy and polls the monitor without credentials or redirects',
    () =>
      Effect.gen(function* () {
        const host = makeHost([
          response(202, '', { Location: monitorUrl }),
          response(
            202,
            JSON.stringify({
              operation: 'ItemCopy',
              percentageComplete: 27.8,
              status: 'inProgress'
            })
          )
        ])

        const accepted = yield* invoke(
          'onedrive.copy_item',
          {
            itemId: 'item/1',
            destinationDriveId: 'drive/2',
            destinationParentItemId: 'folder/2',
            name: 'Copy.txt',
            conflictBehavior: 'rename'
          },
          host.layer
        )

        expect(accepted).toEqual({
          _tag: 'Success',
          value: { status: 'accepted', monitorUrl }
        })

        const status = yield* invoke('onedrive.get_copy_status', { monitorUrl }, host.layer)

        expect(status).toEqual({
          _tag: 'Success',
          value: { status: 'inProgress', percentageComplete: 27.8 }
        })
        expect(host.requests[0]).toMatchObject({
          method: 'POST',
          url: 'https://graph.microsoft.com/v1.0/me/drive/items/item%2F1/copy?%40microsoft.graph.conflictBehavior=rename',
          body: JSON.stringify({
            parentReference: { driveId: 'drive/2', id: 'folder/2' },
            name: 'Copy.txt'
          }),
          redirect: 'manual',
          credentials: 'omit'
        })
        expect(host.requests[1]).toEqual(
          expect.objectContaining({
            method: 'GET',
            url: monitorUrl,
            headers: { accept: 'application/json' },
            redirect: 'manual',
            credentials: 'omit'
          })
        )
        expect(host.requests[1]?.headers).not.toHaveProperty('authorization')
        expect(host.credentialRequests.map(request => request.slot.requiredScopes)).toEqual([
          [microsoftGraphFilesReadWriteScope],
          [microsoftGraphFilesReadWriteScope]
        ])
      })
  )

  it.effect('reports asynchronous copy failure without claiming completion', () =>
    Effect.gen(function* () {
      const host = makeHost([
        response(
          202,
          JSON.stringify({
            id: 'operation-id',
            status: 'failed',
            error: {
              message: 'Errors occurred during copy/move operation.',
              details: [{ code: 'nameAlreadyExists', message: 'Name already exists' }]
            }
          })
        )
      ])

      const result = yield* invoke('onedrive.get_copy_status', { monitorUrl }, host.layer)

      expect(result).toEqual({
        _tag: 'Success',
        value: {
          status: 'failed',
          error: {
            code: 'nameAlreadyExists',
            message: 'Errors occurred during copy/move operation.'
          }
        }
      })
    })
  )

  it.effect('maps an empty 303 completion redirect without following or exposing it', () =>
    Effect.gen(function* () {
      const host = makeHost([
        response(303, '', {
          Location: 'https://contoso.sharepoint.com/secret-result-location'
        })
      ])

      const result = yield* invoke('onedrive.get_copy_status', { monitorUrl }, host.layer)

      expect(result).toEqual({
        _tag: 'Success',
        value: { status: 'completed' }
      })
      expect(JSON.stringify(result)).not.toContain('secret-result-location')
      expect(host.requests).toHaveLength(1)
    })
  )

  it.effect('fails closed on untrusted, ambiguous, and redirected monitor locations', () =>
    Effect.gen(function* () {
      const oneDriveApiMonitorUrl = `https://api.onedrive.com/monitor/${monitorId}`

      const invalidLocationHeaders: ReadonlyArray<Readonly<Record<string, string>>> = [
        {},
        { Location: `http://api.onedrive.com/monitor/${monitorId}` },
        { Location: `https://evil-sharepoint.com/_api/v2.0/monitor/${monitorId}` },
        { Location: `https://api.onedrive.com:443/monitor/${monitorId}` },
        { Location: `${monitorUrl}, ${monitorUrl}` },
        { Location: `${monitorUrl},${oneDriveApiMonitorUrl}` },
        { Location: ` ${oneDriveApiMonitorUrl}` },
        { Location: `https://api.onedrive.com/ignored/../monitor/${monitorId}` },
        { Location: `https://api.onedrive.com\\monitor\\${monitorId}` },
        { Location: `https://contoso.sharepoint.com/sites/%zz/_api/v2.1/monitor/${monitorId}` },
        {
          Location: monitorUrl,
          location: oneDriveApiMonitorUrl
        }
      ]

      for (const headers of invalidLocationHeaders) {
        const host = makeHost([response(202, '', headers)])

        const result = yield* invoke(
          'onedrive.copy_item',
          {
            itemId: 'item',
            destinationDriveId: 'drive',
            destinationParentItemId: 'folder'
          },
          host.layer
        ).pipe(Effect.result)

        expect(Result.isFailure(result)).toBe(true)

        if (Result.isFailure(result)) {
          expect(result.failure).toMatchObject({
            cause: 'validation_failed',
            actionId: 'onedrive.copy_item'
          })
        }
      }

      const invalidMonitorUrls = [
        `https://api.onedrive.com.evil.test/monitor/${monitorId}`,
        `https://api.onedrive.com:443/monitor/${monitorId}`,
        `${monitorUrl},${oneDriveApiMonitorUrl}`,
        `\thttps://api.onedrive.com/monitor/${monitorId}`,
        `https://api.onedrive.com/ignored/../monitor/${monitorId}`,
        `https://api.onedrive.com\\monitor\\${monitorId}`,
        `https://contoso.sharepoint.com/sites/source%2fignored/_api/v2.1/monitor/${monitorId}`,
        `https://contoso.sharepoint.com/sites/%zz/_api/v2.1/monitor/${monitorId}`
      ]

      for (const invalidMonitorUrl of invalidMonitorUrls) {
        const invalidInputHost = makeHost([])

        const invalidInput = yield* invoke(
          'onedrive.get_copy_status',
          { monitorUrl: invalidMonitorUrl },
          invalidInputHost.layer
        ).pipe(Effect.result)

        expect(Result.isFailure(invalidInput)).toBe(true)
        expect(invalidInputHost.credentialRequests).toHaveLength(0)
        expect(invalidInputHost.requests).toHaveLength(0)
      }

      const redirectHost = makeHost([response(302, '', { Location: monitorUrl })])

      const redirected = yield* invoke(
        'onedrive.get_copy_status',
        {
          monitorUrl: 'https://api.onedrive.com/monitor/4A3407B5-88FC-4504-8B21-0AABD3412717'
        },
        redirectHost.layer
      )

      expect(redirected).toMatchObject({
        _tag: 'Failure',
        error: { code: 'onedrive_get_copy_status_failed', status: 302 }
      })
      expect(redirectHost.requests).toHaveLength(1)
    })
  )

  it.effect('sanitizes rejected monitor responses for connector and agent callers', () =>
    Effect.gen(function* () {
      const secretLocation = 'https://contoso.sharepoint.com/secret-result-location'

      const secretBody = JSON.stringify({
        error: { message: `Monitor failed at ${secretLocation}` },
        resourceLocation: secretLocation
      })

      const directHost = makeHost([response(429, secretBody, { 'RETRY-AFTER': '3' })])

      const directResult = yield* invoke(
        'onedrive.get_copy_status',
        { monitorUrl },
        directHost.layer
      )

      expect(directResult).toEqual({
        _tag: 'Failure',
        error: {
          code: 'microsoft_rate_limited',
          message: 'Microsoft OneDrive get copy status failed',
          status: 429,
          retryAfterMs: 3_000
        }
      })
      expect(JSON.stringify(directResult)).not.toContain(secretLocation)

      const unsafeRetryHost = makeHost([
        response(429, secretBody, { 'Retry-After': '9007199254740991' })
      ])

      const unsafeRetry = yield* invoke(
        'onedrive.get_copy_status',
        { monitorUrl },
        unsafeRetryHost.layer
      )

      expect(unsafeRetry).toEqual({
        _tag: 'Failure',
        error: {
          code: 'microsoft_rate_limited',
          message: 'Microsoft OneDrive get copy status failed',
          status: 429
        }
      })
      expect(JSON.stringify(unsafeRetry)).not.toContain('retryAfterMs')

      const agentHost = makeHost([response(429, secretBody, { 'retry-after': '3.5' })])

      const tools = yield* resolveTools(
        [makeConnectorToolModule(MicrosoftConnector, { integration, layer: agentHost.layer })],
        {}
      )

      const agentResult = yield* tools.execute({
        id: 'copy-status-call',
        name: 'onedrive.get_copy_status',
        params: { monitorUrl }
      })

      expect(agentResult).toMatchObject({
        isError: true,
        structuredContent: {
          code: 'microsoft_rate_limited',
          message: 'Microsoft OneDrive get copy status failed',
          status: 429
        }
      })
      expect(agentResult.structuredContent).not.toHaveProperty('retryAfterMs')
      expect(JSON.stringify(agentResult)).not.toContain(secretLocation)
    })
  )

  it.effect('rejects unsupported or unsafe inputs before credentials and network', () =>
    Effect.gen(function* () {
      const invalidInputs = [
        {
          action: 'onedrive.move_item',
          input: { itemId: 'item', destinationParentItemId: 'root' }
        },
        {
          action: 'onedrive.move_item',
          input: { itemId: '..', destinationParentItemId: 'folder' }
        },
        {
          action: 'onedrive.copy_item',
          input: {
            itemId: 'root',
            destinationDriveId: 'drive',
            destinationParentItemId: 'folder'
          }
        },
        {
          action: 'onedrive.copy_item',
          input: {
            itemId: 'item',
            destinationDriveId: 'drive',
            destinationParentItemId: 'folder',
            conflictBehavior: 'replace'
          }
        },
        {
          action: 'onedrive.copy_item',
          input: {
            itemId: 'item',
            destinationDriveId: 'drive',
            destinationParentItemId: 'folder',
            name: 'bad/name'
          }
        }
      ]

      for (const testCase of invalidInputs) {
        const host = makeHost([])

        const result = yield* invoke(testCase.action, testCase.input, host.layer).pipe(
          Effect.result
        )

        expect(Result.isFailure(result)).toBe(true)
        expect(host.credentialRequests).toHaveLength(0)
        expect(host.requests).toHaveLength(0)
      }

      const applicationHost = makeHost([])

      const applicationResult = yield* invoke(
        'onedrive.copy_item',
        {
          itemId: 'item',
          destinationDriveId: 'destination-drive',
          destinationParentItemId: 'folder'
        },
        applicationHost.layer,
        applicationIntegration
      ).pipe(Effect.result)

      expect(Result.isFailure(applicationResult)).toBe(true)
      expect(applicationHost.credentialRequests).toHaveLength(0)
      expect(applicationHost.requests).toHaveLength(0)
    })
  )

  it.effect('uses all-files write scope only for explicit application access', () =>
    Effect.gen(function* () {
      const host = makeHost([
        response(202, '', {
          Location: 'https://api.onedrive.com/monitor/4A3407B5-88FC-4504-8B21-0AABD3412717'
        })
      ])

      const result = yield* invoke(
        'onedrive.copy_item',
        {
          driveId: 'source-drive',
          itemId: 'item',
          destinationDriveId: 'destination-drive',
          destinationParentItemId: 'folder'
        },
        host.layer,
        applicationIntegration
      )

      expect(result._tag).toBe('Success')
      expect(host.credentialRequests[0]?.slot.requiredScopes).toEqual([
        microsoftGraphFilesReadWriteAllScope
      ])
    })
  )

  it.effect('maps provider conflict and retry responses through bounded action failures', () =>
    Effect.gen(function* () {
      const moveHost = makeHost([
        response(412, JSON.stringify({ error: { message: 'The item changed' } }))
      ])

      const move = yield* invoke(
        'onedrive.move_item',
        { itemId: 'item', destinationParentItemId: 'folder', ifMatch: '"old"' },
        moveHost.layer
      )

      expect(move).toMatchObject({
        _tag: 'Failure',
        error: {
          code: 'microsoft_precondition_failed',
          message: 'Microsoft OneDrive move item failed: The item changed',
          status: 412
        }
      })

      const copyHost = makeHost([
        response(429, JSON.stringify({ error: { message: 'Slow down' } }), { 'retry-after': '2' })
      ])

      const copy = yield* invoke(
        'onedrive.copy_item',
        {
          itemId: 'item',
          destinationDriveId: 'drive',
          destinationParentItemId: 'folder'
        },
        copyHost.layer
      )

      expect(copy).toMatchObject({
        _tag: 'Failure',
        error: {
          code: 'microsoft_rate_limited',
          message: 'Microsoft OneDrive copy item failed: Slow down',
          status: 429,
          retryAfterMs: 2_000
        }
      })
    })
  )
})
