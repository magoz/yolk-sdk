import { Data, Match, Predicate } from 'effect'
import * as Schema from 'effect/Schema'
import { backgroundSandboxProbeMs, maxSandboxCommandTimeoutMs } from '../lifecycle.ts'
import {
  CloudflareSandboxReadFileOutput,
  type CloudflareSandboxBoot,
  type CloudflareSandboxContainerSpec,
  type CloudflareSandboxFailureKind,
  type CloudflareSandboxReadFileInput,
  type CloudflareSandboxReply,
  type CloudflareSandboxRequest,
  type CloudflareSandboxRunInput,
  type CloudflareSandboxRunOutput,
  type CloudflareSandboxSourceSpec,
  type CloudflareSandboxStatus,
  type CloudflareSandboxWriteFileInput
} from './protocol.ts'

// The part of workerd's `ctx.container` (`Container` in @cloudflare/workers-types) the engine uses.

export type CloudflareExecOptions = {
  readonly cwd?: string
  readonly env?: Record<string, string>
  readonly stdin?: ReadableStream<Uint8Array> | 'pipe'
  readonly stdout?: 'pipe' | 'ignore'
  readonly stderr?: 'pipe' | 'ignore'
}

export type CloudflareExecProcess = {
  readonly stdin: WritableStream<Uint8Array> | null
  readonly stdout: ReadableStream<Uint8Array> | null
  readonly stderr: ReadableStream<Uint8Array> | null
  readonly pid: number
  readonly exitCode: Promise<number>
  kill(signal?: number): void
}

export type CloudflareContainerStartOptions = {
  readonly image: string
  readonly enableInternet: boolean
  readonly env: Record<string, string>
  readonly instance: { readonly vcpu: number; readonly memoryMib: number; readonly diskMb: number }
}

export type CloudflareContainer = {
  readonly running: boolean
  /** Digest-pinned image references keyed by the container application's image id. */
  readonly images: Readonly<Record<string, string>>
  start(options: CloudflareContainerStartOptions): void
  destroy(): Promise<void>
  setInactivityTimeout(durationMs: number): Promise<void>
  exec(cmd: Array<string>, options?: CloudflareExecOptions): Promise<CloudflareExecProcess>
}

/** The part of `ctx.storage` the engine uses (the key-value API and the alarm). */
export type CloudflareSandboxStorage = {
  get(key: string): Promise<unknown>
  put(key: string, value: unknown): Promise<void>
  delete(key: string): Promise<boolean>
  getAlarm(): Promise<number | null>
  setAlarm(scheduledTimeMs: number): Promise<void>
  deleteAlarm(): Promise<void>
}

export type CloudflareSandboxEngineDeps = {
  /** `ctx.container`; undefined when the class has no container application bound. */
  readonly container: CloudflareContainer | undefined
  readonly storage: CloudflareSandboxStorage
  readonly now: () => number
  readonly randomId: () => string
  readonly fetch: (url: string) => Promise<Response>
  /** Runs after every container start, before the workspace is prepared. */
  readonly containerStarted: () => Promise<void>
  readonly backgroundProbeMs?: number
  /** How long output streams may stay open after the process ended (or was killed). */
  readonly outputGraceMs?: number
}

const isFunctionProperty = (value: unknown, key: string) =>
  Predicate.hasProperty(value, key) && Predicate.isFunction(value[key])

export const isCloudflareContainer = (value: unknown): value is CloudflareContainer =>
  Predicate.hasProperty(value, 'images') &&
  Predicate.hasProperty(value, 'running') &&
  ['start', 'destroy', 'exec', 'setInactivityTimeout'].every(key => isFunctionProperty(value, key))

export const isCloudflareSandboxStorage = (value: unknown): value is CloudflareSandboxStorage =>
  ['get', 'put', 'delete', 'getAlarm', 'setAlarm', 'deleteAlarm'].every(key =>
    isFunctionProperty(value, key)
  )

/** Where the engine keeps its own files in the container, outside the workspace. */
export const cloudflareSandboxStateDir = '/tmp/yolk-sandbox'

const bootFile = `${cloudflareSandboxStateDir}/boot-id`

const notFoundExitCode = 44

/**
 * The shell scripts the engine runs (`[shell, '-c', script, name, ...args]`). User commands run as
 * `bash -c <command>`; internal steps use `sh` where they can.
 */
export const cloudflareSandboxScripts = {
  mkdir: 'mkdir -p -- "$@"',
  writeFile: 'mkdir -p -- "$(dirname -- "$1")" && cat > "$1"',
  readFile: `[ -f "$1" ] || exit ${notFoundExitCode}; exec head -c "$2" -- "$1"`,
  // Detached from the exec: the subshell outlives it, ignores SIGHUP, and writes its exit code
  // last (atomically), so a probe that finds `exit` also finds the complete output.
  spawn: [
    '(',
    "  trap '' HUP",
    '  { cd "$2" && bash "$1/command.sh" < "$1/stdin"; } > "$1/stdout" 2> "$1/stderr"',
    '  echo $? > "$1/exit.tmp" && mv "$1/exit.tmp" "$1/exit"',
    ') < /dev/null > /dev/null 2>&1 &'
  ].join('\n'),
  // SIGKILL a process and all its descendants (collected from /proc before killing any).
  killTree: [
    'target=$1',
    'declare -A kids',
    'for f in /proc/[0-9]*/stat; do',
    '  read -r line < "$f" 2> /dev/null || continue',
    '  rest=${line##*) }',
    '  read -r _ ppid _ <<< "$rest"',
    '  pid=${f#/proc/}',
    '  kids[$ppid]+=" ${pid%/stat}"',
    'done',
    'all=()',
    'todo=("$target")',
    'while ((${#todo[@]})); do',
    '  current=${todo[0]}',
    '  todo=("${todo[@]:1}")',
    '  all+=("$current")',
    '  for child in ${kids[$current]}; do todo+=("$child"); done',
    'done',
    'kill -9 "${all[@]}" 2> /dev/null',
    'true'
  ].join('\n'),
  // Credentials come from this exec's environment through a one-off credential helper: they are
  // never part of the URL, the command line, or the clone's `.git/config`.
  gitClone: [
    'set -e',
    'cd "$1"',
    'auth=()',
    'if [ -n "${YOLK_GIT_USERNAME-}" ]; then',
    `  auth=(-c credential.helper= -c 'credential.helper=!f() { echo "username=\${YOLK_GIT_USERNAME}"; echo "password=\${YOLK_GIT_PASSWORD}"; }; f')`,
    'fi',
    'depth=()',
    'if [ -n "${YOLK_GIT_DEPTH-}" ]; then depth=(--depth "$YOLK_GIT_DEPTH"); fi',
    'if [ -n "${YOLK_GIT_REVISION-}" ]; then',
    '  git init -q .',
    '  git remote add origin "$YOLK_GIT_URL"',
    '  git "${auth[@]}" fetch -q "${depth[@]}" origin "$YOLK_GIT_REVISION"',
    '  git checkout -q FETCH_HEAD',
    'else',
    '  git "${auth[@]}" clone -q "${depth[@]}" -- "$YOLK_GIT_URL" .',
    'fi'
  ].join('\n'),
  untar: 'tar -xzf - -C "$1"'
}

class EngineFailure extends Data.TaggedError('CloudflareSandboxEngineFailure')<{
  readonly kind: CloudflareSandboxFailureKind
  readonly message: string
}> {}

const BootRecord = Schema.Struct({
  bootId: Schema.String,
  startedAtMs: Schema.Number,
  image: Schema.String,
  lastActivityAtMs: Schema.Number,
  idleTtlMs: Schema.Number,
  maxDeadlineMs: Schema.NullOr(Schema.Number)
})

type BootRecord = typeof BootRecord.Type

const isBootRecord = Schema.is(BootRecord)

const bootRecordKey = 'yolk-sandbox:boot'

const deadlineOf = (record: BootRecord) =>
  Math.min(
    record.lastActivityAtMs + record.idleTtlMs,
    record.maxDeadlineMs ?? Number.MAX_SAFE_INTEGER
  )

const bootOf = (record: BootRecord): CloudflareSandboxBoot => ({
  bootId: record.bootId,
  startedAtMs: record.startedAtMs
})

const errorMessage = (error: unknown) =>
  error instanceof Error ? error.message : Predicate.isString(error) ? error : String(error)

const delay = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms))

const encoder = new TextEncoder()

const decode = (bytes: Uint8Array) => new TextDecoder().decode(bytes)

type Collected = {
  readonly bytes: Uint8Array
  /** Every byte the stream produced, kept or not. */
  readonly total: number
}

// Reads a stream to its end, keeping the first `maxBytes` and draining the rest so the process
// never blocks on a full pipe.
const collectStream = (stream: ReadableStream<Uint8Array> | null, maxBytes: number) => {
  const chunks: Array<Uint8Array> = []
  let kept = 0
  let total = 0
  let finished = stream === null
  const reader = stream?.getReader()

  const done = (async () => {
    if (reader === undefined) return

    try {
      for (;;) {
        const next = await reader.read()

        if (next.done) break

        total += next.value.byteLength

        if (kept < maxBytes) {
          const slice = next.value.subarray(0, maxBytes - kept)

          chunks.push(slice)
          kept += slice.byteLength
        }
      }
    } catch {
      // A cancelled or broken stream ends the read; what was read so far is the output.
    } finally {
      finished = true
    }
  })()

  const snapshot = (): Collected => {
    const bytes = new Uint8Array(kept)
    let offset = 0

    for (const chunk of chunks) {
      bytes.set(chunk, offset)
      offset += chunk.byteLength
    }

    return { bytes, total }
  }

  // Waits up to `graceMs` for the stream to end, then stops reading it.
  const settle = async (graceMs: number) => {
    await Promise.race([done, delay(graceMs)])

    if (!finished && reader !== undefined) {
      await reader.cancel().catch(() => undefined)
      await done
    }

    return snapshot()
  }

  return { settle }
}

const feedStdin = async (stdin: WritableStream<Uint8Array> | null, bytes: Uint8Array) => {
  if (stdin === null) return

  const writer = stdin.getWriter()

  try {
    if (bytes.byteLength > 0) await writer.write(bytes)

    await writer.close()
  } catch {
    // The process exited (or closed stdin) before reading all of it; that is its choice.
  }
}

const outputText = (collected: Collected) => {
  const text = decode(collected.bytes)
  const dropped = collected.total - collected.bytes.byteLength

  return dropped > 0 ? `${text}\n[output truncated: ${dropped} more bytes]` : text
}

type ExecRequest = {
  readonly argv: ReadonlyArray<string>
  readonly env: Readonly<Record<string, string>>
  readonly cwd?: string
  readonly stdin?: Uint8Array | ReadableStream<Uint8Array>
  readonly maxBytes: number
  readonly timeoutMs: number
}

type ExecResult = {
  readonly exitCode: number | null
  readonly stdout: Collected
  readonly stderr: Collected
  readonly timedOut: boolean
  readonly durationMs: number
}

type MutableExecOptions = {
  cwd?: string
  env: Record<string, string>
  stdin: ReadableStream<Uint8Array> | 'pipe'
  stdout: 'pipe'
  stderr: 'pipe'
}

/**
 * The sandbox engine behind the `CloudflareSandbox` Durable Object: one container per object,
 * started on demand with the caller's spec, its lifecycle enforced with the object's alarm.
 */
export const makeCloudflareSandboxEngine = (deps: CloudflareSandboxEngineDeps) => {
  const backgroundProbeMs = deps.backgroundProbeMs ?? backgroundSandboxProbeMs
  const outputGraceMs = deps.outputGraceMs ?? 1_000
  // Boot ids whose marker file this instance has seen in the running container.
  const verified = new Set<string>()
  let inflight = 0
  let lock: Promise<void> = Promise.resolve()

  // Container starts, stops and the alarm run one at a time; commands run concurrently.
  const serialized = <A>(body: () => Promise<A>): Promise<A> => {
    const run = lock.then(body)

    lock = run.then(
      () => undefined,
      () => undefined
    )

    return run
  }

  const requireContainer = () => {
    if (deps.container === undefined) {
      throw new EngineFailure({
        kind: 'config',
        message:
          'This Durable Object has no container: bind its class to a container application (durable_object scheduling)'
      })
    }

    return deps.container
  }

  const loadRecord = async () => {
    const value = await deps.storage.get(bootRecordKey)

    return isBootRecord(value) ? value : undefined
  }

  const execCollect = async (request: ExecRequest): Promise<ExecResult> => {
    const container = requireContainer()
    const stdin = request.stdin

    const options: MutableExecOptions = {
      env: { ...request.env },
      stdin: stdin instanceof ReadableStream ? stdin : 'pipe',
      stdout: 'pipe',
      stderr: 'pipe'
    }

    if (request.cwd !== undefined) options.cwd = request.cwd

    const startedAtMs = deps.now()

    const child = await container.exec([...request.argv], options).catch(error => {
      throw new EngineFailure({
        kind: 'provider',
        message: `Container exec failed: ${errorMessage(error)}`
      })
    })

    const stdout = collectStream(child.stdout, request.maxBytes)
    const stderr = collectStream(child.stderr, request.maxBytes)

    const fed =
      stdin instanceof ReadableStream
        ? Promise.resolve()
        : feedStdin(child.stdin, stdin ?? new Uint8Array(0))

    let timer: ReturnType<typeof setTimeout> | undefined

    const expired = new Promise<'timeout'>(resolve => {
      timer = setTimeout(() => resolve('timeout'), request.timeoutMs)
    })

    const outcome = await Promise.race([child.exitCode, expired])
      .catch(error => {
        throw new EngineFailure({
          kind: 'provider',
          message: `Container process failed: ${errorMessage(error)}`
        })
      })
      .finally(() => clearTimeout(timer))

    const timedOut = !Predicate.isNumber(outcome)

    if (timedOut) {
      try {
        child.kill(9)
      } catch {
        // Already gone.
      }

      await killTree(request.env, child.pid)
    }

    const durationMs = Math.max(0, deps.now() - startedAtMs)

    const [out, err] = await Promise.all([
      stdout.settle(outputGraceMs),
      stderr.settle(outputGraceMs)
    ])

    await Promise.race([fed, delay(outputGraceMs)])

    return {
      exitCode: Predicate.isNumber(outcome) ? outcome : null,
      stdout: out,
      stderr: err,
      timedOut,
      durationMs
    }
  }

  // Best effort: a timed-out command's children would otherwise keep running (and its pipes open).
  const killTree = async (env: Readonly<Record<string, string>>, pid: number) => {
    try {
      const container = requireContainer()

      const killer = await container.exec(
        ['bash', '-c', cloudflareSandboxScripts.killTree, 'bash', String(pid)],
        { env: { ...env }, stdout: 'ignore', stderr: 'ignore' }
      )

      await Promise.race([killer.exitCode, delay(outputGraceMs)])
    } catch {
      // The process tree may already be gone, or the image has no bash; the SIGKILL stands.
    }
  }

  const internalExec = async (
    spec: CloudflareSandboxContainerSpec,
    request: Omit<ExecRequest, 'env' | 'maxBytes' | 'timeoutMs'> & {
      readonly env?: Readonly<Record<string, string>>
      readonly maxBytes?: number
      readonly timeoutMs?: number
    }
  ) =>
    execCollect({
      ...request,
      env: { ...spec.env, ...request.env },
      maxBytes: request.maxBytes ?? 64 * 1024,
      timeoutMs: request.timeoutMs ?? maxSandboxCommandTimeoutMs
    })

  const failIfNonZero = (step: string, result: ExecResult) => {
    if (result.exitCode === 0) return

    const detail = decode(result.stderr.bytes).trim().slice(-2_000)

    throw new EngineFailure({
      kind: 'provider',
      message: result.timedOut
        ? `${step} timed out`
        : `${step} failed (exit ${result.exitCode ?? 'unknown'})${detail.length > 0 ? `: ${detail}` : ''}`
    })
  }

  const writeBytes = async (
    spec: CloudflareSandboxContainerSpec,
    path: string,
    bytes: Uint8Array
  ) =>
    failIfNonZero(
      'Writing a file',
      await internalExec(spec, {
        argv: ['sh', '-c', cloudflareSandboxScripts.writeFile, 'sh', path],
        stdin: bytes
      })
    )

  // At most `limit` bytes of a file (`undefined` when it does not exist).
  const readBytes = async (spec: CloudflareSandboxContainerSpec, path: string, limit: number) => {
    const result = await internalExec(spec, {
      argv: ['sh', '-c', cloudflareSandboxScripts.readFile, 'sh', path, String(limit)],
      maxBytes: limit
    })

    if (result.exitCode === notFoundExitCode) return undefined

    failIfNonZero('Reading a file', result)

    return result.stdout
  }

  const cloneGitSource = async (
    spec: CloudflareSandboxContainerSpec,
    source: Data.TaggedEnum.Value<CloudflareSandboxSourceSpec, 'Git'>
  ) => {
    const env = new Map([
      ['GIT_TERMINAL_PROMPT', '0'],
      ['YOLK_GIT_URL', source.url]
    ])

    if (source.auth !== undefined) {
      env.set('YOLK_GIT_USERNAME', source.auth.username)
      env.set('YOLK_GIT_PASSWORD', source.auth.password)
    }

    if (source.depth !== undefined) env.set('YOLK_GIT_DEPTH', String(source.depth))

    if (source.revision !== undefined) env.set('YOLK_GIT_REVISION', source.revision)

    failIfNonZero(
      'Cloning the Git source',
      await internalExec(spec, {
        argv: ['bash', '-c', cloudflareSandboxScripts.gitClone, 'bash', spec.workspaceRoot],
        env: Object.fromEntries(env)
      })
    )
  }

  // The object downloads the tarball (the container needs neither curl nor internet access).
  const unpackTarballSource = async (spec: CloudflareSandboxContainerSpec, url: string) => {
    const response = await deps.fetch(url).catch(error => {
      throw new EngineFailure({
        kind: 'provider',
        message: `Downloading the tarball source failed: ${errorMessage(error)}`
      })
    })

    if (!response.ok || response.body === null) {
      throw new EngineFailure({
        kind: 'provider',
        message: `Downloading the tarball source failed: HTTP ${response.status}`
      })
    }

    failIfNonZero(
      'Unpacking the tarball source',
      await internalExec(spec, {
        argv: ['sh', '-c', cloudflareSandboxScripts.untar, 'sh', spec.workspaceRoot],
        stdin: response.body
      })
    )
  }

  const prepareSource = (spec: CloudflareSandboxContainerSpec) =>
    Match.value(spec.source).pipe(
      Match.withReturnType<Promise<void>>(),
      Match.tagsExhaustive({
        Empty: () => Promise.resolve(),
        Git: git => cloneGitSource(spec, git),
        Tarball: tarball => unpackTarballSource(spec, tarball.url)
      })
    )

  const armAlarm = async (record: BootRecord) => {
    const deadline = deadlineOf(record)
    const current = await deps.storage.getAlarm()

    if (current === null || current > deadline) await deps.storage.setAlarm(deadline)
  }

  const stopContainer = async () => {
    const container = deps.container

    verified.clear()

    if (container !== undefined && container.running) {
      await container.destroy().catch(() => undefined)
    }

    await deps.storage.delete(bootRecordKey)
  }

  const startContainer = async (spec: CloudflareSandboxContainerSpec): Promise<BootRecord> => {
    const container = requireContainer()

    await stopContainer()

    const image = container.images[spec.image]

    if (image === undefined) {
      const known = Object.keys(container.images)

      throw new EngineFailure({
        kind: 'config',
        message: `Image "${spec.image}" is not configured for this Durable Object class (configured: ${known.length === 0 ? 'none' : known.join(', ')})`
      })
    }

    try {
      container.start({
        image,
        enableInternet: spec.internet,
        env: { ...spec.env },
        instance: { ...spec.instance }
      })
    } catch (error) {
      throw new EngineFailure({
        kind: 'provider',
        message: `Starting the container failed: ${errorMessage(error)}`
      })
    }

    try {
      // The first exec waits until the container accepts work.
      failIfNonZero('Starting the container', await internalExec(spec, { argv: ['true'] }))
      await container.setInactivityTimeout(spec.idleTtlMs)
      await deps.containerStarted()

      failIfNonZero(
        'Preparing the workspace',
        await internalExec(spec, {
          argv: [
            'sh',
            '-c',
            cloudflareSandboxScripts.mkdir,
            'sh',
            spec.workspaceRoot,
            cloudflareSandboxStateDir
          ]
        })
      )

      await prepareSource(spec)

      const bootId = deps.randomId()

      await writeBytes(spec, bootFile, encoder.encode(bootId))

      const startedAtMs = deps.now()

      const record: BootRecord = {
        bootId,
        startedAtMs,
        image: spec.image,
        lastActivityAtMs: startedAtMs,
        idleTtlMs: spec.idleTtlMs,
        maxDeadlineMs: spec.maxLifetimeMs === undefined ? null : startedAtMs + spec.maxLifetimeMs
      }

      await deps.storage.put(bootRecordKey, record)
      verified.add(bootId)
      await armAlarm(record)

      return record
    } catch (error) {
      // A half-prepared workspace must not be reused: the next call starts over.
      await stopContainer()

      throw error
    }
  }

  const ensureContainer = async (request: CloudflareSandboxRequest): Promise<BootRecord> => {
    const container = requireContainer()
    const record = await loadRecord()

    const reusable =
      !request.fresh &&
      record !== undefined &&
      container.running &&
      record.image === request.container.image &&
      deps.now() < deadlineOf(record)

    if (!reusable) return startContainer(request.container)

    if (verified.has(record.bootId)) return record

    // A new instance of this object: check that the running container is the one it started.
    const marker = await readBytes(request.container, bootFile, 256)

    if (marker !== undefined && decode(marker.bytes).trim() === record.bootId) {
      verified.add(record.bootId)

      return record
    }

    return startContainer(request.container)
  }

  const touch = async (bootId: string) => {
    const record = await loadRecord()

    if (record === undefined || record.bootId !== bootId) return

    const touched: BootRecord = { ...record, lastActivityAtMs: deps.now() }

    await deps.storage.put(bootRecordKey, touched)
    await armAlarm(touched)
    await deps.container?.setInactivityTimeout(record.idleTtlMs).catch(() => undefined)
  }

  const failed = <A>(error: unknown): CloudflareSandboxReply<A> =>
    error instanceof EngineFailure
      ? { ok: false, kind: error.kind, message: error.message }
      : { ok: false, kind: 'provider', message: errorMessage(error) }

  const operation = async <A>(
    request: CloudflareSandboxRequest,
    body: (spec: CloudflareSandboxContainerSpec) => Promise<A>
  ): Promise<CloudflareSandboxReply<A>> => {
    inflight += 1

    try {
      const record = await serialized(async () => {
        const ensured = await ensureContainer(request)

        await touch(ensured.bootId)

        return ensured
      })

      const value = await body(request.container)

      await touch(record.bootId)

      return { ok: true, boot: bootOf(record), value }
    } catch (error) {
      return failed(error)
    } finally {
      inflight -= 1
    }
  }

  const runForeground = async (input: CloudflareSandboxRunInput) => {
    const result = await execCollect({
      argv: ['bash', '-c', input.command],
      env: input.container.env,
      cwd: input.cwd,
      stdin: encoder.encode(input.stdin ?? ''),
      maxBytes: input.maxOutputBytes,
      timeoutMs: input.timeoutMs
    })

    return {
      exitCode: result.exitCode,
      stdout: outputText(result.stdout),
      stderr: outputText(result.stderr),
      timedOut: result.timedOut,
      durationMs: result.durationMs
    }
  }

  const runBackground = async (input: CloudflareSandboxRunInput) => {
    const spec = input.container
    const startedAtMs = deps.now()
    const backgroundId = `bg-${deps.randomId()}`
    const dir = `${cloudflareSandboxStateDir}/background/${backgroundId}`

    await writeBytes(spec, `${dir}/command.sh`, encoder.encode(`${input.command}\n`))
    await writeBytes(spec, `${dir}/stdin`, encoder.encode(input.stdin ?? ''))

    failIfNonZero(
      'Starting the background command',
      await internalExec(spec, {
        argv: ['sh', '-c', cloudflareSandboxScripts.spawn, 'sh', dir, input.cwd],
        timeoutMs: 30_000
      })
    )

    await delay(backgroundProbeMs)

    const exit = await readBytes(spec, `${dir}/exit`, 32)
    const durationMs = Math.max(0, deps.now() - startedAtMs)

    if (exit === undefined) {
      return { exitCode: null, stdout: '', stderr: '', timedOut: false, durationMs, backgroundId }
    }

    const exitCode = Number.parseInt(decode(exit.bytes).trim(), 10)

    const read = async (name: string) => {
      const collected = await readBytes(spec, `${dir}/${name}`, input.maxOutputBytes + 1)

      if (collected === undefined) return ''

      return collected.bytes.byteLength > input.maxOutputBytes
        ? outputText({
            bytes: collected.bytes.subarray(0, input.maxOutputBytes),
            total: collected.bytes.byteLength
          })
        : decode(collected.bytes)
    }

    return {
      exitCode: Number.isNaN(exitCode) ? null : exitCode,
      stdout: await read('stdout'),
      stderr: await read('stderr'),
      timedOut: false,
      durationMs
    }
  }

  return {
    run: (input: CloudflareSandboxRunInput) =>
      operation<CloudflareSandboxRunOutput>(input, () =>
        input.background ? runBackground(input) : runForeground(input)
      ),

    writeFile: (input: CloudflareSandboxWriteFileInput) =>
      operation<null>(input, async spec => {
        await writeBytes(spec, input.path, input.bytes)

        return null
      }),

    readFile: (input: CloudflareSandboxReadFileInput) =>
      operation<CloudflareSandboxReadFileOutput>(input, async spec => {
        const collected = await readBytes(spec, input.path, input.maxBytes + 1)

        if (collected === undefined) return CloudflareSandboxReadFileOutput.NotFound()

        return collected.bytes.byteLength > input.maxBytes
          ? CloudflareSandboxReadFileOutput.TooLarge()
          : CloudflareSandboxReadFileOutput.Found({ bytes: collected.bytes })
      }),

    status: async (): Promise<CloudflareSandboxStatus> => {
      const record = await loadRecord()
      const running = deps.container?.running === true

      return {
        running,
        boot: record === undefined ? null : bootOf(record),
        deadlineMs: record === undefined || !running ? null : deadlineOf(record)
      }
    },

    destroy: () =>
      serialized(async () => {
        await stopContainer()
        await deps.storage.deleteAlarm()
      }),

    /** The object's alarm: destroys the container once idle or past its max lifetime. */
    alarm: () =>
      serialized(async () => {
        const record = await loadRecord()

        if (record === undefined) return

        const now = deps.now()
        const pastMaxLifetime = record.maxDeadlineMs !== null && now >= record.maxDeadlineMs

        if (!pastMaxLifetime && inflight > 0) {
          // A command is running, so the sandbox is not idle; look again later.
          await deps.storage.setAlarm(now + Math.min(record.idleTtlMs, 60_000))

          return
        }

        if (pastMaxLifetime || now >= deadlineOf(record)) {
          await stopContainer()

          return
        }

        await deps.storage.setAlarm(deadlineOf(record))
      })
  }
}

export type CloudflareSandboxEngine = ReturnType<typeof makeCloudflareSandboxEngine>
