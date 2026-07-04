# @yolk-sdk/sandbox

## 0.1.0-canary.36

### Patch Changes

- Updated dependencies [afb30a0]
  - @yolk-sdk/agent@0.1.0-canary.36

## 0.1.0-canary.35

### Patch Changes

- Updated dependencies [e9d235d]
- Updated dependencies [26b8b4d]
  - @yolk-sdk/agent@0.1.0-canary.35

## 0.1.0-canary.34

### Patch Changes

- Updated dependencies [01719c0]
  - @yolk-sdk/agent@0.1.0-canary.34

## 0.1.0-canary.33

### Patch Changes

- Voice as a first-class agent modality in `@yolk-sdk/agent`:
  - `@yolk-sdk/agent/voice`: provider-neutral voice protocol, client controller, server tool handler with approval HITL, transcript projection, durable voice event ids, WebSocket transport, and one-shot TTS/STT service contracts (`VoiceSpeechSynthesizer`, `VoiceTranscriber`, `VoiceSpeechRequest.instructions` for delivery-style steering).
  - `@yolk-sdk/agent/voice/browser`: Effect-native browser WebRTC voice transport with a fakeable runtime seam.
  - `@yolk-sdk/agent/voice/react`: headless `useYolkVoice` browser hook.
  - `@yolk-sdk/agent/providers/openai/realtime`: OpenAI Realtime session config, event codecs, and voice client codec.
  - `@yolk-sdk/agent/providers/openai/speech`: OpenAI TTS/STT adapters; 429 responses surface as `VoiceSpeechError` code `rate_limited` so hosts can distinguish quota exhaustion from outages.
  - Projection keys assistant drafts per provider output item (falling back to response id): back-to-back responses, multi-item responses, and duplicate final transcript event families no longer concatenate, wipe, or duplicate projected messages.

  Other `@yolk-sdk/*` packages ship as part of the lockstep canary release.

- Updated dependencies
  - @yolk-sdk/agent@0.1.0-canary.33

## 0.1.0-canary.32

### Patch Changes

- Add Effect-native Vercel Workflow host wrappers and refresh package documentation.
- Updated dependencies
  - @yolk-sdk/agent@0.1.0-canary.32

## 0.1.0-canary.31

### Patch Changes

- Simplify knowledge to document, file, chunk, context, and search contracts.
- Updated dependencies
  - @yolk-sdk/agent@0.1.0-canary.31

## 0.1.0-canary.30

### Patch Changes

- Updated dependencies [4148be9]
  - @yolk-sdk/agent@0.1.0-canary.30

## 0.1.0-canary.29

### Patch Changes

- Updated dependencies
  - @yolk-sdk/agent@0.1.0-canary.29

## 0.1.0-canary.28

### Patch Changes

- Updated dependencies [90b0558]
  - @yolk-sdk/agent@0.1.0-canary.28

## 0.1.0-canary.27

### Patch Changes

- Updated dependencies
  - @yolk-sdk/agent@0.1.0-canary.27

## 0.1.0-canary.26

### Patch Changes

- Updated dependencies
  - @yolk-sdk/agent@0.1.0-canary.26

## 0.1.0-canary.25

### Patch Changes

- Fix connector provider pagination, Google scoped OAuth, Gmail drafts/send-as, LinkedIn queued email lookup, and R2 public URL handling.
- Updated dependencies
  - @yolk-sdk/agent@0.1.0-canary.25

## 0.1.0-canary.24

### Patch Changes

- @yolk-sdk/agent@0.1.0-canary.24

## 0.1.0-canary.23

### Patch Changes

- Updated dependencies [e8ac8ce]
  - @yolk-sdk/agent@0.1.0-canary.23

## 0.1.0-canary.22

### Patch Changes

- Updated dependencies [378cd92]
  - @yolk-sdk/agent@0.1.0-canary.22

## 0.1.0-canary.21

### Patch Changes

- Surface typed provider failure metadata, retry state, and retry-aware chat items.
- Updated dependencies
  - @yolk-sdk/agent@0.1.0-canary.21

## 0.1.0-canary.20

### Patch Changes

- Updated dependencies
  - @yolk-sdk/agent@0.1.0-canary.20

## 0.1.0-canary.19

### Patch Changes

- Reattach named Vercel sandboxes when stored state is missing and keep sandbox tool structured content JSON-plain.
  - @yolk-sdk/agent@0.1.0-canary.19

## 0.1.0-canary.18

### Minor Changes

- Add sandbox execution plane package.

### Patch Changes

- @yolk-sdk/agent@0.1.0-canary.18

## 0.1.0-canary.17

- Initial package scaffold.
