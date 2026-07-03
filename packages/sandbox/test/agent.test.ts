import { Effect, Option } from 'effect'
import { describe, expect, it } from '@effect/vitest'
import { ToolResult } from '@yolk-sdk/agent/protocol'
import { resolveTools } from '@yolk-sdk/agent/tools'
import {
  SandboxCommandResult,
  SandboxExpiredError,
  SandboxPreviewUrl,
  VercelSandboxState,
  type SandboxApi
} from '../src/index.ts'
import {
  makeSandboxToolModuleFromApi,
  makeSandboxToolResult,
  sandboxToolName
} from '../src/agent.ts'

const state = VercelSandboxState.make({
  name: 'sandbox-test',
  createdAtMs: 0,
  lastUsedAtMs: 0,
  expiresAtMs: 60_000,
  maxExpiresAtMs: 120_000
})

const commandResult = (input: {
  readonly exitCode?: number | null
  readonly stdout?: string
  readonly stderr?: string
  readonly timedOut?: boolean
  readonly workspaceReset?: boolean
  readonly previewUrls?: ReadonlyArray<SandboxPreviewUrl>
}) =>
  SandboxCommandResult.make({
    exitCode: input.exitCode ?? 0,
    stdout: input.stdout ?? '',
    stderr: input.stderr ?? '',
    durationMs: 10,
    timedOut: input.timedOut ?? false,
    workspaceReset: input.workspaceReset ?? false,
    previewUrls: input.previewUrls ?? [],
    state
  })

describe('sandbox agent tool', () => {
  it.effect('registers destructive sandbox tool', () =>
    Effect.gen(function* () {
      const api: SandboxApi = {
        run: () => Effect.succeed(commandResult({ stdout: 'ok' })),
        currentState: Effect.succeed(Option.some(state)),
        delete: Effect.void
      }
      const toolSet = yield* resolveTools([makeSandboxToolModuleFromApi(api)], {})

      expect(toolSet.tools.map(tool => tool.name)).toEqual([sandboxToolName])
      expect(toolSet.metadata).toEqual([
        { moduleId: 'sandbox', name: sandboxToolName, access: 'destructive' }
      ])
      expect(toolSet.tools[0]?.description).toContain('real sandbox workspace')
    })
  )

  it.effect('normalizes null params and formats result', () =>
    Effect.gen(function* () {
      const api: SandboxApi = {
        run: input =>
          Effect.succeed(
            commandResult({
              stdout: `${input.command}:${input.cwd}:${input.stdin ?? 'none'}:${input.timeoutMs}:${input.background ?? false}`
            })
          ),
        currentState: Effect.succeed(Option.some(state)),
        delete: Effect.void
      }
      const toolSet = yield* resolveTools([makeSandboxToolModuleFromApi(api)], {})
      const result = yield* toolSet.execute({
        id: 'call_1',
        name: sandboxToolName,
        params: {
          command: 'pwd',
          cwd: null,
          stdin: null,
          timeoutSeconds: null,
          background: null
        }
      })

      expect(result.content).toContain('exit_code: 0')
      expect(result.content).toContain('pwd:.:none:120000:false')
      expect(result.isError).toBe(false)
    })
  )

  it('emits plain JSON structured content', () => {
    const result = makeSandboxToolResult({
      callId: 'call_1',
      result: commandResult({
        stdout: 'ok',
        previewUrls: [SandboxPreviewUrl.make({ port: 3000, url: 'https://3000.example.test' })]
      })
    })

    expect(result.structuredContent).toStrictEqual({
      exitCode: 0,
      durationMs: 10,
      timedOut: false,
      truncated: false,
      workspaceReset: false,
      previewUrls: [{ port: 3000, url: 'https://3000.example.test' }],
      state: {
        _tag: 'Vercel',
        name: 'sandbox-test',
        createdAtMs: 0,
        lastUsedAtMs: 0,
        expiresAtMs: 60_000,
        maxExpiresAtMs: 120_000
      }
    })
  })

  it.effect('returns model-visible expired errors', () =>
    Effect.gen(function* () {
      const api: SandboxApi = {
        run: () =>
          Effect.fail(
            new SandboxExpiredError({
              message: 'Sandbox expired',
              expiredAtMs: 1
            })
          ),
        currentState: Effect.succeed(Option.none()),
        delete: Effect.void
      }
      const toolSet = yield* resolveTools([makeSandboxToolModuleFromApi(api)], {})
      const result = yield* toolSet.execute({
        id: 'call_1',
        name: sandboxToolName,
        params: { command: 'pwd' }
      })

      expect(result).toMatchObject({
        toolCallId: 'call_1',
        content: 'Sandbox expired',
        isError: true
      })
    })
  )

  it('marks nonzero and truncated results', () => {
    const result = makeSandboxToolResult({
      callId: 'call_1',
      result: commandResult({ exitCode: 2, stdout: 'x'.repeat(60_000) })
    })

    expect(result.isError).toBe(true)
    expect(result.content).toContain('truncated: true')
    expect(result.content.length).toBeLessThan(51_000)
  })

  it('allows normal ToolResult construction beside sandbox result', () => {
    expect(ToolResult.make({ toolCallId: 'call_1', content: 'ok' }).content).toBe('ok')
  })
})
