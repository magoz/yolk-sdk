/**
 * Recordings parity for the fixture-only routes: for every OpenCode Go fixture and every
 * subscription-usage fixture, the fixture's recorded request (plus the credential and headers the
 * SDK sends, which recordings never keep) is sent to the emulator and the response is compared
 * with the recording: the status, the `content-type`, the SSE event kinds in order (event name and
 * payload `type`), each event's and body's field names and value types (its outline), and the
 * error-free envelope keys; the default content must also equal the fixture byte for byte (the
 * emulator copies it as data). A disagreement drill proves the comparison catches drift. Tests may
 * import SDK packages; the emulator source never does.
 */
import { Predicate } from 'effect'
import type * as Schema from 'effect/Schema'
import { describe, expect, it } from 'vitest'
import { anthropicClaudeUsageSnapshotFixture } from '@yolk-sdk/agent/providers/anthropic/conformance'
import { openAiCodexUsageSnapshotFixture } from '@yolk-sdk/agent/providers/openai/conformance'
import { openCodeGoConformanceFixtures } from '@yolk-sdk/agent/providers/opencode/conformance'
import { xAiGrokUsageSnapshotFixture } from '@yolk-sdk/agent/providers/xai/conformance'
import {
  isWireStreamResponse,
  type WireFixture,
  type WireResponse
} from '@yolk-sdk/conformance/fixture'
import { makeAnthropicEmulator } from '../src/anthropic.ts'
import { makeCodexEmulator } from '../src/codex.ts'
import { isJsonObject } from '../src/emulator-kernel.ts'
import { makeOpenCodeGoEmulator } from '../src/opencode.ts'
import { openCodeGoRecordings } from '../src/opencode-recordings.ts'
import {
  anthropicClaudeUsageRecording,
  codexUsageRecording,
  xAiGrokUsageRecording
} from '../src/subscription-usage-recordings.ts'
import { makeXAiGrokEmulator } from '../src/xai.ts'

/** Field names and value types of a JSON value, keys sorted. */
type Outline = string | ReadonlyArray<Outline> | { readonly [key: string]: Outline }

const outlineOf = (value: Schema.Json): Outline => {
  if (value === null) return 'null'

  if (Predicate.isString(value)) return 'string'

  if (Predicate.isNumber(value)) return 'number'

  if (Predicate.isBoolean(value)) return 'boolean'

  if (Array.isArray(value)) return value.map(outlineOf)

  return Object.fromEntries(
    Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([field, entry]) => [field, outlineOf(entry)])
  )
}

const parseJson = (text: string): Schema.Json => JSON.parse(text)

type Answer = {
  readonly status: number
  readonly contentType: string | undefined
  /** Per SSE event: `event:` name, payload `type`, and payload outline; or the body outline. */
  readonly events: ReadonlyArray<string>
  readonly text: string
}

const typeOf = (value: Schema.Json): string => {
  const type = isJsonObject(value) ? value.type : undefined

  return Predicate.isString(type) ? type : '-'
}

const eventsOf = (text: string, streamed: boolean): ReadonlyArray<string> => {
  if (!streamed) return [JSON.stringify(outlineOf(parseJson(text)))]

  return text
    .replace(/\r\n?/g, '\n')
    .split('\n\n')
    .filter(block => block.trim().length > 0)
    .map(block => {
      const lines = block.split('\n')

      const event = lines
        .find(line => line.startsWith('event:'))
        ?.slice('event:'.length)
        .trim()

      const data = lines
        .filter(line => line.startsWith('data:'))
        .map(line => line.slice('data:'.length).trim())
        .join('\n')

      if (data === '[DONE]') return `${event ?? '-'} [DONE]`

      const json = parseJson(data)

      return `${event ?? '-'} ${typeOf(json)} ${JSON.stringify(outlineOf(json))}`
    })
}

const recordedAnswer = (response: WireResponse): Answer => {
  const streamed = isWireStreamResponse(response)

  const text = streamed
    ? response.chunks
        .map(chunk => (Predicate.isString(chunk) ? chunk : expect.fail('text')))
        .join('')
    : 'body' in response && Predicate.isString(response.body)
      ? response.body
      : expect.fail('text body only')

  return {
    status: response.status,
    contentType: response.headers['content-type'],
    events: eventsOf(text, streamed),
    text
  }
}

const observedAnswer = async (response: Response, streamed: boolean): Promise<Answer> => {
  const text = await response.text()

  return {
    status: response.status,
    contentType: response.headers.get('content-type') ?? undefined,
    events: eventsOf(text, streamed),
    text
  }
}

/** The recorded request as a web `Request`, with the SDK's credential and extra headers. */
const replayRequest = (fixture: WireFixture, headers: Readonly<Record<string, string>>) => {
  const request = fixture.exchanges[0].request

  return new Request(request.url, {
    method: request.method,
    headers: { ...request.headers, ...headers },
    body: request.body === undefined ? undefined : JSON.stringify(request.body)
  })
}

const goHeaders = (fixture: WireFixture): Readonly<Record<string, string>> =>
  fixture.caseId.startsWith('opencode.go.messages')
    ? { 'x-api-key': 'synthetic-go-key', 'anthropic-version': '2023-06-01' }
    : { authorization: 'Bearer synthetic-go-key' }

type ParityEntry = {
  readonly fixture: WireFixture
  readonly fetch: (request: Request) => Promise<Response>
  readonly headers: Readonly<Record<string, string>>
}

const usageFamilies: ReadonlyArray<ParityEntry> = [
  {
    fixture: anthropicClaudeUsageSnapshotFixture,
    fetch: (request: Request) => makeAnthropicEmulator().fetch(request),
    headers: { authorization: 'Bearer synthetic', 'anthropic-beta': 'oauth-2025-04-20' }
  },
  {
    fixture: openAiCodexUsageSnapshotFixture,
    fetch: (request: Request) => makeCodexEmulator().fetch(request),
    headers: { authorization: 'Bearer synthetic', 'chatgpt-account-id': 'synthetic-account' }
  },
  {
    fixture: xAiGrokUsageSnapshotFixture,
    fetch: (request: Request) => makeXAiGrokEmulator().fetch(request),
    headers: {
      authorization: 'Bearer synthetic',
      'x-xai-token-auth': 'xai-grok-cli',
      'x-userid': 'synthetic-user',
      'x-grok-client-version': '0.0.0-synthetic',
      'x-grok-client-mode': 'headless'
    }
  }
]

const parity: ReadonlyArray<ParityEntry> = [
  ...openCodeGoConformanceFixtures.map(fixture => ({
    fixture,
    fetch: (request: Request) => makeOpenCodeGoEmulator().fetch(request),
    headers: goHeaders(fixture)
  })),
  ...usageFamilies
]

const expectParity = (observed: Answer, recorded: Answer, label: string) => {
  expect(observed.status, `${label} status`).toBe(recorded.status)
  expect(observed.contentType, `${label} content-type`).toBe(recorded.contentType)
  expect(observed.events, `${label} event kinds, order, and field names`).toEqual(recorded.events)
  expect(observed.text, `${label} content`).toBe(recorded.text)
}

describe('fixture-only routes answer exactly their recordings', () => {
  it('covers every Go fixture and every usage fixture', () => {
    expect(parity.map(entry => entry.fixture.caseId)).toEqual([
      'opencode.go.chat.stream.plain-text',
      'opencode.go.messages.stream.plain-text',
      'opencode.go.responses.stream.plain-text',
      'opencode.go.responses.stream.commentary-replay',
      'opencode.go.usage.snapshot',
      'anthropic.claude.usage.snapshot',
      'openai.codex.usage.snapshot',
      'xai.grok.usage.snapshot'
    ])
  })

  for (const entry of parity) {
    it(`matches ${entry.fixture.id}`, async () => {
      const recorded = recordedAnswer(entry.fixture.exchanges[0].response)
      const streamed = isWireStreamResponse(entry.fixture.exchanges[0].response)

      const observed = await observedAnswer(
        await entry.fetch(replayRequest(entry.fixture, entry.headers)),
        streamed
      )

      expectParity(observed, recorded, entry.fixture.id)
    })
  }

  it('keeps the emulator data copies equal to the committed fixtures', () => {
    const copies = [
      ...openCodeGoRecordings,
      anthropicClaudeUsageRecording,
      codexUsageRecording,
      xAiGrokUsageRecording
    ]

    expect(copies.map(copy => copy.fixtureId)).toEqual(parity.map(entry => entry.fixture.id))

    for (const [index, copy] of copies.entries()) {
      const fixture = parity[index]?.fixture ?? expect.fail('no fixture')
      const exchange = fixture.exchanges[0]
      const url = new URL(exchange.request.url)

      const expected = {
        method: exchange.request.method,
        path: url.pathname,
        query: url.search,
        headers: exchange.request.headers ?? {}
      }

      expect(copy.request, copy.fixtureId).toEqual(
        exchange.request.body === undefined
          ? expected
          : { ...expected, body: exchange.request.body }
      )
      expect(copy.response.status).toBe(exchange.response.status)
      expect(copy.response.headers).toEqual(exchange.response.headers)
      expect(copy.response.streamed).toBe(isWireStreamResponse(exchange.response))
      expect(copy.response.chunks.join('')).toBe(recordedAnswer(exchange.response).text)
    }
  })

  it('catches drift: a response whose field names differ from the recording fails parity', async () => {
    const [first] = parity
    const fixture = first?.fixture ?? expect.fail('no fixture')
    const recorded = recordedAnswer(fixture.exchanges[0].response)

    const drifted: Answer = {
      ...recorded,
      events: recorded.events.map((event, index) =>
        index === 1 ? event.replace('"content"', '"text"') : event
      )
    }

    expect(drifted.events).not.toEqual(recorded.events)
    expect(() => expectParity(drifted, recorded, fixture.id)).toThrow(/field names/)
  })
})
