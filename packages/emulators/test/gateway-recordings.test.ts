/**
 * Proof that the Gateway emulator matches the wire: for every verified Gateway fixture, the
 * fixture's recorded request is sent to the emulator and the structural shape of the emulator's
 * response is compared with the recording. Compared: the status, the `content-type`, the SSE event
 * kinds in order (each event reduced to its outline: field names and value types, runs of same-shaped
 * events collapsed), where the finish reason and usage sit, that the last network chunk ends with
 * the finish event and `data: [DONE]`, that some network chunk packs several events, and the
 * error envelope's keys. Ignored: ids, text, numbers, and how many content events carry the text.
 *
 * The upstream-provider entry of `provider_metadata` is keyed by whichever provider the Gateway
 * routed to (`openai`, `baseten`, ...), which varies per route, so only its `gateway` entry is
 * compared. Tests may import SDK packages; the emulator source never does.
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

/**
 * The outline of a JSON value. Inside `provider_metadata` only the `gateway` entry is kept (see
 * the header).
 */
const outlineOf = (value: Schema.Json, key?: string): Outline => {
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
      .filter(([field]) => key !== 'provider_metadata' || field === 'gateway')
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([field, entry]) => [field, outlineOf(entry, field)])
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

const emulatorChunks = async (response: Response): Promise<ReadonlyArray<string>> => {
  const reader = response.body?.getReader()

  if (reader === undefined) return []

  const decoder = new TextDecoder()
  const chunks: Array<string> = []

  for (;;) {
    const next = await reader.read()

    if (next.done) return chunks

    chunks.push(decoder.decode(next.value))
  }
}

/** Send the fixture's recorded request (plus a synthetic bearer credential) to a fresh emulator. */
const replayRequest = (fixture: WireFixture, emulator: GatewayEmulator = makeGatewayEmulator()) => {
  const [exchange] = fixture.exchanges

  const response = emulator.fetch(
    new Request(exchange.request.url, {
      method: exchange.request.method,
      headers: { ...exchange.request.headers, authorization: 'Bearer synthetic-gateway-key' },
      body: JSON.stringify(exchange.request.body)
    })
  )

  return { exchange, emulator, response }
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
      const { exchange, emulator, response: pending } = replayRequest(fixture)
      const recorded = exchange.response
      const response = await pending

      expect(response.status).toBe(recorded.status)
      expect(response.headers.get('content-type')).toBe(recorded.headers['content-type'])

      if (!isWireStreamResponse(recorded)) {
        // The error envelope: the same keys and value types (no `code`).
        const recordedText = Predicate.isString(recorded.body)
          ? recorded.body
          : expect.fail('expected a recorded text body')

        const body: Schema.Json = await response.json()

        expect(outlineOf(body)).toEqual(outlineOf(parseJson(recordedText)))
        expect(Predicate.hasProperty(body, 'error')).toBe(true)
        expect(
          Predicate.hasProperty(body, 'error') && Predicate.hasProperty(body.error, 'code')
        ).toBe(false)

        return
      }

      const recordedChunks = recorded.chunks.map(chunkText)
      const chunks = await emulatorChunks(response)

      // Event kinds and field names, in order.
      expect(eventKinds(chunks)).toEqual(eventKinds(recordedChunks))

      // Finish and usage placement: usage rides on the finish event, followed only by [DONE].
      const recordedPlacement = finishAndUsage(recordedChunks).map(entry => entry.placement)

      expect(finishAndUsage(chunks).map(entry => entry.placement)).toEqual(recordedPlacement)
      expect(recordedPlacement.at(-2)).toMatchObject({ usage: true })

      for (const events of [recordedChunks, chunks]) {
        const all = placements(events)
        const [finish, done] = finishAndUsage(events)

        expect(done?.index).toBe(all.length - 1)
        expect(finish?.index).toBe(all.length - 2)
      }

      // Chunk packing: the last network chunk carries the finish event and [DONE] together,
      // and some network chunk carries several events, as recorded.
      for (const events of [recordedChunks, chunks]) {
        const last = eventData(events.at(-1) ?? '')

        expect(last.at(-1)).toBe('[DONE]')
        expect(last.length).toBeGreaterThan(1)
        expect(events.some(chunk => eventData(chunk).length > 1)).toBe(true)
      }

      expect(emulator.ledger.entries()[0]?.bodyChunks).toBe(chunks.length)
    })
  }
})

const recordedStream = (fixture: WireFixture | undefined): ReadonlyArray<string> => {
  const response = fixture?.exchanges[0].response

  return response !== undefined && isWireStreamResponse(response)
    ? response.chunks.map(chunkText)
    : expect.fail('expected a recorded stream')
}

const fixtureFor = (caseId: string) => verifiedFixtures.find(fixture => fixture.caseId === caseId)

describe('the shape comparison catches disagreements', () => {
  it('rejects the earlier reasoning_content field for the DeepSeek recording', async () => {
    const fixture = fixtureFor('vercel-ai-gateway.stream.deepseek-reasoning')
    const emulator = makeGatewayEmulator()

    emulator.script.enqueue({
      reasoning: ['Thinking.'],
      reasoningField: 'reasoning_content',
      text: ['Hello.']
    })

    const chunks = await emulatorChunks(
      await replayRequest(fixture ?? expect.fail('missing'), emulator).response
    )

    expect(eventKinds(chunks)).not.toEqual(eventKinds(recordedStream(fixture)))
  })

  it('rejects one event per network chunk and a dropped usage for the plain-text recording', async () => {
    const fixture = fixtureFor('vercel-ai-gateway.stream.plain-text')

    const unpacked = await emulatorChunks(
      await replayRequest(
        fixture ?? expect.fail('missing'),
        makeGatewayEmulator({ eventsPerChunk: 1 })
      ).response
    )

    expect(unpacked.some(chunk => eventData(chunk).length > 1)).toBe(false)

    const withoutUsage = makeGatewayEmulator()

    withoutUsage.script.enqueue({ text: ['Hello.'], usage: null })

    const chunks = await emulatorChunks(
      await replayRequest(fixture ?? expect.fail('missing'), withoutUsage).response
    )

    expect(finishAndUsage(chunks).map(entry => entry.placement)).not.toEqual(
      finishAndUsage(recordedStream(fixture)).map(entry => entry.placement)
    )
  })
})
