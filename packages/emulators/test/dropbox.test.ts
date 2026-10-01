import { Effect, Layer, Predicate } from 'effect'
import { afterEach, describe, expect, it } from '@effect/vitest'
import { vi } from 'vitest'
import { BearerTokenCredential } from '@yolk-sdk/connectors'
import {
  connectorHttpClientsFromEffectHttpClientLayer,
  staticCredentialResolverLayer
} from '@yolk-sdk/connectors/conformance'
import {
  DropboxListFolderInput,
  dropboxApiBaseUrl,
  dropboxContentApiBaseUrl,
  dropboxListFolderAction
} from '@yolk-sdk/connectors/dropbox'
import {
  dropboxConformanceCases,
  dropboxConformanceFixtureSeeds,
  dropboxConformanceFixtures,
  dropboxConformanceIntegration,
  dropboxCreateFolderConflictFixture,
  dropboxNotFoundEnvelopeFixture,
  dropboxUploadRevPreconditionFixture
} from '@yolk-sdk/connectors/dropbox/conformance'
import {
  DropboxEmulatorInputInvalid,
  dropboxEmulatorErrorBodies,
  dropboxEmulatorRoutes,
  emulatorEvidenceHeader,
  makeDropboxEmulator,
  type DropboxEmulator,
  type DropboxEmulatorOptions,
  type DropboxFault
} from '../src/dropbox.ts'
import { EmulatorRoute, InProcessHttpClient } from '../src/router.ts'
import { makeStatefulEmulator } from '../src/stateful-emulator.ts'

const api = new URL(dropboxApiBaseUrl).origin

const content = new URL(dropboxContentApiBaseUrl).origin

const token = 'synthetic-unit-test-token'

const now = Date.parse('2026-09-29T14:00:00.000Z')

const open: Array<DropboxEmulator> = []

afterEach(async () => {
  await Promise.all(open.splice(0).map(emulator => emulator.close()))
})

const emulator = async (options: DropboxEmulatorOptions = {}): Promise<DropboxEmulator> => {
  const created = await makeDropboxEmulator({ now: () => now, ...options })

  open.push(created)

  return created
}

type CallOptions = {
  readonly authorization?: string | null
  readonly headers?: Record<string, string>
  readonly rawBody?: string
}

/** One RPC call: `POST /2/files/<route>` with a JSON body. */
const rpc = (
  target: DropboxEmulator,
  route: string,
  body: unknown,
  options: CallOptions = {}
): Promise<Response> => {
  const headers = new Headers({ 'content-type': 'application/json', ...options.headers })

  const authorization =
    options.authorization === undefined ? `Bearer ${token}` : options.authorization

  if (authorization !== null) headers.set('authorization', authorization)

  return target.fetch(
    new Request(`${api}/2/files/${route}`, {
      method: 'POST',
      headers,
      body: options.rawBody ?? JSON.stringify(body)
    })
  )
}

const uploadCall = (
  target: DropboxEmulator,
  arg: unknown,
  body: string,
  headers: Record<string, string> = {}
): Promise<Response> =>
  target.fetch(
    new Request(`${content}/2/files/upload`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'application/octet-stream',
        'dropbox-api-arg': JSON.stringify(arg),
        ...headers
      },
      body
    })
  )

const field = (value: unknown, key: string): unknown =>
  Predicate.isObject(value) ? value[key] : undefined

const jsonOf = async (response: Response): Promise<unknown> => response.json()

const notEmulatedBody = {
  error: { type: 'not_emulated', message: expect.stringMatching(/^Not emulated: /) }
}

const expectNotEmulated = async (response: Response, label = '') => {
  expect(response.status, label).toBe(400)
  expect(await jsonOf(response), label).toEqual(notEmulatedBody)
}

const work = dropboxConformanceFixtureSeeds.workFolderPath ?? ''

const credentialLayer = staticCredentialResolverLayer(BearerTokenCredential.make({ token }))

const connectorLayer = (target: DropboxEmulator) =>
  Layer.mergeAll(
    connectorHttpClientsFromEffectHttpClientLayer.pipe(
      Layer.provide(
        InProcessHttpClient.layer([
          EmulatorRoute.handler(api, target.fetch),
          EmulatorRoute.handler(content, target.fetch)
        ])
      )
    ),
    credentialLayer
  )

describe('route evidence manifest', () => {
  it('lists every route as an unverified connector route linked to Dropbox cases', () => {
    const caseIds = new Set(dropboxConformanceCases.map(testCase => testCase.id))

    expect(dropboxEmulatorRoutes.map(route => `${route.method} ${route.path}`)).toEqual([
      'POST /2/files/list_folder',
      'POST /2/files/list_folder/continue',
      'POST /2/files/get_metadata',
      'POST /2/files/search_v2',
      'POST /2/files/search/continue_v2',
      'POST /2/files/create_folder_v2',
      'POST /2/files/delete_v2',
      'POST /2/files/copy_v2',
      'POST /2/files/move_v2',
      'POST /2/files/upload'
    ])
    expect(dropboxEmulatorRoutes.filter(route => route.write).map(route => route.path)).toEqual([
      '/2/files/create_folder_v2',
      '/2/files/delete_v2',
      '/2/files/copy_v2',
      '/2/files/move_v2',
      '/2/files/upload'
    ])

    for (const route of dropboxEmulatorRoutes) {
      expect(route).toMatchObject({ kind: 'connector', evidence: 'unverified' })
      expect(route.observedAt).toBeUndefined()
      expect(route.caseIds.length, route.path).toBeGreaterThan(0)
      expect(route.caseIds.every(caseId => caseIds.has(caseId))).toBe(true)
    }

    // Every case is followed by at least one route.
    expect(new Set(dropboxEmulatorRoutes.flatMap(route => route.caseIds))).toEqual(caseIds)
  })

  it.effect('has a handler behind every manifest route', () =>
    Effect.promise(async () => {
      const target = await emulator()

      for (const route of dropboxEmulatorRoutes) {
        await target.fetch(
          new Request(`${route.path.endsWith('/upload') ? content : api}${route.path}`, {
            method: route.method,
            headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
            body: '{}'
          })
        )
      }

      expect(target.coverage().routes.every(route => route.requests === 1)).toBe(true)
      expect(target.coverage().unknownRouteRequests).toBe(0)
      expect(target.ledger.entries().every(entry => entry.evidence === 'unverified')).toBe(true)
    })
  )
})

describe('fixture data copies', () => {
  // The emulator copies the fixture error envelopes as data (it never imports SDK code); these
  // fail when a fixture changes without the copy.
  it('error envelopes equal the fixture bodies byte for byte', () => {
    const bodies = dropboxConformanceFixtures.flatMap(fixture =>
      fixture.exchanges.flatMap(exchange =>
        exchange.response.status === 409 && 'body' in exchange.response
          ? [exchange.response.body ?? '']
          : []
      )
    )

    expect(new Set(bodies)).toEqual(new Set(Object.values(dropboxEmulatorErrorBodies)))
    expect(field(dropboxNotFoundEnvelopeFixture.exchanges[0]?.response, 'body')).toBe(
      dropboxEmulatorErrorBodies.notFound
    )
    expect(field(dropboxCreateFolderConflictFixture.exchanges[2]?.response, 'body')).toBe(
      dropboxEmulatorErrorBodies.folderConflict
    )
    expect(field(dropboxUploadRevPreconditionFixture.exchanges[4]?.response, 'body')).toBe(
      dropboxEmulatorErrorBodies.uploadConflict
    )
  })

  it.effect('the default seed holds every seeded path of the fixture seeds', () =>
    Effect.promise(async () => {
      const target = await emulator()
      const seeds = dropboxConformanceFixtureSeeds

      for (const path of [seeds.mixedCasePath, seeds.copySourcePath]) {
        const response = await rpc(target, 'get_metadata', { path })

        expect(response.status, path).toBe(200)
        expect(field(await jsonOf(response), 'path_display'), path).toBe(path)
      }

      expect(
        (await rpc(target, 'list_folder', { path: seeds.pagingFolderPath, limit: 2000 })).status
      ).toBe(200)
      // The seeded work folder is empty: no fixture records an empty listing.
      await expectNotEmulated(
        await rpc(target, 'list_folder', { path: seeds.workFolderPath, limit: 2000 })
      )
    })
  )
})

// The values the emulator mints itself, by route and exact field path: created ids, new revs, and
// the content hashes derived from those revs. A fixture value is learned the first time one of
// these paths shows it and must map to the same emulator value wherever it appears again (a move
// keeps the copy's id; a copy keeps the source's content hash, which is never learned). Every other
// byte of every response must equal the fixture.
const mintedPaths = new Map<string, ReadonlyArray<ReadonlyArray<string>>>([
  ['create_folder_v2', [['metadata', 'id']]],
  [
    'copy_v2',
    [
      ['metadata', 'id'],
      ['metadata', 'rev']
    ]
  ],
  ['move_v2', [['metadata', 'rev']]],
  ['upload', [['id'], ['rev'], ['content_hash']]]
])

const at = (value: unknown, path: ReadonlyArray<string>): unknown =>
  path.reduce<unknown>((current, key) => field(current, key), value)

const learn = (
  route: string,
  expected: unknown,
  actual: unknown,
  ids: Map<string, string>
): void => {
  for (const path of mintedPaths.get(route) ?? []) {
    const from = at(expected, path)
    const to = at(actual, path)

    if (!Predicate.isString(from) || !Predicate.isString(to)) continue

    // Learned once: a later appearance of the same fixture value must map to the same value.
    if (!ids.has(from)) ids.set(from, to)
  }
}

const substituted = (text: string, ids: ReadonlyMap<string, string>): string => {
  let result = text

  for (const [from, to] of ids) {
    result = result.split(from).join(to)
  }

  return result
}

describe('fixture envelopes', () => {
  // Replays every Dropbox fixture's requests, in order, against a fresh emulator (the clock at the
  // upload fixture's time) and compares each complete response with the fixture byte for byte:
  // status, content type, and the whole body, after the minted values above replace the fixture's.
  for (const fixture of dropboxConformanceFixtures) {
    it.effect(fixture.id, () =>
      Effect.promise(async () => {
        const target = await emulator()
        const ids = new Map<string, string>()

        for (const exchange of fixture.exchanges) {
          const route = exchange.request.url.slice(exchange.request.url.indexOf('/files/') + 7)
          const label = `${route} ${JSON.stringify(exchange.request.body ?? null)}`
          const headers = new Headers()

          for (const [name, value] of Object.entries(exchange.request.headers ?? {})) {
            headers.set(name, substituted(value, ids))
          }

          headers.set('authorization', `Bearer ${token}`)

          const body = exchange.request.body

          const response = await target.fetch(
            new Request(exchange.request.url, {
              method: exchange.request.method,
              headers,
              body: Predicate.isString(body) ? body : substituted(JSON.stringify(body ?? null), ids)
            })
          )

          const expected = exchange.response

          expect(response.status, label).toBe(expected.status)
          expect(response.headers.get('content-type'), label).toBe(expected.headers['content-type'])
          expect(response.headers.get(emulatorEvidenceHeader), label).toBe('unverified')

          const text = await response.text()
          const recorded = 'body' in expected ? (expected.body ?? '') : ''

          if (expected.status === 200) learn(route, JSON.parse(recorded), JSON.parse(text), ids)

          expect(text, label).toBe(substituted(recorded, ids))
        }

        expect(target.ledger.entries().every(entry => entry.notEmulated === undefined)).toBe(true)
      })
    )
  }

  it.effect('a minted value that changes between appearances fails the comparison', () =>
    Effect.promise(async () => {
      // The drill gives the moved file a new id: the move answer no longer equals the fixture's
      // (the copy's id, learned on copy_v2, must reappear on move_v2).
      const target = await emulator({ drills: { moveMintsNewId: true } })
      const ids = new Map<string, string>()

      const fixture = dropboxConformanceFixtures.find(
        candidate => candidate.caseId === 'dropbox.files.copy-move-metadata'
      )

      let mismatched = 0

      for (const exchange of fixture?.exchanges ?? []) {
        const route = exchange.request.url.slice(exchange.request.url.indexOf('/files/') + 7)

        const response = await target.fetch(
          new Request(exchange.request.url, {
            method: 'POST',
            headers: { ...exchange.request.headers, authorization: `Bearer ${token}` },
            body: substituted(JSON.stringify(exchange.request.body ?? null), ids)
          })
        )

        const text = await response.text()
        const recorded = 'body' in exchange.response ? (exchange.response.body ?? '') : ''

        if (response.status === 200) learn(route, JSON.parse(recorded), JSON.parse(text), ids)

        if (text !== substituted(recorded, ids)) mismatched += 1
      }

      expect(mismatched).toBe(1)
    })
  )
})

describe('fail closed', () => {
  it.effect('answers unknown routes and methods with a ledgered 400 not-emulated', () =>
    Effect.promise(async () => {
      const target = await emulator()

      for (const [method, url] of [
        ['POST', `${api}/2/files/list_folder/longpoll`],
        ['POST', `${api}/2/files/copy_batch_v2`],
        ['POST', `${api}/2/files/delete`],
        ['GET', `${api}/2/files/get_metadata`],
        ['POST', `${content}/2/files/download`],
        ['POST', `${content}/2/files/upload_session/start`],
        ['POST', `${api}/2/users/get_current_account`]
      ] as const) {
        const response = await target.fetch(
          new Request(url, {
            method,
            headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
            body: method === 'GET' ? undefined : '{}'
          })
        )

        await expectNotEmulated(response, `${method} ${url}`)
        expect(response.headers.get(emulatorEvidenceHeader)).toBeNull()
      }

      expect(target.ledger.entries().every(entry => entry.evidence === 'unknown-route')).toBe(true)
      expect(target.coverage()).toMatchObject({ unknownRouteRequests: 7, notEmulatedRequests: 7 })
    })
  )

  it.effect(
    'refuses missing credentials, bodies, queries, shapes, and states, using no fault',
    () =>
      Effect.promise(async () => {
        const target = await emulator()
        const before = target.snapshot()
        const mixed = { path: dropboxConformanceFixtureSeeds.mixedCasePath }

        // An unlimited fault on every route: no refused request may reach it.
        target.faults.add({ kind: 'status', status: 503 })

        const refused: ReadonlyArray<readonly [string, Promise<Response>]> = [
          ['no bearer', rpc(target, 'get_metadata', mixed, { authorization: null })],
          ['empty bearer', rpc(target, 'get_metadata', mixed, { authorization: 'Bearer ' })],
          ['basic auth', rpc(target, 'get_metadata', mixed, { authorization: 'Basic eDp5' })],
          [
            'text body',
            rpc(target, 'get_metadata', mixed, { headers: { 'content-type': 'text/plain' } })
          ],
          ['invalid JSON', rpc(target, 'get_metadata', undefined, { rawBody: '{' })],
          ['array body', rpc(target, 'get_metadata', [mixed])],
          ['extra key', rpc(target, 'get_metadata', { ...mixed, include_media_info: true })],
          [
            'include_deleted false',
            rpc(target, 'get_metadata', { ...mixed, include_deleted: false })
          ],
          ['root path', rpc(target, 'get_metadata', { path: '' })],
          ['id path', rpc(target, 'get_metadata', { path: 'id:SyntheticMixedCaseFile01' })],
          ['rev path', rpc(target, 'get_metadata', { path: 'rev:a1b2c3d4e5f60010' })],
          ['dot path', rpc(target, 'get_metadata', { path: '/Conformance/../x' })],
          ['trailing slash', rpc(target, 'get_metadata', { path: '/Conformance/' })],
          ['folder metadata', rpc(target, 'get_metadata', { path: '/Conformance' })],
          [
            'include_deleted on a live entry',
            rpc(target, 'get_metadata', { ...mixed, include_deleted: true })
          ],
          ['list an empty folder', rpc(target, 'list_folder', { path: work, limit: 2000 })],
          ['list without limit', rpc(target, 'list_folder', { path: work })],
          ['list limit 0', rpc(target, 'list_folder', { path: work, limit: 0 })],
          ['list limit 2001', rpc(target, 'list_folder', { path: work, limit: 2001 })],
          [
            'list recursive',
            rpc(target, 'list_folder', { path: work, limit: 2, recursive: false })
          ],
          ['list a file', rpc(target, 'list_folder', { path: mixed.path, limit: 2 })],
          [
            'list a missing folder',
            rpc(target, 'list_folder', { path: `${work}/absent`, limit: 2 })
          ],
          ['unknown list cursor', rpc(target, 'list_folder/continue', { cursor: 'AAHx' })],
          [
            'unissued list cursor in the minted form',
            rpc(target, 'list_folder/continue', { cursor: 'AAHsyntheticListCursor0001' })
          ],
          ['unknown search cursor', rpc(target, 'search/continue_v2', { cursor: 'AAHx' })],
          [
            'not found under a missing parent',
            rpc(target, 'get_metadata', { path: `${work}/a/b` })
          ],
          [
            'not found under a file',
            rpc(target, 'get_metadata', { path: `${mixed.path ?? ''}/child` })
          ],
          [
            'include_deleted without a recorded delete',
            rpc(target, 'get_metadata', { path: `${work}/absent`, include_deleted: true })
          ],
          [
            'list a folder with implied folders',
            rpc(target, 'list_folder', { path: '/Conformance', limit: 2 })
          ],
          [
            'search without matches',
            rpc(target, 'search_v2', {
              query: 'nothing-matches',
              options: { max_results: 1, filename_only: true }
            })
          ],
          [
            'search matching a folder',
            rpc(target, 'search_v2', {
              query: 'paging',
              options: { max_results: 5, filename_only: true }
            })
          ],
          [
            'search without filename_only',
            rpc(target, 'search_v2', { query: 'x', options: { max_results: 1 } })
          ],
          [
            'search filename_only false',
            rpc(target, 'search_v2', {
              query: 'x',
              options: { max_results: 1, filename_only: false }
            })
          ],
          [
            'search path option',
            rpc(target, 'search_v2', {
              query: 'x',
              options: { max_results: 1, filename_only: true, path: work }
            })
          ],
          [
            'query parameter',
            target.fetch(
              new Request(`${api}/2/files/get_metadata?arg=x`, {
                method: 'POST',
                headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
                body: JSON.stringify(mixed)
              })
            )
          ]
        ]

        for (const [label, response] of refused) {
          await expectNotEmulated(await response, label)
        }

        expect(target.snapshot()).toEqual(before)
        expect(target.faults.list()[0]).toMatchObject({ applied: 0 })
        // An eligible request does reach the fault.
        expect((await rpc(target, 'get_metadata', mixed)).status).toBe(503)
      })
  )

  it.effect(
    'refuses writes the fixtures do not show, by shape and by state, writing nothing and using no fault',
    () =>
      Effect.promise(async () => {
        const target = await emulator()
        const before = target.snapshot()
        const source = dropboxConformanceFixtureSeeds.copySourcePath ?? ''

        const add = {
          path: `${work}/new.txt`,
          mode: 'add',
          autorename: false,
          strict_conflict: true
        }

        target.faults.add({ kind: 'status', status: 503 })

        const refused: ReadonlyArray<readonly [string, Promise<Response>]> = [
          [
            'autorename true',
            rpc(target, 'create_folder_v2', { path: `${work}/x`, autorename: true })
          ],
          ['missing autorename', rpc(target, 'create_folder_v2', { path: `${work}/x` })],
          [
            'missing parent',
            rpc(target, 'create_folder_v2', { path: `${work}/a/b`, autorename: false })
          ],
          [
            'folder over a file',
            rpc(target, 'create_folder_v2', { path: source, autorename: false })
          ],
          ['delete a file', rpc(target, 'delete_v2', { path: source })],
          ['delete a missing path', rpc(target, 'delete_v2', { path: `${work}/absent` })],
          ['delete a missing id', rpc(target, 'delete_v2', { path: 'id:SyntheticNothing' })],
          ['delete an implied folder', rpc(target, 'delete_v2', { path: work })],
          [
            'delete with parent_rev',
            rpc(target, 'delete_v2', { path: work, parent_rev: 'a1b2c3d4e5f60001' })
          ],
          [
            'copy a folder',
            rpc(target, 'copy_v2', {
              from_path: work,
              to_path: '/Conformance/w2',
              autorename: false
            })
          ],
          [
            'copy onto an existing file',
            rpc(target, 'copy_v2', {
              from_path: source,
              to_path: dropboxConformanceFixtureSeeds.mixedCasePath,
              autorename: false
            })
          ],
          [
            'copy into a missing folder',
            rpc(target, 'copy_v2', { from_path: source, to_path: `${work}/a/b`, autorename: false })
          ],
          [
            'copy by id',
            rpc(target, 'copy_v2', {
              from_path: 'id:SyntheticCopySource001',
              to_path: `${work}/c`,
              autorename: false
            })
          ],
          [
            'move with ownership transfer',
            rpc(target, 'move_v2', {
              from_path: source,
              to_path: `${work}/m`,
              autorename: false,
              allow_ownership_transfer: false
            })
          ],
          ['upload without the arg', uploadCall(target, add, 'x', { 'dropbox-api-arg': '' })],
          ['upload as JSON', uploadCall(target, add, 'x', { 'content-type': 'application/json' })],
          ['upload mode overwrite', uploadCall(target, { ...add, mode: 'overwrite' }, 'x')],
          ['upload autorename', uploadCall(target, { ...add, autorename: true }, 'x')],
          [
            'upload strict_conflict false',
            uploadCall(target, { ...add, strict_conflict: false }, 'x')
          ],
          ['upload mute', uploadCall(target, { ...add, mute: true }, 'x')],
          [
            'upload into a missing folder',
            uploadCall(target, { ...add, path: `${work}/a/b.txt` }, 'x')
          ],
          ['upload onto a folder', uploadCall(target, { ...add, path: work }, 'x')],
          [
            'update by path',
            uploadCall(
              target,
              { ...add, path: source, mode: { '.tag': 'update', update: 'a1b2c3d4e5f60030' } },
              'x'
            )
          ],
          [
            'update a missing id',
            uploadCall(
              target,
              {
                ...add,
                path: 'id:SyntheticNothing',
                mode: { '.tag': 'update', update: 'a1b2c3d4e5f60030' }
              },
              'x'
            )
          ]
        ]

        for (const [label, response] of refused) {
          await expectNotEmulated(await response, label)
        }

        expect(target.snapshot()).toEqual(before)
        expect(target.ledger.entries().every(entry => entry.notEmulated !== undefined)).toBe(true)
        expect(target.ledger.entries().every(entry => entry.fault === undefined)).toBe(true)
        expect(target.faults.list()[0]).toMatchObject({ applied: 0 })
      })
  )

  it.effect('deletes keep a record only for an empty folder, the delete a fixture records', () =>
    Effect.promise(async () => {
      const target = await emulator()
      const source = dropboxConformanceFixtureSeeds.copySourcePath ?? ''

      await rpc(target, 'create_folder_v2', { path: `${work}/empty`, autorename: false })
      await rpc(target, 'create_folder_v2', { path: `${work}/full`, autorename: false })
      await rpc(target, 'copy_v2', {
        from_path: source,
        to_path: `${work}/full/copied`,
        autorename: false
      })

      expect((await rpc(target, 'delete_v2', { path: `${work}/empty` })).status).toBe(200)
      expect((await rpc(target, 'delete_v2', { path: `${work}/full` })).status).toBe(200)
      expect(target.snapshot().deleted.map(record => record.pathDisplay)).toEqual([`${work}/empty`])
      expect(
        (await rpc(target, 'get_metadata', { path: `${work}/empty`, include_deleted: true })).status
      ).toBe(200)

      expect((await rpc(target, 'get_metadata', { path: `${work}/full` })).status).toBe(409)
      await expectNotEmulated(
        await rpc(target, 'get_metadata', { path: `${work}/full`, include_deleted: true })
      )

      // Its former content has no parent folder any more: no fixture records that lookup.
      await expectNotEmulated(await rpc(target, 'get_metadata', { path: `${work}/full/copied` }))
      await expectNotEmulated(
        await rpc(target, 'get_metadata', { path: `${work}/full/copied`, include_deleted: true })
      )
    })
  )

  it.effect('refuses a listing continued after its folder changed in any way', () =>
    Effect.promise(async () => {
      const target = await emulator()
      const paging = dropboxConformanceFixtureSeeds.pagingFolderPath ?? ''
      const list = async () => jsonOf(await rpc(target, 'list_folder', { path: paging, limit: 1 }))

      const resume = (listed: unknown) =>
        rpc(target, 'list_folder/continue', { cursor: field(listed, 'cursor') })

      // A new child.
      const beforeCreate = await list()

      await rpc(target, 'create_folder_v2', { path: `${paging}/new`, autorename: false })
      await expectNotEmulated(await resume(beforeCreate), 'new child')
      await rpc(target, 'delete_v2', { path: `${paging}/new` })

      // A rename with the same ids.
      const beforeRename = await list()

      await rpc(target, 'move_v2', {
        from_path: `${paging}/paging-three.txt`,
        to_path: `${paging}/paging-3.txt`,
        autorename: false
      })
      await expectNotEmulated(await resume(beforeRename), 'renamed child')

      // A new rev under the same id and name.
      const beforeUpdate = await list()

      const three = await jsonOf(
        await rpc(target, 'get_metadata', { path: `${paging}/paging-3.txt` })
      )

      expect(
        (
          await uploadCall(
            target,
            {
              path: field(three, 'id'),
              mode: { '.tag': 'update', update: field(three, 'rev') },
              autorename: false,
              strict_conflict: true
            },
            'v2'
          )
        ).status
      ).toBe(200)
      await expectNotEmulated(await resume(beforeUpdate), 'updated child')

      // The last page's cursor (has_more false) is not a delta cursor either.
      const all = await jsonOf(await rpc(target, 'list_folder', { path: paging, limit: 2000 }))

      expect(field(all, 'has_more')).toBe(false)
      await expectNotEmulated(await resume(all), 'finished listing')

      // An unchanged listing continues.
      const unchanged = await list()

      expect((await resume(unchanged)).status).toBe(200)
    })
  )

  it.effect('refuses a search continued after its matches changed in any way', () =>
    Effect.promise(async () => {
      const target = await emulator()
      const searchFolder = '/Conformance/Search'

      const search = async () =>
        jsonOf(
          await rpc(target, 'search_v2', {
            query: 'yolk-search-probe',
            options: { max_results: 1, filename_only: true }
          })
        )

      const resume = (searched: unknown) =>
        rpc(target, 'search/continue_v2', { cursor: field(searched, 'cursor') })

      // A match renamed so that it no longer matches.
      const beforeMove = await search()

      await rpc(target, 'move_v2', {
        from_path: `${searchFolder}/yolk-search-probe-2.txt`,
        to_path: `${work}/moved.txt`,
        autorename: false
      })
      await expectNotEmulated(await resume(beforeMove), 'match moved away')
      await rpc(target, 'move_v2', {
        from_path: `${work}/moved.txt`,
        to_path: `${searchFolder}/yolk-search-probe-2.txt`,
        autorename: false
      })

      // A match moved within the results (same id, new rev).
      const beforeRev = await search()

      await rpc(target, 'move_v2', {
        from_path: `${searchFolder}/yolk-search-probe-2.txt`,
        to_path: `${searchFolder}/yolk-search-probe-2b.txt`,
        autorename: false
      })
      await expectNotEmulated(await resume(beforeRev), 'match renamed')

      // A new match.
      const beforeNew = await search()

      await uploadCall(
        target,
        {
          path: `${searchFolder}/yolk-search-probe-3.txt`,
          mode: 'add',
          autorename: false,
          strict_conflict: true
        },
        'x'
      )
      await expectNotEmulated(await resume(beforeNew), 'new match')

      // An unchanged search continues. The new match is still there (three matches), so this page
      // still has more.
      const unchanged = await search()
      const second = await resume(unchanged)

      expect(second.status).toBe(200)
      expect(field(await jsonOf(second), 'has_more')).toBe(true)
    })
  )

  it.effect('refuses cursors issued before a reset, and never issues one again', () =>
    Effect.promise(async () => {
      const target = await emulator()
      const paging = dropboxConformanceFixtureSeeds.pagingFolderPath ?? ''
      const listed = await jsonOf(await rpc(target, 'list_folder', { path: paging, limit: 1 }))

      expect(field(listed, 'cursor')).toBe('AAHsyntheticListCursor0001')

      await target.reset()

      await expectNotEmulated(
        await rpc(target, 'list_folder/continue', { cursor: field(listed, 'cursor') })
      )

      const again = await jsonOf(await rpc(target, 'list_folder', { path: paging, limit: 1 }))

      expect(field(again, 'cursor')).toBe('AAHsyntheticListCursor0002')
      expect(target.cursors().map(cursor => cursor.cursor)).toEqual(['AAHsyntheticListCursor0002'])
    })
  )

  it.effect('a refused request uses up no fault', () =>
    Effect.promise(async () => {
      const target = await emulator()

      target.faults.add({ kind: 'status', status: 503, count: 1 })

      await expectNotEmulated(await rpc(target, 'get_metadata', { path: '' }))
      expect(target.faults.list()[0]).toMatchObject({ remaining: 1, applied: 0 })
      expect((await rpc(target, 'get_metadata', { path: work + '/x' })).status).toBe(503)
    })
  )

  it.effect('answers 503 after close, unledgered', () =>
    Effect.promise(async () => {
      const target = await makeDropboxEmulator()

      await target.close()
      await target.close()

      const response = await rpc(target, 'get_metadata', { path: '/x' })

      expect(response.status).toBe(503)
      expect(target.ledger.entries()).toEqual([])
    })
  )
})

describe('request-shape latitude', () => {
  it.effect('accepts the documented harmless variations', () =>
    Effect.promise(async () => {
      const target = await emulator()
      const mixed = dropboxConformanceFixtureSeeds.mixedCasePath ?? ''

      // content-type parameters, extra headers, any bearer value, key order.
      const variants = [
        rpc(
          target,
          'get_metadata',
          { path: mixed },
          {
            headers: { 'content-type': 'application/json; charset=utf-8', 'x-extra': '1' },
            authorization: 'bearer another-synthetic-token'
          }
        ),
        rpc(target, 'list_folder', { limit: 2000, path: '/Conformance/Paging' }),
        rpc(target, 'list_folder', { path: '/CONFORMANCE/paging', limit: 1 }),
        rpc(target, 'search_v2', {
          options: { filename_only: true, max_results: 1000 },
          query: 'PROBE'
        }),
        target.fetch(
          new Request(`${content}/2/files/upload`, {
            method: 'POST',
            headers: {
              authorization: `Bearer ${token}`,
              'content-type': 'application/octet-stream',
              'dropbox-api-arg': JSON.stringify({
                strict_conflict: true,
                autorename: false,
                mode: 'add',
                path: `${work}/latitude.bin`
              })
            },
            body: new Uint8Array([0, 1, 2, 255])
          })
        )
      ]

      for (const response of await Promise.all(variants)) {
        expect(response.status).toBe(200)
      }

      expect(
        field(
          await jsonOf(await rpc(target, 'get_metadata', { path: `${work}/latitude.bin` })),
          'size'
        )
      ).toBe(4)
    })
  )
})

describe('origins', () => {
  it.effect('answers each route only on the origin its fixtures record', () =>
    Effect.promise(async () => {
      const target = await emulator()
      const before = target.snapshot()

      const arg = JSON.stringify({
        path: `${work}/origin.txt`,
        mode: 'add',
        autorename: false,
        strict_conflict: true
      })

      const uploadOn = (origin: string, handler = target.fetch) =>
        handler(
          new Request(`${origin}/2/files/upload`, {
            method: 'POST',
            headers: {
              authorization: `Bearer ${token}`,
              'content-type': 'application/octet-stream',
              'dropbox-api-arg': arg
            },
            body: 'x'
          })
        )

      const metadataOn = (origin: string, handler = target.fetch) =>
        handler(
          new Request(`${origin}/2/files/get_metadata`, {
            method: 'POST',
            headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
            body: JSON.stringify({ path: dropboxConformanceFixtureSeeds.mixedCasePath })
          })
        )

      const loopback = 'http://127.0.0.1:9'

      for (const [label, response] of [
        ['upload on the RPC origin', uploadOn(api)],
        ['RPC on the content origin', metadataOn(content)],
        ['upload on another origin', uploadOn(loopback)],
        ['RPC on another origin', metadataOn(loopback)],
        ['upload through the RPC handler', uploadOn(loopback, target.fetchOn(api))],
        ['RPC through the content handler', metadataOn(loopback, target.fetchOn(content))]
      ] as const) {
        const refused = await response

        await expectNotEmulated(refused, label)
        expect(refused.headers.get(emulatorEvidenceHeader), label).toBe('unverified')
      }

      expect(target.snapshot()).toEqual(before)

      // Through the per-origin handlers (as behind a loopback rewrite), each route answers.
      expect((await metadataOn(loopback, target.fetchOn(api))).status).toBe(200)
      expect((await uploadOn(loopback, target.fetchOn(content))).status).toBe(200)
    })
  )
})

describe('handler failures and the clock', () => {
  it.effect('an upload whose clock throws answers a tagged 500, ledgered, and writes nothing', () =>
    Effect.promise(async () => {
      const target = await emulator({
        now: () => {
          throw new Error('synthetic clock failure')
        }
      })

      const before = target.snapshot()
      const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined)

      const failed = await uploadCall(
        target,
        { path: `${work}/clock.txt`, mode: 'add', autorename: false, strict_conflict: true },
        'x'
      ).finally(() => consoleError.mockRestore())

      expect(failed.status).toBe(500)
      expect(failed.headers.get(emulatorEvidenceHeader)).toBe('unverified')
      expect(failed.headers.get('x-emulator-handler-failed')).toBeNull()
      expect(await jsonOf(failed)).toEqual({
        error: { message: expect.any(String), type: 'emulator_error' }
      })
      expect(target.ledger.entries()).toEqual([
        expect.objectContaining({
          route: '/2/files/upload',
          status: 500,
          evidence: 'unverified',
          responseError: 'the route handler failed'
        })
      ])
      expect(target.snapshot()).toEqual(before)

      // Routes that never read the clock, unknown routes, and a closed emulator are unaffected.
      expect((await rpc(target, 'get_metadata', { path: `${work}/absent` })).status).toBe(409)
      await expectNotEmulated(await rpc(target, 'nothing', {}))
      await target.close()
      expect((await rpc(target, 'get_metadata', { path: '/x' })).status).toBe(503)
    })
  )
})

describe('credential redaction', () => {
  it.effect('redacts credential-named query keys and never ledgers credentials', () =>
    Effect.promise(async () => {
      const target = await emulator()
      const secret = 'synthetic-query-secret'

      const response = await target.fetch(
        new Request(
          `${api}/2/files/get_metadata?authorization=Bearer%20${secret}&access_token=${secret}&X-Amz-Signature=${secret}&arg=x`,
          {
            method: 'POST',
            headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
            body: JSON.stringify({ path: '/x', access_token: secret })
          }
        )
      )

      await expectNotEmulated(response)
      expect(target.ledger.entries()[0]?.query).toEqual({
        authorization: '<redacted>',
        access_token: '<redacted>',
        'X-Amz-Signature': '<redacted>',
        arg: 'x'
      })
      expect(target.ledger.entries()[0]?.body).toEqual({ path: '/x', access_token: '<redacted>' })

      const recorded = JSON.stringify([
        target.ledger.entries(),
        await jsonOf(await target.fetch(new Request(`${api}/_emulate/ledger`)))
      ])

      expect(recorded).not.toContain(secret)
      expect(recorded).not.toContain(token)
    })
  )
})

describe('Dropbox-API-Arg in the ledger', () => {
  const secret = 'synthetic-arg-secret'

  it.effect('records the argument with credential fields redacted at any depth', () =>
    Effect.promise(async () => {
      const target = await emulator()

      const accepted = {
        path: `${work}/arg.txt`,
        mode: 'add',
        autorename: false,
        strict_conflict: true
      }

      const rejected = {
        ...accepted,
        access_token: secret,
        mode: { '.tag': 'update', update: 'a1b2c3d4e5f60030', nested: { authorization: secret } }
      }

      expect((await uploadCall(target, accepted, 'x')).status).toBe(200)
      await expectNotEmulated(await uploadCall(target, rejected, 'x'))
      await expectNotEmulated(
        await uploadCall(target, accepted, 'x', { 'dropbox-api-arg': `{"token": "${secret}", ` })
      )
      await expectNotEmulated(
        await target.fetch(
          new Request(`${content}/2/files/upload_session/start`, {
            method: 'POST',
            headers: {
              authorization: `Bearer ${token}`,
              'dropbox-api-arg': JSON.stringify({ close: false, api_key: secret })
            },
            body: 'x'
          })
        )
      )

      const recorded = target.ledger
        .entries()
        .map(entry => entry.headers['dropbox-api-arg'])
        .map(value => (value === undefined || value === '<redacted>' ? value : JSON.parse(value)))

      expect(recorded).toEqual([
        accepted,
        {
          ...accepted,
          access_token: '<redacted>',
          mode: {
            '.tag': 'update',
            update: 'a1b2c3d4e5f60030',
            nested: { authorization: '<redacted>' }
          }
        },
        '<redacted>',
        { close: false, api_key: '<redacted>' }
      ])

      const everything = JSON.stringify([
        target.ledger.entries(),
        await jsonOf(await target.fetch(new Request(`${api}/_emulate/ledger`)))
      ])

      expect(everything).not.toContain(secret)
    })
  )

  it.effect(
    'records a browser-style JSON `arg` query parameter with credential fields redacted',
    () =>
      Effect.promise(async () => {
        const target = await emulator()

        const arg = JSON.stringify({ path: `${work}/q.txt`, nested: { access_token: secret } })

        await expectNotEmulated(
          await target.fetch(
            new Request(`${content}/2/files/upload?arg=${encodeURIComponent(arg)}`, {
              method: 'POST',
              headers: { authorization: `Bearer ${token}` },
              body: 'x'
            })
          )
        )

        const recorded = target.ledger.entries().at(-1)?.query.arg

        expect(recorded === undefined ? undefined : JSON.parse(recorded)).toEqual({
          path: `${work}/q.txt`,
          nested: { access_token: '<redacted>' }
        })
        expect(
          JSON.stringify([
            target.ledger.entries(),
            await jsonOf(await target.fetch(new Request(`${api}/_emulate/ledger`)))
          ])
        ).not.toContain(secret)
      })
  )

  it('refuses to record a credential header', async () => {
    const core = {
      fetch: () => Promise.resolve(new Response(null)),
      baseUrl: 'http://127.0.0.1',
      snapshot: () => ({}),
      restore: () => Promise.resolve(),
      close: () => Promise.resolve()
    }

    await expect(
      makeStatefulEmulator(
        {
          routes: [],
          env: {},
          initial: {},
          buildSeed: () => ({}),
          recordHeaders: [{ name: 'X-Api-Key', json: false }],
          clearRuntime: () => undefined,
          runtimeState: () => ({}),
          seedSummary: () => ({}),
          inputInvalid: (_input, reason) => new Error(reason)
        },
        () => Promise.resolve(core)
      )
    ).rejects.toThrow('credential header')
  })
})

describe('faults', () => {
  it.effect('answer matching requests by method and path, with a count, before any write', () =>
    Effect.promise(async () => {
      const target = await emulator()
      const before = target.snapshot()

      target.faults.add({
        kind: 'status',
        status: 503,
        match: { method: 'POST', path: '/2/files/create_*' },
        count: 1
      })

      const faulted = await rpc(target, 'create_folder_v2', {
        path: `${work}/f`,
        autorename: false
      })

      expect(faulted.status).toBe(503)
      expect(faulted.headers.get(emulatorEvidenceHeader)).toBe('unverified')
      expect(await jsonOf(faulted)).toEqual({
        error: { type: 'emulator_fault', message: 'Emulator fault: status 503.' }
      })
      expect(target.snapshot()).toEqual(before)
      expect(
        (await rpc(target, 'create_folder_v2', { path: `${work}/f`, autorename: false })).status
      ).toBe(200)
      expect(target.faults.list()).toEqual([expect.objectContaining({ remaining: 0, applied: 1 })])
      expect(target.ledger.entries().map(entry => entry.fault)).toEqual(['status', undefined])
    })
  )

  it.effect(
    'rejects success, bodiless, redirecting, and framing faults (JS API and control plane)',
    () =>
      Effect.promise(async () => {
        const target = await emulator()
        const kept = target.faults.add({ kind: 'status', status: 429, count: 2 })

        const invalid: ReadonlyArray<DropboxFault> = [
          { kind: 'status', status: 200 },
          { kind: 'status', status: 204 },
          { kind: 'status', status: 302, headers: { location: 'https://example.test/' } },
          { kind: 'status', status: 399 },
          { kind: 'status', status: 500, headers: { Location: 'https://example.test/' } },
          { kind: 'status', status: 500, headers: { 'content-length': '1' } },
          { kind: 'status', status: 500, headers: { 'bad name': 'x' } }
        ]

        const control = (body: unknown) =>
          target.fetch(
            new Request(`${api}/_emulate/faults`, { method: 'POST', body: JSON.stringify(body) })
          )

        for (const fault of invalid) {
          expect(() => target.faults.add(fault), JSON.stringify(fault)).toThrow(
            DropboxEmulatorInputInvalid
          )
          expect((await control(fault)).status, JSON.stringify(fault)).toBe(400)
        }

        expect(target.faults.list()).toEqual([kept])
      })
  )

  it.effect('a fault response that cannot be built answers a tagged 500 and is not consumed', () =>
    Effect.promise(async () => {
      const target = await emulator()

      target.faults.add({ kind: 'status', status: 503, count: 1 })

      const RealResponse = globalThis.Response

      class UnbuildableResponse extends RealResponse {
        constructor(bodyInit?: BodyInit | null, init?: ResponseInit) {
          if (init?.status === 503) {
            throw new TypeError('synthetic: cannot build a 503 response')
          }

          super(bodyInit, init)
        }
      }

      vi.stubGlobal('Response', UnbuildableResponse)

      const failed = await rpc(target, 'get_metadata', { path: '/x' }).finally(() =>
        vi.unstubAllGlobals()
      )

      expect(failed.status).toBe(500)
      expect(failed.headers.get(emulatorEvidenceHeader)).toBe('unverified')
      expect(target.ledger.entries()).toEqual([
        expect.objectContaining({
          status: 500,
          evidence: 'unverified',
          responseError: expect.any(String)
        })
      ])
      expect(target.faults.list()[0]).toMatchObject({ remaining: 1, applied: 0 })
      expect((await rpc(target, 'get_metadata', { path: '/x' })).status).toBe(503)
    })
  )

  it.effect('a 429 with retry-after reaches the connector as dropbox_rate_limited', () =>
    Effect.gen(function* () {
      const target = yield* Effect.promise(() => emulator())

      target.faults.add({
        kind: 'status',
        status: 429,
        headers: { 'retry-after': '2' },
        match: { path: '/2/files/list_folder' }
      })

      const result = yield* dropboxListFolderAction
        .executeTyped({
          integration: dropboxConformanceIntegration,
          input: DropboxListFolderInput.make({ path: '/Conformance/Paging', limit: 2 })
        })
        .pipe(Effect.provide(connectorLayer(target)))

      expect(Predicate.isTagged(result, 'Failure')).toBe(true)

      if (Predicate.isTagged(result, 'Failure')) {
        expect(result.error).toMatchObject({
          code: 'dropbox_rate_limited',
          status: 429,
          retryAfterMs: 2000
        })
      }
    })
  )
})

describe('seeds and the control plane', () => {
  it.effect('rejects invalid seeds and options', () =>
    Effect.promise(async () => {
      // Parsed from JSON, as a host passing untyped input would.
      const options: ReadonlyArray<DropboxEmulatorOptions> = JSON.parse(
        JSON.stringify([
          { seed: { entries: [{ path: '/a/b', id: 'id:x', kind: 'file' }] } },
          {
            seed: {
              entries: [
                { path: '/a', id: 'id:x', kind: 'folder' },
                { path: '/A', id: 'id:y', kind: 'folder' }
              ]
            }
          },
          { seed: { entries: [{ path: '/a', id: 'id:x', kind: 'folder', rev: 'a1b2c3d4e5f6' }] } },
          { seed: { entries: [{ path: '/a', id: 'x', kind: 'folder' }] } },
          { seed: { profile: 'nope' } },
          { drills: { nope: true } },
          { drills: { moveMintsNewId: 'yes' } }
        ])
      )

      for (const invalid of options) {
        await expect(makeDropboxEmulator(invalid), JSON.stringify(invalid)).rejects.toBeInstanceOf(
          DropboxEmulatorInputInvalid
        )
      }

      const target = await emulator()

      await expect(
        target.seed({ entries: [{ path: '/a/b', id: 'id:x', kind: 'folder' }] })
      ).rejects.toBeInstanceOf(DropboxEmulatorInputInvalid)
    })
  )

  it.effect('minted ids and revs start above the seeded ones in the minted form', () =>
    Effect.promise(async () => {
      const target = await emulator({
        seed: {
          entries: [
            { path: '/Keep', id: 'id:SyntheticEntry00000007', kind: 'folder' },
            {
              path: '/Keep/kept.txt',
              id: 'id:SyntheticEntry00000002',
              kind: 'file',
              rev: 'a1b2c3d4e5f60500'
            },
            { path: '/Work', id: 'id:SyntheticWork', kind: 'folder' }
          ]
        }
      })

      expect(target.snapshot().counters).toEqual({ nextIdNumber: 8, nextRevNumber: 501 })

      const created = await jsonOf(
        await rpc(target, 'create_folder_v2', { path: '/Work/new', autorename: false })
      )

      expect(field(field(created, 'metadata'), 'id')).toBe('id:SyntheticEntry00000008')

      const uploaded = await jsonOf(
        await uploadCall(
          target,
          { path: '/Work/new/file.txt', mode: 'add', autorename: false, strict_conflict: true },
          'x'
        )
      )

      expect(field(uploaded, 'rev')).toBe('a1b2c3d4e5f60501')

      // Deleting the created folder by its id leaves the seeded entries untouched.
      expect(
        (await rpc(target, 'delete_v2', { path: field(field(created, 'metadata'), 'id') })).status
      ).toBe(200)
      expect(target.snapshot().entries.map(entry => entry.id)).toEqual([
        'id:SyntheticEntry00000007',
        'id:SyntheticEntry00000002',
        'id:SyntheticWork'
      ])
    })
  )

  it.effect('a ledger clear while a request awaits dispatch never swaps two requests', () =>
    Effect.promise(async () => {
      const target = await emulator()

      // The first request is in flight (its ledger entry is seq 1) when the ledger clears, so the
      // second request is ledgered as seq 1 too; each must still run its own write.
      const first = rpc(target, 'create_folder_v2', { path: `${work}/first`, autorename: false })

      target.ledger.clear()

      const second = rpc(target, 'create_folder_v2', { path: `${work}/second`, autorename: false })

      const answers = await Promise.all([first, second])

      expect(answers.map(response => response.status)).toEqual([200, 200])
      expect(
        await Promise.all(
          answers.map(async response => field(field(await jsonOf(response), 'metadata'), 'name'))
        )
      ).toEqual(['first', 'second'])
      expect(target.ledger.entries().map(entry => entry.seq)).toEqual([1])
      expect(
        target
          .snapshot()
          .entries.filter(entry => entry.name === 'first' || entry.name === 'second')
          .map(entry => entry.name)
          .toSorted()
      ).toEqual(['first', 'second'])
    })
  )

  it.effect('reset restores the seed and clears the ledger, faults, and cursors', () =>
    Effect.promise(async () => {
      const target = await emulator()
      const seeded = target.snapshot()

      await rpc(target, 'create_folder_v2', { path: `${work}/r`, autorename: false })
      await rpc(target, 'delete_v2', { path: `${work}/r` })
      await rpc(target, 'list_folder', { path: '/Conformance/Paging', limit: 1 })
      target.faults.add({ kind: 'status', status: 503 })

      expect(target.snapshot()).not.toEqual(seeded)
      expect(target.cursors()).toHaveLength(1)

      await target.reset()

      expect(target.snapshot()).toEqual(seeded)
      expect(target.ledger.entries()).toEqual([])
      expect(target.faults.list()).toEqual([])
      expect(target.cursors()).toEqual([])

      await target.seed({ profile: 'empty' })
      await target.reset()

      expect(target.snapshot().entries).toEqual([])
    })
  )

  it.effect('serves ledger, faults, reset, state, seed, and coverage under /_emulate', () =>
    Effect.promise(async () => {
      const target = await emulator()

      const control = (method: string, path: string, body?: unknown) =>
        target.fetch(
          new Request(`${api}/_emulate/${path}`, {
            method,
            body: body === undefined ? undefined : JSON.stringify(body)
          })
        )

      expect(
        (await control('POST', 'faults', { faults: [{ kind: 'status', status: 429, count: 1 }] }))
          .status
      ).toBe(201)
      expect((await rpc(target, 'get_metadata', { path: '/x' })).status).toBe(429)
      expect(field(await jsonOf(await control('GET', 'ledger')), 'entries')).toEqual([
        expect.objectContaining({ method: 'POST', status: 429, fault: 'status' })
      ])
      expect(await jsonOf(await control('GET', 'coverage'))).toMatchObject({
        unknownRouteRequests: 0,
        notEmulatedRequests: 0
      })
      expect(await jsonOf(await control('DELETE', 'ledger'))).toEqual({ cleared: 1 })
      expect(await jsonOf(await control('DELETE', 'faults'))).toEqual({ cleared: 1 })
      expect(
        (await control('POST', 'faults', { kind: 'status', status: 429, extra: 1 })).status
      ).toBe(400)
      expect(await jsonOf(await control('POST', 'seed', { profile: 'empty' }))).toEqual({
        seeded: true,
        entries: 0
      })
      expect(await jsonOf(await control('GET', 'state'))).toEqual({
        state: { entries: [], deleted: [], counters: { nextIdNumber: 1, nextRevNumber: 101 } },
        cursors: [],
        faults: [],
        ledgerEntries: 0
      })
      expect((await control('POST', 'seed', { profile: 'nope' })).status).toBe(400)
      expect(await jsonOf(await control('POST', 'reset'))).toEqual({ reset: true })
      expect((await control('GET', 'reset')).status).toBe(405)
      expect((await control('GET', 'nope')).status).toBe(404)
    })
  )
})
