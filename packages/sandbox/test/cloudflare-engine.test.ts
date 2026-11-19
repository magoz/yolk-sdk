import { describe, expect, it } from 'vitest'
import { cloudflareSandboxScripts } from '../src/cloudflare/engine.ts'
import {
  CloudflareSandboxSourceSpec,
  type CloudflareSandboxContainerSpec,
  type CloudflareSandboxReply,
  type CloudflareSandboxRunInput
} from '../src/cloudflare/protocol.ts'
import { makeFakeContainer, makeFakeStorage, makeTestEngine } from './cloudflare-fakes.ts'

const spec = (overrides: Partial<CloudflareSandboxContainerSpec> = {}) => {
  const base: CloudflareSandboxContainerSpec = {
    image: 'SessionSandbox',
    instance: { vcpu: 2, memoryMib: 4096, diskMb: 16384 },
    env: { AGENT_BROWSER_EXECUTABLE_PATH: '/usr/bin/chromium' },
    internet: true,
    workspaceRoot: '/workspace',
    source: CloudflareSandboxSourceSpec.Empty(),
    idleTtlMs: 60_000,
    maxLifetimeMs: 120_000
  }

  return { ...base, ...overrides }
}

const runInput = (
  overrides: Partial<CloudflareSandboxRunInput> = {}
): CloudflareSandboxRunInput => ({
  container: spec(),
  fresh: false,
  command: 'echo hi',
  cwd: '/workspace',
  timeoutMs: 5_000,
  background: false,
  maxOutputBytes: 1_024,
  ...overrides
})

const ok = <A>(reply: CloudflareSandboxReply<A>) => {
  if (!reply.ok) throw new Error(`expected ok reply, got ${reply.kind}: ${reply.message}`)

  return reply
}

describe('Cloudflare sandbox engine', () => {
  it('starts the configured image once and runs commands with env, cwd and stdin', async () => {
    const container = makeFakeContainer({
      command: input => ({
        exitCode: 3,
        stdout: `${input.command}|${input.cwd}|${input.stdin}|${input.env.AGENT_BROWSER_EXECUTABLE_PATH}`,
        stderr: 'warn'
      })
    })

    const { engine } = makeTestEngine({ container })

    const first = ok(await engine.run(runInput({ stdin: 'input', cwd: '/workspace/app' })))
    const second = ok(await engine.run(runInput()))

    expect(first.value).toMatchObject({
      exitCode: 3,
      stdout: 'echo hi|/workspace/app|input|/usr/bin/chromium',
      stderr: 'warn',
      timedOut: false
    })
    expect(second.boot).toEqual(first.boot)
    expect(container.starts).toEqual([
      {
        image: 'registry.example/session@sha256:abc',
        enableInternet: true,
        env: { AGENT_BROWSER_EXECUTABLE_PATH: '/usr/bin/chromium' },
        instance: { vcpu: 2, memoryMib: 4096, diskMb: 16384 }
      }
    ])
    // Image ENV does not reach exec: every exec carries the configured env.
    expect(container.execs.every(exec => exec.options?.env?.AGENT_BROWSER_EXECUTABLE_PATH)).toBe(
      true
    )
    expect(container.readText('/tmp/yolk-sandbox/boot-id')).toBe(first.boot.bootId)
    expect(container.inactivityTimeouts[0]).toBe(60_000)
  })

  it('reports an unknown image or a missing container as config failures', async () => {
    const unknown = await makeTestEngine({}).engine.run(
      runInput({ container: spec({ image: 'Browser' }) })
    )

    const missing = await makeTestEngine({ noContainer: true }).engine.run(runInput())

    expect(unknown).toMatchObject({ ok: false, kind: 'config' })
    expect(unknown.ok ? '' : unknown.message).toContain('configured: SessionSandbox')
    expect(missing).toMatchObject({ ok: false, kind: 'config' })
  })

  it('kills a command past its timeout, with its process tree, and keeps partial output', async () => {
    const container = makeFakeContainer({ command: () => ({ hang: true, stdout: 'partial' }) })
    const { engine } = makeTestEngine({ container })

    const reply = ok(await engine.run(runInput({ timeoutMs: 30 })))
    const command = container.userExecs()[0]

    expect(reply.value).toMatchObject({ exitCode: null, timedOut: true, stdout: 'partial' })
    expect(container.kills).toEqual([command?.pid])
  })

  it('returns after an exit even when a background child keeps the pipes open', async () => {
    const container = makeFakeContainer({
      command: () => ({ exitCode: 0, stdout: 'started', keepOpen: true })
    })

    const { engine } = makeTestEngine({ container })

    const reply = ok(await engine.run(runInput()))

    expect(reply.value).toMatchObject({ exitCode: 0, timedOut: false, stdout: 'started' })
  })

  it('keeps the first maxOutputBytes of each stream and says how much was dropped', async () => {
    const container = makeFakeContainer({
      command: () => ({ exitCode: 0, stdout: '0123456789', stderr: 'ab' })
    })

    const { engine } = makeTestEngine({ container })

    const reply = ok(await engine.run(runInput({ maxOutputBytes: 4 })))

    expect(reply.value.stdout).toBe('0123\n[output truncated: 6 more bytes]')
    expect(reply.value.stderr).toBe('ab')
  })

  it('transfers files byte for byte and bounds reads', async () => {
    const { engine, container } = makeTestEngine({})
    const bytes = Uint8Array.from([0, 255, 10, 13, 37])
    const request = { container: spec(), fresh: false }

    ok(await engine.writeFile({ ...request, path: '/workspace/a/b.bin', bytes }))

    const found = ok(await engine.readFile({ ...request, path: '/workspace/a/b.bin', maxBytes: 5 }))

    const tooLarge = ok(
      await engine.readFile({ ...request, path: '/workspace/a/b.bin', maxBytes: 4 })
    )

    const missing = ok(await engine.readFile({ ...request, path: '/workspace/none', maxBytes: 4 }))

    expect(container.files.get('/workspace/a/b.bin')).toEqual(bytes)
    expect(found.value).toMatchObject({ _tag: 'Found', bytes })
    expect(tooLarge.value._tag).toBe('TooLarge')
    expect(missing.value._tag).toBe('NotFound')
  })

  it('starts a new boot when asked fresh, after a stop, or for another image', async () => {
    const container = makeFakeContainer({
      images: { SessionSandbox: 'session@sha256:1', Browser: 'browser@sha256:2' }
    })

    const { engine } = makeTestEngine({ container })

    const first = ok(await engine.run(runInput())).boot
    const fresh = ok(await engine.run(runInput({ fresh: true }))).boot

    container.stop()

    const afterStop = ok(await engine.run(runInput())).boot
    const browser = ok(await engine.run(runInput({ container: spec({ image: 'Browser' }) }))).boot

    expect(new Set([first.bootId, fresh.bootId, afterStop.bootId, browser.bootId]).size).toBe(4)
    expect(container.destroys()).toBe(2)
    expect(container.starts.map(start => start.image)).toEqual([
      'session@sha256:1',
      'session@sha256:1',
      'session@sha256:1',
      'browser@sha256:2'
    ])
  })

  it('a new object instance reuses the running container only when its boot marker matches', async () => {
    const container = makeFakeContainer()
    const storage = makeFakeStorage()
    const first = ok(await makeTestEngine({ container, storage }).engine.run(runInput())).boot

    const reused = ok(
      await makeTestEngine({ container, storage, idPrefix: 'second' }).engine.run(runInput())
    ).boot

    container.files.delete('/tmp/yolk-sandbox/boot-id')

    const replaced = ok(
      await makeTestEngine({ container, storage, idPrefix: 'third' }).engine.run(runInput())
    ).boot

    expect(reused.bootId).toBe(first.bootId)
    expect(replaced.bootId).not.toBe(first.bootId)
    expect(container.starts).toHaveLength(2)
  })

  it('destroys from the alarm when idle or past max lifetime, not while a command runs', async () => {
    const clock = { now: 1_000 }
    const container = makeFakeContainer()
    const storage = makeFakeStorage()
    const { engine } = makeTestEngine({ container, storage, clock })

    ok(await engine.run(runInput()))

    expect(storage.alarm()).toBe(61_000)

    clock.now = 30_000
    await engine.alarm()

    expect(container.container.running).toBe(true)

    clock.now = 61_000
    await engine.alarm()

    expect(container.container.running).toBe(false)
    expect((await engine.status()).boot).toBeNull()

    // Max lifetime: activity keeps it alive until startedAt + maxLifetime.
    clock.now = 100_000
    const boot = ok(await engine.run(runInput())).boot

    for (const at of [140_000, 180_000, 219_000]) {
      clock.now = at
      ok(await engine.run(runInput()))
      await engine.alarm()
    }

    expect(container.container.running).toBe(true)

    clock.now = boot.startedAtMs + 120_000
    await engine.alarm()

    expect(container.container.running).toBe(false)
  })

  it('a persistent spec has no max lifetime', async () => {
    const clock = { now: 0 }
    const { engine, container } = makeTestEngine({ clock })
    const persistent = spec({ maxLifetimeMs: undefined })

    for (const at of [0, 50_000, 100_000, 150_000]) {
      clock.now = at
      ok(await engine.run(runInput({ container: persistent })))
      await engine.alarm()
    }

    expect(container.starts).toHaveLength(1)
    expect(container.container.running).toBe(true)
  })

  it('returns a background id while the command runs, its output once it finished', async () => {
    const container = makeFakeContainer({
      command: input =>
        input.command === 'serve' ? { hang: true } : { exitCode: 2, stdout: 'quick', stderr: 'e' }
    })

    const { engine } = makeTestEngine({ container })

    const running = ok(await engine.run(runInput({ command: 'serve', background: true })))
    const finished = ok(await engine.run(runInput({ command: 'quick', background: true })))

    expect(running.value).toMatchObject({ exitCode: null, stdout: '', timedOut: false })
    expect(running.value.backgroundId).toMatch(/^bg-/)
    expect(finished.value).toMatchObject({ exitCode: 2, stdout: 'quick', stderr: 'e' })
    expect(finished.value.backgroundId).toBeUndefined()
    expect(container.userExecs()).toHaveLength(0)
  })

  it('clones a Git source with credentials only in the exec environment', async () => {
    const container = makeFakeContainer()
    const { engine } = makeTestEngine({ container })

    const source = CloudflareSandboxSourceSpec.Git({
      url: 'https://github.com/example/private.git',
      auth: { username: 'x-access-token', password: 'secret-token' },
      depth: 1,
      revision: 'main'
    })

    ok(await engine.run(runInput({ container: spec({ source }) })))

    const clone = container.execs.find(exec => exec.argv[2] === cloudflareSandboxScripts.gitClone)

    expect(clone?.argv).toEqual([
      'bash',
      '-c',
      cloudflareSandboxScripts.gitClone,
      'bash',
      '/workspace'
    ])
    expect(clone?.options?.env).toMatchObject({
      YOLK_GIT_URL: 'https://github.com/example/private.git',
      YOLK_GIT_USERNAME: 'x-access-token',
      YOLK_GIT_PASSWORD: 'secret-token',
      YOLK_GIT_DEPTH: '1',
      YOLK_GIT_REVISION: 'main',
      GIT_TERMINAL_PROMPT: '0'
    })
    expect(JSON.stringify(container.starts)).not.toContain('secret-token')
  })

  it('a failed source destroys the half-prepared container and fails the call', async () => {
    const container = makeFakeContainer({ gitExitCode: 128 })
    const { engine, storage } = makeTestEngine({ container })
    const source = CloudflareSandboxSourceSpec.Git({ url: 'https://example.test/missing.git' })

    const reply = await engine.run(runInput({ container: spec({ source }) }))

    expect(reply).toMatchObject({ ok: false, kind: 'provider' })
    expect(reply.ok ? '' : reply.message).toContain('repository not found')
    expect(container.container.running).toBe(false)
    expect(storage.values.size).toBe(0)
  })

  it('downloads a tarball source in the object and unpacks it from stdin', async () => {
    const archive = Uint8Array.from([31, 139, 8, 0])
    const container = makeFakeContainer()
    const fetched: Array<string> = []

    const { engine } = makeTestEngine({
      container,
      fetch: async url => {
        fetched.push(url)

        return new Response(archive)
      }
    })

    const source = CloudflareSandboxSourceSpec.Tarball({ url: 'https://example.test/a.tar.gz' })

    ok(await engine.run(runInput({ container: spec({ source }) })))

    const failing = makeTestEngine({ fetch: async () => new Response('no', { status: 404 }) })
    const failed = await failing.engine.run(runInput({ container: spec({ source }) }))

    expect(fetched).toEqual(['https://example.test/a.tar.gz'])
    expect(container.untarred).toEqual([archive])
    expect(failed).toMatchObject({ ok: false, kind: 'provider' })
    expect(failed.ok ? '' : failed.message).toContain('HTTP 404')
  })

  it('destroy stops the container and forgets the boot', async () => {
    const { engine, container, storage } = makeTestEngine({})

    ok(await engine.run(runInput()))
    await engine.destroy()

    expect(container.container.running).toBe(false)
    expect(storage.values.size).toBe(0)
    expect(storage.alarm()).toBeNull()
    expect(await engine.status()).toEqual({ running: false, boot: null, deadlineMs: null })
  })
})
