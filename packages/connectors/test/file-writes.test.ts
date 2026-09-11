import { describe, expect, it } from '@effect/vitest'
import { Deferred, Effect, Fiber, Layer } from 'effect'
import {
  ConnectorBinaryWriteHttpClient,
  ConnectorBinaryHttpError,
  ConnectorFileTransferError,
  CredentialResolver,
  OAuthCredential,
  makeCredentialBinding,
  makeIntegration
} from '@yolk-sdk/connectors'
import type {
  ConnectorBinaryWriteHttpRequest,
  ConnectorBinaryHttpResponse
} from '@yolk-sdk/connectors'
import { createDropboxFile, updateDropboxFile, dropboxActions } from '@yolk-sdk/connectors/dropbox'
import { createOneDriveFile, updateOneDriveFile } from '@yolk-sdk/connectors/microsoft'
import {
  createR2Object,
  updateR2Object,
  getR2Object,
  R2ObjectClient
} from '@yolk-sdk/connectors/r2-storage'
import type { R2ObjectCondition } from '@yolk-sdk/connectors/r2-storage'

const budget = { maxBytes: 10, maxMetadataBytes: 1000, maxErrorBodyBytes: 32 }
const bytes = new Uint8Array([0, 255, 128])
const integration = (connectorId: string, config = {}) =>
  makeIntegration({
    connectorId,
    config,
    credentialBindings: [
      makeCredentialBinding({ slotId: `${connectorId}.oauth`, credentialRef: 'ref' })
    ]
  })
const response = (metadata: unknown, status = 200): ConnectorBinaryHttpResponse => ({
  status,
  headers: {},
  bytes: new TextEncoder().encode(JSON.stringify(metadata)),
  bodyComplete: true
})
const dropbox = { id: 'id:file', name: 'x.bin', rev: 'abcdef123', size: 3 }
const microsoft = { id: 'file', name: 'x.bin', size: 3, eTag: 'etag', file: {} }
const host = (r = response(dropbox)) => {
  const requests: ConnectorBinaryWriteHttpRequest[] = []
  const scopes: (readonly string[] | undefined)[] = []
  return {
    requests,
    scopes,
    layer: Layer.mergeAll(
      Layer.succeed(CredentialResolver, {
        resolve: req => {
          scopes.push(req.slot.requiredScopes)
          return Effect.succeed(
            OAuthCredential.make({
              _tag: 'OAuthCredential',
              provider: req.integration.connectorId,
              accessToken: 'secret',
              expiresAt: 4e12
            })
          )
        }
      }),
      Layer.succeed(ConnectorBinaryWriteHttpClient, {
        request: req => {
          requests.push(req)
          return Effect.succeed(r)
        }
      })
    )
  }
}

describe('host-only binary writes', () => {
  it.effect('Dropbox create is strict add with untouched bytes and ASCII JSON', () =>
    Effect.gen(function* () {
      const h = host()
      const result = yield* createDropboxFile(
        integration('dropbox'),
        { path: '/é.bin', bytes },
        budget
      ).pipe(Effect.provide(h.layer))
      expect(result.rev).toBe('abcdef123')
      expect(h.requests[0]).toMatchObject({
        method: 'POST',
        url: 'https://content.dropboxapi.com/2/files/upload',
        bytes,
        redirect: 'manual',
        credentials: 'omit',
        maxUploadBytes: 10,
        maxBytes: 1000
      })
      expect(h.requests[0]?.headers['dropbox-api-arg']).toBe(
        '{"path":"/\\u00e9.bin","mode":"add","autorename":false,"strict_conflict":true}'
      )
      expect(h.scopes).toEqual([['files.content.write']])
      expect(dropboxActions.some(a => a.id.includes('upload'))).toBe(false)
    })
  )
  it.effect('Dropbox update carries the exact revision and stable ID', () =>
    Effect.gen(function* () {
      const h = host()
      yield* updateDropboxFile(
        integration('dropbox'),
        { fileId: 'id:file', expectedRev: 'abcdef123', bytes },
        budget
      ).pipe(Effect.provide(h.layer))
      expect(h.requests[0]?.headers['dropbox-api-arg']).toBe(
        '{"path":"id:file","mode":{".tag":"update","update":"abcdef123"},"autorename":false,"strict_conflict":true}'
      )
    })
  )
  it.effect(
    'OneDrive create fails name conflicts, update acknowledges replacement without invented CAS',
    () =>
      Effect.gen(function* () {
        const h = host(response(microsoft, 201))
        yield* createOneDriveFile(
          integration('microsoft'),
          { parentItemId: 'parent', name: 'x.bin', bytes },
          budget
        ).pipe(Effect.provide(h.layer))
        expect(h.requests[0]?.url).toBe(
          'https://graph.microsoft.com/v1.0/me/drive/items/parent:/x.bin:/content?@microsoft.graph.conflictBehavior=fail'
        )
        yield* updateOneDriveFile(
          integration('microsoft'),
          { itemId: 'file', acknowledgeOverwrite: true, bytes },
          budget
        ).pipe(Effect.provide(h.layer))
        expect(h.requests[1]?.url).toBe(
          'https://graph.microsoft.com/v1.0/me/drive/items/file/content'
        )
        expect(h.requests[1]?.headers['if-match']).toBeUndefined()
        expect(h.scopes).toEqual([
          ['https://graph.microsoft.com/Files.ReadWrite'],
          ['https://graph.microsoft.com/Files.ReadWrite']
        ])
      })
  )
  it.effect('empty files are valid', () =>
    Effect.gen(function* () {
      const h = host(response({ ...dropbox, size: 0 }))
      const r = yield* createDropboxFile(
        integration('dropbox'),
        { path: '/empty', bytes: new Uint8Array() },
        { ...budget, maxBytes: 0 }
      ).pipe(Effect.provide(h.layer))
      expect(r.size).toBe(0)
    })
  )
  it.effect(
    'invalid paths, IDs, budgets and application guards fail before credentials/network',
    () =>
      Effect.gen(function* () {
        const h = host()
        for (const path of ['/../x', '/a\r\nx', '/\ud800', 'https://evil.test/x']) {
          const r = yield* createDropboxFile(integration('dropbox'), { path, bytes }, budget).pipe(
            Effect.provide(h.layer),
            Effect.result
          )
          expect(r._tag).toBe('Failure')
        }
        const tasks: readonly Effect.Effect<
          unknown,
          ConnectorFileTransferError,
          CredentialResolver | ConnectorBinaryWriteHttpClient
        >[] = [
          createDropboxFile(integration('other'), { path: '/x', bytes }, budget),
          createDropboxFile(
            integration('dropbox'),
            { path: '/x', bytes },
            { ...budget, maxBytes: -1 }
          ),
          createDropboxFile(
            integration('dropbox'),
            { path: '/x', bytes },
            { ...budget, maxBytes: 2 }
          ),
          updateDropboxFile(
            integration('dropbox'),
            { fileId: 'id:file', expectedRev: '*', bytes },
            budget
          ),
          updateOneDriveFile(
            integration('microsoft'),
            { itemId: '..', acknowledgeOverwrite: true, bytes },
            budget
          ),
          createOneDriveFile(
            integration('microsoft', { oneDriveAccessMode: 'application' }),
            { parentItemId: 'parent', name: 'x', bytes },
            budget
          )
        ]
        for (const task of tasks)
          expect((yield* task.pipe(Effect.provide(h.layer), Effect.result))._tag).toBe('Failure')
        expect(h.requests).toHaveLength(0)
        expect(h.scopes).toHaveLength(0)
      })
  )
  it.effect('conflicts, redirects, truncation and malformed/oversized metadata never retry', () =>
    Effect.gen(function* () {
      for (const r of [
        response({}, 409),
        response({}, 412),
        response({}, 302),
        response({ secret: 'SECRET' }),
        { ...response(dropbox), bodyComplete: false },
        response({ ...dropbox, size: 4 }),
        response(dropbox, 206)
      ]) {
        const h = host(r)
        const result = yield* updateDropboxFile(
          integration('dropbox'),
          { fileId: 'id:file', expectedRev: 'abcdef123', bytes },
          budget
        ).pipe(Effect.provide(h.layer), Effect.result)
        expect(result._tag).toBe('Failure')
        expect(JSON.stringify(result)).not.toContain('SECRET')
        expect(h.requests).toHaveLength(1)
      }
      const h = host()
      const r = yield* createDropboxFile(
        integration('dropbox'),
        { path: '/x', bytes },
        { ...budget, maxMetadataBytes: 1 }
      ).pipe(Effect.provide(h.layer), Effect.result)
      expect(r._tag).toBe('Failure')
    })
  )
  it.effect('transport failures are code-only and missing credentials never send', () =>
    Effect.gen(function* () {
      const h = host()
      const missing = yield* createDropboxFile(
        makeIntegration({ connectorId: 'dropbox' }),
        { path: '/x', bytes },
        budget
      ).pipe(Effect.provide(h.layer), Effect.result)
      expect(missing._tag).toBe('Failure')
      expect(h.requests).toHaveLength(0)
      const r = yield* createDropboxFile(
        integration('dropbox'),
        { path: '/x', bytes },
        budget
      ).pipe(
        Effect.provideService(ConnectorBinaryWriteHttpClient, {
          request: () => Effect.fail(new ConnectorBinaryHttpError({ code: 'transport_failed' }))
        }),
        Effect.provide(h.layer),
        Effect.result
      )
      expect(r._tag).toBe('Failure')
    })
  )
})

describe('conditional R2 host port', () => {
  it.effect('preserves host conflicts without retry and rejects invalid returned metadata', () =>
    Effect.gen(function* () {
      const i = integration('r2-storage')
      let calls = 0
      const conflicting = Layer.succeed(R2ObjectClient, {
        get: () => Effect.fail(new ConnectorFileTransferError({ code: 'conflict' })),
        put: () => {
          calls++
          return Effect.fail(new ConnectorFileTransferError({ code: 'conflict' }))
        }
      })
      const conflict = yield* updateR2Object(
        i,
        { bucket: 'bucket', key: 'x', expectedEtag: '"old"', bytes },
        budget
      ).pipe(Effect.provide(conflicting), Effect.result)
      expect(conflict._tag).toBe('Failure')
      if (conflict._tag === 'Failure') expect(conflict.failure.code).toBe('conflict')
      expect(calls).toBe(1)
      const readConflict = yield* getR2Object(
        i,
        { bucket: 'bucket', key: 'x', expectedEtag: '"old"' },
        budget
      ).pipe(Effect.provide(conflicting), Effect.result)
      expect(readConflict._tag).toBe('Failure')
      if (readConflict._tag === 'Failure') expect(readConflict.failure.code).toBe('conflict')
      for (const metadata of [
        { etag: '', size: 3 },
        { etag: '"opaque"', size: -1 },
        { etag: '"opaque"', size: 4 }
      ]) {
        const layer = Layer.succeed(R2ObjectClient, {
          get: () => Effect.succeed({ ...metadata, bytes }),
          put: () => Effect.succeed(metadata)
        })
        const read = yield* getR2Object(i, { bucket: 'bucket', key: 'x' }, budget).pipe(
          Effect.provide(layer),
          Effect.result
        )
        const write = yield* createR2Object(i, { bucket: 'bucket', key: 'x', bytes }, budget).pipe(
          Effect.provide(layer),
          Effect.result
        )
        for (const result of [read, write]) {
          expect(result._tag).toBe('Failure')
          if (result._tag === 'Failure') expect(result.failure.code).toBe('invalid_metadata')
        }
      }
      const mismatch = yield* getR2Object(
        i,
        { bucket: 'bucket', key: 'x', expectedEtag: '"old"' },
        budget
      ).pipe(
        Effect.provideService(R2ObjectClient, {
          get: () => Effect.succeed({ etag: '"new"', size: 3, bytes }),
          put: () => Effect.die('Unexpected PUT')
        }),
        Effect.result
      )
      expect(mismatch._tag).toBe('Failure')
      if (mismatch._tag === 'Failure') expect(mismatch.failure.code).toBe('invalid_metadata')
    })
  )
  it.effect('interrupts an ambiguous R2 write without retrying', () =>
    Effect.gen(function* () {
      const started = yield* Deferred.make<void>()
      let calls = 0
      let released = false
      const program = createR2Object(
        integration('r2-storage'),
        { bucket: 'bucket', key: 'x', bytes },
        budget
      ).pipe(
        Effect.provideService(R2ObjectClient, {
          get: () => Effect.die('Unexpected GET'),
          put: () =>
            Effect.gen(function* () {
              calls++
              yield* Deferred.succeed(started, undefined)
              return yield* Effect.never
            }).pipe(
              Effect.ensuring(
                Effect.sync(() => {
                  released = true
                })
              )
            )
        })
      )
      const fiber = yield* Effect.forkChild(program)
      yield* Deferred.await(started)
      yield* Fiber.interrupt(fiber)
      expect(calls).toBe(1)
      expect(released).toBe(true)
    })
  )
  it.effect('requires atomic absent/ETag conditions and checks actual downloaded bytes', () =>
    Effect.gen(function* () {
      const conditions: R2ObjectCondition[] = []
      const layer = Layer.succeed(R2ObjectClient, {
        put: req => {
          conditions.push(req.condition)
          return Effect.succeed({ etag: '"opaque"', size: req.bytes.byteLength })
        },
        get: () => Effect.succeed({ etag: '"opaque"', size: 3, bytes })
      })
      const i = integration('r2-storage')
      yield* createR2Object(i, { bucket: 'bucket', key: 'x', bytes }, budget).pipe(
        Effect.provide(layer)
      )
      yield* updateR2Object(
        i,
        { bucket: 'bucket', key: 'x', expectedEtag: '"old"', bytes },
        budget
      ).pipe(Effect.provide(layer))
      expect(conditions).toEqual([{ kind: 'absent' }, { kind: 'etag', etag: '"old"' }])
      expect(
        (yield* getR2Object(i, { bucket: 'bucket', key: 'x' }, budget).pipe(Effect.provide(layer)))
          .bytes
      ).toEqual(bytes)
      const invalid = yield* updateR2Object(
        i,
        { bucket: 'bucket', key: 'x', expectedEtag: '*', bytes },
        budget
      ).pipe(Effect.provide(layer), Effect.result)
      expect(invalid._tag).toBe('Failure')
      expect(conditions).toHaveLength(2)
      expect(
        (yield* getR2Object(i, { bucket: 'bucket', key: 'x' }, { ...budget, maxBytes: 2 }).pipe(
          Effect.provide(layer),
          Effect.result
        ))._tag
      ).toBe('Failure')
    })
  )
})

it.effect('rejects malformed JS write envelopes and acknowledgement before effects', () =>
  Effect.gen(function* () {
    const h = host()
    const tasks: readonly Effect.Effect<
      unknown,
      ConnectorFileTransferError,
      CredentialResolver | ConnectorBinaryWriteHttpClient | R2ObjectClient
    >[] = [
      // @ts-expect-error Exercise direct JavaScript callers at runtime.
      createDropboxFile(integration('dropbox'), null, budget),
      // @ts-expect-error Exercise direct JavaScript callers at runtime.
      updateDropboxFile(integration('dropbox'), undefined, budget),
      // @ts-expect-error Exercise direct JavaScript callers at runtime.
      createOneDriveFile(integration('microsoft'), null, budget),
      // @ts-expect-error Missing acknowledgement must never permit replacement.
      updateOneDriveFile(integration('microsoft'), { itemId: 'file', bytes }, budget),
      // @ts-expect-error Exercise direct JavaScript callers at runtime.
      createR2Object(integration('r2-storage'), null, budget)
    ]
    for (const task of tasks) {
      const r = yield* task.pipe(
        Effect.provide(h.layer),
        Effect.provideService(R2ObjectClient, {
          get: () => Effect.die('unexpected'),
          put: () => Effect.die('unexpected')
        }),
        Effect.result
      )
      expect(r._tag).toBe('Failure')
    }
    expect(h.requests).toHaveLength(0)
    expect(h.scopes).toHaveLength(0)
  })
)

it.effect('single-upload provider caps fail before the write transport', () =>
  Effect.gen(function* () {
    const h = host()
    const limits = { ...budget, maxBytes: 300_000_000 }
    const largeDropbox = yield* createDropboxFile(
      integration('dropbox'),
      { path: '/x', bytes: new Uint8Array(150_000_001) },
      limits
    ).pipe(Effect.provide(h.layer), Effect.result)
    const largeOneDrive = yield* createOneDriveFile(
      integration('microsoft'),
      { parentItemId: 'p', name: 'x', bytes: new Uint8Array(250_000_001) },
      limits
    ).pipe(Effect.provide(h.layer), Effect.result)
    for (const r of [largeDropbox, largeOneDrive]) {
      expect(r._tag).toBe('Failure')
      expect(JSON.stringify(r)).toContain('upload_session_required')
    }
    expect(h.requests).toHaveLength(0)
    expect(h.scopes).toHaveLength(0)
  })
)

it.effect('interruption cancels the host operation and never retries the ambiguous write', () =>
  Effect.gen(function* () {
    const started = yield* Deferred.make<void>()
    let calls = 0
    let released = false
    const h = host()
    const program = createDropboxFile(integration('dropbox'), { path: '/x', bytes }, budget).pipe(
      Effect.provideService(ConnectorBinaryWriteHttpClient, {
        request: () =>
          Effect.gen(function* () {
            calls += 1
            yield* Deferred.succeed(started, undefined)
            return yield* Effect.never
          }).pipe(
            Effect.ensuring(
              Effect.sync(() => {
                released = true
              })
            )
          )
      }),
      Effect.provide(h.layer)
    )
    const fiber = yield* Effect.forkChild(program)
    yield* Deferred.await(started)
    yield* Fiber.interrupt(fiber)
    expect(calls).toBe(1)
    expect(released).toBe(true)
  })
)
