import { Buffer } from 'node:buffer'
import { spawn } from 'node:child_process'
import process from 'node:process'
import { Data, Effect } from 'effect'

type Repo = Readonly<{
  prefix: string
  remote: string
  branch: string
}>

type CommandOutput = Readonly<{
  stdout: string
  stderr: string
}>

class CommandError extends Data.TaggedError('CommandError')<{
  readonly command: string
  readonly args: ReadonlyArray<string>
  readonly details: string
  readonly exitCode?: number
  readonly signal?: NodeJS.Signals
  readonly cause?: unknown
}> {}

class DirtyWorkingTreeError extends Data.TaggedError('DirtyWorkingTreeError')<{
  readonly status: string
}> {}

type RepoUpdateError = CommandError | DirtyWorkingTreeError

const repos = [
  {
    prefix: '.repos/effect',
    remote: 'https://github.com/Effect-TS/effect-smol',
    branch: 'main'
  },
  {
    prefix: '.repos/pi',
    remote: 'git@github.com:badlogic/pi-mono.git',
    branch: 'main'
  },
  {
    prefix: '.repos/opencode',
    remote: 'git@github.com:anomalyco/opencode.git',
    branch: 'dev'
  }
] satisfies ReadonlyArray<Repo>

const commandText = (command: string, args: ReadonlyArray<string>) =>
  [command, ...args].join(' ')

const commandError = (
  command: string,
  args: ReadonlyArray<string>,
  details: string,
  props?: Readonly<{
    exitCode?: number
    signal?: NodeJS.Signals
    cause?: unknown
  }>
) =>
  new CommandError({
    command,
    args,
    details,
    exitCode: props?.exitCode,
    signal: props?.signal,
    cause: props?.cause
  })

const runCommand = (cwd: string, command: string, args: ReadonlyArray<string>) =>
  Effect.tryPromise({
    try: () =>
      new Promise<void>((resolve, reject) => {
        const child = spawn(command, args, { cwd, stdio: 'inherit' })

        child.on('error', error =>
          reject(commandError(command, args, `Failed to start ${commandText(command, args)}`, { cause: error }))
        )

        child.on('close', (exitCode, signal) => {
          if (exitCode === 0) {
            resolve()
            return
          }

          reject(
            commandError(command, args, `Failed: ${commandText(command, args)}`, {
              exitCode: exitCode ?? undefined,
              signal: signal ?? undefined
            })
          )
        })
      }),
    catch: error =>
      error instanceof CommandError
        ? error
        : commandError(command, args, `Failed: ${commandText(command, args)}`, { cause: error })
  })

const runCommandOutput = (cwd: string, command: string, args: ReadonlyArray<string>) =>
  Effect.tryPromise({
    try: () =>
      new Promise<CommandOutput>((resolve, reject) => {
        const stdout: Array<Buffer> = []
        const stderr: Array<Buffer> = []
        const child = spawn(command, args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] })

        child.stdout.on('data', (chunk: Buffer | string) => stdout.push(Buffer.from(chunk)))
        child.stderr.on('data', (chunk: Buffer | string) => stderr.push(Buffer.from(chunk)))

        child.on('error', error =>
          reject(commandError(command, args, `Failed to start ${commandText(command, args)}`, { cause: error }))
        )

        child.on('close', (exitCode, signal) => {
          const output = {
            stdout: Buffer.concat(stdout).toString('utf8'),
            stderr: Buffer.concat(stderr).toString('utf8')
          }

          if (exitCode === 0) {
            resolve(output)
            return
          }

          reject(
            commandError(command, args, `Failed: ${commandText(command, args)}\n${output.stderr}`, {
              exitCode: exitCode ?? undefined,
              signal: signal ?? undefined
            })
          )
        })
      }),
    catch: error =>
      error instanceof CommandError
        ? error
        : commandError(command, args, `Failed: ${commandText(command, args)}`, { cause: error })
  })

const getRoot = runCommandOutput(process.cwd(), 'git', ['rev-parse', '--show-toplevel']).pipe(
  Effect.map(output => output.stdout.trim())
)

const ensureClean = (root: string) =>
  runCommandOutput(root, 'git', ['status', '--porcelain']).pipe(
    Effect.flatMap(output => {
      const status = output.stdout.trimEnd()

      return status === ''
        ? Effect.void
        : Effect.fail(
            new DirtyWorkingTreeError({
              status
            })
          )
    })
  )

const updateRepo = (root: string, repo: Repo) =>
  Effect.gen(function* () {
    yield* Effect.sync(() => console.log(`\nUpdating ${repo.prefix}`))
    yield* runCommand(root, 'git', [
      'subtree',
      'pull',
      `--prefix=${repo.prefix}`,
      repo.remote,
      repo.branch,
      '--squash'
    ])
  })

const program = Effect.gen(function* () {
  const root = yield* getRoot
  yield* ensureClean(root)

  for (const repo of repos) {
    yield* updateRepo(root, repo)
  }
})

const formatError = (error: RepoUpdateError): string => {
  switch (error._tag) {
    case 'DirtyWorkingTreeError':
      return `Working tree dirty. Commit or stash first.\n${error.status}`
    case 'CommandError':
      return [
        error.details,
        `Command: ${commandText(error.command, error.args)}`,
        error.exitCode === undefined ? undefined : `Exit: ${error.exitCode}`,
        error.signal === undefined ? undefined : `Signal: ${error.signal}`
      ]
        .filter(message => message !== undefined)
        .join('\n')
  }
}

await Effect.runPromise(
  program.pipe(
    Effect.catch(error =>
      Effect.sync(() => {
        console.error(formatError(error))
        process.exitCode = 1
      })
    )
  )
)
