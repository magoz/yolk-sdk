// A fake `ctx.container` and `ctx.storage` for the Cloudflare sandbox engine. The container keeps
// an in-memory filesystem and interprets the engine's internal scripts; user commands
// (`bash -c <command>`) go to the test's `command` handler.

import {
  cloudflareSandboxScripts,
  makeCloudflareSandboxEngine,
  type CloudflareContainer,
  type CloudflareContainerStartOptions,
  type CloudflareExecOptions,
  type CloudflareExecProcess,
  type CloudflareSandboxEngineDeps,
  type CloudflareSandboxStorage
} from '../src/cloudflare/engine.ts'
import type {
  CloudflareSandboxNamespace,
  CloudflareSandboxStub
} from '../src/cloudflare/protocol.ts'

export type FakeCommandInput = {
  readonly command: string
  readonly cwd: string | undefined
  readonly env: Readonly<Record<string, string>>
  readonly stdin: string
}

export type FakeCommandResult = {
  readonly exitCode?: number
  readonly stdout?: string
  readonly stderr?: string
  /** Never exits on its own; `kill` ends it with 137. */
  readonly hang?: boolean
  /** Output streams stay open after exit (a background grandchild holds them). */
  readonly keepOpen?: boolean
}

export type FakeExec = {
  readonly argv: ReadonlyArray<string>
  readonly options: CloudflareExecOptions | undefined
  readonly pid: number
}

const encoder = new TextEncoder()

const decode = (bytes: Uint8Array) => new TextDecoder().decode(bytes)

const readAll = async (stream: ReadableStream<Uint8Array>) => {
  const reader = stream.getReader()
  const chunks: Array<Uint8Array> = []

  for (;;) {
    const next = await reader.read()

    if (next.done) break

    chunks.push(next.value)
  }

  const total = chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0)
  const bytes = new Uint8Array(total)
  let offset = 0

  for (const chunk of chunks) {
    bytes.set(chunk, offset)
    offset += chunk.byteLength
  }

  return bytes
}

export const makeFakeContainer = (
  options: {
    readonly images?: Readonly<Record<string, string>>
    readonly command?: (input: FakeCommandInput) => FakeCommandResult
    readonly gitExitCode?: number
  } = {}
) => {
  const files = new Map<string, Uint8Array>()
  const starts: Array<CloudflareContainerStartOptions> = []
  const execs: Array<FakeExec> = []
  const kills: Array<number> = []
  const inactivityTimeouts: Array<number> = []
  const untarred: Array<Uint8Array> = []
  let running = false
  let destroys = 0
  let nextPid = 100

  const command: (input: FakeCommandInput) => FakeCommandResult =
    options.command ?? (() => ({ exitCode: 0 }))

  const stdinOf = (execOptions: CloudflareExecOptions | undefined) => {
    const source = execOptions?.stdin

    if (source instanceof ReadableStream) return { writable: null, bytes: readAll(source) }

    const chunks: Array<Uint8Array> = []
    let resolveBytes: (bytes: Uint8Array) => void = () => undefined
    const bytes = new Promise<Uint8Array>(resolve => (resolveBytes = resolve))

    const writable = new WritableStream<Uint8Array>({
      write: chunk => {
        chunks.push(chunk)
      },
      close: () => {
        resolveBytes(
          chunks.reduce((all, chunk) => {
            const next = new Uint8Array(all.byteLength + chunk.byteLength)

            next.set(all)
            next.set(chunk, all.byteLength)

            return next
          }, new Uint8Array(0))
        )
      }
    })

    return { writable: source === 'pipe' ? writable : null, bytes }
  }

  // Runs one exec: returns its exit code and output once its stdin closed.
  const behave = async (
    argv: ReadonlyArray<string>,
    execOptions: CloudflareExecOptions | undefined,
    stdin: Promise<Uint8Array>
  ): Promise<FakeCommandResult & { readonly stdoutBytes?: Uint8Array }> => {
    const script = argv[2]
    const arg = (index: number) => argv[index] ?? ''

    if (argv[0] === 'true') return { exitCode: 0 }

    if (script === cloudflareSandboxScripts.mkdir) return { exitCode: 0 }

    if (script === cloudflareSandboxScripts.writeFile) {
      files.set(arg(4), await stdin)

      return { exitCode: 0 }
    }

    if (script === cloudflareSandboxScripts.readFile) {
      const bytes = files.get(arg(4))

      if (bytes === undefined) return { exitCode: 44 }

      return { exitCode: 0, stdoutBytes: bytes.subarray(0, Number(arg(5))) }
    }

    if (script === cloudflareSandboxScripts.spawn) {
      const dir = arg(4)

      const result = command({
        command: decode(files.get(`${dir}/command.sh`) ?? new Uint8Array(0)).trimEnd(),
        cwd: arg(5),
        env: execOptions?.env ?? {},
        stdin: decode(files.get(`${dir}/stdin`) ?? new Uint8Array(0))
      })

      if (result.hang !== true) {
        files.set(`${dir}/stdout`, encoder.encode(result.stdout ?? ''))
        files.set(`${dir}/stderr`, encoder.encode(result.stderr ?? ''))
        files.set(`${dir}/exit`, encoder.encode(`${result.exitCode ?? 0}\n`))
      }

      return { exitCode: 0 }
    }

    if (script === cloudflareSandboxScripts.killTree) {
      kills.push(Number(arg(4)))

      return { exitCode: 0 }
    }

    if (script === cloudflareSandboxScripts.gitClone) {
      const exitCode = options.gitExitCode ?? 0

      return exitCode === 0 ? { exitCode } : { exitCode, stderr: 'fatal: repository not found' }
    }

    if (script === cloudflareSandboxScripts.untar) {
      untarred.push(await stdin)

      return { exitCode: 0 }
    }

    if (argv[0] === 'bash' && argv[1] === '-c') {
      return command({
        command: arg(2),
        cwd: execOptions?.cwd,
        env: execOptions?.env ?? {},
        stdin: decode(await stdin)
      })
    }

    return { exitCode: 127, stderr: `unknown exec: ${argv.join(' ')}` }
  }

  const container: CloudflareContainer = {
    get running() {
      return running
    },
    images: options.images ?? { SessionSandbox: 'registry.example/session@sha256:abc' },
    start: startOptions => {
      if (running) throw new Error('already running')

      starts.push(startOptions)
      running = true
    },
    destroy: async () => {
      destroys += 1
      running = false
    },
    setInactivityTimeout: async durationMs => {
      inactivityTimeouts.push(durationMs)
    },
    exec: async (argv, execOptions) => {
      if (!running) throw new Error('container is not running')

      const pid = nextPid

      nextPid += 1
      execs.push({ argv: [...argv], options: execOptions, pid })

      const stdin = stdinOf(execOptions)

      let resolveExit: (code: number) => void = () => undefined
      const exitCode = new Promise<number>(resolve => (resolveExit = resolve))
      let stdoutController: ReadableStreamDefaultController<Uint8Array> | undefined
      let stderrController: ReadableStreamDefaultController<Uint8Array> | undefined
      let keepOpen = false

      const stdout = new ReadableStream<Uint8Array>({
        start: controller => {
          stdoutController = controller
        }
      })

      const stderr = new ReadableStream<Uint8Array>({
        start: controller => {
          stderrController = controller
        }
      })

      void behave(argv, execOptions, stdin.bytes).then(result => {
        keepOpen = result.keepOpen === true

        const out = result.stdoutBytes ?? encoder.encode(result.stdout ?? '')
        const err = encoder.encode(result.stderr ?? '')

        if (out.byteLength > 0) stdoutController?.enqueue(out)

        if (err.byteLength > 0) stderrController?.enqueue(err)

        if (result.hang === true) return

        if (!keepOpen) {
          stdoutController?.close()
          stderrController?.close()
        }

        resolveExit(result.exitCode ?? 0)
      })

      const child: CloudflareExecProcess = {
        stdin: stdin.writable,
        stdout,
        stderr,
        pid,
        exitCode,
        kill: () => {
          resolveExit(137)
        }
      }

      return child
    }
  }

  return {
    container,
    files,
    starts,
    execs,
    kills,
    inactivityTimeouts,
    untarred,
    destroys: () => destroys,
    /** The container stops on its own (idle timeout, crash): its filesystem is gone. */
    stop: () => {
      running = false
      files.clear()
    },
    userExecs: () => execs.filter(exec => exec.argv[0] === 'bash' && exec.argv[1] === '-c'),
    readText: (path: string) => {
      const bytes = files.get(path)

      return bytes === undefined ? undefined : decode(bytes)
    }
  }
}

export type FakeContainer = ReturnType<typeof makeFakeContainer>

export const makeFakeStorage = () => {
  const values = new Map<string, unknown>()
  let alarm: number | null = null

  const storage: CloudflareSandboxStorage = {
    get: async key => values.get(key),
    put: async (key, value) => {
      values.set(key, structuredClone(value))
    },
    delete: async key => values.delete(key),
    getAlarm: async () => alarm,
    setAlarm: async time => {
      alarm = time
    },
    deleteAlarm: async () => {
      alarm = null
    }
  }

  return { storage, values, alarm: () => alarm }
}

export type FakeClock = { now: number }

export const makeTestEngine = (input: {
  readonly container?: FakeContainer
  readonly storage?: ReturnType<typeof makeFakeStorage>
  readonly clock?: FakeClock
  readonly fetch?: CloudflareSandboxEngineDeps['fetch']
  readonly noContainer?: boolean
  /** Distinguishes the ids of several engines (object instances) over one container. */
  readonly idPrefix?: string
}) => {
  const container = input.container ?? makeFakeContainer()
  const storage = input.storage ?? makeFakeStorage()
  const clock = input.clock ?? { now: 1_000 }
  let ids = 0

  const engine = makeCloudflareSandboxEngine({
    container: input.noContainer === true ? undefined : container.container,
    storage: storage.storage,
    now: () => clock.now,
    randomId: () => {
      ids += 1

      return `${input.idPrefix ?? 'id'}-${ids}`
    },
    fetch:
      input.fetch ??
      (async () => {
        throw new Error('unexpected fetch')
      }),
    containerStarted: async () => undefined,
    backgroundProbeMs: 0,
    outputGraceMs: 20
  })

  return { engine, container, storage, clock }
}

/** RPC as the layer sees it: every call's input and output goes through structured clone. */
export const makeFakeNamespace = (
  engineFor: (name: string) => ReturnType<typeof makeTestEngine>['engine'],
  calls: Array<{ readonly name: string; readonly method: string; readonly input: unknown }> = []
): CloudflareSandboxNamespace => ({
  getByName: name => {
    const engine = engineFor(name)

    const record = (method: string, input: unknown) => {
      calls.push({ name, method, input: structuredClone(input) })
    }

    const stub: CloudflareSandboxStub = {
      run: async input => {
        record('run', input)

        return structuredClone(await engine.run(structuredClone(input)))
      },
      writeFile: async input => {
        record('writeFile', input)

        return structuredClone(await engine.writeFile(structuredClone(input)))
      },
      readFile: async input => {
        record('readFile', input)

        return structuredClone(await engine.readFile(structuredClone(input)))
      },
      status: async () => structuredClone(await engine.status()),
      destroy: async () => {
        record('destroy', undefined)

        await engine.destroy()
      }
    }

    return stub
  }
})
