/**
 * Proof that the Gateway emulator matches the wire: for every verified Gateway fixture, the
 * fixture's recorded request is sent to the emulator and the structural shape of the emulator's
 * response is compared with the recording by `mismatches`. Compared: the status, the
 * `content-type`, the SSE event kinds in order (each event reduced to its outline: field names and
 * value types, including every `provider_metadata` entry; runs of same-shaped events collapsed),
 * where the finish reason and usage sit, that the last network chunk ends with the finish event and
 * `data: [DONE]`, that some network chunk packs several events, and the error envelope's outline.
 * Ignored: ids, text, numbers, and how many content events carry the text. Tests may import SDK
 * packages; the emulator source never does.
 */
import { Encoding, Predicate, Result } from 'effect'
import type * as Schema from 'effect/Schema'
import { describe, expect, it } from 'vitest'
import {
  isWireStreamResponse,
  type WireChunk,
  type WireFixture
} from '@yolk-sdk/conformance/fixture'
import { vercelAiGatewayConformanceFixtures } from '@yolk-sdk/agent/providers/vercel/conformance'
import { gatewayEmulatorRoutes, makeGatewayEmulator, type GatewayEmulator } from '../src/gateway.ts'

/** Field names and value types of a JSON value, keys sorted, array element outlines deduplicated. */
type Outline = string | ReadonlyArray<Outline> | { readonly [key: string]: Outline }

const outlineOf = (value: Schema.Json): Outline => {
  if (value === null) return 'null'

  if (Predicate.isString(value)) return 'string'

  if (Predicate.isNumber(value)) return 'number'

  if (Predicate.isBoolean(value)) return 'boolean'

  if (Array.isArray(value)) {
    const outlines = new Map<string, Outline>()

    for (const element of value) {
      const outline = outlineOf(element)

      outlines.set(JSON.stringify(outline), outline)
    }

    return [...outlines.values()]
  }

  return Object.fromEntries(
    Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([field, entry]) => [field, outlineOf(entry)])
  )
}

const parseJson = (text: string): Schema.Json => JSON.parse(text)

/** One SSE event: `[DONE]`, or the outline of its JSON payload. */
const eventOutline = (data: string): string =>
  data === '[DONE]' ? '[DONE]' : JSON.stringify(outlineOf(parseJson(data)))

const eventData = (text: string): ReadonlyArray<string> =>
  text
    .replace(/\r\n?/g, '\n')
    .split('\n\n')
    .filter(block => block.startsWith('data: '))
    .map(block => block.slice('data: '.length))

/** Event outlines in order, runs of the same outline collapsed to one. */
const eventKinds = (chunks: ReadonlyArray<string>): ReadonlyArray<string> =>
  eventData(chunks.join(''))
    .map(eventOutline)
    .filter((outline, index, outlines) => index === 0 || outlines[index - 1] !== outline)

type EventPlacement = { readonly finish: string | null; readonly usage: boolean } | '[DONE]'

type PlacedEvent = { readonly index: number; readonly placement: EventPlacement }

/** Per event: its finish reason and whether it carries usage. */
const placements = (chunks: ReadonlyArray<string>): ReadonlyArray<EventPlacement> =>
  eventData(chunks.join('')).map(data => {
    if (data === '[DONE]') return '[DONE]'

    const payload: {
      readonly choices: ReadonlyArray<{ readonly finish_reason: string | null }>
      readonly usage?: Schema.Json
    } = JSON.parse(data)

    return {
      finish: payload.choices.find(choice => choice.finish_reason !== null)?.finish_reason ?? null,
      usage: payload.usage !== undefined
    }
  })

/** Where the finish reason, usage, and `[DONE]` sit, in order. */
const finishAndUsage = (chunks: ReadonlyArray<string>): ReadonlyArray<PlacedEvent> =>
  placements(chunks).flatMap((placement, index): ReadonlyArray<PlacedEvent> =>
    placement === '[DONE]' || placement.finish !== null || placement.usage
      ? [{ index, placement }]
      : []
  )

/** The recorded chunk as text (base64 chunks decoded). */
const chunkText = (chunk: WireChunk): string => {
  if (Predicate.isString(chunk)) return chunk

  return new TextDecoder().decode(
    Result.getOrElse(Encoding.decodeBase64(chunk.base64), () => new Uint8Array())
  )
}

/** What the emulator sent: status, `content-type`, and the body's network chunks as text. */
type Observed = {
  readonly status: number
  readonly contentType: string | null
  readonly chunks: ReadonlyArray<string>
}

const observe = async (response: Response): Promise<Observed> => {
  const chunks: Array<string> = []
  const reader = response.body?.getReader()

  if (reader !== undefined) {
    const decoder = new TextDecoder()

    for (;;) {
      const next = await reader.read()

      if (next.done) break

      chunks.push(decoder.decode(next.value))
    }
  }

  return { status: response.status, contentType: response.headers.get('content-type'), chunks }
}

const differ = (left: unknown, right: unknown): boolean =>
  JSON.stringify(left) !== JSON.stringify(right)

/** Structural stream checks that hold for any recorded or emulated Gateway stream. */
const framingMismatches = (label: string, chunks: ReadonlyArray<string>): Array<string> => {
  const found: Array<string> = []
  const all = placements(chunks)
  const [finish, done] = finishAndUsage(chunks)
  const last = eventData(chunks.at(-1) ?? '')

  if (done?.index !== all.length - 1 || finish?.index !== all.length - 2) {
    found.push(`${label}: the finish event is not followed only by [DONE]`)
  }

  if (last.at(-1) !== '[DONE]' || last.length < 2) {
    found.push(`${label}: the last network chunk does not carry the finish event and [DONE]`)
  }

  if (!chunks.some(chunk => eventData(chunk).length > 1)) {
    found.push(`${label}: no network chunk packs several events`)
  }

  return found
}

/** Every structural difference between the fixture's recorded response and `observed`. */
const mismatches = (fixture: WireFixture, observed: Observed): ReadonlyArray<string> => {
  const recorded = fixture.exchanges[0].response
  const found: Array<string> = []

  if (observed.status !== recorded.status) {
    found.push(`status ${observed.status}, recorded ${recorded.status}`)
  }

  if (observed.contentType !== recorded.headers['content-type']) {
    found.push(`content-type ${String(observed.contentType)}`)
  }

  if (!isWireStreamResponse(recorded)) {
    if (!Predicate.isString(recorded.body)) return [...found, 'recorded body is not text']

    const body = Result.try(() => parseJson(observed.chunks.join('')))

    if (Result.isFailure(body)) return [...found, 'body is not JSON']

    if (differ(outlineOf(body.success), outlineOf(parseJson(recorded.body)))) {
      found.push('error envelope outline differs')
    }

    return found
  }

  const recordedChunks = recorded.chunks.map(chunkText)

  if (differ(eventKinds(observed.chunks), eventKinds(recordedChunks))) {
    found.push('event kinds differ')
  }

  const recordedPlacement = finishAndUsage(recordedChunks).map(entry => entry.placement)

  if (
    differ(
      finishAndUsage(observed.chunks).map(entry => entry.placement),
      recordedPlacement
    )
  ) {
    found.push('finish and usage placement differs')
  }

  const beforeDone = recordedPlacement.at(-2)

  if (beforeDone === undefined || beforeDone === '[DONE]' || !beforeDone.usage) {
    found.push('recording: usage is not on the finish event')
  }

  return [
    ...found,
    ...framingMismatches('recording', recordedChunks),
    ...framingMismatches('emulator', observed.chunks)
  ]
}

/** Send the fixture's recorded request (plus a synthetic bearer credential) to the emulator. */
const replay = async (
  fixture: WireFixture,
  emulator: GatewayEmulator = makeGatewayEmulator()
): Promise<Observed> => {
  const [exchange] = fixture.exchanges

  return observe(
    await emulator.fetch(
      new Request(exchange.request.url, {
        method: exchange.request.method,
        headers: { ...exchange.request.headers, authorization: 'Bearer synthetic-gateway-key' },
        body: JSON.stringify(exchange.request.body)
      })
    )
  )
}

const verifiedFixtures = vercelAiGatewayConformanceFixtures.filter(
  fixture => fixture.evidence === 'verified'
)

describe('the Gateway emulator matches the verified recordings', () => {
  it('covers every verified fixture of the cases the verified route cites', () => {
    const [route] = gatewayEmulatorRoutes

    expect(route?.evidence).toBe('verified')
    expect(verifiedFixtures.map(fixture => fixture.caseId)).toEqual(route?.caseIds)
  })

  for (const fixture of verifiedFixtures) {
    it(`${fixture.caseId}: status, content type, and body shape match the recording`, async () => {
      const emulator = makeGatewayEmulator()
      const observed = await replay(fixture, emulator)

      expect(mismatches(fixture, observed)).toEqual([])

      if (isWireStreamResponse(fixture.exchanges[0].response)) {
        expect(emulator.ledger.entries()[0]?.bodyChunks).toBe(observed.chunks.length)
      }
    })
  }
})

const fixtureFor = (caseId: string): WireFixture =>
  verifiedFixtures.find(fixture => fixture.caseId === caseId) ?? expect.fail(`missing ${caseId}`)

const plainText = () => fixtureFor('vercel-ai-gateway.stream.plain-text')

const deepseekReasoning = () => fixtureFor('vercel-ai-gateway.stream.deepseek-reasoning')

const errorEnvelope = () => fixtureFor('vercel-ai-gateway.stream.error-envelope')

/** The parts of an emulated event payload the drills rewrite. */
type Payload = {
  readonly choices: ReadonlyArray<{
    readonly delta: { readonly provider_metadata?: Record<string, Schema.Json> }
  }>
  readonly system_fingerprint?: string
}

/**
 * Rewrite the JSON payload of every SSE event (the event's index across the stream is passed),
 * keeping the network chunk boundaries and `data: [DONE]`.
 */
const rewriteEvents = (
  observed: Observed,
  rewrite: (payload: Payload, index: number) => object
): Observed => {
  let index = 0

  const chunks = observed.chunks.map(chunk =>
    eventData(chunk)
      .map(data => {
        const current = index++

        return `data: ${data === '[DONE]' ? data : JSON.stringify(rewrite(JSON.parse(data), current))}\n\n`
      })
      .join('')
  )

  return { ...observed, chunks }
}

/** Update the finish event's `provider_metadata` in place. */
const withMetadata = (
  payload: Payload,
  update: (metadata: Record<string, Schema.Json>) => void
): Payload => {
  const metadata = payload.choices[0]?.delta.provider_metadata

  if (metadata !== undefined) update(metadata)

  return payload
}

describe('the shape comparison catches disagreements', () => {
  it('rejects the earlier reasoning_content field for the DeepSeek recording', async () => {
    const emulator = makeGatewayEmulator()

    emulator.script.enqueue({
      reasoning: ['Thinking.'],
      reasoningField: 'reasoning_content',
      text: ['Hello.']
    })

    expect(mismatches(deepseekReasoning(), await replay(deepseekReasoning(), emulator))).toContain(
      'event kinds differ'
    )
  })

  it('rejects one event per network chunk for the plain-text recording', async () => {
    const observed = await replay(plainText(), makeGatewayEmulator({ eventsPerChunk: 1 }))

    expect(mismatches(plainText(), observed)).toEqual([
      'emulator: the last network chunk does not carry the finish event and [DONE]',
      'emulator: no network chunk packs several events'
    ])
  })

  it('rejects a dropped usage for the plain-text recording', async () => {
    const emulator = makeGatewayEmulator()

    emulator.script.enqueue({ text: ['Hello.'], usage: null })

    expect(mismatches(plainText(), await replay(plainText(), emulator))).toContain(
      'finish and usage placement differs'
    )
  })

  it('rejects a removed upstream entry for the DeepSeek recording', async () => {
    const observed = await replay(deepseekReasoning())

    expect(mismatches(deepseekReasoning(), observed)).toEqual([])

    const withoutBaseten = rewriteEvents(observed, payload =>
      withMetadata(payload, metadata => {
        delete metadata.baseten
      })
    )

    expect(mismatches(deepseekReasoning(), withoutBaseten)).toEqual(['event kinds differ'])
  })

  it('rejects a corrupted openai entry for the plain-text recording', async () => {
    const observed = await replay(plainText())

    expect(mismatches(plainText(), observed)).toEqual([])

    const corrupted = rewriteEvents(observed, payload =>
      withMetadata(payload, metadata => {
        metadata.openai = { responseId: 1, serviceTier: 'default' }
      })
    )

    expect(mismatches(plainText(), corrupted)).toEqual(['event kinds differ'])
  })

  it('rejects an error envelope with an extra code', async () => {
    const emulator = makeGatewayEmulator()

    emulator.script.enqueue({
      error: {
        status: 404,
        body: {
          error: {
            message: "Model 'synthetic' not found",
            type: 'model_not_found',
            param: { modelId: 'synthetic' },
            code: 'model_not_found'
          }
        }
      }
    })

    expect(mismatches(errorEnvelope(), await replay(errorEnvelope(), emulator))).toEqual([
      'error envelope outline differs'
    ])
  })

  it('rejects an error envelope sent as a 400', async () => {
    const emulator = makeGatewayEmulator()

    emulator.script.enqueue({
      error: {
        status: 400,
        body: {
          error: {
            message: "Model 'synthetic' not found",
            type: 'model_not_found',
            param: { modelId: 'synthetic' }
          }
        }
      }
    })

    expect(mismatches(errorEnvelope(), await replay(errorEnvelope(), emulator))).toEqual([
      'status 400, recorded 404'
    ])
  })

  it('rejects a per-chunk field missing from one event', async () => {
    const observed = await replay(plainText())

    expect(mismatches(plainText(), observed)).toEqual([])

    const withoutFingerprint = rewriteEvents(observed, (payload, index) => {
      if (index !== 2) return payload

      const { system_fingerprint: _dropped, ...rest } = payload

      return rest
    })

    expect(mismatches(plainText(), withoutFingerprint)).toEqual(['event kinds differ'])
  })
})
