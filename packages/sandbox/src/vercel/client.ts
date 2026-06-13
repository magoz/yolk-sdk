import { Context, Layer } from 'effect'
import { APIError, Sandbox as VercelSdkSandbox, type Command, type CommandFinished, type NetworkPolicy } from '@vercel/sandbox'
import type { SandboxInitialSource, SandboxResources, SandboxSnapshotRetention } from '../model.ts'

export type VercelSandboxRuntime = 'node22' | 'node24' | 'node26' | 'python3.13'
export type VercelNetworkPolicy = NetworkPolicy

export type VercelCommandOutput = {
  readonly stdout: string
  readonly stderr: string
}

export type VercelCommandSignal = 'SIGTERM' | 'SIGKILL'

export type VercelFinishedCommand = {
  readonly id: string
  readonly exitCode: number
  readonly output: () => Promise<VercelCommandOutput>
}

export type VercelDetachedCommand = {
  readonly id: string
  readonly exitCode: number | null
  readonly wait: () => Promise<VercelFinishedCommand>
  readonly kill: (signal: VercelCommandSignal) => Promise<void>
  readonly output: () => Promise<VercelCommandOutput>
}

export type VercelSandboxFile = {
  readonly path: string
  readonly content: string
  readonly mode?: number
}

export type VercelRunCommandInput = {
  readonly cmd: string
  readonly args?: ReadonlyArray<string>
  readonly cwd?: string
}

export type VercelSandboxCreateInput = {
  readonly name: string
  readonly source: SandboxInitialSource
  readonly ports: ReadonlyArray<number>
  readonly timeoutMs: number
  readonly resources: SandboxResources
  readonly runtime: VercelSandboxRuntime
  readonly env?: Readonly<Record<string, string>>
  readonly persistent: boolean
  readonly snapshotExpirationMs?: number
  readonly keepLastSnapshots?: SandboxSnapshotRetention
  readonly networkPolicy?: VercelNetworkPolicy
}

export type VercelSandboxGetInput = {
  readonly name: string
}

export type VercelSandboxHandle = {
  readonly name: string
  readonly writeFiles: (files: ReadonlyArray<VercelSandboxFile>) => Promise<void>
  readonly runDetachedCommand: (input: VercelRunCommandInput) => Promise<VercelDetachedCommand>
  readonly getCommand: (id: string) => Promise<VercelDetachedCommand>
  readonly extendTimeout: (durationMs: number) => Promise<void>
  readonly delete: () => Promise<void>
  readonly domain: (port: number) => string
}

export type VercelSandboxClientApi = {
  readonly get: (input: VercelSandboxGetInput) => Promise<VercelSandboxHandle | null>
  readonly create: (input: VercelSandboxCreateInput) => Promise<VercelSandboxHandle>
}

export class VercelSandboxClient extends Context.Service<VercelSandboxClient, VercelSandboxClientApi>()(
  '@yolk-sdk/sandbox/vercel/VercelSandboxClient'
) {}

export const isVercelMissingSandboxError = (error: unknown) =>
  error instanceof APIError && (error.response.status === 404 || error.response.status === 410)

const commandOutput = (command: Command | CommandFinished): Promise<VercelCommandOutput> =>
  Promise.all([command.stdout(), command.stderr()]).then(([stdout, stderr]) => ({ stdout, stderr }))

const toFinishedCommand = (command: CommandFinished): VercelFinishedCommand => ({
  id: command.cmdId,
  exitCode: command.exitCode,
  output: () => commandOutput(command)
})

const toDetachedCommand = (command: Command): VercelDetachedCommand => ({
  id: command.cmdId,
  exitCode: command.exitCode,
  wait: () => command.wait().then(toFinishedCommand),
  kill: signal => command.kill(signal),
  output: () => commandOutput(command)
})

const toHandle = (sandbox: VercelSdkSandbox): VercelSandboxHandle => ({
  name: sandbox.name,
  writeFiles: files =>
    sandbox.writeFiles(files.map(file => ({
      path: file.path,
      content: file.content,
      ...(file.mode === undefined ? {} : { mode: file.mode })
    }))),
  runDetachedCommand: input =>
    sandbox.runCommand({
      cmd: input.cmd,
      args: input.args === undefined ? [] : [...input.args],
      ...(input.cwd === undefined ? {} : { cwd: input.cwd }),
      detached: true
    }).then(toDetachedCommand),
  getCommand: id => sandbox.getCommand(id).then(toDetachedCommand),
  extendTimeout: durationMs => sandbox.extendTimeout(durationMs).then(() => undefined),
  delete: () => sandbox.delete().then(() => undefined),
  domain: port => sandbox.domain(port)
})

const envObject = (env?: Readonly<Record<string, string>>) =>
  env === undefined ? undefined : Object.fromEntries(Object.entries(env))

const retentionObject = (retention?: SandboxSnapshotRetention) =>
  retention === undefined
    ? undefined
    : {
        count: retention.count,
        ...(retention.expirationMs === undefined ? {} : { expiration: retention.expirationMs }),
        ...(retention.deleteEvicted === undefined ? {} : { deleteEvicted: retention.deleteEvicted })
      }

type AnonymousGitSource = {
  readonly type: 'git'
  readonly url: string
  readonly depth?: number
  readonly revision?: string
}

type BasicAuthGitSource = AnonymousGitSource & {
  readonly username: string
  readonly password: string
}

const commonCreateOptions = (input: VercelSandboxCreateInput) => ({
  name: input.name,
  ports: [...input.ports],
  timeout: input.timeoutMs,
  resources: { vcpus: input.resources.vcpus },
  env: envObject(input.env),
  persistent: input.persistent,
  networkPolicy: input.networkPolicy,
  snapshotExpiration: input.snapshotExpirationMs,
  keepLastSnapshots: retentionObject(input.keepLastSnapshots)
})

const gitSource = (
  source: Extract<SandboxInitialSource, { readonly _tag: 'Git' }>
): AnonymousGitSource | BasicAuthGitSource => {
  if ((source.username === undefined) !== (source.password === undefined)) {
    throw new Error('Vercel git source requires both username and password when using basic auth')
  }

  if (source.username !== undefined && source.password !== undefined) {
    return {
      type: 'git',
      url: source.url,
      username: source.username,
      password: source.password,
      ...(source.depth === undefined ? {} : { depth: source.depth }),
      ...(source.revision === undefined ? {} : { revision: source.revision })
    }
  }

  return {
    type: 'git',
    url: source.url,
    ...(source.depth === undefined ? {} : { depth: source.depth }),
    ...(source.revision === undefined ? {} : { revision: source.revision })
  }
}

const createSandbox = (input: VercelSandboxCreateInput) => {
  const common = commonCreateOptions(input)

  switch (input.source._tag) {
    case 'Empty':
      return VercelSdkSandbox.create({
        ...common,
        runtime: input.runtime
      })
    case 'Snapshot':
      return VercelSdkSandbox.create({
        ...common,
        source: { type: 'snapshot', snapshotId: input.source.snapshotId }
      })
    case 'Git':
      return VercelSdkSandbox.create({
        ...common,
        runtime: input.runtime,
        source: gitSource(input.source)
      })
    case 'Tarball':
      return VercelSdkSandbox.create({
        ...common,
        runtime: input.runtime,
        source: { type: 'tarball', url: input.source.url }
      })
  }
}

export const VercelSandboxClientLive = Layer.succeed(
  VercelSandboxClient,
  VercelSandboxClient.of({
    get: input =>
      VercelSdkSandbox.get({ name: input.name }).then(toHandle).catch(error => {
        if (isVercelMissingSandboxError(error)) {
          return null
        }

        throw error
      }),
    create: input => createSandbox(input).then(toHandle)
  })
)
