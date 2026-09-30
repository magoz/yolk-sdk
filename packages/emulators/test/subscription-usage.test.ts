/**
 * Subscription-usage routes on the Anthropic, Codex, and Grok emulators: fixture-only. A request
 * with the credential, headers, and query the SDK fetcher sends gets the recorded snapshot body;
 * everything else is one ledgered 400 not-emulated that uses up no fault or turn. Each route is
 * served by the model emulator's fetch handler on the same origin but keeps its own manifest,
 * ledger, faults, turns, coverage, and control plane (`/_emulate/usage/*`); the model route's
 * manifest, coverage, and top-level APIs are unchanged.
 */
import { Predicate } from 'effect'
import type * as Schema from 'effect/Schema'
import { describe, expect, it } from 'vitest'
import { anthropicClaudeUsageSnapshotFixture } from '@yolk-sdk/agent/providers/anthropic/conformance'
import { openAiCodexUsageSnapshotFixture } from '@yolk-sdk/agent/providers/openai/conformance'
import { xAiGrokUsageSnapshotFixture } from '@yolk-sdk/agent/providers/xai/conformance'
import type { WireFixture } from '@yolk-sdk/conformance/fixture'
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
  CodexEmulatorInputInvalid,
  codexSubscriptionUsageDefault,
  codexSubscriptionUsageEmulatorRoutes,
  codexSubscriptionUsagePath,
  makeCodexEmulator
} from '../src/codex.ts'
import { emulatorEvidenceHeader, EmulatorRouteUnmapped } from '../src/route-evidence.ts'
import {
  makeSubscriptionUsageEmulator,
  type SubscriptionUsageEmulator
} from '../src/subscription-usage.ts'
import { xAiGrokUsageRecording } from '../src/subscription-usage-recordings.ts'
import {
  makeXAiGrokEmulator,
  xAiGrokEmulatorRoutes,
  XAiGrokEmulatorInputInvalid,
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
  accept: 'application/json',
  authorization: 'Bearer synthetic-claude-token',
  'anthropic-beta': 'oauth-2025-04-20'
}

const codexHeaders = {
  accept: 'application/json',
  authorization: 'Bearer synthetic-codex-token',
  'chatgpt-account-id': 'synthetic-account'
}

const grokHeaders = {
  accept: 'application/json',
  authorization: 'Bearer synthetic-grok-token',
  'x-xai-token-auth': 'xai-grok-cli',
  'x-userid': 'synthetic-user',
  'x-grok-client-version': '0.0.0-synthetic',
  'x-grok-client-mode': 'headless'
}

const get = (host: UsageHost, url: string, headers: Readonly<Record<string, string>>) =>
  host.fetch(new Request(url, { headers }))

const control = (host: UsageHost, method: string, url: string, body?: unknown) =>
  host.fetch(
    new Request(url, {
      method,
      headers: { 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body)
    })
  )

const recordedText = (fixture: WireFixture): string => {
  const response = fixture.exchanges[0].response

  return 'body' in response && Predicate.isString(response.body)
    ? response.body
    : expect.fail(`${fixture.id} has no body`)
}

const without = (headers: Readonly<Record<string, string>>, name: string) =>
  Object.fromEntries(Object.entries(headers).filter(([key]) => key !== name))

const expectNotEmulated = async (response: Response) => {
  expect(response.status).toBe(400)
  expect(await response.json()).toMatchObject({
    error: { type: 'not_emulated', message: expect.stringMatching(/^Not emulated: /) }
  })
}

type Family = {
  readonly name: string
  readonly make: (options?: { readonly subscriptionUsage?: Schema.Json }) => UsageHost
  readonly inputInvalid: new (...args: never) => Error
  readonly origin: string
  readonly url: string
  readonly headers: Readonly<Record<string, string>>
  readonly fixture: WireFixture
  readonly body: Schema.Json
  /** The recorded body with other values (same keys and value kinds). */
  readonly otherValues: Schema.Json
  readonly routes: ReadonlyArray<{ readonly path: string }>
  readonly wireRoutes: ReadonlyArray<{ readonly path: string }>
  readonly recorded: Readonly<Record<string, string>>
  /** Every header the fetcher sends besides `accept`. */
  readonly required: ReadonlyArray<string>
}

const families: ReadonlyArray<Family> = [
  {
    name: 'Claude',
    make: makeAnthropicEmulator,
    inputInvalid: AnthropicEmulatorInputInvalid,
    origin: 'https://api.anthropic.com',
    url: `https://api.anthropic.com${anthropicSubscriptionUsagePath}`,
    headers: claudeHeaders,
    fixture: anthropicClaudeUsageSnapshotFixture,
    body: anthropicSubscriptionUsageDefault,
    otherValues: {
      five_hour: { utilization: 1, resets_at: '2026-10-02T00:00:00.000Z' },
      seven_day: { utilization: 2, resets_at: '2026-10-09T00:00:00.000Z' }
    },
    routes: anthropicSubscriptionUsageEmulatorRoutes,
    wireRoutes: anthropicEmulatorRoutes,
    recorded: { 'anthropic-beta': 'oauth-2025-04-20' },
    required: ['authorization', 'anthropic-beta']
  },
  {
    name: 'Codex',
    make: makeCodexEmulator,
    inputInvalid: CodexEmulatorInputInvalid,
    origin: 'https://chatgpt.com',
    url: `https://chatgpt.com${codexSubscriptionUsagePath}`,
    headers: codexHeaders,
    fixture: openAiCodexUsageSnapshotFixture,
    body: codexSubscriptionUsageDefault,
    otherValues: {
      rate_limit: {
        primary_window: {
          used_percent: 1,
          limit_window_seconds: 1,
          reset_after_seconds: 1,
          reset_at: 1
        },
        secondary_window: {
          used_percent: 2,
          limit_window_seconds: 2,
          reset_after_seconds: 2,
          reset_at: 2
        }
      }
    },
    routes: codexSubscriptionUsageEmulatorRoutes,
    wireRoutes: codexEmulatorRoutes,
    recorded: {},
    required: ['authorization', 'chatgpt-account-id']
  },
  {
    name: 'Grok',
    make: makeXAiGrokEmulator,
    inputInvalid: XAiGrokEmulatorInputInvalid,
    origin: 'https://cli-chat-proxy.grok.com',
    url: `https://cli-chat-proxy.grok.com${xAiGrokSubscriptionUsagePath}?format=credits`,
    headers: grokHeaders,
    fixture: xAiGrokUsageSnapshotFixture,
    body: xAiGrokSubscriptionUsageDefault,
    otherValues: {
      config: {
        creditUsagePercent: 1,
        currentPeriod: { type: 'monthly', start: 'a', end: 'b' }
      }
    },
    routes: xAiGrokSubscriptionUsageEmulatorRoutes,
    wireRoutes: xAiGrokEmulatorRoutes,
    recorded: { 'x-grok-client-version': '0.0.0-synthetic', 'x-grok-client-mode': 'headless' },
    required: [
      'authorization',
      'x-xai-token-auth',
      'x-userid',
      'x-grok-client-version',
      'x-grok-client-mode'
    ]
  }
]

/** One armed fault and one pending turn, to prove a rejection uses up neither. */
const armed = (host: UsageHost) => {
  host.usage.faults.add({ kind: 'status', status: 503, count: 1 })
  host.usage.script.enqueue({ error: { status: 502, body: { error: { message: 'synthetic' } } } })
}

const expectUntouched = (host: UsageHost) => {
  expect(host.usage.faults.list()).toMatchObject([{ remaining: 1, applied: 0 }])
  expect(host.usage.script.pending()).toBe(1)
  expect(host.usage.ledger.entries().at(-1)).toMatchObject({
    status: 400,
    notEmulated: expect.any(String)
  })
  expect(host.ledger.entries()).toEqual([])
}

describe.each(families)('$name subscription-usage route', family => {
  it('answers the recorded snapshot, evidence-tagged, in its own ledger', async () => {
    const host = family.make()
    const response = await get(host, family.url, family.headers)

    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toBe('application/json')
    expect(response.headers.get(emulatorEvidenceHeader)).toBe('unverified')
    expect(await response.text()).toBe(recordedText(family.fixture))
    expect(family.body).toEqual(JSON.parse(recordedText(family.fixture)))
    expect(host.usage.ledger.entries()).toMatchObject([
      {
        seq: 1,
        method: 'GET',
        path: family.routes[0]?.path,
        credentialHeader: 'authorization',
        headers: family.recorded,
        recording: family.fixture.id,
        evidence: 'unverified',
        status: 200,
        bodyChunks: 1
      }
    ])
    // The model route's ledger and coverage are untouched.
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
    const host = family.make()

    await get(host, family.url, family.headers)

    const recorded = JSON.stringify(host.usage.ledger.entries())

    for (const value of [
      'synthetic-claude-token',
      'synthetic-codex-token',
      'synthetic-grok-token',
      'synthetic-account',
      'synthetic-user',
      'xai-grok-cli'
    ]) {
      expect(recorded).not.toContain(value)
    }
  })

  for (const header of ['authorization', 'accept']) {
    it(`answers 400 not-emulated without ${header}, leaving faults and turns untouched`, async () => {
      const host = family.make()

      armed(host)
      await expectNotEmulated(await get(host, family.url, without(family.headers, header)))
      expectUntouched(host)
    })
  }

  it('answers 400 not-emulated when any fetcher header is missing', async () => {
    for (const header of family.required) {
      const host = family.make()

      armed(host)
      await expectNotEmulated(await get(host, family.url, without(family.headers, header)))
      expectUntouched(host)
    }
  })

  it('answers 400 not-emulated for a Basic credential, another query, or another method', async () => {
    const other = new URL(family.url)

    other.searchParams.set('extra', '1')

    for (const send of [
      (host: UsageHost) => get(host, family.url, { ...family.headers, authorization: 'Basic abc' }),
      (host: UsageHost) => get(host, other.toString(), family.headers),
      (host: UsageHost) =>
        host.fetch(new Request(family.url, { method: 'POST', headers: family.headers, body: '{}' }))
    ]) {
      const host = family.make()

      armed(host)
      await expectNotEmulated(await send(host))
      expectUntouched(host)
    }
  })

  it('answers scripted same-shaped bodies and errors, then the recording', async () => {
    const host = family.make()

    host.usage.script.enqueue({ usage: family.otherValues })
    host.usage.script.enqueue({
      error: { status: 503, body: { error: { message: 'synthetic' } } }
    })

    expect(await (await get(host, family.url, family.headers)).json()).toEqual(family.otherValues)
    expect((await get(host, family.url, family.headers)).status).toBe(503)
    expect(await (await get(host, family.url, family.headers)).text()).toBe(
      recordedText(family.fixture)
    )
    expect(host.usage.ledger.entries().map(entry => entry.scripted)).toEqual([
      'usage',
      'error',
      undefined
    ])
  })

  it('refuses bodies whose shape no fixture records, in the JS API and the control plane', async () => {
    const host = family.make()

    expect(() => host.usage.script.enqueue({ usage: { scripted: true } })).toThrow(
      family.inputInvalid
    )
    expect(
      (await control(host, 'POST', `${family.origin}/_emulate/usage/script`, { usage: null }))
        .status
    ).toBe(400)
    expect(host.usage.script.pending()).toBe(0)
    expect(() => family.make({ subscriptionUsage: { custom: 1 } })).toThrow(family.inputInvalid)

    const custom = family.make({ subscriptionUsage: family.otherValues })

    expect(await (await get(custom, family.url, family.headers)).json()).toEqual(family.otherValues)
  })

  it('applies usage faults to the usage route only, through /_emulate/usage/*', async () => {
    const host = family.make()

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

    // The model route's control plane is still the top-level one; reset clears both parts.
    expect((await control(host, 'GET', `${family.origin}/_emulate/state`)).status).toBe(200)
    expect((await control(host, 'POST', `${family.origin}/_emulate/reset`)).status).toBe(200)
    expect(host.usage.ledger.entries()).toEqual([])

    host.usage.script.enqueue({ error: { status: 500, body: 'x' } })
    host.reset()

    expect(host.usage.script.pending()).toBe(0)
  })
})

describe('fixture-only usage route rules', () => {
  const grokUrl = `https://cli-chat-proxy.grok.com${xAiGrokSubscriptionUsagePath}?format=credits`

  it('Grok pins X-XAI-Token-Auth and x-grok-client-mode to the SDK values', async () => {
    for (const headers of [
      { ...grokHeaders, 'x-grok-client-mode': 'interactive' },
      { ...grokHeaders, 'x-xai-token-auth': 'other-client' }
    ]) {
      const host = makeXAiGrokEmulator()

      armed(host)
      await expectNotEmulated(await get(host, grokUrl, headers))
      expectUntouched(host)
    }
  })

  it('Grok accepts any non-empty x-userid and x-grok-client-version (documented latitude)', async () => {
    const host = makeXAiGrokEmulator()

    const response = await get(host, grokUrl, {
      ...grokHeaders,
      'x-userid': 'synthetic-other-user',
      'x-grok-client-version': '9.9.9-synthetic'
    })

    expect(response.status).toBe(200)
  })

  it('matches the recorded query string byte for byte', async () => {
    for (const query of ['?format=cred%69ts', '?format=credits&', '?&format=credits']) {
      const host = makeXAiGrokEmulator()

      armed(host)
      await expectNotEmulated(
        await get(host, grokUrl.replace('?format=credits', query), grokHeaders)
      )
      expectUntouched(host)
    }

    const host = makeAnthropicEmulator()

    await expectNotEmulated(
      await get(
        host,
        `https://api.anthropic.com${anthropicSubscriptionUsagePath}?&&`,
        claudeHeaders
      )
    )
  })

  it('refuses success statuses for faults and scripted errors', () => {
    const host = makeXAiGrokEmulator()

    expect(() => host.usage.faults.add({ kind: 'status', status: 200 })).toThrow(
      XAiGrokEmulatorInputInvalid
    )
    expect(() => host.usage.script.enqueue({ error: { status: 299, body: {} } })).toThrow(
      XAiGrokEmulatorInputInvalid
    )
    expect(host.usage.faults.list()).toEqual([])
    expect(host.usage.script.pending()).toBe(0)
  })

  it('throws EmulatorRouteUnmapped when the manifest does not list the usage path', () => {
    expect(() =>
      makeSubscriptionUsageEmulator({
        path: '/v1/other-usage',
        routes: xAiGrokSubscriptionUsageEmulatorRoutes,
        recording: xAiGrokUsageRecording,
        headers: [],
        subscriptionUsage: undefined,
        inputInvalid: (input, reason) => new XAiGrokEmulatorInputInvalid({ input, reason })
      })
    ).toThrow(EmulatorRouteUnmapped)
  })
})

describe('usage header values', () => {
  it('Claude accepts an anthropic-beta list containing the OAuth value, and nothing else', async () => {
    const host = makeAnthropicEmulator()
    const url = `https://api.anthropic.com${anthropicSubscriptionUsagePath}`

    await expectNotEmulated(
      await get(host, url, { ...claudeHeaders, 'anthropic-beta': 'prompt-caching-2024-07-31' })
    )
    expect(
      (
        await get(host, url, {
          ...claudeHeaders,
          'anthropic-beta': 'prompt-caching-2024-07-31, oauth-2025-04-20'
        })
      ).status
    ).toBe(200)
  })
})
