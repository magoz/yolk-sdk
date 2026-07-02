# First-class Yolk voice

Execution status: PLANNING. Initial decisions resolved; no implementation started.

Scope: Yolk-native voice stack using Effect patterns. No AI SDK runtime dependency.

## Goal

Make voice a first-class Yolk agent modality:

- live browser speech-to-speech sessions
- server/Node realtime sessions
- one-shot speech-to-text and text-to-speech
- Yolk tools, HITL, knowledge, connectors, sandbox, transcript, and durability
- provider mechanics isolated behind provider subpaths

The target is not “wrap AI SDK voice”. AI SDK 7 is research/reference only.

## Motivation

AI SDK 7 now has realtime voice, speech, transcription, AI Gateway support, browser hooks, and provider-normalized WebSocket sessions. That raises the baseline for agent SDK voice DX.

Yolk should still own voice because its differentiator is the agent control plane:

- typed protocol and event stream
- host-owned auth/storage/policy
- tool approval and question HITL
- append-log durability and replay
- knowledge/search/context contracts
- connector credential/action model
- Effect-native services, errors, layers, and tests

Voice should make these Yolk capabilities available through speech, not bypass them through provider-specific demo glue.

## Research findings

### AI SDK 7 voice

- Realtime uses WebSocket, not WebRTC, in public docs.
- Browser hook manages microphone capture, WS connection, audio playback, messages, and tool calls.
- Server mints short-lived realtime tokens so provider/Gateway keys stay server-side.
- AI Gateway normalizes realtime sessions and adds routing, observability, spend controls, and BYOK.
- Realtime sessions support server VAD, barge-in/interruption, audio transcripts, and mid-session tools.
- One-shot APIs exist for `generateSpeech` and `transcribe`.
- Realtime limitations include no true reconnect resume; clients must start a new session and replay context.

### OpenAI Realtime

- OpenAI supports WebRTC for browser realtime voice.
- Current Yolk example already uses OpenAI WebRTC by posting SDP to `https://api.openai.com/v1/realtime/calls`.
- OpenAI also has realtime event shapes that carry transcripts, assistant audio transcript deltas, tool calls, and errors.

### Effect support

- Effect has WebSocket support via Socket APIs and platform layers.
- Effect has browser and server HTTP clients.
- Effect does not have first-class WebRTC APIs.
- WebRTC must be wrapped with Yolk services around browser APIs: `RTCPeerConnection`, `RTCDataChannel`, `MediaStream`, and `navigator.mediaDevices.getUserMedia`.

### Current Yolk voice assets

- `@yolk-sdk/agent/protocol` already has `AudioPart`.
- `@yolk-sdk/agent/voice` has a provider-neutral voice tool-call bridge.
- Next example has OpenAI WebRTC routes and config helpers.
- Voice tools reuse Yolk `ToolExecutor`.
- OpenAI realtime details are intentionally app-local today.

## Decisions

1. Build native Yolk voice. Do not depend on AI SDK runtime APIs.
2. Use Effect services/layers/streams for all package-owned runtime abstractions.
3. Keep browser WebRTC as the preferred live browser transport.
4. Add WebSocket transport for Node/server sessions and provider fallback.
5. Add HTTP one-shot STT/TTS as separate speech services.
6. Keep provider-neutral voice protocol separate from OpenAI event shapes.
7. Keep provider-specific code under provider subpaths, not core voice.
8. Treat realtime reconnect as a new provider session plus Yolk transcript/context replay.
9. Make Yolk HITL work in voice before declaring voice first-class.
10. Persist normalized transcript/tool/HITL events, not provider session internals.
11. Secure tool calls with session-bound policy and verification; no unaudited generic execute-by-name endpoint.
12. Do not pursue telephony in MVP.
13. Use `@yolk-sdk/agent/voice/*` subpaths; voice is an agent modality, not a standalone domain.
14. Ship OpenAI-only first canary because the repo already has a working OpenAI WebRTC path.
15. Implement WebRTC before WebSocket because browser voice UX is the differentiator.
16. Defer voice `question`; approval HITL is higher-risk and simpler for MVP.
17. Persist transcript by default; raw audio persistence is host-owned through optional `Ref` attachments.
18. Expose only safe provider metadata: provider, model, status/session ids when safe, never raw payloads.
19. Keep `VoiceEvent` separate from `AgentEvent`; provide projection helpers into protocol events/messages.
20. Put browser transport behind an explicit browser subpath to contain DOM/WebRTC globals.
21. Keep live provider/WebRTC smoke opt-in; default tests use fakes.
22. Tools execute server-side only. Browser controller forwards provider tool calls to a host server endpoint; server resolves policy, executes through `ToolExecutor`, and returns provider tool output. The browser never holds tools, credentials, or executor layers.
23. Use `VoiceSessionBroker` instead of a token-only broker. MVP OpenAI WebRTC uses server-proxied SDP exchange; token minting is a broker capability for ephemeral-token/WS providers later.
24. Pending HITL approvals persist in the session log. If the provider session dies while awaiting input, the approval stays pending; on reconnect the host replays context and executes/denies the tool from the stored response. Session death never silently denies.
25. Reuse runtime `SessionEventStore` append-log contracts for voice durability; do not define a parallel `VoiceSessionStore` unless a voice-specific need appears.
26. Durable voice events carry `eventId` and clients de-dupe by id, matching text runtime replay rules.
27. Voice usage accounting is deferred from MVP; when added, provider usage maps to protocol `UsageUpdate` semantics.
28. Mic device selection and mute UI are host-owned; package exposes start/stop capture and accepts a host-provided `MediaStream`.

## Non-goals

- No AI SDK wrapper.
- No provider-neutral WebRTC abstraction before OpenAI WebRTC works.
- No custom audio codec work unless WebSocket transport requires it.
- No raw audio persistence in MVP unless needed for debugging/tests.
- No telephony/SIP/RTP bridge in MVP.
- No package-owned app auth, DB schema, routes, or UI policy.
- No voice `question` support in MVP; document deferral and keep approval HITL first.

## Target architecture

Browser owns media/transport/UI state. Server owns tools, policy, HITL state, and durability.

```txt
Browser
  useYolkVoice
    -> VoiceController (client state machine)
    -> VoiceTransport(WebRTC)
    -> Stream<VoiceEvent>
    -> forwards tool calls to host tool endpoint

Server routes / host app
  auth/session/tool policy
  VoiceSessionBroker (SDP proxy now; token minting later)
  voice tool endpoint -> ToolExecutor
  HITL pending state
  SessionEventStore append log

Packages
  @yolk-sdk/agent/voice
    provider-neutral protocol, controller, tool/HITL orchestration, transcript projection

  @yolk-sdk/agent/voice/react
    headless React hook/projection

  @yolk-sdk/agent/voice/browser
    browser WebRTC transport and DOM boundary

  @yolk-sdk/agent/providers/openai/realtime
    OpenAI WebRTC + WS event codecs/session config

  @yolk-sdk/agent/providers/openai/speech
    OpenAI TTS/STT adapters
```

Core flow:

```txt
VoiceCommand -> VoiceController -> VoiceTransport -> provider
provider event -> provider codec -> VoiceEvent -> client state/UI
provider tool call -> browser forwards to server tool endpoint
server: policy/HITL -> ToolExecutor -> tool output -> browser -> provider
final transcripts/tool events -> AgentMessage projection -> append log (eventId, de-duped)
```

## Proposed public model

### Voice commands

```txt
VoiceCommand
  Connect
  Disconnect
  StartAudioInput
  StopAudioInput
  SendText
  SubmitToolOutput
  ApproveTool
  DenyTool
  AnswerQuestion (future; deferred from MVP)
```

### Voice events

```txt
VoiceEvent
  SessionOpening
  SessionOpened
  SessionClosed
  AudioInputStarted
  AudioInputStopped
  UserTranscriptDelta
  UserTranscriptFinal
  AssistantTranscriptDelta
  AssistantTranscriptFinal
  AssistantAudioStarted
  AssistantAudioStopped
  Interrupted
  ToolCallRequested
  ToolCallExecuting
  ToolCallCompleted
  ToolCallFailed
  AwaitingInput
  Error
```

### Effect services

```txt
VoiceProvider
  makeSessionConfig
  makeToolDefinitions
  decodeProviderEvent
  encodeProviderCommand

VoiceTransport
  connect
  disconnect
  send
  events

VoiceSessionBroker
  openSession        server-side; SDP proxy for OpenAI WebRTC MVP
  mintToken          later; ephemeral-token/WS providers

VoiceToolController
  handleToolCall     server-side; policy + HITL + ToolExecutor
  submitToolOutput

VoiceTranscriptProjector
  projectVoiceEvent
```

Durability reuses `@yolk-sdk/agent/runtime` `SessionEventStore`; no new store contract.

Use `Context.Service`, `Layer`, `Stream`, `Queue`, `Scope.acquireRelease`, `Schema.TaggedClass`, `Schema.TaggedErrorClass`, and `effect/unstable/http` clients where applicable.

## Implementation plan

### Phase 1 — Package protocol and codecs

- Add provider-neutral voice command/event/config schemas.
- Add voice errors with safe metadata only.
- Add OpenAI realtime event decoder/encoder in provider subpath.
- Add OpenAI session config builder in provider subpath.
- Move reusable pieces from `examples/next/lib/agents/realtime/openai-realtime.ts` into packages.
- Keep app auth/routes in example.
- Add pure codec tests for OpenAI transcript, interruption, tool-call, tool-result, error, and session events.

### Phase 2 — Native WebRTC transport

- Add browser-only OpenAI WebRTC transport.
- Wrap `RTCPeerConnection`, data channel, mic tracks, remote audio tracks, and cleanup in Effect resources.
- Expose provider events as `Stream<VoiceEvent>`.
- Accept `VoiceCommand` via queue/send API.
- Handle permission denied, SDP failure, ICE failure, data channel close, track ended, and disconnect.
- Add fake WebRTC test seam for unit tests.
- Add Playwright smoke for browser connect/disconnect with fake provider if feasible.

### Phase 3 — Voice controller and tool bridge

- Build client `VoiceController` over `VoiceTransport`; no tools/credentials in browser.
- Build server-side `VoiceToolController` over `ToolExecutor` and tool policy.
- Define the host tool endpoint contract replacing today's generic `/api/agent/realtime/tool`: authenticated session id, toolset revision/hash, tool call id, tool name, args; server re-resolves policy before execution.
- Route provider tool calls through Yolk `ToolCall` and `ToolResult`.
- Preserve current `executeVoiceToolCall` semantics but bind to sessions.
- Add idempotency by tool call id.
- Add model-visible safe failure results.
- Enforce voice toolset resolution by host context `{ surface: 'voice' }`.
- Define interruption-vs-pending-tool behavior: pending execution completes server-side; output submission is skipped if the call was cancelled by the provider, and the result is still logged.

### Phase 4 — Voice HITL

- Support manual tool approval during voice sessions.
- Document package `question` deferral for voice sessions.
- Emit `AwaitingInput` voice events mapped from protocol HITL requests.
- Persist pending approval requests in the session log before surfacing to UI.
- Resume tool call after approve/deny response.
- Return denial output as provider tool output.
- Handle session timeout while awaiting input: approval stays pending in log; reconnect replays context and applies the stored response; never silently deny on session death.
- Add tests for approve, deny, cancel, duplicate response, disconnect while waiting, and approve-after-session-death.

### Phase 5 — Transcript projection and durability

- Map final user transcript to `UserMessage`.
- Map final assistant transcript to `AssistantMessage`.
- Map tool call/result pairs to normal protocol messages.
- Represent interruption/partial assistant output without creating dangling tool calls.
- Append normalized events/messages through runtime `SessionEventStore`.
- Assign `eventId` to durable voice events; clients de-dupe by id per text runtime replay rules.
- On reconnect, start a new provider session and seed compacted Yolk transcript/context.
- Add projection tests, append-log replay tests, and duplicate-event de-dupe tests.

### Phase 6 — React hook and example UI

- Add `@yolk-sdk/agent/voice/react`.
- Implement headless `useYolkVoice` hook.
- Return status, capture state, messages, events, connect/disconnect, audio controls, HITL responders, and send text.
- Migrate Next example voice UI to package hook.
- Keep UI app-owned; package owns state/projection only.
- Add React hook tests with fake transport.

### Phase 7 — WebSocket transport

- Add Effect-native WebSocket transport for Node/server sessions.
- Use Effect Socket APIs where runtime supports them.
- Implement provider event codecs shared with WebRTC where possible.
- Add Node smoke tests with fake provider WS.
- Use this path for CLI/server/telephony bridge foundations.

### Phase 8 — Speech and transcription

- Add provider-neutral speech/transcription contracts.
- Add OpenAI speech and transcription provider adapters.
- Return audio as Yolk `AudioPart`-compatible structures.
- Return transcription segments/language/duration when available.
- Add HTTP adapter tests with fake `HttpClient`.

### Phase 9 — Docs and release readiness

- Update package READMEs/subpaths.
- Update `exports`, `publishConfig.exports`, `scripts/check-package-exports.ts`, and `scripts/smoke-package-imports.ts` together for every new subpath.
- Update `packages/agent/AGENTS.md` subpath/dependency tables: voice gains controller/react/browser subpaths beyond "protocol + loop only".
- Update `packages/AGENTS.md` dependency direction for new voice subpaths.
- Verify agent package tsconfig covers DOM lib types for `voice/browser` without leaking DOM into core subpaths.
- Update docs package reference pages.
- Add quickstart: live voice agent with tools.
- Add guide: voice HITL approval.
- Add guide: recorded audio STT/TTS.
- Add provider limitations and browser permission troubleshooting.
- Run package export/smoke checks.

## Security model

Voice tool calls must be bound to a server-created session:

- authenticated session id
- toolset revision/hash
- tool call id
- tool name
- arguments hash
- expiry
- user/agent scope
- approval state if needed

Server must re-resolve policy before execution. Client or provider-supplied tool output must never be trusted as execution proof.

Verification mechanism for MVP: server-side session state keyed by authenticated session id; the server stores the resolved toolset revision at session open and validates every tool call against it. HMAC-signed call envelopes are a later option for stateless hosts, not required while session state is server-owned.

## Testing strategy

- Pure Schema/codec tests for provider events.
- Controller tests with fake transport and fake tool executor.
- HITL tests for pause/resume semantics.
- Transcript projector tests for no dangling tool calls.
- WebRTC fake tests for lifecycle and cleanup.
- Browser smoke for real media APIs behind opt-in/live flag.
- HTTP tests with injected `HttpClient` fakes.
- No live provider tests by default.

## Trackable TODO

### Planning

- [x] VOICE-00 Create plan document.
- [x] VOICE-01 Decide package/subpath layout: `@yolk-sdk/agent/voice/*`.
- [x] VOICE-02 Decide OpenAI-only MVP boundaries.
- [x] VOICE-03 Decide WebRTC-first delivery order.
- [x] VOICE-04 Decide raw audio persistence policy: transcript default, host refs optional.
- [x] VOICE-05 Decide voice `question` MVP policy: deferred.
- [x] VOICE-06 Decide `VoiceEvent` relation to `AgentEvent`: separate with projection helpers.
- [x] VOICE-07 Decide browser transport boundary: explicit browser subpath.
- [x] VOICE-08 Decide live smoke policy: opt-in only.
- [x] VOICE-09a Decide tool execution split: server-side only; browser forwards.
- [x] VOICE-09b Decide session broker: `VoiceSessionBroker`, SDP proxy MVP.
- [x] VOICE-09c Decide HITL timeout behavior: pending persists; apply on reconnect.
- [x] VOICE-09d Decide durability store: reuse runtime `SessionEventStore`.

### Protocol/core

- [ ] VOICE-10 Add voice command/event/config schemas.
- [ ] VOICE-11 Add voice error schemas.
- [ ] VOICE-12 Add voice controller service contracts.
- [ ] VOICE-13 Add transcript projector contract.

### OpenAI realtime

- [ ] VOICE-20 Move OpenAI session config builder to provider subpath.
- [ ] VOICE-21 Add OpenAI realtime event decoder.
- [ ] VOICE-22 Add OpenAI realtime command encoder.
- [ ] VOICE-23 Add codec tests for transcript/tool/error/interruption events.

### WebRTC

- [ ] VOICE-30 Add browser WebRTC transport.
- [ ] VOICE-31 Add fake WebRTC seam.
- [ ] VOICE-32 Add lifecycle cleanup tests.
- [ ] VOICE-33 Add example route integration for SDP/token flow.

### Tools/HITL

- [ ] VOICE-40 Bind voice tool calls to sessions.
- [ ] VOICE-41 Enforce voice tool policy server-side.
- [ ] VOICE-42 Add manual approval flow with persisted pending state.
- [ ] VOICE-43 Document voice `question` deferral.
- [ ] VOICE-44 Add duplicate/idempotent tool-call handling.
- [ ] VOICE-45 Add approve-after-session-death resume path.
- [ ] VOICE-46 Define server tool endpoint contract replacing generic `/api/agent/realtime/tool`.

### Durability

- [ ] VOICE-50 Project transcripts to `AgentMessage`.
- [ ] VOICE-51 Project tool calls/results without dangling calls.
- [ ] VOICE-52 Append normalized voice events through `SessionEventStore` with `eventId`.
- [ ] VOICE-53 Add reconnect replay path with client de-dupe.

### React/example

- [ ] VOICE-60 Add headless React voice hook.
- [ ] VOICE-61 Migrate Next example voice UI.
- [ ] VOICE-62 Add UI/HITL projection tests.

### WebSocket/STT/TTS

- [ ] VOICE-70 Add Effect WebSocket voice transport.
- [ ] VOICE-71 Add OpenAI speech adapter.
- [ ] VOICE-72 Add OpenAI transcription adapter.

### Docs/checks

- [ ] VOICE-80 Update package README/export docs.
- [ ] VOICE-81 Update docs site package reference.
- [ ] VOICE-82 Add voice quickstart.
- [ ] VOICE-83 Add voice HITL guide.
- [ ] VOICE-84 Run package gates.

## Open questions

None for initial implementation.

Future questions:

- Which second provider after OpenAI?
- When to promote WebSocket Node transport beyond browser MVP?
- When to add voice `question`?
- When to add telephony bridge?
- When to add voice usage/cost events mapped to `UsageUpdate`?
- When to add HMAC-signed tool call envelopes for stateless hosts?
