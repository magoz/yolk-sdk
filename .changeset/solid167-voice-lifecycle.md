---
'@yolk-sdk/agent': minor
---

Voice sessions are now an injectable Effect resource graph instead of a React-owned factory trio.

This is a breaking 0.x change: `makeVoiceController` no longer accepts a `transport` value and instead yields `VoiceTransport`. Hosts that already have an API value should `Effect.provideService(VoiceTransport, transport)` or pass `Layer.succeed(VoiceTransport, transport)` into `VoiceSession.layer`. `Layer.succeed` injects a caller-owned transport and does not allocate or finalize it.

- New `VoiceSession` (`@yolk-sdk/agent/voice`) composes one session from a supplied transport layer, `VoiceController`, and optional `eventLog`. Configured durable logging is session-owned: controller events are captured even without an external `events` consumer, and omitting `eventLog` never reads an ambient `VoiceEventOutbox`.
- `webRtcVoiceTransportLayer` and `webSocketVoiceTransportLayer` publish a connected transport as `VoiceTransport`. `VoiceController.layer` / `VoiceEventOutbox.layer` wrap the existing scoped factories.
- `useYolkVoice` still owns UI state, latest callbacks, HITL helpers, attempt cancellation, and audio-element identity. It no longer imports service constructors; each `start()` provides a fresh `VoiceSession.layer`.
