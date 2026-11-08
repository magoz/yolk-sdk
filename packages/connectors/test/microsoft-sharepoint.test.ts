import { describe, expect, it } from '@effect/vitest'
import { Effect, Layer } from 'effect'
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
  MicrosoftSharePointSitesReadOAuthCredentialSlot,
  microsoftGraphFilesReadAllScope,
  microsoftGraphFilesReadWriteAllScope,
  microsoftGraphSitesReadAllScope,
  microsoftOAuthSlotId,
  MicrosoftCombinedOAuthCredentialSlot,
  oneDriveResolveSharingLinkAction,
  oneDriveSharingUrlShareId,
  sharePointListSiteDrivesAction,
  sharePointSearchSitesAction
} from '@yolk-sdk/connectors/microsoft'

const bindings = [
  makeCredentialBinding({ slotId: microsoftOAuthSlotId, credentialRef: 'microsoft-oauth' })
]

const integration = makeIntegration({ connectorId: 'microsoft', credentialBindings: bindings })

const integrationWithMode = (oneDriveAccessMode: string) =>
  makeIntegration({
    connectorId: 'microsoft',
    config: { oneDriveAccessMode },
    credentialBindings: bindings
  })

const siteId = 'contoso.sharepoint.com,2c712604-1370-44e7-a1f5-426573fdab87,2d2244e1-d1e5-4e4b'

const sharingUrl =
  'https://contoso.sharepoint.com/:p:/s/Sales/IQC9J2L9-8g7Qax8mtYRzPTKAam5lxlr4Rd2ArTHsLKUlg0'

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

describe('Microsoft SharePoint sites and sharing links', () => {
  it.effect('registers actions without write access and with root-object tool parameters', () =>
    Effect.gen(function* () {
      const host = makeHost([])

      const tools = yield* resolveTools(
        [makeConnectorToolModule(MicrosoftConnector, { integration, layer: host.layer })],
        {}
      )

      for (const action of [
        sharePointSearchSitesAction,
        sharePointListSiteDrivesAction,
        oneDriveResolveSharingLinkAction
      ]) {
        expect(action.access).toBeUndefined()
        expect(MicrosoftConnector.actions).toContain(action)
      }

      expect(
        tools.tools.find(tool => tool.name === 'sharepoint.search_sites')?.parameters
      ).toMatchObject({ type: 'object', required: ['query'] })
      expect(
        tools.tools.find(tool => tool.name === 'sharepoint.list_site_drives')?.parameters
      ).toMatchObject({ type: 'object', required: ['siteId'] })
      expect(
        tools.tools.find(tool => tool.name === 'onedrive.resolve_sharing_link')?.parameters
      ).toMatchObject({ type: 'object', required: ['sharingUrl'] })
    })
  )

  it('keeps Sites.Read.All out of the combined slot', () => {
    expect(MicrosoftSharePointSitesReadOAuthCredentialSlot.requiredScopes).toEqual([
      microsoftGraphSitesReadAllScope
    ])
    expect(MicrosoftCombinedOAuthCredentialSlot.requiredScopes).not.toContain(
      microsoftGraphSitesReadAllScope
    )
  })

  it.each<string>([
    sharingUrl,
    'https://onedrive.live.com/redir?resid=1231244193912!12&authKey=1201919!12921!1',
    'https://contoso.sharepoint.com/:w:/s/Försäljning/EZ?e=a+b/c'
  ])('encodes %s as Graph u! unpadded base64url of its UTF-8 bytes', url => {
    expect(oneDriveSharingUrlShareId(url)).toBe(`u!${Buffer.from(url).toString('base64url')}`)
  })

  it.effect('resolves a sharing link for this request only under delegated Files.Read.All', () =>
    Effect.gen(function* () {
      const host = makeHost([
        response(
          200,
          JSON.stringify({
            id: '01ITEM',
            name: 'Weekly sales.pptx',
            webUrl: 'https://contoso.sharepoint.com/sites/Sales/Shared%20Documents/Weekly.pptx',
            parentReference: {
              driveId: 'b!library',
              driveType: 'documentLibrary',
              id: '01PARENT',
              siteId
            },
            file: { mimeType: 'application/vnd.ms-powerpoint' }
          })
        )
      ])

      const result = yield* invoke('onedrive.resolve_sharing_link', { sharingUrl }, host.layer)

      expect(result).toMatchObject({
        _tag: 'Success',
        value: {
          id: '01ITEM',
          parentReference: { driveId: 'b!library', driveType: 'documentLibrary', siteId }
        }
      })
      expect(host.requests).toHaveLength(1)
      expect(host.requests[0]).toMatchObject({
        method: 'GET',
        headers: {
          authorization: 'Bearer FAKE-MICROSOFT-TOKEN',
          accept: 'application/json',
          prefer: 'redeemSharingLinkIfNecessary'
        }
      })

      const url = new URL(host.requests[0]?.url ?? '')

      expect(url.origin).toBe('https://graph.microsoft.com')
      expect(url.pathname).toBe(`/v1.0/shares/${oneDriveSharingUrlShareId(sharingUrl)}/driveItem`)
      expect(url.searchParams.get('$select')).toContain('parentReference')
      expect(host.credentialRequests.map(request => request.slot.requiredScopes)).toEqual([
        [microsoftGraphFilesReadAllScope]
      ])
    })
  )

  it.effect('selects Files.Read.All for delegated_all and Files.ReadWrite.All for apps', () =>
    Effect.gen(function* () {
      const item = response(200, JSON.stringify({ id: '01ITEM', name: 'a.docx' }))
      const host = makeHost([item, item])

      yield* invoke(
        'onedrive.resolve_sharing_link',
        { sharingUrl },
        host.layer,
        integrationWithMode('delegated_all')
      )
      yield* invoke(
        'onedrive.resolve_sharing_link',
        { sharingUrl },
        host.layer,
        integrationWithMode('application')
      )

      expect(host.credentialRequests.map(request => request.slot.requiredScopes)).toEqual([
        [microsoftGraphFilesReadAllScope],
        [microsoftGraphFilesReadWriteAllScope]
      ])
    })
  )

  it.effect.each<string>([
    'http://contoso.sharepoint.com/:p:/s/Sales/abc',
    'https://user:pass@contoso.sharepoint.com/:p:/s/Sales/abc',
    'https://contoso.sharepoint.com:8443/:p:/s/Sales/abc',
    'https://evil-sharepoint.com/:p:/s/Sales/abc',
    'https://sharepoint.com.example.test/:p:/s/Sales/abc',
    ` ${sharingUrl}`,
    `${sharingUrl}\n`,
    'https://contoso.sharepoint.com/:p:/s/Sales/a\tb',
    'not a url',
    `https://contoso.sharepoint.com/${'a'.repeat(2048)}`
  ])('rejects %s before credentials or requests', sharingUrlInput =>
    Effect.gen(function* () {
      const host = makeHost([])

      const error = yield* Effect.flip(
        invoke('onedrive.resolve_sharing_link', { sharingUrl: sharingUrlInput }, host.layer)
      )

      expect(error).toMatchObject({ cause: 'validation_failed' })
      expect(host.credentialRequests).toHaveLength(0)
      expect(host.requests).toHaveLength(0)
    })
  )

  it.effect('reports a refused sharing link as a provider failure', () =>
    Effect.gen(function* () {
      const host = makeHost([
        response(403, JSON.stringify({ error: { code: 'accessDenied', message: 'Access denied' } }))
      ])

      const result = yield* invoke('onedrive.resolve_sharing_link', { sharingUrl }, host.layer)

      expect(result).toMatchObject({
        _tag: 'Failure',
        error: { status: 403, message: expect.stringContaining('resolve sharing link failed') }
      })
    })
  )

  it.effect('searches sites under Sites.Read.All and omits null properties', () =>
    Effect.gen(function* () {
      const nextLink = 'https://graph.microsoft.com/v1.0/sites?search=sales&$skiptoken=abc'

      const host = makeHost([
        response(
          200,
          JSON.stringify({
            value: [
              {
                id: siteId,
                name: 'Sales',
                displayName: 'Försäljning',
                description: null,
                webUrl: 'https://contoso.sharepoint.com/sites/Sales',
                siteCollection: { hostname: 'contoso.sharepoint.com' }
              }
            ],
            '@odata.nextLink': nextLink
          })
        ),
        response(200, JSON.stringify({ value: [] }))
      ])

      const first = yield* invoke(
        'sharepoint.search_sites',
        { query: "Försäljning & Co's", top: 5 },
        host.layer
      )

      expect(first).toEqual({
        _tag: 'Success',
        value: {
          sites: [
            {
              id: siteId,
              name: 'Sales',
              displayName: 'Försäljning',
              webUrl: 'https://contoso.sharepoint.com/sites/Sales'
            }
          ],
          nextLink
        }
      })

      const url = new URL(host.requests[0]?.url ?? '')

      expect(url.pathname).toBe('/v1.0/sites')
      expect(url.searchParams.get('search')).toBe("Försäljning & Co's")
      expect(url.searchParams.get('$top')).toBe('5')

      const second = yield* invoke(
        'sharepoint.search_sites',
        { query: 'sales', nextLink },
        host.layer
      )

      expect(second).toEqual({ _tag: 'Success', value: { sites: [] } })
      expect(host.requests[1]?.url).toBe(nextLink)
      expect(host.credentialRequests.map(request => request.slot.requiredScopes)).toEqual([
        [microsoftGraphSitesReadAllScope],
        [microsoftGraphSitesReadAllScope]
      ])
    })
  )

  it.effect('lists site drives with the site id commas kept literal', () =>
    Effect.gen(function* () {
      const host = makeHost([
        response(
          200,
          JSON.stringify({
            value: [
              {
                id: 'b!library',
                name: 'Documents',
                driveType: 'documentLibrary',
                description: '',
                webUrl: 'https://contoso.sharepoint.com/sites/Sales/Shared%20Documents',
                owner: { group: { displayName: 'Sales' } }
              }
            ]
          })
        )
      ])

      const result = yield* invoke('sharepoint.list_site_drives', { siteId }, host.layer)

      expect(result).toEqual({
        _tag: 'Success',
        value: {
          drives: [
            {
              id: 'b!library',
              name: 'Documents',
              driveType: 'documentLibrary',
              description: '',
              webUrl: 'https://contoso.sharepoint.com/sites/Sales/Shared%20Documents'
            }
          ]
        }
      })

      const url = new URL(host.requests[0]?.url ?? '')

      expect(url.pathname).toBe(`/v1.0/sites/${siteId}/drives`)
      expect(url.searchParams.get('$select')).toContain('driveType')
      expect(host.credentialRequests[0]?.slot.requiredScopes).toEqual([
        microsoftGraphSitesReadAllScope
      ])
    })
  )

  it.effect.each<string>([
    `https://graph.microsoft.com/v1.0/sites/${siteId}/drives?$skiptoken=1`,
    `https://graph.microsoft.com/v1.0/sites/${encodeURIComponent(siteId)}/drives?$skiptoken=1`
  ])('replays the selected site drives nextLink %s', nextLink =>
    Effect.gen(function* () {
      const host = makeHost([response(200, JSON.stringify({ value: [] }))])

      const result = yield* invoke('sharepoint.list_site_drives', { siteId, nextLink }, host.layer)

      expect(result).toEqual({ _tag: 'Success', value: { drives: [] } })
      expect(host.requests[0]?.url).toBe(nextLink)
    })
  )

  it.effect.each<{ readonly action: string; readonly input: Record<string, string> }>([
    {
      action: 'sharepoint.list_site_drives',
      input: {
        siteId,
        nextLink: 'https://graph.microsoft.com/v1.0/sites/other,site,id/drives?$skiptoken=1'
      }
    },
    {
      action: 'sharepoint.list_site_drives',
      input: { siteId, nextLink: `https://evil.example.test/v1.0/sites/${siteId}/drives` }
    },
    {
      action: 'sharepoint.search_sites',
      input: { query: 'sales', nextLink: 'https://graph.microsoft.com/v1.0/me/drive/root/children' }
    },
    { action: 'sharepoint.search_sites', input: { query: 'sales', nextLink: 'not a url' } }
  ])('rejects a nextLink outside the selected collection ($action)', ({ action, input }) =>
    Effect.gen(function* () {
      const host = makeHost([])

      const error = yield* Effect.flip(invoke(action, input, host.layer))

      expect(error).toMatchObject({ cause: 'validation_failed' })
      expect(host.requests).toHaveLength(0)
    })
  )

  it.effect.each<string>(['..', 'contoso.sharepoint.com,\ud800', 'site\u0000id'])(
    'rejects the site id %j before credentials or requests',
    badSiteId =>
      Effect.gen(function* () {
        const host = makeHost([])

        const error = yield* Effect.flip(
          invoke('sharepoint.list_site_drives', { siteId: badSiteId }, host.layer)
        )

        expect(error).toMatchObject({ cause: 'validation_failed' })
        expect(host.credentialRequests).toHaveLength(0)
        expect(host.requests).toHaveLength(0)
      })
  )

  it.effect('reports a refused site search as a provider failure', () =>
    Effect.gen(function* () {
      const host = makeHost([
        response(403, JSON.stringify({ error: { code: 'accessDenied', message: 'Denied' } }))
      ])

      const result = yield* invoke('sharepoint.search_sites', { query: 'sales' }, host.layer)

      expect(result).toMatchObject({
        _tag: 'Failure',
        error: { status: 403, message: expect.stringContaining('search sites failed') }
      })
    })
  )

  it.effect('accepts a 1drv.ms personal sharing link', () =>
    Effect.gen(function* () {
      const link = 'https://1drv.ms/w/s!AkPersonalShareToken'
      const host = makeHost([response(200, JSON.stringify({ id: 'ITEM', name: 'a.docx' }))])

      const result = yield* invoke(
        'onedrive.resolve_sharing_link',
        { sharingUrl: link },
        host.layer
      )

      expect(result).toMatchObject({ _tag: 'Success', value: { id: 'ITEM' } })
      expect(new URL(host.requests[0]?.url ?? '').pathname).toBe(
        `/v1.0/shares/${oneDriveSharingUrlShareId(link)}/driveItem`
      )
    })
  )
})
