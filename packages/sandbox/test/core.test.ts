import { Effect, Option } from 'effect'
import * as Schema from 'effect/Schema'
import { describe, expect, it } from '@effect/vitest'
import {
  CloudflareSandboxState,
  defaultSandboxLifecycle,
  makeSandboxName,
  GitSandboxBasicAuth,
  makeVercelSandboxName,
  normalizeWorkspaceCwd,
  PersistentSandboxLifecycle,
  sandboxCommandTimeoutMs,
  SandboxSnapshotRetention,
  sandboxStateDecision,
  touchSandboxState,
  VercelSandboxState
} from '../src/index.ts'

describe('sandbox core', () => {
  it('builds deterministic Vercel names', () => {
    expect(makeVercelSandboxName('user_1:session_1')).toBe(
      makeVercelSandboxName('user_1:session_1')
    )
    expect(makeVercelSandboxName('user_1:session_1')).toMatch(/^sandbox-[a-z0-9]+$/)
  })

  it.effect('normalizes workspace cwd', () =>
    Effect.gen(function* () {
      yield* normalizeWorkspaceCwd(undefined).pipe(Effect.map(value => expect(value).toBe('.')))
      yield* normalizeWorkspaceCwd('packages/../examples/next').pipe(
        Effect.map(value => expect(value).toBe('examples/next'))
      )
    })
  )

  it.effect('rejects workspace escapes', () =>
    Effect.gen(function* () {
      const absolute = yield* normalizeWorkspaceCwd('/tmp').pipe(Effect.result)
      const escape = yield* normalizeWorkspaceCwd('../outside').pipe(Effect.result)

      expect(absolute._tag).toBe('Failure')
      expect(escape._tag).toBe('Failure')
    })
  )

  it('caps command timeouts', () => {
    expect(sandboxCommandTimeoutMs(undefined)).toBe(120_000)
    expect(sandboxCommandTimeoutMs(999_000)).toBe(600_000)
    expect(sandboxCommandTimeoutMs(1_500)).toBe(1_500)
  })

  it.effect('validates Git auth and snapshot retention boundaries', () =>
    Effect.gen(function* () {
      const auth = yield* Schema.decodeUnknownEffect(GitSandboxBasicAuth)({
        username: 'git-user',
        password: 'git-password'
      })

      const retention = yield* Schema.decodeUnknownEffect(SandboxSnapshotRetention)({ count: 10 })

      const tooMany = yield* Schema.decodeUnknownEffect(SandboxSnapshotRetention)({
        count: 11
      }).pipe(Effect.result)

      expect(auth.username).toBe('git-user')
      expect(retention.count).toBe(10)
      expect(tooMany._tag).toBe('Failure')
    })
  )

  it('detects idle and max expiry', () => {
    const state = VercelSandboxState.make({
      name: 'sandbox-a',
      createdAtMs: 0,
      lastUsedAtMs: 0,
      expiresAtMs: 100,
      maxExpiresAtMs: 200
    })

    const existing = sandboxStateDecision({
      state: Option.some(state),
      name: 'sandbox-a',
      nowMs: 50,
      lifecycle: defaultSandboxLifecycle
    })

    const idleExpired = sandboxStateDecision({
      state: Option.some(state),
      name: 'sandbox-a',
      nowMs: 150,
      lifecycle: defaultSandboxLifecycle
    })

    const maxExpired = sandboxStateDecision({
      state: Option.some(state),
      name: 'sandbox-a',
      nowMs: 250,
      lifecycle: defaultSandboxLifecycle
    })

    expect(existing._tag).toBe('UseExisting')
    expect(idleExpired._tag).toBe('Create')
    expect(idleExpired).toMatchObject({
      workspaceReset: true,
      reason: 'idle_expired'
    })
    expect(maxExpired._tag).toBe('Create')
    expect(maxExpired).toMatchObject({
      workspaceReset: true,
      reason: 'max_expired'
    })
  })

  it('reattaches expired persistent state', () => {
    const state = VercelSandboxState.make({
      name: 'sandbox-a',
      createdAtMs: 0,
      lastUsedAtMs: 0,
      expiresAtMs: 100,
      maxExpiresAtMs: Number.MAX_SAFE_INTEGER
    })

    const lifecycle = PersistentSandboxLifecycle.make({ idleTtlMs: 100 })

    const decision = sandboxStateDecision({
      state: Option.some(state),
      name: 'sandbox-a',
      nowMs: 150,
      lifecycle
    })

    expect(decision._tag).toBe('UseExisting')
    expect(decision).toMatchObject({ state })
  })

  it('touches disposable state without exceeding max lifetime', () => {
    const state = VercelSandboxState.make({
      name: 'sandbox-a',
      createdAtMs: 0,
      lastUsedAtMs: 0,
      expiresAtMs: 100,
      maxExpiresAtMs: 250
    })

    const touched = touchSandboxState({ state, nowMs: 200, lifecycle: defaultSandboxLifecycle })

    expect(touched.lastUsedAtMs).toBe(200)
    expect(touched.expiresAtMs).toBe(250)
  })

  it('names Vercel and Cloudflare sandboxes alike', () => {
    expect(makeSandboxName('user_1:session_1')).toBe(makeVercelSandboxName('user_1:session_1'))
  })

  it('touching a Cloudflare state keeps its variant and boot id', () => {
    const state = CloudflareSandboxState.make({
      name: 'sandbox-a',
      bootId: 'boot-1',
      createdAtMs: 0,
      lastUsedAtMs: 0,
      expiresAtMs: 100,
      maxExpiresAtMs: 300
    })

    const touched = touchSandboxState({ state, nowMs: 250, lifecycle: defaultSandboxLifecycle })

    expect(touched).toEqual(
      CloudflareSandboxState.make({
        name: 'sandbox-a',
        bootId: 'boot-1',
        createdAtMs: 0,
        lastUsedAtMs: 250,
        expiresAtMs: 300,
        maxExpiresAtMs: 300
      })
    )
  })

  it('stored state of another provider recreates', () => {
    const state = VercelSandboxState.make({
      name: 'sandbox-a',
      createdAtMs: 0,
      lastUsedAtMs: 0,
      expiresAtMs: 100,
      maxExpiresAtMs: 300
    })

    const input = { state: Option.some(state), name: 'sandbox-a', nowMs: 1 }

    expect(
      sandboxStateDecision({ ...input, lifecycle: defaultSandboxLifecycle, provider: 'Cloudflare' })
    ).toEqual({ _tag: 'Create', workspaceReset: true, reason: 'provider_mismatch' })
    expect(
      sandboxStateDecision({ ...input, lifecycle: defaultSandboxLifecycle, provider: 'Vercel' })
    ).toMatchObject({ _tag: 'UseExisting' })
  })
})
