import { Duration, Effect, Fiber, Layer, Match, Option, Predicate } from 'effect'
import { TestClock } from 'effect/testing'
import { describe, expect, it } from '@effect/vitest'
import { APIError } from '@vercel/sandbox'
import {
  GitSandboxBasicAuth,
  GitSandboxInitialSource,
  Sandbox,
  SandboxCommandResult,
  SandboxProviderError,
  SandboxResources,
  defaultSandboxLifecycle,
  makeVercelSandboxName,
  sandboxStateDecision,
  VercelSandboxState
} from '../src/index.ts'
import type { SandboxPreviewUrl } from '../src/index.ts'
import { makeSandboxToolResult } from '../src/agent.ts'
import { makeInMemorySandboxStateStoreLayer } from '../src/testing/index.ts'
import {
  isVercelMissingSandboxError,
  makeVercelSandboxLayerWithClient,
  VercelSandboxClient,
  type VercelDetachedCommand,
  type VercelFinishedCommand,
  type VercelRunCommandInput,
  type VercelSandboxCreateInput,
  type VercelSandboxFile,
  type VercelSandboxHandle
} from '../src/vercel/index.ts'

const state = VercelSandboxState.make({
  name: 'sandbox-test',
  createdAtMs: 0,
  lastUsedAtMs: 0,
  expiresAtMs: 60_000,
  maxExpiresAtMs: 120_000
})

type RegressionCommandResultFields = {
  exitCode: number | null
  stdout: string
  stderr: string
  durationMs: number
  timedOut: boolean
  workspaceReset: boolean
  backgroundId?: string
}

type RegressionCommandResultInput = {
  readonly exitCode?: number | null
  readonly stdout?: string
  readonly stderr?: string
  readonly timedOut?: boolean
  readonly workspaceReset?: boolean
  readonly backgroundId?: string
  readonly previewUrls?: ReadonlyArray<SandboxPreviewUrl>
}

const commandResult = (input: RegressionCommandResultInput) => {
  const fields: RegressionCommandResultFields = {
    exitCode: input.exitCode ?? 0,
    stdout: input.stdout ?? '',
    stderr: input.stderr ?? '',
    durationMs: 10,
    timedOut: input.timedOut ?? false,
    workspaceReset: input.workspaceReset ?? false
  }

  if (input.backgroundId !== undefined) {
    fields.backgroundId = input.backgroundId
  }

  return SandboxCommandResult.make({
    ...fields,
    previewUrls: input.previewUrls ?? [],
    state
  })
}

const structuredContentRecord = (result: ReturnType<typeof makeSandboxToolResult>) => {
  if (!Predicate.isObject(result.structuredContent)) {
    throw new Error('expected object structuredContent')
  }

  return result.structuredContent
}

type Equal<A, B> =
  (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false

const statusInFalseBranch = (error: APIError<object>): number => {
  if (!isVercelMissingSandboxError(error)) {
    type FalseBranch = typeof error

    const holdsApiError: Equal<FalseBranch, APIError<object>> = true

    expect(holdsApiError).toBe(true)

    return error.response.status
  }

  return error.response.status
}

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
  readonly wait?: VercelDetachedCommand['wait']
  readonly kill?: VercelDetachedCommand['kill']
}): VercelDetachedCommand => ({
  id: input.id,
  exitCode: input.exitCode,
  wait: input.wait ?? Effect.succeed(finishedCommand(input.id, input.exitCode ?? 0)),
  kill: input.kill ?? (() => Effect.void),
  output: Effect.succeed({
    stdout: input.stdout ?? 'done',
    stderr: input.stderr ?? ''
  })
})

const makeHandle = (input: {
  readonly name: string
  readonly files: Array<VercelSandboxFile>
  readonly commands: Array<VercelRunCommandInput>
  readonly deleted: Array<string>
  readonly killed?: Array<string>
  readonly wait?: VercelDetachedCommand['wait']
}): VercelSandboxHandle => ({
  name: input.name,
  writeFiles: files => {
    input.files.push(...files)

    return Effect.void
  },
  runDetachedCommand: command => {
    input.commands.push(command)

    return Effect.succeed(
      detachedCommand({
        id: 'cmd_1',
        exitCode: null,
        wait: input.wait,
        kill: () => {
          input.killed?.push('cmd_1')

          return Effect.void
        }
      })
    )
  },
  getCommand: id => Effect.succeed(detachedCommand({ id, exitCode: 0 })),
  extendTimeout: () => Effect.void,
  delete: Effect.sync(() => {
    input.deleted.push(input.name)
  }),
  domain: port => `https://${port}.example.test`
})

describe('sandbox anti-slop regressions', () => {
  it('returns a plain Create object with _tag first and no reason key', () => {
    const decision = sandboxStateDecision({
      state: Option.none(),
      name: 'sandbox-a',
      nowMs: 0,
      lifecycle: defaultSandboxLifecycle
    })

    expect(decision._tag).toBe('Create')
    expect(decision).toMatchObject({ workspaceReset: false })
    expect(Object.hasOwn(decision, 'reason')).toBe(false)

    expect(Object.keys(decision)).toEqual(['_tag', 'workspaceReset'])

    expect(Object.getPrototypeOf(decision)).toBe(Object.prototype)
  })

  it('keeps UseExisting _tag first, state identity, and no reason key', () => {
    const decision = sandboxStateDecision({
      state: Option.some(state),
      name: state.name,
      nowMs: 1,
      lifecycle: defaultSandboxLifecycle
    })

    expect(decision._tag).toBe('UseExisting')
    expect(decision).toMatchObject({ state })
    expect(Object.hasOwn(decision, 'reason')).toBe(false)

    expect(Object.keys(decision)).toEqual(['_tag', 'state'])

    expect(Object.getPrototypeOf(decision)).toBe(Object.prototype)

    const kept = Match.value(decision).pipe(
      Match.tag('UseExisting', current => current.state),
      Match.orElse(() => undefined)
    )

    expect(kept).toBe(state)
  })

  it('keeps _tag first when a recreate reason is present', () => {
    const renamed = sandboxStateDecision({
      state: Option.some(state),
      name: 'other-name',
      nowMs: 1,
      lifecycle: defaultSandboxLifecycle
    })

    expect(renamed._tag).toBe('Create')
    expect(renamed).toMatchObject({
      workspaceReset: true,
      reason: 'name_mismatch'
    })

    expect(Object.keys(renamed)).toEqual(['_tag', 'workspaceReset', 'reason'])

    expect(Object.getPrototypeOf(renamed)).toBe(Object.prototype)
  })

  it('omits structuredContent.backgroundId instead of writing undefined', () => {
    const result = makeSandboxToolResult({
      callId: 'call_1',
      result: commandResult({ stdout: 'ok' })
    })

    const content = structuredContentRecord(result)

    expect(result.structuredContent).toEqual({
      exitCode: 0,
      durationMs: 10,
      timedOut: false,
      truncated: false,
      workspaceReset: false,
      previewUrls: [],
      state: {
        _tag: state._tag,
        name: state.name,
        createdAtMs: state.createdAtMs,
        lastUsedAtMs: state.lastUsedAtMs,
        expiresAtMs: state.expiresAtMs,
        maxExpiresAtMs: state.maxExpiresAtMs
      }
    })

    expect(Object.hasOwn(content, 'backgroundId')).toBe(false)

    expect(Object.keys(content)).toEqual([
      'exitCode',
      'durationMs',
      'timedOut',
      'truncated',
      'workspaceReset',
      'previewUrls',
      'state'
    ])
  })

  it('inserts backgroundId before previewUrls when present', () => {
    const result = makeSandboxToolResult({
      callId: 'call_1',
      result: commandResult({ stdout: 'ok', backgroundId: 'cmd_1' })
    })

    const content = structuredContentRecord(result)

    expect(Object.hasOwn(content, 'backgroundId')).toBe(true)
    expect(result.structuredContent).toEqual({
      exitCode: 0,
      durationMs: 10,
      timedOut: false,
      truncated: false,
      workspaceReset: false,
      backgroundId: 'cmd_1',
      previewUrls: [],
      state: {
        _tag: state._tag,
        name: state.name,
        createdAtMs: state.createdAtMs,
        lastUsedAtMs: state.lastUsedAtMs,
        expiresAtMs: state.expiresAtMs,
        maxExpiresAtMs: state.maxExpiresAtMs
      }
    })

    expect(Object.keys(content)).toEqual([
      'exitCode',
      'durationMs',
      'timedOut',
      'truncated',
      'workspaceReset',
      'backgroundId',
      'previewUrls',
      'state'
    ])
  })

  it('reads getter _tag twice then remaining state fields through public makeSandboxToolResult', () => {
    const reads: Array<string> = []

    const getterState: VercelSandboxState = {
      get _tag(): 'Vercel' {
        reads.push('_tag')

        return 'Vercel'
      },
      get name() {
        reads.push('name')

        return 'fixture'
      },
      get createdAtMs() {
        reads.push('createdAtMs')

        return 0
      },
      get lastUsedAtMs() {
        reads.push('lastUsedAtMs')

        return 0
      },
      get expiresAtMs() {
        reads.push('expiresAtMs')

        return 100
      },
      get maxExpiresAtMs() {
        reads.push('maxExpiresAtMs')

        return 200
      }
    }

    const result: SandboxCommandResult = {
      exitCode: 0,
      stdout: 'ok',
      stderr: '',
      durationMs: 1,
      timedOut: false,
      workspaceReset: false,
      previewUrls: [],
      state: getterState
    }

    const toolResult = makeSandboxToolResult({ callId: 'call_1', result })

    expect(reads).toEqual([
      '_tag',
      '_tag',
      'name',
      'createdAtMs',
      'lastUsedAtMs',
      'expiresAtMs',
      'maxExpiresAtMs'
    ])

    const content = structuredContentRecord(toolResult)

    expect(JSON.stringify(content)).toBe(
      '{"exitCode":0,"durationMs":1,"timedOut":false,"truncated":false,"workspaceReset":false,"previewUrls":[],"state":{"_tag":"Vercel","name":"fixture","createdAtMs":0,"lastUsedAtMs":0,"expiresAtMs":100,"maxExpiresAtMs":200}}'
    )
    expect(Object.keys(content)).toEqual([
      'exitCode',
      'durationMs',
      'timedOut',
      'truncated',
      'workspaceReset',
      'previewUrls',
      'state'
    ])

    if (!('state' in content) || !Predicate.isObject(content.state)) {
      throw new Error('expected object structuredContent.state')
    }

    expect(Object.keys(content.state)).toEqual([
      '_tag',
      'name',
      'createdAtMs',
      'lastUsedAtMs',
      'expiresAtMs',
      'maxExpiresAtMs'
    ])
  })

  it('treats SDK 404/410 as missing and keeps APIError usable in the false branch', () => {
    const missing = new APIError<object>(new Response(null, { status: 404 }))
    const gone = new APIError<object>(new Response(null, { status: 410 }))
    const server = new APIError<object>(new Response(null, { status: 500 }))
    const generic = new Error('boom')

    expect(isVercelMissingSandboxError(missing)).toBe(true)
    expect(isVercelMissingSandboxError(gone)).toBe(true)
    expect(isVercelMissingSandboxError(server)).toBe(false)
    expect(isVercelMissingSandboxError(generic)).toBe(false)
    expect(isVercelMissingSandboxError('sandbox missing')).toBe(false)
    expect(statusInFalseBranch(server)).toBe(500)
    expect(statusInFalseBranch(missing)).toBe(404)
  })

  it.effect('records create options for git auth, ports, env, and resources', () =>
    Effect.gen(function* () {
      const files: Array<VercelSandboxFile> = []
      const commands: Array<VercelRunCommandInput> = []
      const deleted: Array<string> = []
      const sandboxSessionId = 'session_create_options'
      const name = makeVercelSandboxName(sandboxSessionId)
      const handle = makeHandle({ name, files, commands, deleted })
      const created: Array<VercelSandboxCreateInput> = []

      const auth = GitSandboxBasicAuth.make({
        username: 'git-user',
        password: 'git-password'
      })

      const source = GitSandboxInitialSource.make({
        url: 'https://example.test/repo.git',
        auth,
        depth: 1,
        revision: 'main'
      })

      const resources = SandboxResources.make({ vcpus: 4 })
      const env = { NODE_ENV: 'test' }

      const clientLayer = Layer.succeed(
        VercelSandboxClient,
        VercelSandboxClient.of({
          get: () => Effect.succeed(null),
          create: input => {
            created.push(input)

            return Effect.succeed(handle)
          }
        })
      )

      const layer = makeVercelSandboxLayerWithClient({
        sandboxSessionId,
        source,
        env,
        ports: [3000],
        resources
      }).pipe(Layer.provide(Layer.mergeAll(clientLayer, makeInMemorySandboxStateStoreLayer())))

      yield* Effect.gen(function* () {
        const sandbox = yield* Sandbox

        return yield* sandbox.run({ command: 'pwd' })
      }).pipe(Effect.provide(layer))

      expect(created).toHaveLength(1)
      expect(created[0]?.name).toBe(name)
      expect(created[0]?.ports).toEqual([3000])
      expect(created[0]?.env).toEqual(env)
      expect(created[0]?.resources).toBe(resources)
      expect(created[0]?.source).toBe(source)
    })
  )

  it.effect('wraps provider failures without changing underlying error identity', () =>
    Effect.gen(function* () {
      const sandboxSessionId = 'session_provider_error'
      const underlying = new Error('vercel down')

      const clientLayer = Layer.succeed(
        VercelSandboxClient,
        VercelSandboxClient.of({
          get: () => Effect.fail(underlying),
          create: () => Effect.fail(underlying)
        })
      )

      const layer = makeVercelSandboxLayerWithClient({
        sandboxSessionId
      }).pipe(Layer.provide(Layer.mergeAll(clientLayer, makeInMemorySandboxStateStoreLayer())))

      const error = yield* Effect.gen(function* () {
        const sandbox = yield* Sandbox

        return yield* sandbox.run({ command: 'pwd' }).pipe(Effect.flip)
      }).pipe(Effect.provide(layer))

      expect(error).toBeInstanceOf(SandboxProviderError)

      if (!(error instanceof SandboxProviderError)) {
        throw new Error('expected SandboxProviderError')
      }

      expect(error.underlying).toBe(underlying)
      expect(error.message).toContain('vercel down')
    })
  )

  it.effect('kills and reports timeout when wait exceeds the owned timeout', () =>
    Effect.gen(function* () {
      const files: Array<VercelSandboxFile> = []
      const commands: Array<VercelRunCommandInput> = []
      const deleted: Array<string> = []
      const killed: Array<string> = []
      const sandboxSessionId = 'session_timeout'
      const name = makeVercelSandboxName(sandboxSessionId)

      const handle = makeHandle({
        name,
        files,
        commands,
        deleted,
        killed,
        wait: Effect.never
      })

      const clientLayer = Layer.succeed(
        VercelSandboxClient,
        VercelSandboxClient.of({
          get: () => Effect.succeed(null),
          create: () => Effect.succeed(handle)
        })
      )

      const layer = makeVercelSandboxLayerWithClient({
        sandboxSessionId
      }).pipe(Layer.provide(Layer.mergeAll(clientLayer, makeInMemorySandboxStateStoreLayer())))

      const fiber = yield* Effect.gen(function* () {
        const sandbox = yield* Sandbox

        return yield* sandbox.run({ command: 'sleep 30', timeoutMs: 1_000 })
      }).pipe(Effect.provide(layer), Effect.forkChild)

      yield* TestClock.adjust(Duration.millis(1_100))
      const result = yield* Fiber.join(fiber)

      expect(result.timedOut).toBe(true)
      expect(result.exitCode).toBe(null)
      expect(killed).toEqual(['cmd_1'])
    })
  )

  it('Create omitted-reason branch is plain JSON golden with data descriptors', () => {
    const decision = sandboxStateDecision({
      state: Option.none(),
      name: 'sandbox-a',
      nowMs: 0,
      lifecycle: defaultSandboxLifecycle
    })

    expect(JSON.stringify(decision)).toBe('{"_tag":"Create","workspaceReset":false}')
    expect(Object.keys(decision)).toEqual(['_tag', 'workspaceReset'])
    expect(Object.getPrototypeOf(decision)).toBe(Object.prototype)
    expect(Object.hasOwn(decision, 'reason')).toBe(false)

    for (const [key, value] of Object.entries(decision)) {
      expect(Object.getOwnPropertyDescriptor(decision, key)).toEqual({
        value,
        writable: true,
        enumerable: true,
        configurable: true
      })
    }
  })

  it('Create name_mismatch branch is plain JSON golden with data descriptors', () => {
    const decision = sandboxStateDecision({
      state: Option.some(state),
      name: 'other-name',
      nowMs: 1,
      lifecycle: defaultSandboxLifecycle
    })

    expect(JSON.stringify(decision)).toBe(
      '{"_tag":"Create","workspaceReset":true,"reason":"name_mismatch"}'
    )
    expect(Object.keys(decision)).toEqual(['_tag', 'workspaceReset', 'reason'])
    expect(Object.getPrototypeOf(decision)).toBe(Object.prototype)
    expect(Object.hasOwn(decision, 'reason')).toBe(true)

    for (const [key, value] of Object.entries(decision)) {
      expect(Object.getOwnPropertyDescriptor(decision, key)).toEqual({
        value,
        writable: true,
        enumerable: true,
        configurable: true
      })
    }
  })

  it('Create max_expired branch is plain JSON golden with data descriptors', () => {
    const decision = sandboxStateDecision({
      state: Option.some(state),
      name: state.name,
      nowMs: 120_000,
      lifecycle: defaultSandboxLifecycle
    })

    expect(JSON.stringify(decision)).toBe(
      '{"_tag":"Create","workspaceReset":true,"reason":"max_expired"}'
    )
    expect(Object.keys(decision)).toEqual(['_tag', 'workspaceReset', 'reason'])
    expect(Object.getPrototypeOf(decision)).toBe(Object.prototype)
    expect(Object.hasOwn(decision, 'reason')).toBe(true)

    for (const [key, value] of Object.entries(decision)) {
      expect(Object.getOwnPropertyDescriptor(decision, key)).toEqual({
        value,
        writable: true,
        enumerable: true,
        configurable: true
      })
    }
  })

  it('Create idle_expired branch is plain JSON golden with data descriptors', () => {
    const decision = sandboxStateDecision({
      state: Option.some(state),
      name: state.name,
      nowMs: 60_000,
      lifecycle: defaultSandboxLifecycle
    })

    expect(JSON.stringify(decision)).toBe(
      '{"_tag":"Create","workspaceReset":true,"reason":"idle_expired"}'
    )
    expect(Object.keys(decision)).toEqual(['_tag', 'workspaceReset', 'reason'])
    expect(Object.getPrototypeOf(decision)).toBe(Object.prototype)
    expect(Object.hasOwn(decision, 'reason')).toBe(true)

    for (const [key, value] of Object.entries(decision)) {
      expect(Object.getOwnPropertyDescriptor(decision, key)).toEqual({
        value,
        writable: true,
        enumerable: true,
        configurable: true
      })
    }
  })

  it('Create name_mismatch getter state is read only for name', () => {
    const reads: Array<string> = []

    const getterState: VercelSandboxState = {
      get _tag(): 'Vercel' {
        reads.push('_tag')

        return 'Vercel'
      },
      get name() {
        reads.push('name')

        return 'sandbox-test'
      },
      get createdAtMs() {
        reads.push('createdAtMs')

        return 0
      },
      get lastUsedAtMs() {
        reads.push('lastUsedAtMs')

        return 0
      },
      get expiresAtMs() {
        reads.push('expiresAtMs')

        return 60_000
      },
      get maxExpiresAtMs() {
        reads.push('maxExpiresAtMs')

        return 120_000
      }
    }

    const decision = sandboxStateDecision({
      state: Option.some(getterState),
      name: 'other-name',
      nowMs: 1,
      lifecycle: defaultSandboxLifecycle
    })

    expect(reads).toEqual(['name'])
    expect(JSON.stringify(decision)).toBe(
      '{"_tag":"Create","workspaceReset":true,"reason":"name_mismatch"}'
    )
  })

  it('Create max_expired getter state is read for name then maxExpiresAtMs', () => {
    const reads: Array<string> = []

    const getterState: VercelSandboxState = {
      get _tag(): 'Vercel' {
        reads.push('_tag')

        return 'Vercel'
      },
      get name() {
        reads.push('name')

        return 'sandbox-test'
      },
      get createdAtMs() {
        reads.push('createdAtMs')

        return 0
      },
      get lastUsedAtMs() {
        reads.push('lastUsedAtMs')

        return 0
      },
      get expiresAtMs() {
        reads.push('expiresAtMs')

        return 60_000
      },
      get maxExpiresAtMs() {
        reads.push('maxExpiresAtMs')

        return 120_000
      }
    }

    const decision = sandboxStateDecision({
      state: Option.some(getterState),
      name: 'sandbox-test',
      nowMs: 120_000,
      lifecycle: defaultSandboxLifecycle
    })

    expect(reads).toEqual(['name', 'maxExpiresAtMs'])
    expect(JSON.stringify(decision)).toBe(
      '{"_tag":"Create","workspaceReset":true,"reason":"max_expired"}'
    )
  })

  it('Create idle_expired getter state is read for name, maxExpiresAtMs, expiresAtMs', () => {
    const reads: Array<string> = []

    const getterState: VercelSandboxState = {
      get _tag(): 'Vercel' {
        reads.push('_tag')

        return 'Vercel'
      },
      get name() {
        reads.push('name')

        return 'sandbox-test'
      },
      get createdAtMs() {
        reads.push('createdAtMs')

        return 0
      },
      get lastUsedAtMs() {
        reads.push('lastUsedAtMs')

        return 0
      },
      get expiresAtMs() {
        reads.push('expiresAtMs')

        return 60_000
      },
      get maxExpiresAtMs() {
        reads.push('maxExpiresAtMs')

        return 120_000
      }
    }

    const decision = sandboxStateDecision({
      state: Option.some(getterState),
      name: 'sandbox-test',
      nowMs: 60_000,
      lifecycle: defaultSandboxLifecycle
    })

    expect(reads).toEqual(['name', 'maxExpiresAtMs', 'expiresAtMs'])
    expect(JSON.stringify(decision)).toBe(
      '{"_tag":"Create","workspaceReset":true,"reason":"idle_expired"}'
    )
  })
})
