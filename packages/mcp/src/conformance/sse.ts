/**
 * Server-sent event reading shared by the MCP conformance cases and the observer (internal).
 *
 * It does not mirror the SSE grammar by hand: it runs the SDK's own parser, `eventsource-parser`,
 * declared with the same range the client declares (`^3.0.0`), so a package manager resolves the
 * same copy the client uses; in this repository a parity test verifies that both resolve the same
 * version (3.0.8). A consumer whose package manager does not dedupe could still end up with two
 * copies; the parity test cannot see that.
 *
 * The client reads a POST or GET event stream as
 * `body.pipeThrough(new TextDecoderStream()).pipeThrough(new EventSourceParserStream())`, and
 * `makeEffectFetch` buffers the whole body first, so the decoder receives ONE byte chunk. The
 * decoder then emits up to two text chunks: the streaming decode of those bytes, and, at flush, the
 * decode of any incomplete trailing UTF-8 sequence (U+FFFD). Each non-empty chunk is a separate
 * parser `feed`, and the parser has no flush. `decodeAsTextDecoderStream` reproduces those chunks
 * from the bytes, and the payload functions feed them to `createParser` one by one, so every
 * parser rule applies as the client applies it: the first-chunk strip of the literal characters
 * `ï»¿`, a CR left pending at the end of a feed, and the never dispatched unterminated final event.
 *
 * @experimental
 */
import { createParser, type EventSourceMessage } from 'eventsource-parser'

/**
 * The text chunks `TextDecoderStream` emits for one byte chunk: `decode(bytes, { stream: true })`,
 * then, when `flush` is set (the stream ended), `decode()`. Empty chunks are skipped, as the stream
 * skips them. The decoder is UTF-8 with the BOM removed, as `TextDecoderStream` defaults to.
 */
export const decodeAsTextDecoderStream = (
  bytes: Uint8Array,
  flush: boolean
): ReadonlyArray<string> => {
  const decoder = new TextDecoder()
  const chunks = [decoder.decode(bytes, { stream: true }), flush ? decoder.decode() : '']

  return chunks.filter(chunk => chunk.length > 0)
}

/** Every event `eventsource-parser` dispatches for `feeds`, fed one by one with no flush. */
const parsedEvents = (feeds: ReadonlyArray<string>): ReadonlyArray<EventSourceMessage> => {
  const events: Array<EventSourceMessage> = []
  const parser = createParser({ onEvent: event => events.push(event) })

  for (const feed of feeds) {
    parser.feed(feed)
  }

  return events
}

/**
 * The `data` of the events the SDK reads, in order: `_handleSseStream` skips an event with empty
 * data (`if (!event.data) continue`) and reads only events with no `event:` type or `message`.
 */
export const sseMessagePayloads = (feeds: ReadonlyArray<string>): ReadonlyArray<string> =>
  parsedEvents(feeds)
    .filter(
      event => event.data.length > 0 && (event.event === undefined || event.event === 'message')
    )
    .map(event => event.data)

/** The `data` of every dispatched event with data, whatever its type (the conservative view). */
export const sseAllPayloads = (feeds: ReadonlyArray<string>): ReadonlyArray<string> =>
  parsedEvents(feeds)
    .filter(event => event.data.length > 0)
    .map(event => event.data)
