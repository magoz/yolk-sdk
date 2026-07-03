import { Effect, Option } from 'effect'
import { SandboxInputError } from './errors.ts'
import {
  DisposableSandboxLifecycle,
  EmptySandboxInitialSource,
  type SandboxInitialSource,
  type SandboxLifecycle,
  type SandboxState,
  VercelSandboxState
} from './model.ts'

export const defaultSandboxIdleTtlMs = 30 * 60_000
export const defaultSandboxMaxLifetimeMs = 45 * 60_000
export const defaultSandboxCommandTimeoutMs = 120_000
export const maxSandboxCommandTimeoutMs = 600_000
export const backgroundSandboxProbeMs = 2_000
export const sandboxToolOutputLimit = 50_000
export const defaultSandboxPorts: ReadonlyArray<number> = [3000, 5173, 4321, 8000]
export const defaultSandboxWorkspaceRoot = '/vercel/sandbox'

export const defaultSandboxLifecycle = DisposableSandboxLifecycle.make({
  idleTtlMs: defaultSandboxIdleTtlMs,
  maxLifetimeMs: defaultSandboxMaxLifetimeMs
})

export const defaultSandboxInitialSource = EmptySandboxInitialSource.make({})

export type SandboxRecreateReason = 'idle_expired' | 'max_expired' | 'name_mismatch'

export type SandboxStateDecision =
  | {
      readonly _tag: 'UseExisting'
      readonly state: SandboxState
    }
  | {
      readonly _tag: 'Create'
      readonly workspaceReset: boolean
      readonly reason?: SandboxRecreateReason
    }

const positiveOr = (value: number | undefined, fallback: number) =>
  value === undefined || !Number.isFinite(value) || value <= 0 ? fallback : Math.floor(value)

export const sandboxLifecycleOrDefault = (lifecycle?: SandboxLifecycle): SandboxLifecycle =>
  lifecycle ?? defaultSandboxLifecycle

export const sandboxSourceOrDefault = (source?: SandboxInitialSource): SandboxInitialSource =>
  source ?? defaultSandboxInitialSource

export const sandboxCommandTimeoutMs = (timeoutMs?: number) =>
  Math.min(maxSandboxCommandTimeoutMs, positiveOr(timeoutMs, defaultSandboxCommandTimeoutMs))

export const validateSandboxCommand = (command: string) => {
  if (command.trim().length === 0) {
    return Effect.fail(
      new SandboxInputError({
        cause: 'empty_command',
        message: 'Sandbox command must not be empty'
      })
    )
  }

  return Effect.succeed(command)
}

export const normalizeWorkspaceCwd = (
  cwd?: string | null
): Effect.Effect<string, SandboxInputError> => {
  if (cwd === undefined || cwd === null || cwd.trim().length === 0) {
    return Effect.succeed('.')
  }

  const trimmed = cwd.trim()

  if (trimmed.startsWith('/') || trimmed.includes('\0')) {
    return Effect.fail(
      new SandboxInputError({
        cause: 'invalid_cwd',
        message: 'cwd must be workspace-relative'
      })
    )
  }

  const parts: Array<string> = []

  for (const segment of trimmed.split('/')) {
    if (segment.length === 0 || segment === '.') {
      continue
    }

    if (segment === '..') {
      const previous = parts.pop()
      if (previous === undefined) {
        return Effect.fail(
          new SandboxInputError({
            cause: 'invalid_cwd',
            message: 'cwd must not escape the workspace'
          })
        )
      }
      continue
    }

    parts.push(segment)
  }

  return Effect.succeed(parts.length === 0 ? '.' : parts.join('/'))
}

export const absoluteSandboxCwd = (workspaceRoot: string, normalizedCwd: string) =>
  normalizedCwd === '.' ? workspaceRoot : `${workspaceRoot}/${normalizedCwd}`

export const initialSandboxState = (input: {
  readonly name: string
  readonly nowMs: number
  readonly lifecycle: SandboxLifecycle
}) => {
  switch (input.lifecycle._tag) {
    case 'Disposable':
      return VercelSandboxState.make({
        name: input.name,
        createdAtMs: input.nowMs,
        lastUsedAtMs: input.nowMs,
        expiresAtMs: input.nowMs + input.lifecycle.idleTtlMs,
        maxExpiresAtMs: input.nowMs + input.lifecycle.maxLifetimeMs
      })
    case 'Persistent':
      return VercelSandboxState.make({
        name: input.name,
        createdAtMs: input.nowMs,
        lastUsedAtMs: input.nowMs,
        expiresAtMs: input.nowMs + input.lifecycle.idleTtlMs,
        maxExpiresAtMs: Number.MAX_SAFE_INTEGER
      })
  }
}

export const touchSandboxState = (input: {
  readonly state: SandboxState
  readonly nowMs: number
  readonly lifecycle: SandboxLifecycle
}) => {
  switch (input.lifecycle._tag) {
    case 'Disposable':
      return VercelSandboxState.make({
        ...input.state,
        lastUsedAtMs: input.nowMs,
        expiresAtMs: Math.min(input.nowMs + input.lifecycle.idleTtlMs, input.state.maxExpiresAtMs)
      })
    case 'Persistent':
      return VercelSandboxState.make({
        ...input.state,
        lastUsedAtMs: input.nowMs,
        expiresAtMs: input.nowMs + input.lifecycle.idleTtlMs
      })
  }
}

export const sandboxTimeoutExtendDeltaMs = (input: {
  readonly before: SandboxState
  readonly after: SandboxState
}) => Math.max(0, input.after.expiresAtMs - input.before.expiresAtMs)

export const sandboxStateDecision = (input: {
  readonly state: Option.Option<SandboxState>
  readonly name: string
  readonly nowMs: number
}): SandboxStateDecision => {
  if (Option.isNone(input.state)) {
    return { _tag: 'Create', workspaceReset: false }
  }

  const state = input.state.value

  if (state.name !== input.name) {
    return { _tag: 'Create', workspaceReset: true, reason: 'name_mismatch' }
  }

  if (input.nowMs >= state.maxExpiresAtMs) {
    return { _tag: 'Create', workspaceReset: true, reason: 'max_expired' }
  }

  if (input.nowMs >= state.expiresAtMs) {
    return { _tag: 'Create', workspaceReset: true, reason: 'idle_expired' }
  }

  return { _tag: 'UseExisting', state }
}
