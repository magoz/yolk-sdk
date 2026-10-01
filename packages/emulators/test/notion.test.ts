import { Effect, Layer, Predicate } from 'effect'
import { afterEach, describe, expect, it } from '@effect/vitest'
import { vi } from 'vitest'
import type * as Schema from 'effect/Schema'
import { ApiKeyCredential } from '@yolk-sdk/connectors'
import {
  connectorHttpClientsFromEffectHttpClientLayer,
  staticCredentialResolverLayer
} from '@yolk-sdk/connectors/conformance'
import {
  NotionSearchInput,
  notionApiBaseUrl,
  notionSearchAction
} from '@yolk-sdk/connectors/notion'
import {
  notionConformanceCases,
  notionConformanceFixtureSeeds,
  notionConformanceFixtures,
  notionConformanceIntegration
} from '@yolk-sdk/connectors/notion/conformance'
import {
  NotionEmulatorInputInvalid,
  emulatorEvidenceHeader,
  makeNotionEmulator,
  notionEmulatorRoutes,
  type NotionEmulator,
  type NotionEmulatorOptions,
  type NotionFault
} from '../src/notion.ts'
import { EmulatorRoute, InProcessHttpClient } from '../src/router.ts'

const origin = new URL(notionApiBaseUrl).origin

const token = 'synthetic-unit-test-token'

const now = Date.parse('2026-09-29T15:00:00.000Z')

const seeds = notionConformanceFixtureSeeds

const open: Array<NotionEmulator> = []

afterEach(async () => {
  await Promise.all(open.splice(0).map(emulator => emulator.close()))
})

const emulator = async (options: NotionEmulatorOptions = {}): Promise<NotionEmulator> => {
  const created = await makeNotionEmulator({ now: () => now, ...options })

  open.push(created)

  return created
}

type CallOptions = {
  readonly body?: unknown
  readonly rawBody?: string
  readonly authorization?: string | null
  readonly version?: string | null
  readonly headers?: Record<string, string>
}

const call = (
  target: NotionEmulator,
  method: string,
  path: string,
  options: CallOptions = {}
): Promise<Response> => {
  const headers = new Headers(options.headers)

  const authorization =
    options.authorization === undefined ? `Bearer ${token}` : options.authorization

  const version = options.version === undefined ? '2025-09-03' : options.version

  if (authorization !== null) headers.set('authorization', authorization)

  if (version !== null) headers.set('notion-version', version)

  const body =
    options.rawBody ?? (options.body === undefined ? undefined : JSON.stringify(options.body))

  if (body !== undefined && !headers.has('content-type')) {
    headers.set('content-type', 'application/json')
  }

  return target.fetch(new Request(`${origin}${path}`, { method, headers, body }))
}

const field = (value: unknown, key: string): unknown =>
  Predicate.isObject(value) ? value[key] : undefined

const jsonOf = async (response: Response): Promise<unknown> => response.json()

const expectNotEmulated = async (response: Response, label = '') => {
  expect(response.status, label).toBe(400)
  expect(await jsonOf(response), label).toEqual({
    error: { type: 'not_emulated', message: expect.stringMatching(/^Not emulated: /) }
  })
}

const searchBody = (extra: Schema.JsonObject = {}) => ({
  query: 'yolk-search-probe',
  filter: { property: 'object', value: 'page' },
  page_size: 1,
  ...extra
})

const credentialLayer = staticCredentialResolverLayer(ApiKeyCredential.make({ key: token }))

const connectorLayer = (target: NotionEmulator) =>
  Layer.mergeAll(
    connectorHttpClientsFromEffectHttpClientLayer.pipe(
      Layer.provide(InProcessHttpClient.layer([EmulatorRoute.handler(origin, target.fetch)]))
    ),
    credentialLayer
  )

const createBody = (title = 'yolk-conformance page: safe to delete') => ({
  parent: { page_id: seeds.parentPageId },
  properties: { title: { title: [{ text: { content: title } }] } }
})

describe('route evidence manifest', () => {
  it('lists every route as an unverified connector route linked to Notion cases', () => {
    const caseIds = new Set(notionConformanceCases.map(testCase => testCase.id))

    expect(notionEmulatorRoutes.map(route => `${route.method} ${route.path}`)).toEqual([
      'POST /v1/search',
      'GET /v1/users/me',
      'GET /v1/pages/{pageId}',
      'POST /v1/pages',
      'PATCH /v1/pages/{pageId}',
      'GET /v1/blocks/{blockId}/children',
      'GET /v1/pages/{pageId}/properties/{propertyId}',
      'GET /v1/databases/{databaseId}',
      'GET /v1/data_sources/{dataSourceId}',
      'POST /v1/data_sources/{dataSourceId}/query'
    ])
    expect(
      notionEmulatorRoutes
        .filter(route => route.write)
        .map(route => `${route.method} ${route.path}`)
    ).toEqual(['POST /v1/pages', 'PATCH /v1/pages/{pageId}'])

    for (const route of notionEmulatorRoutes) {
      expect(route).toMatchObject({ kind: 'connector', evidence: 'unverified' })
      expect(route.observedAt).toBeUndefined()
      expect(route.caseIds.length, route.path).toBeGreaterThan(0)
      expect(route.caseIds.every(caseId => caseIds.has(caseId))).toBe(true)
    }

    expect(new Set(notionEmulatorRoutes.flatMap(route => route.caseIds))).toEqual(caseIds)
  })

  it.effect('has a handler behind every manifest route', () =>
    Effect.promise(async () => {
      const target = await emulator()

      for (const route of notionEmulatorRoutes) {
        const path = route.path
          .replace('{pageId}', 'missing')
          .replace('{blockId}', 'missing')
          .replace('{propertyId}', 'missing')
          .replace('{databaseId}', 'missing')
          .replace('{dataSourceId}', 'missing')

        await call(target, route.method, path, {
          body: route.method === 'GET' ? undefined : {}
        })
      }

      expect(target.coverage().routes.every(route => route.requests === 1)).toBe(true)
      expect(target.coverage().unknownRouteRequests).toBe(0)
      expect(target.ledger.entries().every(entry => entry.evidence === 'unverified')).toBe(true)
    })
  )
})

describe('fixture data copies', () => {
  it.effect('the default seed holds every seeded id of the fixture seeds', () =>
    Effect.promise(async () => {
      const state = (await emulator()).snapshot()

      // Shown pages: the search, title, and property pages and the query's first row.
      expect(state.pages.map(page => page.id)).toEqual([
        '1f0000a0-0000-4000-8000-000000000001',
        '1f0000a0-0000-4000-8000-000000000002',
        seeds.titlePageId,
        seeds.propertyPageId,
        '1f0000d0-0000-4000-8000-000000000101'
      ])
      // Pages a fixture only names by id carry no content at all.
      expect(state.impliedPages).toEqual([
        { id: seeds.blocksPageId, parent: null },
        { id: seeds.parentPageId, parent: null },
        { id: '1f0000d0-0000-4000-8000-0000000000aa', parent: null },
        {
          id: '1f0000d0-0000-4000-8000-000000000102',
          parent: {
            type: 'data_source_id',
            data_source_id: '1f0000d0-0000-4000-8000-000000000001',
            database_id: seeds.databaseId
          }
        }
      ])
      expect(state.databases.map(database => database.id)).toEqual([seeds.databaseId])
      expect(state.propertyItems.map(items => [items.pageId, items.propertyId])).toEqual([
        [seeds.propertyPageId, seeds.propertyId]
      ])
      expect(state.blocks.every(block => block.pageId === seeds.blocksPageId)).toBe(true)
    })
  )
})

describe('fixture envelopes', () => {
  // Replays every Notion fixture's requests, in order, against a fresh emulator (the clock at the
  // archive fixture's time) and compares each complete response with the fixture byte for byte:
  // status, content type, and the whole body. Only the top-level `request_id` (the emulator mints
  // it from its ledger) is replaced by the fixture's before the comparison.
  for (const fixture of notionConformanceFixtures) {
    it.effect(fixture.id, () =>
      Effect.promise(async () => {
        const target = await emulator()

        for (const exchange of fixture.exchanges) {
          const label = `${exchange.request.method} ${exchange.request.url}`
          const headers = new Headers(exchange.request.headers)

          headers.set('authorization', `Bearer ${token}`)

          const body = exchange.request.body

          const response = await target.fetch(
            new Request(exchange.request.url, {
              method: exchange.request.method,
              headers,
              body: body === undefined ? undefined : JSON.stringify(body)
            })
          )

          const expected = exchange.response

          expect(response.status, label).toBe(expected.status)
          expect(response.headers.get('content-type'), label).toBe(expected.headers['content-type'])
          expect(response.headers.get(emulatorEvidenceHeader), label).toBe('unverified')

          const text = await response.text()
          const recorded = 'body' in expected ? (expected.body ?? '') : ''
          const fixtureRequestId = field(JSON.parse(recorded), 'request_id')
          const actual: unknown = JSON.parse(text)

          const comparable =
            Predicate.isString(fixtureRequestId) && Predicate.isObject(actual)
              ? JSON.stringify({ ...actual, request_id: fixtureRequestId })
              : text

          expect(comparable, label).toBe(recorded)
        }

        expect(target.ledger.entries().every(entry => entry.notEmulated === undefined)).toBe(true)
      })
    )
  }
})

describe('fail closed', () => {
  it.effect('answers unknown routes and methods with a ledgered 400 not-emulated', () =>
    Effect.promise(async () => {
      const target = await emulator()

      for (const [method, path] of [
        ['GET', '/v1/users'],
        ['GET', `/v1/users/${'1f0000b0-0000-4000-8000-000000000001'}`],
        ['POST', `/v1/databases/${seeds.databaseId}/query`],
        ['PATCH', `/v1/blocks/${seeds.blocksPageId}/children`],
        ['GET', `/v1/blocks/${seeds.blocksPageId}`],
        ['DELETE', `/v1/blocks/${seeds.blocksPageId}`],
        ['GET', '/v1/comments'],
        ['POST', '/v1/data_sources'],
        ['GET', '/v2/search'],
        ['DELETE', `/v1/pages/${seeds.titlePageId}`]
      ] as const) {
        const response = await call(target, method, path)

        await expectNotEmulated(response, `${method} ${path}`)
        expect(response.headers.get(emulatorEvidenceHeader)).toBeNull()
      }

      expect(target.ledger.entries().every(entry => entry.evidence === 'unknown-route')).toBe(true)
      expect(target.coverage()).toMatchObject({ unknownRouteRequests: 10, notEmulatedRequests: 10 })
    })
  )

  it.effect(
    'refuses other credentials, versions, bodies, queries, and shapes, writing nothing',
    () =>
      Effect.promise(async () => {
        const target = await emulator()
        const before = target.snapshot()
        const page = `/v1/pages/${seeds.titlePageId}`
        const blocks = `/v1/blocks/${seeds.blocksPageId}/children`
        const property = `/v1/pages/${seeds.propertyPageId}/properties/${encodeURIComponent(seeds.propertyId ?? '')}`
        const query = `/v1/data_sources/1f0000d0-0000-4000-8000-000000000001/query`

        // An unlimited fault on every route: no refused request may reach it.
        target.faults.add({ kind: 'status', status: 503 })

        const refused: ReadonlyArray<readonly [string, Promise<Response>]> = [
          ['no bearer', call(target, 'GET', page, { authorization: null })],
          ['basic auth', call(target, 'GET', page, { authorization: 'Basic eDp5' })],
          ['no version', call(target, 'GET', page, { version: null })],
          ['older version', call(target, 'GET', page, { version: '2022-06-28' })],
          ['query on a page read', call(target, 'GET', `${page}?filter_properties=title`)],
          [
            'search text body',
            call(target, 'POST', '/v1/search', {
              rawBody: '{}',
              headers: { 'content-type': 'text/plain' }
            })
          ],
          ['search sort', call(target, 'POST', '/v1/search', { body: searchBody({ sort: {} }) })],
          [
            'search data sources',
            call(target, 'POST', '/v1/search', {
              body: searchBody({ filter: { property: 'object', value: 'data_source' } })
            })
          ],
          [
            'search without page_size',
            call(target, 'POST', '/v1/search', {
              body: { query: 'x', filter: { property: 'object', value: 'page' } }
            })
          ],
          [
            'search page_size 101',
            call(target, 'POST', '/v1/search', { body: searchBody({ page_size: 101 }) })
          ],
          [
            'search without matches',
            call(target, 'POST', '/v1/search', {
              body: searchBody({ query: 'yolk-conformance', page_size: 100 })
            })
          ],
          [
            'search unknown cursor',
            call(target, 'POST', '/v1/search', { body: searchBody({ start_cursor: 'nope' }) })
          ],
          ['blocks without page_size', call(target, 'GET', blocks)],
          ['blocks page_size 0', call(target, 'GET', `${blocks}?page_size=0`)],
          ['blocks repeated page_size', call(target, 'GET', `${blocks}?page_size=2&page_size=2`)],
          ['blocks unknown cursor', call(target, 'GET', `${blocks}?page_size=2&start_cursor=nope`)],
          [
            'blocks of a block',
            call(
              target,
              'GET',
              `/v1/blocks/1f0000c0-0000-4000-8000-000000000001/children?page_size=2`
            )
          ],
          ['blocks malformed id', call(target, 'GET', '/v1/blocks/nope/children?page_size=2')],
          [
            'single-encoded property id',
            call(
              target,
              'GET',
              `/v1/pages/${seeds.propertyPageId}/properties/${seeds.propertyId}?page_size=2`
            )
          ],
          ['property without page_size', call(target, 'GET', property)],
          [
            'property foreign cursor',
            call(
              target,
              'GET',
              `${property}?page_size=2&start_cursor=${btoa(`2|${seeds.titlePageId}|x`)}`
            )
          ],
          [
            'missing database',
            call(target, 'GET', '/v1/databases/ffffffff-ffff-4fff-bfff-ffffffffffff')
          ],
          [
            'missing data source',
            call(target, 'GET', '/v1/data_sources/ffffffff-ffff-4fff-bfff-ffffffffffff')
          ],
          [
            'query with a cursor',
            call(target, 'POST', query, {
              body: { page_size: 1, start_cursor: '1f0000d0-0000-4000-8000-000000000102' }
            })
          ],
          [
            'query with a filter',
            call(target, 'POST', query, { body: { page_size: 1, filter: {} } })
          ],
          [
            'create with children',
            call(target, 'POST', '/v1/pages', { body: { ...createBody(), children: [] } })
          ],
          [
            'create under a database',
            call(target, 'POST', '/v1/pages', {
              body: { ...createBody(), parent: { database_id: seeds.databaseId } }
            })
          ],
          [
            'create under a missing page',
            call(target, 'POST', '/v1/pages', {
              body: { ...createBody(), parent: { page_id: 'ffffffff-ffff-4fff-bfff-ffffffffffff' } }
            })
          ],
          [
            'create with two title items',
            call(target, 'POST', '/v1/pages', {
              body: {
                ...createBody(),
                properties: {
                  title: { title: [{ text: { content: 'a' } }, { text: { content: 'b' } }] }
                }
              }
            })
          ],
          [
            'create with annotations',
            call(target, 'POST', '/v1/pages', {
              body: {
                ...createBody(),
                properties: { title: { title: [{ text: { content: 'a' }, annotations: {} }] } }
              }
            })
          ],
          ['restore from trash', call(target, 'PATCH', page, { body: { archived: false } })],
          [
            'update properties',
            call(target, 'PATCH', page, { body: { archived: true, properties: {} } })
          ],
          ['in_trash flag', call(target, 'PATCH', page, { body: { in_trash: true } })],
          [
            'archive malformed id',
            call(target, 'PATCH', '/v1/pages/nope', { body: { archived: true } })
          ],
          [
            'archive a missing page',
            call(target, 'PATCH', '/v1/pages/ffffffff-ffff-4fff-bfff-ffffffffffff', {
              body: { archived: true }
            })
          ],
          [
            'create with another title',
            call(target, 'POST', '/v1/pages', { body: createBody('Another') })
          ],
          [
            'read the blocks page (implied)',
            call(target, 'GET', `/v1/pages/${seeds.blocksPageId}`)
          ],
          [
            'read the parent page (implied)',
            call(target, 'GET', `/v1/pages/${seeds.parentPageId}`)
          ],
          [
            'read the second row (implied)',
            call(target, 'GET', '/v1/pages/1f0000d0-0000-4000-8000-000000000102')
          ],
          [
            'read the first row (shown only as a query row)',
            call(target, 'GET', '/v1/pages/1f0000d0-0000-4000-8000-000000000101')
          ],
          [
            'archive an implied page',
            call(target, 'PATCH', `/v1/pages/${seeds.parentPageId}`, { body: { archived: true } })
          ],
          [
            'query page_size 2 (needs the implied row)',
            call(target, 'POST', query, { body: { page_size: 2 } })
          ],
          [
            'search cursor never issued (a real result id)',
            call(target, 'POST', '/v1/search', {
              body: searchBody({ start_cursor: '1f0000a0-0000-4000-8000-000000000002' })
            })
          ],
          [
            'blocks cursor never issued (a real block id)',
            call(
              target,
              'GET',
              `${blocks}?page_size=2&start_cursor=1f0000c0-0000-4000-8000-000000000003`
            )
          ],
          [
            'property cursor never issued (the minted form)',
            call(
              target,
              'GET',
              `${property}?page_size=2&start_cursor=c3ludGhldGljLXByb3BlcnR5LWN1cnNvcg`
            )
          ]
        ]

        for (const [label, response] of refused) {
          await expectNotEmulated(await response, label)
        }

        expect(target.snapshot()).toEqual(before)
        expect(target.ledger.entries().every(entry => entry.fault === undefined)).toBe(true)
        expect(target.faults.list()[0]).toMatchObject({ applied: 0 })
        // An eligible request does reach the fault.
        expect((await call(target, 'GET', page)).status).toBe(503)
      })
  )

  it.effect('accepts a cursor only for the list it was issued for, until a reset', () =>
    Effect.promise(async () => {
      const target = await emulator()
      const blocks = `/v1/blocks/${seeds.blocksPageId}/children`
      const property = `/v1/pages/${seeds.propertyPageId}/properties/${encodeURIComponent(seeds.propertyId ?? '')}`

      const searched = await jsonOf(
        await call(target, 'POST', '/v1/search', { body: searchBody() })
      )

      const searchCursor = String(field(searched, 'next_cursor'))

      expect(searchCursor).toBe('1f0000a0-0000-4000-8000-000000000002')

      // The same cursor for another query's list is not issued.
      await expectNotEmulated(
        await call(target, 'POST', '/v1/search', {
          body: searchBody({ query: 'probe', start_cursor: searchCursor })
        })
      )
      expect(
        (
          await call(target, 'POST', '/v1/search', {
            body: searchBody({ start_cursor: searchCursor })
          })
        ).status
      ).toBe(200)

      const blockCursor = field(
        await jsonOf(await call(target, 'GET', `${blocks}?page_size=2`)),
        'next_cursor'
      )

      const propertyCursor = field(
        await jsonOf(await call(target, 'GET', `${property}?page_size=2`)),
        'next_cursor'
      )

      expect(propertyCursor).toBe('c3ludGhldGljLXByb3BlcnR5LWN1cnNvcg')

      await target.reset()

      await expectNotEmulated(
        await call(target, 'GET', `${blocks}?page_size=2&start_cursor=${String(blockCursor)}`)
      )
      await expectNotEmulated(
        await call(target, 'GET', `${property}?page_size=2&start_cursor=${String(propertyCursor)}`)
      )

      // A property cursor issued after the reset is a new value.
      const reissued = field(
        await jsonOf(await call(target, 'GET', `${property}?page_size=2`)),
        'next_cursor'
      )

      expect(reissued).not.toBe(propertyCursor)
      expect(
        (await call(target, 'GET', `${property}?page_size=2&start_cursor=${String(reissued)}`))
          .status
      ).toBe(200)
    })
  )

  it.effect('refuses a search cursor after the matches changed', () =>
    Effect.promise(async () => {
      const target = await emulator()

      // No fixture records a search answer without results.
      await expectNotEmulated(
        await call(target, 'POST', '/v1/search', {
          body: searchBody({ query: 'yolk-conformance', page_size: 1 })
        })
      )

      await call(target, 'POST', '/v1/pages', { body: createBody() })
      await call(target, 'POST', '/v1/pages', { body: createBody() })

      const first = await jsonOf(
        await call(target, 'POST', '/v1/search', {
          body: searchBody({ query: 'yolk-conformance', page_size: 1 })
        })
      )

      await call(target, 'POST', '/v1/pages', { body: createBody() })
      await expectNotEmulated(
        await call(target, 'POST', '/v1/search', {
          body: searchBody({
            query: 'yolk-conformance',
            page_size: 1,
            start_cursor: String(field(first, 'next_cursor'))
          })
        })
      )
    })
  )

  it.effect('archives a page once; a second archive and creates under it are refused', () =>
    Effect.promise(async () => {
      const target = await emulator()
      const created = await jsonOf(await call(target, 'POST', '/v1/pages', { body: createBody() }))
      const path = `/v1/pages/${String(field(created, 'id'))}`

      expect((await call(target, 'PATCH', path, { body: { archived: true } })).status).toBe(200)

      const after = target.snapshot()

      await expectNotEmulated(await call(target, 'PATCH', path, { body: { archived: true } }))
      await expectNotEmulated(
        await call(target, 'POST', '/v1/pages', {
          body: { ...createBody(), parent: { page_id: field(created, 'id') } }
        })
      )
      expect(target.snapshot()).toEqual(after)

      // The trashed page still reads back; a search it would match is not emulated (no fixture
      // records a search answer with a trashed page).
      expect(field(await jsonOf(await call(target, 'GET', path)), 'archived')).toBe(true)
      await expectNotEmulated(
        await call(target, 'POST', '/v1/search', {
          body: searchBody({ query: 'yolk-conformance', page_size: 100 })
        })
      )
    })
  )

  it.effect('a refused request uses up no fault', () =>
    Effect.promise(async () => {
      const target = await emulator()

      target.faults.add({ kind: 'status', status: 503, count: 1 })

      await expectNotEmulated(
        await call(target, 'GET', `/v1/pages/${seeds.titlePageId}`, { version: null })
      )
      expect(target.faults.list()[0]).toMatchObject({ remaining: 1, applied: 0 })
      expect((await call(target, 'GET', `/v1/pages/${seeds.titlePageId}`)).status).toBe(503)
    })
  )

  it.effect('answers 503 after close, unledgered', () =>
    Effect.promise(async () => {
      const target = await makeNotionEmulator()

      await target.close()

      expect((await call(target, 'GET', '/v1/users/me')).status).toBe(503)
      expect(target.ledger.entries()).toEqual([])
    })
  )
})

describe('request-shape latitude', () => {
  it.effect('accepts the documented harmless variations', () =>
    Effect.promise(async () => {
      const target = await emulator()
      const compact = (seeds.titlePageId ?? '').replaceAll('-', '').toUpperCase()

      const page = await call(target, 'GET', `/v1/pages/${compact}`, {
        authorization: 'bearer another-synthetic-token',
        headers: { 'x-extra': '1' }
      })

      expect(page.status).toBe(200)
      expect(field(await jsonOf(page), 'id')).toBe(seeds.titlePageId)

      const missing = await call(target, 'GET', '/v1/pages/FFFFFFFFFFFF4FFFBFFFFFFFFFFFFFFF')

      expect(missing.status).toBe(404)
      expect(field(await jsonOf(missing), 'message')).toContain(
        'ffffffff-ffff-4fff-bfff-ffffffffffff'
      )

      const first = await jsonOf(
        await call(target, 'GET', `/v1/blocks/${seeds.blocksPageId}/children?page_size=1`)
      )

      // Query parameter order is free.
      const second = await call(
        target,
        'GET',
        `/v1/blocks/${(seeds.blocksPageId ?? '').replaceAll('-', '')}/children?start_cursor=${String(field(first, 'next_cursor'))}&page_size=100`
      )

      expect(second.status).toBe(200)
      expect(field(await jsonOf(second), 'has_more')).toBe(false)

      const searched = await call(target, 'POST', '/v1/search', {
        body: { page_size: 100, filter: { value: 'page', property: 'object' }, query: 'PROBE' },
        headers: { 'content-type': 'application/json; charset=utf-8' }
      })

      expect(field(await jsonOf(searched), 'results')).toHaveLength(2)

      const created = await call(target, 'POST', '/v1/pages', {
        body: {
          ...createBody(),
          parent: { page_id: (seeds.parentPageId ?? '').replaceAll('-', '').toUpperCase() }
        }
      })

      expect(created.status).toBe(200)
      expect(field(field(await jsonOf(created), 'parent'), 'page_id')).toBe(seeds.parentPageId)
    })
  )
})

describe('handler failures and the clock', () => {
  it.effect('a create whose clock throws answers a tagged 500, ledgered, and writes nothing', () =>
    Effect.promise(async () => {
      const target = await emulator({
        now: () => {
          throw new Error('synthetic clock failure')
        }
      })

      const before = target.snapshot()
      const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined)

      const failed = await call(target, 'POST', '/v1/pages', { body: createBody() }).finally(() =>
        consoleError.mockRestore()
      )

      expect(failed.status).toBe(500)
      expect(failed.headers.get(emulatorEvidenceHeader)).toBe('unverified')
      expect(await jsonOf(failed)).toEqual({
        error: { message: expect.any(String), type: 'emulator_error' }
      })
      expect(target.ledger.entries()).toEqual([
        expect.objectContaining({
          route: '/v1/pages',
          status: 500,
          responseError: 'the route handler failed'
        })
      ])
      expect(target.snapshot()).toEqual(before)

      // The error envelopes and every other route never read the clock.
      expect((await call(target, 'GET', '/v1/pages/not-a-notion-id')).status).toBe(400)
      expect((await call(target, 'GET', `/v1/pages/${seeds.titlePageId}`)).status).toBe(200)
      await expectNotEmulated(await call(target, 'GET', '/v1/nothing'))
      await target.close()
      expect((await call(target, 'GET', '/v1/users/me')).status).toBe(503)
    })
  )
})

describe('credential redaction', () => {
  it.effect('redacts credential-named query keys and body keys, never ledgering credentials', () =>
    Effect.promise(async () => {
      const target = await emulator()
      const secret = 'synthetic-query-secret'

      const response = await call(
        target,
        'GET',
        `/v1/blocks/${seeds.blocksPageId}/children?page_size=2&access_token=${secret}&api_key=${secret}&X-Amz-Credential=${secret}`
      )

      await expectNotEmulated(response)
      expect(target.ledger.entries()[0]?.query).toEqual({
        page_size: '2',
        access_token: '<redacted>',
        api_key: '<redacted>',
        'X-Amz-Credential': '<redacted>'
      })

      await call(target, 'POST', '/v1/search', { body: searchBody({ token: secret }) })

      expect(target.ledger.entries()[1]?.body).toMatchObject({ token: '<redacted>' })

      const recorded = JSON.stringify([
        target.ledger.entries(),
        await jsonOf(await target.fetch(new Request(`${origin}/_emulate/ledger`)))
      ])

      expect(recorded).not.toContain(secret)
      expect(recorded).not.toContain(token)
    })
  )
})

describe('faults', () => {
  it.effect('answer matching requests by method and path, with a count, before any write', () =>
    Effect.promise(async () => {
      const target = await emulator()
      const before = target.snapshot()

      target.faults.add({
        kind: 'status',
        status: 502,
        match: { method: 'POST', path: '/v1/pages' },
        count: 1
      })

      const faulted = await call(target, 'POST', '/v1/pages', { body: createBody() })

      expect(faulted.status).toBe(502)
      expect(faulted.headers.get(emulatorEvidenceHeader)).toBe('unverified')
      expect(target.snapshot()).toEqual(before)
      expect((await call(target, 'POST', '/v1/pages', { body: createBody() })).status).toBe(200)
      expect(target.ledger.entries().map(entry => entry.fault)).toEqual(['status', undefined])
    })
  )

  it.effect('rejects success, bodiless, redirecting, and framing faults', () =>
    Effect.promise(async () => {
      const target = await emulator()

      const invalid: ReadonlyArray<NotionFault> = [
        { kind: 'status', status: 201 },
        { kind: 'status', status: 205 },
        { kind: 'status', status: 307, headers: { location: 'https://example.test/' } },
        { kind: 'status', status: 500, headers: { 'transfer-encoding': 'chunked' } }
      ]

      for (const fault of invalid) {
        expect(() => target.faults.add(fault), JSON.stringify(fault)).toThrow(
          NotionEmulatorInputInvalid
        )
      }

      expect(target.faults.list()).toEqual([])
    })
  )

  it.effect('a 429 with retry-after reaches the connector as notion_rate_limited', () =>
    Effect.gen(function* () {
      const target = yield* Effect.promise(() => emulator())

      target.faults.add({
        kind: 'status',
        status: 429,
        headers: { 'retry-after': '2' },
        match: { path: '/v1/search' }
      })

      const result = yield* notionSearchAction
        .executeTyped({
          integration: notionConformanceIntegration,
          input: NotionSearchInput.make({
            query: 'yolk-search-probe',
            filter: { property: 'object', value: 'page' },
            pageSize: 1
          })
        })
        .pipe(Effect.provide(connectorLayer(target)))

      expect(Predicate.isTagged(result, 'Failure')).toBe(true)

      if (Predicate.isTagged(result, 'Failure')) {
        expect(result.error).toMatchObject({ code: 'notion_rate_limited', status: 429 })
      }
    })
  )
})

describe('seeds and the control plane', () => {
  it.effect('minted page ids start above the seeded ones in the minted form', () =>
    Effect.promise(async () => {
      const target = await emulator({
        seed: {
          profile: 'empty',
          impliedPages: [{ id: '1f0000e0-0000-4000-8000-000000000009', parent: null }]
        }
      })

      expect(target.snapshot().counters).toEqual({ nextPageNumber: 10 })

      const created = await jsonOf(
        await call(target, 'POST', '/v1/pages', {
          body: { ...createBody(), parent: { page_id: '1f0000e0-0000-4000-8000-000000000009' } }
        })
      )

      expect(field(created, 'id')).toBe('1f0000e0-0000-4000-8000-000000000010')

      // Archiving the created page leaves the seeded (implied) page untouched.
      expect(
        (
          await call(target, 'PATCH', `/v1/pages/${String(field(created, 'id'))}`, {
            body: { archived: true }
          })
        ).status
      ).toBe(200)
      expect(target.snapshot().impliedPages).toEqual([
        { id: '1f0000e0-0000-4000-8000-000000000009', parent: null }
      ])
    })
  )

  it.effect('rejects invalid seeds and options', () =>
    Effect.promise(async () => {
      // Parsed from JSON, as a host passing untyped input would.
      const options: ReadonlyArray<NotionEmulatorOptions> = JSON.parse(
        JSON.stringify([
          { seed: { blocks: [{ id: '1f0000c0-0000-4000-8000-000000000009' }] } },
          {
            seed: {
              profile: 'empty',
              databases: [],
              dataSources: [
                {
                  id: '1f0000d0-0000-4000-8000-000000000001',
                  databaseId: '1f000000-0000-4000-8000-000000000004',
                  title: [],
                  properties: {},
                  archived: false,
                  inTrash: false
                }
              ]
            }
          },
          { seed: { pages: [{ id: 'not-an-id' }] } },
          {
            seed: {
              impliedPages: [{ id: '1f000000-0000-4000-8000-000000000001', parent: null }]
            }
          },
          { baseUrl: 'https://api.notion.com/v1' },
          { drills: { nope: true } },
          { drills: { trashedPageNotFound: 1 } }
        ])
      )

      for (const invalid of options) {
        await expect(makeNotionEmulator(invalid), JSON.stringify(invalid)).rejects.toBeInstanceOf(
          NotionEmulatorInputInvalid
        )
      }
    })
  )

  it.effect(
    'reset restores the seed; the control plane serves ledger, faults, state, seed, and coverage',
    () =>
      Effect.promise(async () => {
        const target = await emulator()
        const seeded = target.snapshot()

        await call(target, 'POST', '/v1/pages', { body: createBody() })

        expect(target.snapshot()).not.toEqual(seeded)

        await target.reset()

        expect(target.snapshot()).toEqual(seeded)
        expect(target.ledger.entries()).toEqual([])

        const control = (method: string, path: string, body?: unknown) =>
          target.fetch(
            new Request(`${origin}/_emulate/${path}`, {
              method,
              body: body === undefined ? undefined : JSON.stringify(body)
            })
          )

        expect(
          (await control('POST', 'faults', { kind: 'status', status: 429, count: 1 })).status
        ).toBe(201)
        expect((await call(target, 'GET', '/v1/users/me')).status).toBe(429)
        expect(await jsonOf(await control('GET', 'coverage'))).toMatchObject({
          unknownRouteRequests: 0
        })
        expect(await jsonOf(await control('POST', 'seed', { profile: 'empty' }))).toEqual({
          seeded: true,
          pages: 0,
          blocks: 0,
          dataSources: 0
        })
        expect(field(field(await jsonOf(await control('GET', 'state')), 'state'), 'pages')).toEqual(
          []
        )
        expect(await jsonOf(await control('POST', 'reset'))).toEqual({ reset: true })
        expect(target.snapshot().pages).toEqual([])
        expect((await control('PUT', 'state')).status).toBe(405)
      })
  )
})
