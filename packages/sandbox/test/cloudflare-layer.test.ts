import { Duration, Effect, Layer, Option, Predicate } from 'effect'
import { TestClock } from 'effect/testing'
import { describe, expect, it } from '@effect/vitest'
import {
  GitSandboxInitialSource,
  PersistentSandboxLifecycle,
  Sandbox,
  SandboxCommandInput,
  SandboxResources,
  VercelSandboxState,
  makeSandboxName
} from '../src/index.ts'
import type { SandboxStateStore } from '../src/index.ts'
import { makeSandboxToolResult } from '../src/agent.ts'
import { makeInMemorySandboxStateStoreLayer } from '../src/testing/index.ts'
import {
  CloudflareSandbox,
  CloudflareSandboxSourceSpec,
  makeCloudflareSandboxLayer,
  type CloudflareSandboxLayerConfig,
  type CloudflareSandboxNamespace
} from '../src/cloudflare/index.ts'
import {
  makeFakeContainer,
  makeFakeNamespace,
  makeFakeStorage,
  makeTestEngine
} from './cloudflare-fakes.ts'

const sessionId = 'user_1:session_1'

const setup = (overrides: Partial<CloudflareSandboxLayerConfig> = {}) => {
  const container = makeFakeContainer({
    command: input => ({ exitCode: 0, stdout: input.command })
  })

  const test = makeTestEngine({ container })

  const calls: Array<{ readonly name: string; readonly method: string; readonly input: unknown }> =
    []

  const namespace = makeFakeNamespace(() => test.engine, calls)

  const config: CloudflareSandboxLayerConfig = {
    sandboxSessionId: sessionId,
    namespace: () => namespace,
    image: 'SessionSandbox',
    ...overrides
  }

  return { ...test, calls, config }
}

const provide = (
  config: CloudflareSandboxLayerConfig,
  store = makeInMemorySandboxStateStoreLayer()
) => {
  const layer = makeCloudflareSandboxLayer(config).pipe(Layer.provideMerge(store))

  return <A, E>(effect: Effect.Effect<A, E, Sandbox | SandboxStateStore>) =>
    effect.pipe(Effect.provide(layer))
}

const run = (command: string) =>
  Effect.gen(function* () {
    const sandbox = yield* Sandbox

    return yield* sandbox.run(SandboxCommandInput.make({ command }))
  })

describe('Cloudflare sandbox layer', () => {
  it.effect('runs in the object named after the session and stores a Cloudflare state', () =>
    Effect.gen(function* () {
      const { config, calls, container } = setup()

      const { first, second, stored } = yield* Effect.gen(function* () {
        const first = yield* run('echo one')
        yield* TestClock.adjust(Duration.seconds(5))
        const second = yield* run('echo two')
        const stored = yield* (yield* Sandbox).currentState

        return { first, second, stored }
      }).pipe(provide(config))

      expect(calls.map(call => call.name)).toEqual([
        makeSandboxName(sessionId),
        makeSandboxName(sessionId)
      ])
      expect(first).toMatchObject({ exitCode: 0, stdout: 'echo one', workspaceReset: false })
      expect(first.previewUrls).toEqual([])
      expect(first.state).toMatchObject({ _tag: 'Cloudflare', name: makeSandboxName(sessionId) })
      expect(second.workspaceReset).toBe(false)
      expect(second.state.lastUsedAtMs).toBe(5_000)
      expect(Option.getOrUndefined(stored)).toEqual(second.state)
      expect(container.starts).toHaveLength(1)
      expect(calls[0]?.input).toMatchObject({
        fresh: false,
        cwd: '/workspace',
        container: {
          image: 'SessionSandbox',
          instance: { vcpu: 2, memoryMib: 4096, diskMb: 16384 },
          internet: true,
          idleTtlMs: 30 * 60_000,
          maxLifetimeMs: 45 * 60_000
        }
      })
    })
  )

  it.effect('reports workspaceReset when the container started over', () =>
    Effect.gen(function* () {
      const { config, container } = setup()

      const results = yield* Effect.gen(function* () {
        const first = yield* run('touch a')

        container.stop()

        const second = yield* run('ls')

        return { first, second }
      }).pipe(provide(config))

      expect(results.second.workspaceReset).toBe(true)
      expect(results.second.state._tag).toBe('Cloudflare')
      expect(results.second.state).not.toEqual(results.first.state)
    })
  )

  it.effect('expired disposable state starts fresh; persistent state does not expire', () =>
    Effect.gen(function* () {
      const disposable = setup()

      const expired = yield* Effect.gen(function* () {
        yield* run('one')
        yield* TestClock.adjust(Duration.minutes(31))

        return yield* run('two')
      }).pipe(provide(disposable.config))

      expect(expired.workspaceReset).toBe(true)
      expect(
        disposable.calls.map(call => Predicate.hasProperty(call.input, 'fresh') && call.input.fresh)
      ).toEqual([false, true])

      const persistent = setup({
        lifecycle: PersistentSandboxLifecycle.make({ idleTtlMs: 60_000 })
      })

      const kept = yield* Effect.gen(function* () {
        yield* run('one')
        yield* TestClock.adjust(Duration.minutes(5))

        return yield* run('two')
      }).pipe(provide(persistent.config))

      expect(kept.workspaceReset).toBe(false)
      expect(kept.state.maxExpiresAtMs).toBe(Number.MAX_SAFE_INTEGER)
      expect(persistent.calls[0]?.input).not.toHaveProperty('container.maxLifetimeMs')
    })
  )

  it.effect('stored state of another provider starts fresh', () =>
    Effect.gen(function* () {
      const { config, calls } = setup()

      const store = makeInMemorySandboxStateStoreLayer([
        {
          sandboxSessionId: sessionId,
          state: VercelSandboxState.make({
            name: makeSandboxName(sessionId),
            createdAtMs: 0,
            lastUsedAtMs: 0,
            expiresAtMs: 60_000,
            maxExpiresAtMs: 120_000
          })
        }
      ])

      const result = yield* run('ls').pipe(provide(config, store))

      expect(result.workspaceReset).toBe(true)
      expect(result.state._tag).toBe('Cloudflare')
      expect(calls[0]?.input).toMatchObject({ fresh: true })
    })
  )

  it.effect('maps resources, disk, env, internet, root and Git source into the spec', () =>
    Effect.gen(function* () {
      const { config, calls } = setup({
        resources: SandboxResources.make({ vcpus: 4 }),
        diskMb: 20_000,
        env: { TOKEN: 't' },
        internet: false,
        workspaceRoot: '/srv/work',
        source: GitSandboxInitialSource.make({ url: 'https://example.test/r.git', depth: 1 })
      })

      yield* Effect.gen(function* () {
        const sandbox = yield* Sandbox

        return yield* sandbox.run(SandboxCommandInput.make({ command: 'pwd', cwd: 'a/../b' }))
      }).pipe(provide(config))

      expect(calls[0]?.input).toMatchObject({
        cwd: '/srv/work/b',
        container: {
          instance: { vcpu: 4, memoryMib: 8192, diskMb: 20_000 },
          env: { TOKEN: 't' },
          internet: false,
          workspaceRoot: '/srv/work',
          source: { _tag: 'Git', url: 'https://example.test/r.git', depth: 1 }
        }
      })
    })
  )

  it.effect('transfers workspace files and maps read failures to input errors', () =>
    Effect.gen(function* () {
      const { config, container } = setup()
      const bytes = Uint8Array.from([1, 2, 3])

      const outcome = yield* Effect.gen(function* () {
        const sandbox = yield* Sandbox
        const write = sandbox.writeFile
        const read = sandbox.readFile

        if (write === undefined || read === undefined) {
          return yield* Effect.die(new Error('expected file transfer'))
        }

        const path = yield* write({ path: './out/../out/f.bin', bytes })
        const back = yield* read({ path, maxBytes: 3 })
        const tooLarge = yield* read({ path, maxBytes: 2 }).pipe(Effect.flip)
        const missing = yield* read({ path: 'none', maxBytes: 2 }).pipe(Effect.flip)
        const escape = yield* write({ path: '../x', bytes }).pipe(Effect.flip)

        return { path, back, tooLarge, missing, escape }
      }).pipe(provide(config))

      expect(outcome.path).toBe('out/f.bin')
      expect(container.files.get('/workspace/out/f.bin')).toEqual(bytes)
      expect(outcome.back).toEqual(bytes)
      expect(outcome.tooLarge).toMatchObject({ _tag: 'SandboxInputError', cause: 'file_too_large' })
      expect(outcome.missing).toMatchObject({ _tag: 'SandboxInputError', cause: 'file_not_found' })
      expect(outcome.escape).toMatchObject({ _tag: 'SandboxInputError', cause: 'invalid_path' })
    })
  )

  it.effect('config failures, RPC failures and a missing binding are typed errors', () =>
    Effect.gen(function* () {
      const unknownImage = yield* run('ls').pipe(
        provide(setup({ image: 'Nope' }).config),
        Effect.flip
      )

      const throwing: CloudflareSandboxNamespace = makeFakeNamespace(() => ({
        ...makeTestEngine({}).engine,
        run: async () => {
          throw new Error('Durable Object reset because its code was updated')
        }
      }))

      const rpc = yield* run('ls').pipe(
        provide(setup({ namespace: () => throwing }).config),
        Effect.flip
      )

      const unbound = yield* run('ls').pipe(
        provide(
          setup({
            namespace: () => {
              throw new Error('SANDBOX binding missing')
            }
          }).config
        ),
        Effect.flip
      )

      expect(unknownImage).toMatchObject({ _tag: 'SandboxConfigError' })
      expect(rpc).toMatchObject({ _tag: 'SandboxProviderError', provider: 'cloudflare' })
      expect(rpc.message).toContain('code was updated')
      expect(unbound).toMatchObject({ _tag: 'SandboxProviderError', operation: 'run' })
    })
  )

  it.effect('delete destroys the object container and clears the state', () =>
    Effect.gen(function* () {
      const { config, container } = setup()

      const state = yield* Effect.gen(function* () {
        const sandbox = yield* Sandbox

        yield* run('ls')
        yield* sandbox.delete

        return yield* sandbox.currentState
      }).pipe(provide(config))

      expect(Option.isNone(state)).toBe(true)
      expect(container.container.running).toBe(false)
    })
  )

  it.effect('background commands return their id; the agent tool shows Cloudflare state', () =>
    Effect.gen(function* () {
      const container = makeFakeContainer({ command: () => ({ hang: true }) })
      const test = makeTestEngine({ container })

      const config: CloudflareSandboxLayerConfig = {
        sandboxSessionId: sessionId,
        namespace: () => makeFakeNamespace(() => test.engine),
        image: 'SessionSandbox'
      }

      const result = yield* Effect.gen(function* () {
        const sandbox = yield* Sandbox

        return yield* sandbox.run(SandboxCommandInput.make({ command: 'serve', background: true }))
      }).pipe(provide(config))

      const tool = makeSandboxToolResult({ callId: 'call_1', result })

      expect(result.backgroundId).toMatch(/^bg-/)
      expect(tool.structuredContent).toMatchObject({
        backgroundId: result.backgroundId,
        state: {
          _tag: 'Cloudflare',
          bootId: Predicate.isTagged(result.state, 'Cloudflare') ? result.state.bootId : ''
        }
      })
    })
  )
})

// A `ctx` with what the object reads (`storage`, `container`) plus the rest of the Durable Object
// state the workspace's `cloudflare:workers` declaration requires.
const objectContext = (storage: ReturnType<typeof makeFakeStorage>['storage']) => ({
  id: { toString: () => 'sandbox-object' },
  storage: { ...storage, sql: { exec: () => ({ toArray: () => [] }) } },
  waitUntil: () => undefined
})

describe('CloudflareSandbox Durable Object', () => {
  it('serves the engine over its RPC methods from ctx.container and ctx.storage', async () => {
    const container = makeFakeContainer({ command: () => ({ exitCode: 0, stdout: 'ok' }) })
    const storage = makeFakeStorage()
    const ctx = { ...objectContext(storage.storage), container: container.container }
    const object = new CloudflareSandbox(ctx, {})

    const reply = await object.run({
      container: {
        image: 'SessionSandbox',
        instance: { vcpu: 1, memoryMib: 2048, diskMb: 8192 },
        env: {},
        internet: true,
        workspaceRoot: '/workspace',
        source: CloudflareSandboxSourceSpec.Empty(),
        idleTtlMs: 60_000
      },
      fresh: false,
      command: 'true',
      cwd: '/workspace',
      timeoutMs: 1_000,
      background: false,
      maxOutputBytes: 100
    })

    expect(reply).toMatchObject({ ok: true, value: { exitCode: 0, stdout: 'ok' } })
    expect((await object.status()).running).toBe(true)

    await object.alarm()
    await object.destroy()

    expect((await object.status()).running).toBe(false)
  })

  it('answers with a config failure when the class has no container', async () => {
    const object = new CloudflareSandbox(objectContext(makeFakeStorage().storage), {})

    const reply = await object.writeFile({
      container: {
        image: 'SessionSandbox',
        instance: { vcpu: 1, memoryMib: 2048, diskMb: 8192 },
        env: {},
        internet: true,
        workspaceRoot: '/workspace',
        source: CloudflareSandboxSourceSpec.Empty(),
        idleTtlMs: 60_000
      },
      fresh: false,
      path: '/workspace/a',
      bytes: new Uint8Array(0)
    })

    expect(reply).toMatchObject({ ok: false, kind: 'config' })
  })
})
