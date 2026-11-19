import { Clock, Effect, Layer, Match, Option, Predicate, Semaphore } from 'effect'
import {
  absoluteSandboxCwd,
  absoluteSandboxPath,
  normalizeWorkspaceCwd,
  normalizeWorkspacePath,
  sandboxCommandTimeoutMs,
  sandboxLifecycleOrDefault,
  sandboxStateDecision,
  validateSandboxCommand
} from '../lifecycle.ts'
import { makeSandboxName } from '../name.ts'
import {
  CloudflareSandboxState,
  SandboxCommandResult,
  SandboxResources,
  type EmptySandboxInitialSource,
  type GitSandboxInitialSource,
  type SandboxCommandInput,
  type SandboxLifecycle,
  type TarballSandboxInitialSource
} from '../model.ts'
import { Sandbox, type SandboxReadFileInput, type SandboxWriteFileInput } from '../service.ts'
import { SandboxStateStore } from '../state-store.ts'
import { SandboxConfigError, SandboxInputError, SandboxProviderError } from '../errors.ts'
import type { SandboxError } from '../errors.ts'
import {
  CloudflareSandboxSourceSpec,
  type CloudflareSandboxBoot,
  type CloudflareSandboxContainerSpec,
  type CloudflareSandboxNamespace,
  type CloudflareSandboxReply,
  type CloudflareSandboxStub
} from './protocol.ts'

/** Cloudflare has no sandbox snapshots in this adapter: empty, Git, or tarball. */
export type CloudflareSandboxInitialSource =
  | EmptySandboxInitialSource
  | GitSandboxInitialSource
  | TarballSandboxInitialSource

export type CloudflareSandboxLayerConfig = {
  readonly sandboxSessionId: string
  /** The host's `CloudflareSandbox` Durable Object namespace binding (read on each call). */
  readonly namespace: () => CloudflareSandboxNamespace
  /** The image's key in `ctx.container.images` (its container application image id). */
  readonly image: string
  /** vCPUs; memory follows at 2 GiB per vCPU, like Vercel Sandbox. Default 2 vCPUs. */
  readonly resources?: SandboxResources
  /** Container disk in MB. Default 16384. */
  readonly diskMb?: number
  readonly lifecycle?: SandboxLifecycle
  readonly source?: CloudflareSandboxInitialSource
  /**
   * Environment for the container and every command. Image `ENV` does not reach commands on
   * Cloudflare (they run through `exec`), so set command environment here.
   */
  readonly env?: Readonly<Record<string, string>>
  /** Outbound internet access (`enableInternet`). Default true. */
  readonly internet?: boolean
  /** Absolute workspace directory in the container. Default `/workspace`. */
  readonly workspaceRoot?: string
  /** Bytes of stdout and of stderr kept per command. Default 1 MiB. */
  readonly maxOutputBytes?: number
}

type CommandResultFields = {
  readonly exitCode: number | null
  readonly stdout: string
  readonly stderr: string
  readonly durationMs: number
  readonly timedOut: boolean
  readonly workspaceReset: boolean
  backgroundId?: string
}

export const defaultCloudflareSandboxWorkspaceRoot = '/workspace'

export const defaultCloudflareSandboxDiskMb = 16_384

export const defaultCloudflareSandboxMaxOutputBytes = 1_048_576

const defaultCloudflareResources = SandboxResources.make({ vcpus: 2 })

const memoryMibPerVcpu = 2_048

const providerError = (operation: string, message: string, underlying?: unknown) =>
  new SandboxProviderError({
    provider: 'cloudflare',
    operation,
    message: `Cloudflare Sandbox ${operation} failed: ${message}`,
    underlying
  })

const sourceSpec = (
  source: CloudflareSandboxInitialSource | undefined
): CloudflareSandboxSourceSpec =>
  source === undefined
    ? CloudflareSandboxSourceSpec.Empty()
    : Match.value(source).pipe(
        Match.withReturnType<CloudflareSandboxSourceSpec>(),
        Match.tagsExhaustive({
          Empty: () => CloudflareSandboxSourceSpec.Empty(),
          Git: git =>
            CloudflareSandboxSourceSpec.Git({
              url: git.url,
              auth:
                git.auth === undefined
                  ? undefined
                  : { username: git.auth.username, password: git.auth.password },
              depth: git.depth,
              revision: git.revision
            }),
          Tarball: tarball => CloudflareSandboxSourceSpec.Tarball({ url: tarball.url })
        })
      )

const lifecycleSpec = (lifecycle: SandboxLifecycle) =>
  Match.value(lifecycle).pipe(
    Match.tagsExhaustive({
      Disposable: disposable => ({
        idleTtlMs: disposable.idleTtlMs,
        maxLifetimeMs: disposable.maxLifetimeMs
      }),
      Persistent: persistent => ({ idleTtlMs: persistent.idleTtlMs })
    })
  )

/**
 * `Sandbox` on Cloudflare Containers: commands and files go over RPC to the `CloudflareSandbox`
 * Durable Object named after `sandboxSessionId`. The host provides `SandboxStateStore`; the stored
 * `CloudflareSandboxState` holds the container's boot id, and a different boot id on a later call
 * (the container stopped, idled out or was destroyed) reports `workspaceReset: true`.
 */
export const makeCloudflareSandboxLayer = (config: CloudflareSandboxLayerConfig) =>
  Layer.effect(
    Sandbox,
    Effect.gen(function* () {
      const store = yield* SandboxStateStore
      const semaphore = yield* Semaphore.make(1)
      const lifecycle = sandboxLifecycleOrDefault(config.lifecycle)
      const resources = config.resources ?? defaultCloudflareResources
      const workspaceRoot = config.workspaceRoot ?? defaultCloudflareSandboxWorkspaceRoot
      const maxOutputBytes = config.maxOutputBytes ?? defaultCloudflareSandboxMaxOutputBytes
      const name = makeSandboxName(config.sandboxSessionId)

      const container: CloudflareSandboxContainerSpec = {
        image: config.image,
        instance: {
          vcpu: resources.vcpus,
          memoryMib: Math.round(resources.vcpus * memoryMibPerVcpu),
          diskMb: config.diskMb ?? defaultCloudflareSandboxDiskMb
        },
        env: { ...config.env },
        internet: config.internet ?? true,
        workspaceRoot,
        source: sourceSpec(config.source),
        ...lifecycleSpec(lifecycle)
      }

      const stub = (operation: string) =>
        Effect.try({
          try: () => config.namespace().getByName(name),
          catch: error =>
            providerError(operation, error instanceof Error ? error.message : String(error), error)
        })

      const call = <A>(
        operation: string,
        body: (stub: CloudflareSandboxStub) => Promise<A>
      ): Effect.Effect<A, SandboxProviderError> =>
        stub(operation).pipe(
          Effect.flatMap(target =>
            Effect.tryPromise({
              try: () => body(target),
              catch: error =>
                providerError(
                  operation,
                  error instanceof Error ? error.message : String(error),
                  error
                )
            })
          )
        )

      const replyValue = <A>(
        operation: string,
        reply: CloudflareSandboxReply<A>
      ): Effect.Effect<
        { readonly boot: CloudflareSandboxBoot; readonly value: A },
        SandboxConfigError | SandboxProviderError
      > => {
        if (reply.ok) return Effect.succeed(reply)

        return reply.kind === 'config'
          ? Effect.fail(
              new SandboxConfigError({
                message: `Cloudflare Sandbox ${operation}: ${reply.message}`,
                cause: 'cloudflare_config'
              })
            )
          : Effect.fail(providerError(operation, reply.message))
      }

      /**
       * Calls the object with the state decision, then stores the state of the container that
       * answered: same boot → touched; a new boot → fresh state (`workspaceReset` when a stored
       * state pointed at another boot).
       */
      const withSandbox = <A>(
        operation: string,
        body: (stub: CloudflareSandboxStub, fresh: boolean) => Promise<CloudflareSandboxReply<A>>
      ): Effect.Effect<
        {
          readonly value: A
          readonly state: CloudflareSandboxState
          readonly workspaceReset: boolean
        },
        SandboxError
      > =>
        Effect.gen(function* () {
          const nowMs = yield* Clock.currentTimeMillis
          const loaded = yield* store.load(config.sandboxSessionId)

          const decision = sandboxStateDecision({
            state: loaded,
            name,
            nowMs,
            lifecycle,
            provider: 'Cloudflare'
          })

          const fresh = Predicate.isTagged(decision, 'Create') && decision.workspaceReset

          const previous = Option.filter(loaded, (state): state is CloudflareSandboxState =>
            Predicate.isTagged(state, 'Cloudflare')
          )

          const reply = yield* call(operation, target => body(target, fresh))
          const ok = yield* replyValue(operation, reply)
          const after = yield* Clock.currentTimeMillis

          const sameBoot =
            !fresh && Option.isSome(previous) && previous.value.bootId === ok.boot.bootId

          const maxExpiresAtMs =
            container.maxLifetimeMs === undefined
              ? Number.MAX_SAFE_INTEGER
              : ok.boot.startedAtMs + container.maxLifetimeMs

          const state = CloudflareSandboxState.make({
            name,
            bootId: ok.boot.bootId,
            createdAtMs: ok.boot.startedAtMs,
            lastUsedAtMs: after,
            expiresAtMs: Math.min(after + container.idleTtlMs, maxExpiresAtMs),
            maxExpiresAtMs
          })

          yield* store.save({ sandboxSessionId: config.sandboxSessionId, state })

          return {
            value: ok.value,
            state,
            workspaceReset: Option.isSome(loaded) && !sameBoot
          }
        })

      const runUnlocked = (input: SandboxCommandInput) =>
        Effect.gen(function* () {
          yield* validateSandboxCommand(input.command)
          const cwd = yield* normalizeWorkspaceCwd(input.cwd)
          const timeoutMs = sandboxCommandTimeoutMs(input.timeoutMs)

          const result = yield* withSandbox('run', (target, fresh) =>
            target.run({
              container,
              fresh,
              command: input.command,
              cwd: absoluteSandboxCwd(workspaceRoot, cwd),
              stdin: input.stdin,
              timeoutMs,
              background: input.background === true,
              maxOutputBytes
            })
          )

          const output = result.value

          const fields: CommandResultFields = {
            exitCode: output.exitCode,
            stdout: output.stdout,
            stderr: output.stderr,
            durationMs: output.durationMs,
            timedOut: output.timedOut,
            workspaceReset: result.workspaceReset
          }

          if (output.backgroundId !== undefined) fields.backgroundId = output.backgroundId

          // Cloudflare containers have no public preview URLs.
          return SandboxCommandResult.make({ ...fields, previewUrls: [], state: result.state })
        })

      const writeFileUnlocked = (input: SandboxWriteFileInput) =>
        Effect.gen(function* () {
          const path = yield* normalizeWorkspacePath(input.path)

          yield* withSandbox('writeFile', (target, fresh) =>
            target.writeFile({
              container,
              fresh,
              path: absoluteSandboxPath(workspaceRoot, path),
              bytes: input.bytes
            })
          )

          return path
        })

      const readFileUnlocked = (input: SandboxReadFileInput) =>
        Effect.gen(function* () {
          const path = yield* normalizeWorkspacePath(input.path)

          const result = yield* withSandbox('readFile', (target, fresh) =>
            target.readFile({
              container,
              fresh,
              path: absoluteSandboxPath(workspaceRoot, path),
              maxBytes: input.maxBytes
            })
          )

          return yield* Match.value(result.value).pipe(
            Match.withReturnType<Effect.Effect<Uint8Array, SandboxInputError>>(),
            Match.tagsExhaustive({
              Found: found => Effect.succeed(found.bytes),
              NotFound: () =>
                Effect.fail(
                  new SandboxInputError({
                    cause: 'file_not_found',
                    message: `${path} does not exist`
                  })
                ),
              TooLarge: () =>
                Effect.fail(
                  new SandboxInputError({
                    cause: 'file_too_large',
                    message: `${path} is larger than ${input.maxBytes} bytes`
                  })
                )
            })
          )
        })

      return Sandbox.of({
        run: input => semaphore.withPermits(1)(runUnlocked(input)),
        writeFile: input => semaphore.withPermits(1)(writeFileUnlocked(input)),
        readFile: input => semaphore.withPermits(1)(readFileUnlocked(input)),
        currentState: store.load(config.sandboxSessionId),
        // The object is named after the session, so destroy it even without stored state.
        delete: Effect.gen(function* () {
          yield* call('delete', target => target.destroy())
          yield* store.clear(config.sandboxSessionId)
        })
      })
    })
  )
