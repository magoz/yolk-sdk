import { Duration, Effect, Fiber, Layer } from 'effect'
import { TestClock } from 'effect/testing'
import { describe, expect, it } from '@effect/vitest'
import {
  PersistentSandboxLifecycle,
  Sandbox,
  VercelSandboxState,
  makeVercelSandboxName
} from '../src/index.ts'
import { makeInMemorySandboxStateStoreLayer } from '../src/testing/index.ts'
import {
  VercelSandboxClient,
  makeVercelSandboxLayerWithClient,
  type VercelDetachedCommand,
  type VercelFinishedCommand,
  type VercelRunCommandInput,
  type VercelSandboxFile,
  type VercelSandboxHandle
} from '../src/vercel/index.ts'

const finishedCommand = (id: string, exitCode: number): VercelFinishedCommand => ({
  id,
  exitCode,
  output: Effect.succeed({ stdout: 'done', stderr: '' })
})

const detachedCommand = (input: {
  readonly id: string
  readonly exitCode: number | null
  readonly stdout?: string
  readonly stderr?: string
}): VercelDetachedCommand => ({
  id: input.id,
  exitCode: input.exitCode,
  wait: Effect.succeed(finishedCommand(input.id, input.exitCode ?? 0)),
  kill: () => Effect.void,
  output: Effect.succeed({ stdout: input.stdout ?? 'done', stderr: input.stderr ?? '' })
})

const makeHandle = (input: {
  readonly name: string
  readonly files: Array<VercelSandboxFile>
  readonly commands: Array<VercelRunCommandInput>
  readonly deleted: Array<string>
  readonly background?: boolean
}): VercelSandboxHandle => ({
  name: input.name,
  writeFiles: files => {
    input.files.push(...files)
    return Effect.void
  },
  runDetachedCommand: command => {
    input.commands.push(command)
    return Effect.succeed(
      detachedCommand({ id: 'cmd_1', exitCode: input.background === true ? null : 0 })
    )
  },
  getCommand: id =>
    Effect.succeed(detachedCommand({ id, exitCode: input.background === true ? null : 0 })),
  extendTimeout: () => Effect.void,
  delete: Effect.sync(() => {
    input.deleted.push(input.name)
  }),
  domain: port => `https://${port}.example.test`
})

describe('vercel sandbox layer', () => {
  it.effect('creates sandbox lazily and runs wrapper command', () =>
    Effect.gen(function* () {
      const files: Array<VercelSandboxFile> = []
      const commands: Array<VercelRunCommandInput> = []
      const deleted: Array<string> = []
      const name = makeVercelSandboxName('session_1')
      const handle = makeHandle({ name, files, commands, deleted })
      const clientLayer = Layer.succeed(
        VercelSandboxClient,
        VercelSandboxClient.of({
          get: () => Effect.succeed(null),
          create: () => Effect.succeed(handle)
        })
      )
      const layer = makeVercelSandboxLayerWithClient({ sandboxSessionId: 'session_1' }).pipe(
        Layer.provide(Layer.mergeAll(clientLayer, makeInMemorySandboxStateStoreLayer()))
      )
      const result = yield* Effect.gen(function* () {
        const sandbox = yield* Sandbox
        return yield* sandbox.run({ command: 'pwd', cwd: 'packages/sandbox' })
      }).pipe(Effect.provide(layer))

      expect(result.exitCode).toBe(0)
      expect(result.workspaceReset).toBe(false)
      expect(result.previewUrls.map(url => url.port)).toEqual([3000, 5173, 4321, 8000])
      expect(files.map(file => file.path).some(path => path.endsWith('/wrapper.sh'))).toBe(true)
      expect(commands[0]?.cmd).toBe('bash')
      expect(commands[0]?.cwd).toBe('/vercel/sandbox/packages/sandbox')
    })
  )

  it.effect('reattaches named sandbox when state store is empty', () =>
    Effect.gen(function* () {
      const files: Array<VercelSandboxFile> = []
      const commands: Array<VercelRunCommandInput> = []
      const deleted: Array<string> = []
      const sandboxSessionId = 'session_reattach'
      const name = makeVercelSandboxName(sandboxSessionId)
      const handle = makeHandle({ name, files, commands, deleted })
      let createCount = 0
      const clientLayer = Layer.succeed(
        VercelSandboxClient,
        VercelSandboxClient.of({
          get: () => Effect.succeed(handle),
          create: () => {
            createCount = createCount + 1
            return Effect.succeed(handle)
          }
        })
      )
      const layer = makeVercelSandboxLayerWithClient({ sandboxSessionId }).pipe(
        Layer.provide(Layer.mergeAll(clientLayer, makeInMemorySandboxStateStoreLayer()))
      )
      const result = yield* Effect.gen(function* () {
        const sandbox = yield* Sandbox
        return yield* sandbox.run({ command: 'pwd' })
      }).pipe(Effect.provide(layer))

      expect(createCount).toBe(0)
      expect(result.workspaceReset).toBe(false)
      expect(result.state.name).toBe(name)
    })
  )

  it.effect('recreates expired disposable state', () =>
    Effect.gen(function* () {
      const files: Array<VercelSandboxFile> = []
      const commands: Array<VercelRunCommandInput> = []
      const deleted: Array<string> = []
      const sandboxSessionId = 'session_expired'
      const name = makeVercelSandboxName(sandboxSessionId)
      const handle = makeHandle({ name, files, commands, deleted })
      const clientLayer = Layer.succeed(
        VercelSandboxClient,
        VercelSandboxClient.of({
          get: input => Effect.succeed(makeHandle({ name: input.name, files, commands, deleted })),
          create: () => Effect.succeed(handle)
        })
      )
      const expiredState = VercelSandboxState.make({
        name,
        createdAtMs: 0,
        lastUsedAtMs: 0,
        expiresAtMs: 0,
        maxExpiresAtMs: 0
      })
      const stateLayer = makeInMemorySandboxStateStoreLayer([
        { sandboxSessionId, state: expiredState }
      ])
      const layer = makeVercelSandboxLayerWithClient({ sandboxSessionId }).pipe(
        Layer.provide(Layer.mergeAll(clientLayer, stateLayer))
      )
      const result = yield* Effect.gen(function* () {
        const sandbox = yield* Sandbox
        return yield* sandbox.run({ command: 'pwd' })
      }).pipe(Effect.provide(layer))

      expect(result.workspaceReset).toBe(true)
      expect(deleted).toEqual([name])
    })
  )

  it.effect('reattaches expired persistent state without deleting the workspace', () =>
    Effect.gen(function* () {
      const files: Array<VercelSandboxFile> = []
      const commands: Array<VercelRunCommandInput> = []
      const deleted: Array<string> = []
      const sandboxSessionId = 'session_persistent'
      const name = makeVercelSandboxName(sandboxSessionId)
      const handle = makeHandle({ name, files, commands, deleted })
      let createCount = 0
      const clientLayer = Layer.succeed(
        VercelSandboxClient,
        VercelSandboxClient.of({
          get: () => Effect.succeed(handle),
          create: () => {
            createCount += 1
            return Effect.succeed(handle)
          }
        })
      )
      const expiredState = VercelSandboxState.make({
        name,
        createdAtMs: 0,
        lastUsedAtMs: 0,
        expiresAtMs: 0,
        maxExpiresAtMs: Number.MAX_SAFE_INTEGER
      })
      const stateLayer = makeInMemorySandboxStateStoreLayer([
        { sandboxSessionId, state: expiredState }
      ])
      const layer = makeVercelSandboxLayerWithClient({
        sandboxSessionId,
        lifecycle: PersistentSandboxLifecycle.make({ idleTtlMs: 30 * 60_000 })
      }).pipe(Layer.provide(Layer.mergeAll(clientLayer, stateLayer)))
      const result = yield* Effect.gen(function* () {
        const sandbox = yield* Sandbox
        return yield* sandbox.run({ command: 'pwd' })
      }).pipe(Effect.provide(layer))

      expect(result.workspaceReset).toBe(false)
      expect(createCount).toBe(0)
      expect(deleted).toEqual([])
    })
  )

  it.effect('recreates persistent state when the provider sandbox is missing', () =>
    Effect.gen(function* () {
      const files: Array<VercelSandboxFile> = []
      const commands: Array<VercelRunCommandInput> = []
      const deleted: Array<string> = []
      const sandboxSessionId = 'session_persistent_missing'
      const name = makeVercelSandboxName(sandboxSessionId)
      const handle = makeHandle({ name, files, commands, deleted })
      let createCount = 0
      const clientLayer = Layer.succeed(
        VercelSandboxClient,
        VercelSandboxClient.of({
          get: () => Effect.succeed(null),
          create: () => {
            createCount += 1
            return Effect.succeed(handle)
          }
        })
      )
      const stateLayer = makeInMemorySandboxStateStoreLayer([
        {
          sandboxSessionId,
          state: VercelSandboxState.make({
            name,
            createdAtMs: 0,
            lastUsedAtMs: 0,
            expiresAtMs: 0,
            maxExpiresAtMs: Number.MAX_SAFE_INTEGER
          })
        }
      ])
      const layer = makeVercelSandboxLayerWithClient({
        sandboxSessionId,
        lifecycle: PersistentSandboxLifecycle.make({ idleTtlMs: 30 * 60_000 })
      }).pipe(Layer.provide(Layer.mergeAll(clientLayer, stateLayer)))
      const result = yield* Effect.gen(function* () {
        const sandbox = yield* Sandbox
        return yield* sandbox.run({ command: 'pwd' })
      }).pipe(Effect.provide(layer))

      expect(result.workspaceReset).toBe(true)
      expect(createCount).toBe(1)
      expect(deleted).toEqual([])
    })
  )

  it.effect('returns background id when command keeps running', () =>
    Effect.gen(function* () {
      const files: Array<VercelSandboxFile> = []
      const commands: Array<VercelRunCommandInput> = []
      const deleted: Array<string> = []
      const sandboxSessionId = 'session_background'
      const name = makeVercelSandboxName(sandboxSessionId)
      const handle = makeHandle({ name, files, commands, deleted, background: true })
      const clientLayer = Layer.succeed(
        VercelSandboxClient,
        VercelSandboxClient.of({
          get: () => Effect.succeed(null),
          create: () => Effect.succeed(handle)
        })
      )
      const layer = makeVercelSandboxLayerWithClient({ sandboxSessionId }).pipe(
        Layer.provide(Layer.mergeAll(clientLayer, makeInMemorySandboxStateStoreLayer()))
      )
      const fiber = yield* Effect.gen(function* () {
        const sandbox = yield* Sandbox
        return yield* sandbox.run({ command: 'pnpm dev', background: true })
      }).pipe(Effect.provide(layer), Effect.forkChild)
      yield* TestClock.adjust(Duration.millis(2_100))
      const result = yield* Fiber.join(fiber)

      expect(result.exitCode).toBe(null)
      expect(result.backgroundId).toBe('cmd_1')
      expect(result.timedOut).toBe(false)
    })
  )
})
