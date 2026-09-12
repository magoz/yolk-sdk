import { Effect } from 'effect'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Sandbox as VercelSdkSandbox } from '@vercel/sandbox'
import {
  EmptySandboxInitialSource,
  GitSandboxBasicAuth,
  GitSandboxInitialSource,
  SandboxResources,
  SandboxSnapshotRetention,
  SnapshotSandboxInitialSource,
  TarballSandboxInitialSource
} from '../src/model.ts'
import {
  VercelSandboxClient,
  VercelSandboxClientLive,
  type VercelSandboxCreateInput
} from '../src/vercel/client.ts'

type CreateCall = Parameters<typeof VercelSdkSandbox.create>

const capturedCreate = (calls: ReadonlyArray<CreateCall>) => {
  const input = calls[0]?.[0]

  if (input === undefined) throw new Error('expected an SDK create argument')

  return input
}

const baseInput = (
  overrides: Partial<VercelSandboxCreateInput> = {}
): VercelSandboxCreateInput => ({
  name: 'sandbox-fixture',
  source: EmptySandboxInitialSource.make({}),
  ports: [3000],
  timeoutMs: 60_000,
  resources: SandboxResources.make({ vcpus: 2 }),
  runtime: 'node24',
  persistent: false,
  ...overrides
})

const createError = (input: VercelSandboxCreateInput) =>
  Effect.runPromise(
    Effect.gen(function* () {
      const client = yield* VercelSandboxClient

      return yield* client.create(input).pipe(Effect.flip)
    }).pipe(Effect.provide(VercelSandboxClientLive))
  )

const commonKeys = [
  'name',
  'ports',
  'timeout',
  'resources',
  'env',
  'persistent',
  'networkPolicy',
  'snapshotExpiration',
  'keepLastSnapshots'
]

beforeEach(() => {
  vi.spyOn(globalThis, 'fetch').mockImplementation(async () => {
    throw new Error('unexpected network access')
  })
})

afterEach(() => vi.restoreAllMocks())

describe('live Vercel client request construction', () => {
  it('forwards get arguments and preserves the rejected error', async () => {
    const sentinel = new Error('get sentinel')
    const spy = vi.spyOn(VercelSdkSandbox, 'get').mockRejectedValue(sentinel)

    const error = await Effect.runPromise(
      Effect.gen(function* () {
        const client = yield* VercelSandboxClient

        return yield* client.get({ name: 'fixture' }).pipe(Effect.flip)
      }).pipe(Effect.provide(VercelSandboxClientLive))
    )

    const input = spy.mock.calls[0]?.[0]

    expect(error).toBe(sentinel)
    expect(spy).toHaveBeenCalledTimes(1)

    if (input === undefined) throw new Error('expected get arguments')
    expect(Object.keys(input)).toEqual(['name'])
    expect(input.name).toBe('fixture')
  })

  it('keeps common undefined keys, copied ports, and runtime ordering', async () => {
    const sentinel = new Error('create sentinel')
    const spy = vi.spyOn(VercelSdkSandbox, 'create').mockRejectedValue(sentinel)
    const input = baseInput()

    expect(await createError(input)).toBe(sentinel)
    const captured = capturedCreate(spy.mock.calls)

    expect(Object.keys(captured)).toEqual([...commonKeys, 'runtime'])
    expect(captured.ports).toEqual(input.ports)
    expect(captured.ports).not.toBe(input.ports)
    expect(captured.resources).toEqual({ vcpus: 2 })
    expect(Object.hasOwn(captured, 'env')).toBe(true)
    expect(Object.hasOwn(captured, 'networkPolicy')).toBe(true)
    expect(Object.hasOwn(captured, 'snapshotExpiration')).toBe(true)
    expect(Object.hasOwn(captured, 'keepLastSnapshots')).toBe(true)
    expect(captured.env).toBeUndefined()
    expect(captured.networkPolicy).toBeUndefined()
    expect(captured.snapshotExpiration).toBeUndefined()
    expect(captured.keepLastSnapshots).toBeUndefined()
  })

  it('omits runtime for snapshots but puts runtime before a tarball source', async () => {
    const sentinel = new Error('create sentinel')
    const spy = vi.spyOn(VercelSdkSandbox, 'create').mockRejectedValue(sentinel)

    expect(
      await createError(
        baseInput({
          source: SnapshotSandboxInitialSource.make({ snapshotId: 'snap_fixture' })
        })
      )
    ).toBe(sentinel)
    const snapshot = capturedCreate(spy.mock.calls)
    expect(Object.keys(snapshot)).toEqual([...commonKeys, 'source'])
    expect(Object.hasOwn(snapshot, 'runtime')).toBe(false)
    expect(snapshot.source).toEqual({ type: 'snapshot', snapshotId: 'snap_fixture' })

    spy.mockClear()
    expect(
      await createError(
        baseInput({
          source: TarballSandboxInitialSource.make({ url: 'https://example.test/bundle.tgz' })
        })
      )
    ).toBe(sentinel)
    const tarball = capturedCreate(spy.mock.calls)
    expect(Object.keys(tarball)).toEqual([...commonKeys, 'runtime', 'source'])
    expect(tarball.source).toEqual({ type: 'tarball', url: 'https://example.test/bundle.tgz' })
  })

  it('preserves git omission and auth/depth/revision evaluation order', async () => {
    const sentinel = new Error('create sentinel')
    const spy = vi.spyOn(VercelSdkSandbox, 'create').mockRejectedValue(sentinel)
    const url = 'https://example.test/repo.git'

    expect(await createError(baseInput({ source: GitSandboxInitialSource.make({ url }) }))).toBe(
      sentinel
    )
    const anonymous = capturedCreate(spy.mock.calls).source
    expect(anonymous).toEqual({ type: 'git', url })

    if (anonymous === undefined) throw new Error('expected source')
    expect(Object.keys(anonymous)).toEqual(['type', 'url'])

    const reads: Array<string> = []
    const auth = GitSandboxBasicAuth.make({ username: 'fake_user', password: 'fake_password' })
    const source = GitSandboxInitialSource.make({ url, auth, depth: 1, revision: 'main' })
    Object.defineProperty(source, 'depth', {
      get: () => {
        reads.push('depth')

        return 1
      }
    })
    Object.defineProperty(source, 'revision', {
      get: () => {
        reads.push('revision')

        return 'main'
      }
    })
    const input = baseInput()
    Object.defineProperty(input, 'source', {
      get: () => {
        reads.push('source')

        return source
      }
    })
    spy.mockClear()

    expect(await createError(input)).toBe(sentinel)
    const git = capturedCreate(spy.mock.calls).source
    expect(git).toEqual({
      type: 'git',
      url,
      username: 'fake_user',
      password: 'fake_password',
      depth: 1,
      revision: 'main'
    })

    if (git === undefined) throw new Error('expected git source')
    expect(Object.keys(git)).toEqual(['type', 'url', 'username', 'password', 'depth', 'revision'])
    expect(reads).toEqual(['source', 'source', 'depth', 'depth', 'revision', 'revision'])

    spy.mockClear()
    expect(
      await createError(baseInput({ source: GitSandboxInitialSource.make({ url, auth }) }))
    ).toBe(sentinel)
    const withoutOptional = capturedCreate(spy.mock.calls).source

    if (withoutOptional === undefined) throw new Error('expected git source')
    expect(Object.keys(withoutOptional)).toEqual(['type', 'url', 'username', 'password'])
  })

  it('preserves retention omission, ordering and repeated getter reads', async () => {
    const sentinel = new Error('create sentinel')
    const spy = vi.spyOn(VercelSdkSandbox, 'create').mockRejectedValue(sentinel)

    expect(
      await createError(
        baseInput({ keepLastSnapshots: SandboxSnapshotRetention.make({ count: 3 }) })
      )
    ).toBe(sentinel)
    const omitted = capturedCreate(spy.mock.calls).keepLastSnapshots
    expect(omitted).toEqual({ count: 3 })

    if (omitted === undefined) throw new Error('expected retention')
    expect(Object.keys(omitted)).toEqual(['count'])

    const reads: Array<string> = []

    const retention = SandboxSnapshotRetention.make({
      count: 3,
      expirationMs: 6000,
      deleteEvicted: false
    })

    Object.defineProperty(retention, 'expirationMs', {
      get: () => {
        reads.push('expiration')

        return 6000
      }
    })
    Object.defineProperty(retention, 'deleteEvicted', {
      get: () => {
        reads.push('delete')

        return false
      }
    })
    spy.mockClear()

    expect(
      await createError(baseInput({ keepLastSnapshots: retention, snapshotExpirationMs: 7000 }))
    ).toBe(sentinel)
    const captured = capturedCreate(spy.mock.calls)
    expect(captured.keepLastSnapshots).toEqual({ count: 3, expiration: 6000, deleteEvicted: false })

    if (captured.keepLastSnapshots === undefined) throw new Error('expected retention')
    expect(Object.keys(captured.keepLastSnapshots)).toEqual([
      'count',
      'expiration',
      'deleteEvicted'
    ])
    expect(captured.snapshotExpiration).toBe(7000)
    expect(reads).toEqual(['expiration', 'expiration', 'delete', 'delete'])
  })
})
