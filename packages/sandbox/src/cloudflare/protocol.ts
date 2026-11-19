import { Data } from 'effect'

// The RPC contract between the Cloudflare sandbox layer (any Worker) and the `CloudflareSandbox`
// Durable Object. Data only: every value crosses Workers RPC (structured clone keeps own fields,
// so tagged values arrive as plain objects with their `_tag`).

/** Container resources for `ctx.container.start({ instance })`. */
export type CloudflareSandboxInstance = {
  readonly vcpu: number
  readonly memoryMib: number
  readonly diskMb: number
}

/** How a fresh container's workspace starts. Snapshots are not supported on Cloudflare. */
export type CloudflareSandboxSourceSpec = Data.TaggedEnum<{
  Empty: Record<never, never>
  Git: {
    readonly url: string
    readonly auth?: { readonly username: string; readonly password: string } | undefined
    readonly depth?: number | undefined
    readonly revision?: string | undefined
  }
  Tarball: { readonly url: string }
}>

export const CloudflareSandboxSourceSpec = Data.taggedEnum<CloudflareSandboxSourceSpec>()

/**
 * Everything the object needs to start the container. It applies when the object starts a
 * container; a running container keeps the settings it started with (except `image`: a different
 * image restarts it).
 */
export type CloudflareSandboxContainerSpec = {
  /** The image's key in `ctx.container.images` (the container application's image id). */
  readonly image: string
  readonly instance: CloudflareSandboxInstance
  /** Set on the container and on every command (image `ENV` does not reach `exec`). */
  readonly env: Readonly<Record<string, string>>
  readonly internet: boolean
  readonly workspaceRoot: string
  readonly source: CloudflareSandboxSourceSpec
  readonly idleTtlMs: number
  /** Disposable lifecycle: destroy this long after start. Absent for persistent. */
  readonly maxLifetimeMs?: number
}

/** One container start. A different `bootId` means the workspace started over. */
export type CloudflareSandboxBoot = {
  readonly bootId: string
  readonly startedAtMs: number
}

export type CloudflareSandboxRequest = {
  readonly container: CloudflareSandboxContainerSpec
  /** Destroy any running container first (the stored state expired). */
  readonly fresh: boolean
}

export type CloudflareSandboxRunInput = CloudflareSandboxRequest & {
  readonly command: string
  /** Absolute directory inside the container. */
  readonly cwd: string
  readonly stdin?: string | undefined
  readonly timeoutMs: number
  readonly background: boolean
  /** Bytes kept per stream; the rest is drained and dropped. */
  readonly maxOutputBytes: number
}

export type CloudflareSandboxRunOutput = {
  readonly exitCode: number | null
  readonly stdout: string
  readonly stderr: string
  readonly timedOut: boolean
  readonly durationMs: number
  readonly backgroundId?: string
}

export type CloudflareSandboxWriteFileInput = CloudflareSandboxRequest & {
  /** Absolute path inside the container. */
  readonly path: string
  readonly bytes: Uint8Array
}

export type CloudflareSandboxReadFileInput = CloudflareSandboxRequest & {
  /** Absolute path inside the container. */
  readonly path: string
  readonly maxBytes: number
}

export type CloudflareSandboxReadFileOutput = Data.TaggedEnum<{
  Found: { readonly bytes: Uint8Array }
  NotFound: Record<never, never>
  TooLarge: Record<never, never>
}>

export const CloudflareSandboxReadFileOutput = Data.taggedEnum<CloudflareSandboxReadFileOutput>()

/** `config`: the host's setup is wrong (unknown image, no container); `provider`: it failed. */
export type CloudflareSandboxFailureKind = 'config' | 'provider'

export type CloudflareSandboxReply<A> =
  | { readonly ok: true; readonly boot: CloudflareSandboxBoot; readonly value: A }
  | {
      readonly ok: false
      readonly kind: CloudflareSandboxFailureKind
      readonly message: string
    }

export type CloudflareSandboxStatus = {
  readonly running: boolean
  readonly boot: CloudflareSandboxBoot | null
  /** When the lifecycle alarm destroys the container (idle or max lifetime), if one is running. */
  readonly deadlineMs: number | null
}

/** The RPC surface of a `CloudflareSandbox` object (`namespace.getByName(name)`). */
export interface CloudflareSandboxStub {
  run(input: CloudflareSandboxRunInput): Promise<CloudflareSandboxReply<CloudflareSandboxRunOutput>>
  writeFile(input: CloudflareSandboxWriteFileInput): Promise<CloudflareSandboxReply<null>>
  readFile(
    input: CloudflareSandboxReadFileInput
  ): Promise<CloudflareSandboxReply<CloudflareSandboxReadFileOutput>>
  status(): Promise<CloudflareSandboxStatus>
  destroy(): Promise<void>
}

/** The host's Durable Object namespace binding for the `CloudflareSandbox` class. */
export interface CloudflareSandboxNamespace {
  getByName(name: string): CloudflareSandboxStub
}
