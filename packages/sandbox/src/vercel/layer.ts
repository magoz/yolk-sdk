import { Array as Arr, Clock, Duration, Effect, Layer, Option, Ref, Semaphore } from 'effect'
import {
  absoluteSandboxCwd,
  backgroundSandboxProbeMs,
  defaultSandboxPorts,
  defaultSandboxWorkspaceRoot,
  initialSandboxState,
  normalizeWorkspaceCwd,
  sandboxCommandTimeoutMs,
  sandboxLifecycleOrDefault,
  sandboxSourceOrDefault,
  sandboxStateDecision,
  sandboxTimeoutExtendDeltaMs,
  touchSandboxState,
  validateSandboxCommand
} from '../lifecycle.ts'
import { makeVercelSandboxName } from '../name.ts'
import {
  SandboxCommandResult,
  type SandboxCommandInput,
  SandboxPreviewUrl,
  SandboxResources,
  type SandboxInitialSource,
  type SandboxLifecycle,
  type SandboxState
} from '../model.ts'
import { Sandbox } from '../service.ts'
import { SandboxStateStore } from '../state-store.ts'
import { SandboxProviderError, unknownToMessage } from '../errors.ts'
import type { SandboxError } from '../errors.ts'
import {
  VercelSandboxClient,
  VercelSandboxClientLive,
  type VercelDetachedCommand,
  type VercelNetworkPolicy,
  type VercelSandboxHandle,
  type VercelSandboxRuntime
} from './client.ts'

export type VercelSandboxLayerConfig = {
  readonly sandboxSessionId: string
  readonly lifecycle?: SandboxLifecycle
  readonly source?: SandboxInitialSource
  readonly env?: Readonly<Record<string, string>>
  readonly ports?: ReadonlyArray<number>
  readonly resources?: SandboxResources
  readonly runtime?: VercelSandboxRuntime
  readonly networkPolicy?: VercelNetworkPolicy
  readonly workspaceRoot?: string
}

type ActiveSandbox = {
  readonly handle: VercelSandboxHandle
  readonly state: SandboxState
  readonly workspaceReset: boolean
}

type CommandRunOutput = {
  readonly exitCode: number | null
  readonly stdout: string
  readonly stderr: string
  readonly timedOut: boolean
  readonly backgroundId?: string
}

const defaultVercelResources = SandboxResources.make({ vcpus: 2 })
const defaultVercelRuntime: VercelSandboxRuntime = 'node24'

const providerError = (operation: string, error: unknown) =>
  new SandboxProviderError({
    provider: 'vercel',
    operation,
    message: `Vercel Sandbox ${operation} failed: ${unknownToMessage(error)}`,
    underlying: error
  })

const tryProvider = <A>(operation: string, body: () => Promise<A>) =>
  Effect.tryPromise({
    try: body,
    catch: error => providerError(operation, error)
  })

const lifecycleTimeoutMs = (lifecycle: SandboxLifecycle) => {
  switch (lifecycle._tag) {
    case 'Disposable':
      return Math.min(lifecycle.idleTtlMs, lifecycle.maxLifetimeMs)
    case 'Persistent':
      return lifecycle.idleTtlMs
  }
}

const persistentFlag = (lifecycle: SandboxLifecycle) => lifecycle._tag === 'Persistent'

const snapshotExpirationMs = (lifecycle: SandboxLifecycle) =>
  lifecycle._tag === 'Persistent' ? lifecycle.snapshotExpirationMs : undefined

const keepLastSnapshots = (lifecycle: SandboxLifecycle) =>
  lifecycle._tag === 'Persistent' ? lifecycle.keepLastSnapshots : undefined

const previewUrls = (handle: VercelSandboxHandle, ports: ReadonlyArray<number>) =>
  Effect.forEach(ports, port =>
    Effect.try({
      try: () => handle.domain(port),
      catch: error => error
    }).pipe(
      Effect.match({
        onFailure: () => Option.none<SandboxPreviewUrl>(),
        onSuccess: url => Option.some(SandboxPreviewUrl.make({ port, url }))
      })
    )
  ).pipe(Effect.map(Arr.getSomes))

const commandOutputOrEmpty = (command: VercelDetachedCommand) =>
  tryProvider('command.output', command.output).pipe(
    Effect.catchTag('SandboxProviderError', error =>
      Effect.succeed({
        stdout: '',
        stderr: error.message
      })
    )
  )

const finishedCommandOutputOrEmpty = (command: {
  readonly output: () => Promise<{ readonly stdout: string; readonly stderr: string }>
}) =>
  tryProvider('command.output', command.output).pipe(
    Effect.catchTag('SandboxProviderError', error =>
      Effect.succeed({
        stdout: '',
        stderr: error.message
      })
    )
  )

const waitForegroundCommand = (
  command: VercelDetachedCommand,
  timeoutMs: number
): Effect.Effect<CommandRunOutput, SandboxProviderError> =>
  tryProvider('command.wait', command.wait).pipe(
    Effect.flatMap(finished =>
      finishedCommandOutputOrEmpty(finished).pipe(
        Effect.map(output => ({
          exitCode: finished.exitCode,
          stdout: output.stdout,
          stderr: output.stderr,
          timedOut: false
        }))
      )
    ),
    Effect.timeoutOrElse({
      duration: Duration.millis(timeoutMs),
      orElse: () =>
        Effect.gen(function* () {
          yield* tryProvider('command.kill', () => command.kill('SIGKILL')).pipe(
            Effect.catchTag('SandboxProviderError', () => Effect.void)
          )
          const output = yield* commandOutputOrEmpty(command)

          return {
            exitCode: null,
            stdout: output.stdout,
            stderr: output.stderr,
            timedOut: true
          }
        })
    })
  )

const probeBackgroundCommand = (
  handle: VercelSandboxHandle,
  command: VercelDetachedCommand
): Effect.Effect<CommandRunOutput, SandboxProviderError> =>
  Effect.sleep(Duration.millis(backgroundSandboxProbeMs)).pipe(
    Effect.flatMap(() => tryProvider('command.get', () => handle.getCommand(command.id))),
    Effect.flatMap(current => {
      if (current.exitCode === null) {
        return Effect.succeed({
          exitCode: null,
          stdout: '',
          stderr: '',
          timedOut: false,
          backgroundId: command.id
        })
      }

      return commandOutputOrEmpty(current).pipe(
        Effect.map(output => ({
          exitCode: current.exitCode,
          stdout: output.stdout,
          stderr: output.stderr,
          timedOut: false
        }))
      )
    })
  )

const createCommandFiles = (input: {
  readonly commandId: string
  readonly workspaceRoot: string
  readonly command: string
  readonly stdin?: string
}) => {
  const commandDir = `${input.workspaceRoot}/.yolk/commands/${input.commandId}`
  const commandPath = `${commandDir}/command.sh`
  const stdinPath = `${commandDir}/stdin.txt`
  const wrapperPath = `${commandDir}/wrapper.sh`

  return {
    wrapperPath,
    files: [
      {
        path: commandPath,
        content: `#!/usr/bin/env bash\n${input.command}\n`,
        mode: 0o755
      },
      {
        path: stdinPath,
        content: input.stdin ?? ''
      },
      {
        path: wrapperPath,
        content: `#!/usr/bin/env bash\nbash ${JSON.stringify(commandPath)} < ${JSON.stringify(stdinPath)}\n`,
        mode: 0o755
      }
    ]
  }
}

export const makeVercelSandboxLayerWithClient = (config: VercelSandboxLayerConfig) =>
  Layer.effect(
    Sandbox,
    Effect.gen(function* () {
      const store = yield* SandboxStateStore
      const client = yield* VercelSandboxClient
      const semaphore = yield* Semaphore.make(1)
      const commandCounter = yield* Ref.make(0)
      const lifecycle = sandboxLifecycleOrDefault(config.lifecycle)
      const source = sandboxSourceOrDefault(config.source)
      const ports = config.ports ?? defaultSandboxPorts
      const resources = config.resources ?? defaultVercelResources
      const runtime = config.runtime ?? defaultVercelRuntime
      const workspaceRoot = config.workspaceRoot ?? defaultSandboxWorkspaceRoot
      const name = makeVercelSandboxName(config.sandboxSessionId)

      const deleteNamedSandbox = (sandboxName: string) =>
        tryProvider('get', () => client.get({ name: sandboxName })).pipe(
          Effect.flatMap(handle =>
            handle === null ? Effect.void : tryProvider('delete', () => handle.delete())
          )
        )

      const createSandbox = (input: { readonly nowMs: number; readonly workspaceReset: boolean }) =>
        Effect.gen(function* () {
          const handle = yield* tryProvider('create', () =>
            client.create({
              name,
              source,
              ports,
              timeoutMs: lifecycleTimeoutMs(lifecycle),
              resources,
              runtime,
              env: config.env,
              persistent: persistentFlag(lifecycle),
              snapshotExpirationMs: snapshotExpirationMs(lifecycle),
              keepLastSnapshots: keepLastSnapshots(lifecycle),
              networkPolicy: config.networkPolicy
            })
          )
          const state = initialSandboxState({ name, nowMs: input.nowMs, lifecycle })
          yield* store.save({ sandboxSessionId: config.sandboxSessionId, state })

          return { handle, state, workspaceReset: input.workspaceReset }
        })

      const attachExistingSandbox = (input: {
        readonly handle: VercelSandboxHandle
        readonly nowMs: number
      }) =>
        Effect.gen(function* () {
          const state = initialSandboxState({ name, nowMs: input.nowMs, lifecycle })
          yield* store.save({ sandboxSessionId: config.sandboxSessionId, state })

          return {
            handle: input.handle,
            state,
            workspaceReset: false
          }
        })

      const attachOrCreateSandbox = (input: {
        readonly nowMs: number
        readonly workspaceReset: boolean
      }) =>
        Effect.gen(function* () {
          const handle = yield* tryProvider('get', () => client.get({ name }))

          if (handle !== null) {
            return yield* attachExistingSandbox({ handle, nowMs: input.nowMs })
          }

          return yield* createSandbox(input)
        })

      const touchExistingSandbox = (input: {
        readonly handle: VercelSandboxHandle
        readonly state: SandboxState
        readonly nowMs: number
        readonly workspaceReset: boolean
      }) =>
        Effect.gen(function* () {
          const touched = touchSandboxState({
            state: input.state,
            nowMs: input.nowMs,
            lifecycle
          })
          const deltaMs = sandboxTimeoutExtendDeltaMs({ before: input.state, after: touched })

          if (deltaMs > 0) {
            yield* tryProvider('extendTimeout', () => input.handle.extendTimeout(deltaMs))
          }

          yield* store.save({ sandboxSessionId: config.sandboxSessionId, state: touched })

          return {
            handle: input.handle,
            state: touched,
            workspaceReset: input.workspaceReset
          }
        })

      const ensureSandbox = (nowMs: number): Effect.Effect<ActiveSandbox, SandboxError> =>
        Effect.gen(function* () {
          const loaded = yield* store.load(config.sandboxSessionId)
          const decision = sandboxStateDecision({ state: loaded, name, nowMs })

          if (decision._tag === 'Create') {
            if (Option.isNone(loaded)) {
              return yield* attachOrCreateSandbox({
                nowMs,
                workspaceReset: decision.workspaceReset
              })
            }

            if (Option.isSome(loaded) && decision.workspaceReset) {
              yield* deleteNamedSandbox(loaded.value.name)
              yield* store.clear(config.sandboxSessionId)
            }

            return yield* createSandbox({ nowMs, workspaceReset: decision.workspaceReset })
          }

          const handle = yield* tryProvider('get', () => client.get({ name }))

          if (handle === null) {
            yield* store.clear(config.sandboxSessionId)
            return yield* createSandbox({ nowMs, workspaceReset: true })
          }

          return yield* touchExistingSandbox({
            handle,
            state: decision.state,
            nowMs,
            workspaceReset: false
          })
        })

      const nextCommandId = Ref.updateAndGet(commandCounter, value => value + 1).pipe(
        Effect.map(value => `command-${value}`)
      )

      const runUnlocked = (input: SandboxCommandInput) =>
        Effect.gen(function* () {
          yield* validateSandboxCommand(input.command)
          const normalizedCwd = yield* normalizeWorkspaceCwd(input.cwd)
          const timeoutMs = sandboxCommandTimeoutMs(input.timeoutMs)
          const nowMs = yield* Clock.currentTimeMillis
          const active = yield* ensureSandbox(nowMs)
          const id = yield* nextCommandId
          const commandFiles = createCommandFiles({
            commandId: id,
            workspaceRoot,
            command: input.command,
            stdin: input.stdin
          })

          yield* tryProvider('writeFiles', () => active.handle.writeFiles(commandFiles.files))

          const startedAtMs = yield* Clock.currentTimeMillis
          const command = yield* tryProvider('runCommand', () =>
            active.handle.runDetachedCommand({
              cmd: 'bash',
              args: [commandFiles.wrapperPath],
              cwd: absoluteSandboxCwd(workspaceRoot, normalizedCwd)
            })
          )
          const output = yield* input.background === true
            ? probeBackgroundCommand(active.handle, command)
            : waitForegroundCommand(command, timeoutMs)
          const endedAtMs = yield* Clock.currentTimeMillis
          const urls = yield* previewUrls(active.handle, ports)

          return SandboxCommandResult.make({
            exitCode: output.exitCode,
            stdout: output.stdout,
            stderr: output.stderr,
            durationMs: Math.max(0, endedAtMs - startedAtMs),
            timedOut: output.timedOut,
            workspaceReset: active.workspaceReset,
            ...(output.backgroundId === undefined ? {} : { backgroundId: output.backgroundId }),
            previewUrls: urls,
            state: active.state
          })
        })

      return Sandbox.of({
        run: input => semaphore.withPermits(1)(runUnlocked(input)),
        currentState: store.load(config.sandboxSessionId),
        delete: Effect.gen(function* () {
          const loaded = yield* store.load(config.sandboxSessionId)
          if (Option.isSome(loaded)) {
            yield* deleteNamedSandbox(loaded.value.name)
          }
          yield* store.clear(config.sandboxSessionId)
        })
      })
    })
  )

export const makeVercelSandboxLayer = (config: VercelSandboxLayerConfig) =>
  makeVercelSandboxLayerWithClient(config).pipe(Layer.provide(VercelSandboxClientLive))
