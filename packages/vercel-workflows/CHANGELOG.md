# @yolk-sdk/vercel-workflows

## 0.1.0-canary.54

## 0.1.0-canary.53

## 0.1.0-canary.52

## 0.1.0-canary.51

## 0.1.0-canary.50

## 0.1.0-canary.49

### Patch Changes

- 9b50918: Normalize non-finite Workflow retry attempt counts to one attempt instead of retrying forever.

## 0.1.0-canary.48

## 0.1.0-canary.47

## 0.1.0-canary.46

## 0.1.0-canary.45

## 0.1.0-canary.44

## 0.1.0-canary.43

## 0.1.0-canary.42

### Patch Changes

- Add compaction checkpoint formatting and one-shot context-overflow retry helpers.

## 0.1.0-canary.41

### Patch Changes

- 6303c57: Remove terminal-event helper stream closing so workflow loop owns final close.

## 0.1.0-canary.40

### Patch Changes

- Make public client, Workflow, and sandbox helpers Effect-native.

## 0.1.0-canary.39

### Patch Changes

- Expose Effect-native attachment and durable workflow helpers, and refresh package documentation for current public exports.

## 0.1.0-canary.38

### Patch Changes

- Harden agent transport and voice Effect boundaries.

## 0.1.0-canary.37

### Patch Changes

- Publish canary with agent client stream continuation fixes and package docs updates.

## 0.1.0-canary.36

## 0.1.0-canary.35

## 0.1.0-canary.34

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

## 0.1.0-canary.32

### Patch Changes

- Add Effect-native Vercel Workflow host wrappers and refresh package documentation.

## 0.1.0-canary.31

### Patch Changes

- Simplify knowledge to document, file, chunk, context, and search contracts.

## 0.1.0-canary.30

## 0.1.0-canary.29

### Patch Changes

- Expose terminal agent event detection and add Workflow terminal commit-barrier helpers.

## 0.1.0-canary.28

## 0.1.0-canary.27

## 0.1.0-canary.26

### Minor Changes

- Add replay-safe workflow event sequencing and chat projection helpers.

## 0.1.0-canary.25

### Patch Changes

- Fix connector provider pagination, Google scoped OAuth, Gmail drafts/send-as, LinkedIn queued email lookup, and R2 public URL handling.

## 0.1.0-canary.24

## 0.1.0-canary.23

## 0.1.0-canary.22

## 0.1.0-canary.21

### Patch Changes

- Surface typed provider failure metadata, retry state, and retry-aware chat items.

## 0.1.0-canary.20

## 0.1.0-canary.19

## 0.1.0-canary.18

## 0.1.0-canary.17

### Patch Changes

- 92d966b: Expose structured model-visible tool error details.

## 0.1.0-canary.16

## 0.1.0-canary.15

### Minor Changes

- Unify public package shape around `@yolk-sdk/agent` subpaths, fold React/OAuth/provider/skillset/voice APIs into the agent package, and rename Vercel Workflow imports to `@yolk-sdk/vercel-workflows`.

## 0.1.0-canary.14

## 0.1.0-canary.13

### Minor Changes

- Add model-visible message envelopes with timestamps, author display names, and annotations.

## 0.0.1-canary.12

## 0.0.1-canary.11

## 0.0.1-canary.10

## 0.0.1-canary.9

## 0.0.1-canary.8

## 0.0.1-canary.7

### Patch Changes

- Add package-owned workflow orchestration with HITL await-input resume support.

## 0.0.1-canary.6

## 0.0.1-canary.5

## 0.0.1-canary.4

## 0.0.1-canary.3

## 0.0.1-canary.2

### Patch Changes

- 55bc6c7: Prepare next canary release.

## 0.0.1-canary.1

### Patch Changes

- Prepare next canary release.

## 0.0.1-canary.0

### Patch Changes

- 4232c86: Prepare first public canary release.
