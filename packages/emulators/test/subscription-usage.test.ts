/**
 * Subscription-usage routes on the Anthropic, Codex, and Grok emulators: each is served by the
 * wire emulator's fetch handler on the same origin but keeps its own manifest, ledger, faults,
 * turns, coverage, and control plane (`/_emulate/usage/*`); the wire route's manifest, coverage,
 * and top-level APIs are unchanged.
 */
import { describe, expect, it } from 'vitest'
import {
  anthropicEmulatorRoutes,
  AnthropicEmulatorInputInvalid,
  anthropicSubscriptionUsageDefault,
  anthropicSubscriptionUsageEmulatorRoutes,
  anthropicSubscriptionUsagePath,
  makeAnthropicEmulator
} from '../src/anthropic.ts'
import {
  codexEmulatorRoutes,
  codexSubscriptionUsageDefault,
  codexSubscriptionUsageEmulatorRoutes,
  codexSubscriptionUsagePath,
  makeCodexEmulator
} from '../src/codex.ts'
import { emulatorEvidenceHeader } from '../src/route-evidence.ts'
import type { SubscriptionUsageEmulator } from '../src/subscription-usage.ts'
import {
  makeXAiGrokEmulator,
  xAiGrokEmulatorRoutes,
  xAiGrokSubscriptionUsageDefault,
  xAiGrokSubscriptionUsageEmulatorRoutes,
  xAiGrokSubscriptionUsagePath
} from '../src/xai.ts'

type UsageHost = {
  readonly fetch: (request: Request) => Promise<Response>
  readonly reset: () => void
  readonly usage: SubscriptionUsageEmulator
  readonly ledger: { readonly entries: () => ReadonlyArray<unknown> }
  readonly coverage: () => { readonly routes: ReadonlyArray<{ readonly path: string }> }
}

const claudeHeaders = {
  authorization: 'Bearer synthetic-claude-token',
  'anthropic-beta': 'oauth-2025-04-20'
}

const codexHeaders = {
  authorization: 'Bearer synthetic-codex-token',
  'chatgpt-account-id': 'synthetic-account'
}

const grokHeaders = {
  authorization: 'Bearer synthetic-grok-token',
  'x-xai-token-auth': 'xai-grok-cli',
  'x-userid': 'synthetic-user',
  'x-grok-client-version': '0.0.0-synthetic',
  'x-grok-client-mode': 'headless'
}

const get = (host: UsageHost, url: string, headers: Record<string, string>) =>
  host.fetch(new Request(url, { headers }))

const control = (host: UsageHost, method: string, url: string, body?: unknown) =>
  host.fetch(
    new Request(url, {
      method,
      headers: { 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body)
    })
  )

const families = [
  {
    name: 'Claude',
    make: makeAnthropicEmulator,
    origin: 'https://api.anthropic.com',
    url: `https://api.anthropic.com${anthropicSubscriptionUsagePath}`,
    headers: claudeHeaders,
    body: anthropicSubscriptionUsageDefault,
    routes: anthropicSubscriptionUsageEmulatorRoutes,
    wireRoutes: anthropicEmulatorRoutes,
    recorded: { 'anthropic-beta': 'oauth-2025-04-20' }
  },
  {
    name: 'Codex',
    make: makeCodexEmulator,
    origin: 'https://chatgpt.com',
    url: `https://chatgpt.com${codexSubscriptionUsagePath}`,
    headers: codexHeaders,
    body: codexSubscriptionUsageDefault,
    routes: codexSubscriptionUsageEmulatorRoutes,
    wireRoutes: codexEmulatorRoutes,
    recorded: {}
  },
  {
    name: 'Grok',
    make: makeXAiGrokEmulator,
    origin: 'https://cli-chat-proxy.grok.com',
    url: `https://cli-chat-proxy.grok.com${xAiGrokSubscriptionUsagePath}?format=credits`,
    headers: grokHeaders,
    body: xAiGrokSubscriptionUsageDefault,
    routes: xAiGrokSubscriptionUsageEmulatorRoutes,
    wireRoutes: xAiGrokEmulatorRoutes,
    recorded: { 'x-grok-client-version': '0.0.0-synthetic', 'x-grok-client-mode': 'headless' }
  }
] as const

describe.each(families)('$name subscription-usage route', family => {
  it('answers the default snapshot, evidence-tagged, in its own ledger', async () => {
    const host: UsageHost = family.make()
    const response = await get(host, family.url, family.headers)

    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toBe('application/json')
    expect(response.headers.get(emulatorEvidenceHeader)).toBe('unverified')
    expect(await response.json()).toEqual(family.body)
    expect(host.usage.ledger.entries()).toMatchObject([
      {
        seq: 1,
        method: 'GET',
        path: family.routes[0]?.path,
        credentialHeader: 'authorization',
        headers: family.recorded,
        evidence: 'unverified',
        status: 200,
        bodyChunks: 1
      }
    ])
    // The wire route's ledger and coverage are untouched.
    expect(host.ledger.entries()).toEqual([])
    expect(host.coverage().routes.map(route => route.path)).toEqual(
      family.wireRoutes.map(route => route.path)
    )
    expect(host.usage.coverage()).toEqual({
      routes: family.routes.map(route => ({ ...route, requests: 1 })),
      unknownRouteRequests: 0
    })
  })

  it('never records credential or account values', async () => {
    const host: UsageHost = family.make()

    await get(host, family.url, family.headers)

    const recorded = JSON.stringify(host.usage.ledger.entries())

    expect(recorded).not.toContain('synthetic-claude-token')
    expect(recorded).not.toContain('synthetic-codex-token')
    expect(recorded).not.toContain('synthetic-grok-token')
    expect(recorded).not.toContain('synthetic-account')
    expect(recorded).not.toContain('synthetic-user')
    expect(recorded).not.toContain('xai-grok-cli')
  })

  it('refuses a missing bearer with 401', async () => {
    const host: UsageHost = family.make()
    const { authorization: _authorization, ...rest } = family.headers

    expect((await get(host, family.url, rest)).status).toBe(401)
    expect(
      (await get(host, family.url, { ...family.headers, authorization: 'Basic abc' })).status
    ).toBe(401)
  })

  it('answers scripted snapshots and errors, then the default', async () => {
    const host: UsageHost = family.make()

    host.usage.script.enqueue({ usage: { scripted: true } })
    host.usage.script.enqueue({
      error: { status: 503, body: { error: { message: 'synthetic' } } }
    })

    expect(await (await get(host, family.url, family.headers)).json()).toEqual({ scripted: true })
    expect((await get(host, family.url, family.headers)).status).toBe(503)
    expect(await (await get(host, family.url, family.headers)).json()).toEqual(family.body)
    expect(host.usage.ledger.entries().map(entry => entry.scripted)).toEqual([
      'usage',
      'error',
      undefined
    ])
  })

  it('applies usage faults to the usage route only, through /_emulate/usage/*', async () => {
    const host: UsageHost = family.make()

    const added = await control(host, 'POST', `${family.origin}/_emulate/usage/faults`, {
      kind: 'status',
      status: 429,
      headers: { 'retry-after': '7' },
      count: 1
    })

    expect(added.status).toBe(201)

    const limited = await get(host, family.url, family.headers)

    expect(limited.status).toBe(429)
    expect(limited.headers.get('retry-after')).toBe('7')
    expect((await get(host, family.url, family.headers)).status).toBe(200)

    host.usage.faults.add({ kind: 'truncate-after-chunks', chunks: 0, count: 1 })

    expect(await (await get(host, family.url, family.headers)).text()).toBe('')

    const ledger = await (
      await control(host, 'GET', `${family.origin}/_emulate/usage/ledger`)
    ).json()

    expect(ledger.entries.map((entry: { fault?: string }) => entry.fault)).toEqual([
      'status',
      undefined,
      'truncate-after-chunks'
    ])
    expect(host.ledger.entries()).toEqual([])

    // The wire control plane is still the top-level one; reset clears both parts.
    expect((await control(host, 'GET', `${family.origin}/_emulate/state`)).status).toBe(200)
    expect((await control(host, 'POST', `${family.origin}/_emulate/reset`)).status).toBe(200)
    expect(host.usage.ledger.entries()).toEqual([])

    host.usage.script.enqueue({ usage: {} })
    host.reset()

    expect(host.usage.script.pending()).toBe(0)
  })

  it('fails other methods on the usage path closed in the usage ledger', async () => {
    const host: UsageHost = family.make()

    const response = await host.fetch(
      new Request(family.url, { method: 'POST', headers: family.headers, body: '{}' })
    )

    expect(response.status).toBe(404)
    expect(host.usage.ledger.entries()).toMatchObject([{ evidence: 'unknown-route' }])
  })

  it('takes a default body from the options', async () => {
    const host: UsageHost = family.make({ subscriptionUsage: { custom: 1 } })

    expect(await (await get(host, family.url, family.headers)).json()).toEqual({ custom: 1 })
  })
})

describe('usage auth and header rules', () => {
  it('Claude requires the OAuth anthropic-beta value', async () => {
    const host = makeAnthropicEmulator()
    const url = `https://api.anthropic.com${anthropicSubscriptionUsagePath}`

    const betaHeaders: ReadonlyArray<Record<string, string>> = [
      { authorization: claudeHeaders.authorization },
      { authorization: claudeHeaders.authorization, 'anthropic-beta': 'prompt-caching-2024-07-31' }
    ]

    for (const headers of betaHeaders) {
      const response = await get(host, url, headers)

      expect(response.status).toBe(401)
      expect(await response.json()).toMatchObject({
        type: 'error',
        error: { type: 'authentication_error' }
      })
    }

    expect(
      (
        await get(host, url, {
          ...claudeHeaders,
          'anthropic-beta': 'prompt-caching-2024-07-31, oauth-2025-04-20'
        })
      ).status
    ).toBe(200)
    expect(() => host.usage.faults.add({ kind: 'status', status: 301 })).toThrow(
      AnthropicEmulatorInputInvalid
    )
  })

  it('Codex requires ChatGPT-Account-Id', async () => {
    const host = makeCodexEmulator()
    const url = `https://chatgpt.com${codexSubscriptionUsagePath}`

    const response = await get(host, url, { authorization: codexHeaders.authorization })

    expect(response.status).toBe(401)
    expect(await response.json()).toMatchObject({ error: { code: 'missing_account_id' } })
  })

  it('Grok requires token auth, user id, and client version in order, then format=credits', async () => {
    const host = makeXAiGrokEmulator()
    const base = `https://cli-chat-proxy.grok.com${xAiGrokSubscriptionUsagePath}`
    const url = `${base}?format=credits`

    const without = (name: keyof typeof grokHeaders) =>
      Object.fromEntries(Object.entries(grokHeaders).filter(([key]) => key !== name))

    expect((await get(host, url, without('x-xai-token-auth'))).status).toBe(401)
    expect(await (await get(host, url, without('x-userid'))).json()).toMatchObject({
      error: { code: 'missing_user_id' }
    })
    expect((await get(host, url, without('x-grok-client-version'))).status).toBe(426)
    // The client mode is recorded, not required.
    expect((await get(host, url, without('x-grok-client-mode'))).status).toBe(200)
    expect((await get(host, base, grokHeaders)).status).toBe(400)
    expect((await get(host, `${base}?format=usd`, grokHeaders)).status).toBe(400)
    expect(host.usage.ledger.entries().at(-1)).toMatchObject({ query: '?format=usd', status: 400 })
  })
})
