import { Effect, Fiber, Layer, Scope, Stream, Exit } from 'effect'
import { describe, expect, it } from '@effect/vitest'
import * as Socket from 'effect/unstable/socket/Socket'
import {
  makeWebSocketVoiceTransport,
  VoiceUserTranscriptFinal,
  type VoiceEvent
} from '../../src/voice/index.ts'

type FakeSocketListener = (event: Event) => void

class FakeWebSocket implements WebSocket {
  static instances: Array<FakeWebSocket> = []

  readonly CONNECTING = 0 as const
  readonly OPEN = 1 as const
  readonly CLOSING = 2 as const
  readonly CLOSED = 3 as const
  binaryType: BinaryType = 'blob'
  readonly bufferedAmount = 0
  readonly extensions = ''
  readonly protocol = ''
  readyState = 0
  readonly url: string
  onclose: ((this: WebSocket, ev: CloseEvent) => unknown) | null = null
  onerror: ((this: WebSocket, ev: Event) => unknown) | null = null
  onmessage: ((this: WebSocket, ev: MessageEvent) => unknown) | null = null
  onopen: ((this: WebSocket, ev: Event) => unknown) | null = null
  readonly sent: Array<string> = []
  private readonly listeners = new Map<string, Array<FakeSocketListener>>()

  constructor(url: string) {
    this.url = url
    FakeWebSocket.instances.push(this)
  }

  addEventListener(type: string, listener: EventListenerOrEventListenerObject): void {
    if (typeof listener !== 'function') {
      return
    }

    this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener])
  }

  removeEventListener(type: string, listener: EventListenerOrEventListenerObject): void {
    if (typeof listener !== 'function') {
      return
    }

    this.listeners.set(
      type,
      (this.listeners.get(type) ?? []).filter(existing => existing !== listener)
    )
  }

  dispatchEvent(event: Event): boolean {
    for (const listener of this.listeners.get(event.type) ?? []) {
      listener(event)
    }

    return true
  }

  send(data: string | ArrayBufferLike | Blob | ArrayBufferView): void {
    this.sent.push(String(data))
  }

  close(code?: number, reason?: string): void {
    this.readyState = 3
    this.dispatchEvent(new CloseEvent('close', { code: code ?? 1000, reason }))
  }

  fireOpen(): void {
    this.readyState = 1
    this.dispatchEvent(new Event('open'))
  }

  fireMessage(data: string): void {
    this.dispatchEvent(new MessageEvent('message', { data }))
  }

  fireError(): void {
    this.dispatchEvent(new Event('error'))
  }
}

const fakeConstructorLayer = Layer.succeed(
  Socket.WebSocketConstructor,
  (url: string) => new FakeWebSocket(url)
)

const decodeMessage = (raw: string): ReadonlyArray<VoiceEvent> => [
  VoiceUserTranscriptFinal.make({ itemId: null, text: raw })
]

const awaitFakeSocket = Effect.gen(function* () {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const socket = FakeWebSocket.instances.at(-1)

    if (socket !== undefined) {
      return socket
    }

    yield* Effect.sleep('2 millis')
  }

  return yield* Effect.die(new Error('Fake WebSocket was never constructed'))
})

describe('makeWebSocketVoiceTransport', () => {
  it.live('connects, sends open payloads, decodes messages, and ends on close', () =>
    Effect.gen(function* () {
      FakeWebSocket.instances = []
      const scope = yield* Scope.make()
      const transportFiber = yield* Effect.forkChild(
        Scope.provide(
          makeWebSocketVoiceTransport({
            url: 'wss://example.com/voice',
            decodeMessage,
            openPayloads: ['session-config'],
            readyTimeoutMs: 2_000
          }),
          scope
        ).pipe(Effect.provide(fakeConstructorLayer))
      )
      const fakeSocket = yield* awaitFakeSocket

      fakeSocket.fireOpen()

      const transport = yield* Fiber.join(transportFiber)
      const collected = yield* Effect.forkChild(Stream.runCollect(transport.events))

      yield* transport.send('client-payload')
      fakeSocket.fireMessage('hello')
      yield* Effect.sleep('10 millis')
      fakeSocket.close(1000)

      const events = yield* Fiber.join(collected)

      expect([...events].map(event => event._tag)).toEqual([
        'SessionOpening',
        'UserTranscriptFinal',
        'SessionClosed'
      ])
      expect(fakeSocket.sent[0]).toBe('session-config')
      expect(fakeSocket.sent).toContain('client-payload')

      yield* Scope.close(scope, Exit.void)
    })
  )

  it.live('fails acquisition when the socket never opens', () =>
    Effect.gen(function* () {
      FakeWebSocket.instances = []
      const error = yield* Effect.scoped(
        makeWebSocketVoiceTransport({
          url: 'wss://example.com/voice',
          decodeMessage,
          readyTimeoutMs: 30
        })
      ).pipe(Effect.provide(fakeConstructorLayer), Effect.flip)

      expect(error._tag).toBe('VoiceSessionError')
      expect(error.message).toContain('before ready')
    })
  )

  it.live('emits a transport error event and ends the stream on socket failure', () =>
    Effect.gen(function* () {
      FakeWebSocket.instances = []
      const scope = yield* Scope.make()
      const transportFiber = yield* Effect.forkChild(
        Scope.provide(
          makeWebSocketVoiceTransport({
            url: 'wss://example.com/voice',
            decodeMessage,
            readyTimeoutMs: 2_000
          }),
          scope
        ).pipe(Effect.provide(fakeConstructorLayer))
      )
      const fakeSocket = yield* awaitFakeSocket

      fakeSocket.fireOpen()

      const transport = yield* Fiber.join(transportFiber)
      const collected = yield* Effect.forkChild(Stream.runCollect(transport.events))

      yield* Effect.sleep('5 millis')
      fakeSocket.close(1006, 'abnormal')

      const events = yield* Fiber.join(collected)
      const tags = [...events].map(event => event._tag)

      expect(tags[0]).toBe('SessionOpening')
      expect(tags.at(-1) === 'Error' || tags.at(-1) === 'SessionClosed').toBe(true)

      yield* Scope.close(scope, Exit.void)
    })
  )
})
