# @yolk-sdk/connectors

## 0.1.0-canary.67

### Patch Changes

- 57795cf: Add single-message Gmail attachment discovery and typed retrieval output with validated Gmail base64url data plus standard-base64 content while preserving existing wire fields.
- 57795cf: Add Outlook attachment metadata listing and file attachment retrieval through Microsoft Graph, including inline attachment discovery and shared-mailbox permission selection.
- 57795cf: Refresh public package descriptions, connector access guidance, and documented package subpaths.
- 57795cf: Add generic IMAP and POP3 attachment retrieval through an optional host email port method, returning decoded file bytes as base64 with normalized attachment metadata while preserving existing host adapters.
- Updated dependencies [0da67d1]
- Updated dependencies [57795cf]
  - @yolk-sdk/agent@0.1.0-canary.67

## 0.1.0-canary.66

### Patch Changes

- @yolk-sdk/agent@0.1.0-canary.66

## 0.1.0-canary.65

### Patch Changes

- @yolk-sdk/agent@0.1.0-canary.65

## 0.1.0-canary.64

### Patch Changes

- @yolk-sdk/agent@0.1.0-canary.64

## 0.1.0-canary.63

### Minor Changes

- 9085104: Add Google Drive metadata listing, search, lookup, folder creation, trash, and permanent deletion actions with action-scoped Google OAuth consent hints.

### Patch Changes

- @yolk-sdk/agent@0.1.0-canary.63

## 0.1.0-canary.62

### Patch Changes

- Updated dependencies [7677e18]
  - @yolk-sdk/agent@0.1.0-canary.62

## 0.1.0-canary.61

### Patch Changes

- Updated dependencies [025b16b]
- Updated dependencies [f495460]
  - @yolk-sdk/agent@0.1.0-canary.61

## 0.1.0-canary.60

### Patch Changes

- c4eea3f: Add a portable generic email connector with host-provided IMAP, POP3, and SMTP transport, normalized message schemas, IMAP draft creation, separate incoming and SMTP credential slots, and username/password runtime credentials.
- Updated dependencies [8ac2ad9]
  - @yolk-sdk/agent@0.1.0-canary.60

## 0.1.0-canary.59

### Minor Changes

- 3770fcd: Add the Dropbox OAuth connector with metadata, search, pagination, and file-management actions.
- 8c9ba43: Add a Microsoft Graph v1.0 connector with one shared `microsoft.oauth` credential binding, scoped Outlook and OneDrive OAuth slots, delegated/application Exchange and drive targeting, typed Outlook mail actions, and OneDrive list, search, metadata, folder-create, and recycle-bin actions. Connector actions can now declare default read, write, or destructive access metadata for agent adapters.

### Patch Changes

- a5581f7: Refresh public package documentation with verified imports, runtime boundaries, and host responsibilities.
- Updated dependencies [eb908b7]
- Updated dependencies [a5581f7]
  - @yolk-sdk/agent@0.1.0-canary.59

## 0.1.0-canary.58

### Patch Changes

- Updated dependencies [a4a3d52]
  - @yolk-sdk/agent@0.1.0-canary.58

## 0.1.0-canary.57

### Patch Changes

- da9e8ba: Refresh package documentation with runtime requirements, host responsibilities, subpath boundaries, and corrected usage examples.
- Updated dependencies [da9e8ba]
- Updated dependencies [de55946]
  - @yolk-sdk/agent@0.1.0-canary.57

## 0.1.0-canary.56

### Patch Changes

- Updated dependencies [2013d5e]
  - @yolk-sdk/agent@0.1.0-canary.56

## 0.1.0-canary.55

### Patch Changes

- Updated dependencies [6297363]
  - @yolk-sdk/agent@0.1.0-canary.55

## 0.1.0-canary.54

### Patch Changes

- Updated dependencies
- Updated dependencies
  - @yolk-sdk/agent@0.1.0-canary.54

## 0.1.0-canary.53

### Patch Changes

- Updated dependencies [a47adb1]
  - @yolk-sdk/agent@0.1.0-canary.53

## 0.1.0-canary.52

### Patch Changes

- Updated dependencies [15d0159]
  - @yolk-sdk/agent@0.1.0-canary.52

## 0.1.0-canary.51

### Patch Changes

- d0f1744: Use Afloat's deployed `https://useafloat.com/mcp` endpoint for remote MCP connections.
  - @yolk-sdk/agent@0.1.0-canary.51

## 0.1.0-canary.50

### Minor Changes

- 123dabf: Add an official Afloat remote MCP connector contract with the canonical endpoint, required MCP protocol version, API-key credential slot, and server-side auth-data action.

### Patch Changes

- @yolk-sdk/agent@0.1.0-canary.50

## 0.1.0-canary.49

### Patch Changes

- 9b50918: Resolve Figma refresh tokens and OAuth client secrets through host runtime credentials instead of integration config.
- b1f81eb: Keep Gmail attachment content out of normalized thread bodies and tolerate malformed body encoding.
  - @yolk-sdk/agent@0.1.0-canary.49

## 0.1.0-canary.48

### Patch Changes

- 300d4ef: Clarify that Gmail thread tools return normalized output and require `full` for decoded bodies.
- Updated dependencies [6cfc7fb]
  - @yolk-sdk/agent@0.1.0-canary.48

## 0.1.0-canary.47

### Patch Changes

- Updated dependencies [b0576d3]
  - @yolk-sdk/agent@0.1.0-canary.47

## 0.1.0-canary.46

### Patch Changes

- Classify Anthropic context overflow, support tokenizer-backed compaction estimates, and return
  normalized Gmail threads without raw MIME or attachment bytes.
- Updated dependencies
  - @yolk-sdk/agent@0.1.0-canary.46

## 0.1.0-canary.45

### Patch Changes

- Updated dependencies [d8c0b7a]
  - @yolk-sdk/agent@0.1.0-canary.45

## 0.1.0-canary.44

### Patch Changes

- Updated dependencies [607255e]
  - @yolk-sdk/agent@0.1.0-canary.44

## 0.1.0-canary.43

### Patch Changes

- Updated dependencies [5c53852]
  - @yolk-sdk/agent@0.1.0-canary.43

## 0.1.0-canary.42

### Patch Changes

- Add compaction checkpoint formatting and one-shot context-overflow retry helpers.
- Updated dependencies
  - @yolk-sdk/agent@0.1.0-canary.42

## 0.1.0-canary.41

### Patch Changes

- @yolk-sdk/agent@0.1.0-canary.41

## 0.1.0-canary.40

### Patch Changes

- Updated dependencies
  - @yolk-sdk/agent@0.1.0-canary.40

## 0.1.0-canary.39

### Patch Changes

- Expose Effect-native attachment and durable workflow helpers, and refresh package documentation for current public exports.
- Updated dependencies
  - @yolk-sdk/agent@0.1.0-canary.39

## 0.1.0-canary.38

### Patch Changes

- Harden agent transport and voice Effect boundaries.
- Updated dependencies
  - @yolk-sdk/agent@0.1.0-canary.38

## 0.1.0-canary.37

### Patch Changes

- Publish canary with agent client stream continuation fixes and package docs updates.
- Updated dependencies
  - @yolk-sdk/agent@0.1.0-canary.37

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

- Add Gmail send-as alias support for draft actions.
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

- @yolk-sdk/agent@0.1.0-canary.19

## 0.1.0-canary.18

### Patch Changes

- @yolk-sdk/agent@0.1.0-canary.18

## 0.1.0-canary.17

### Patch Changes

- 92d966b: Expose structured model-visible tool error details.
- Updated dependencies [92d966b]
- Updated dependencies [6a6d7a6]
  - @yolk-sdk/agent@0.1.0-canary.17

## 0.1.0-canary.16

### Patch Changes

- Updated dependencies [ca545a6]
  - @yolk-sdk/agent@0.1.0-canary.16

## 0.1.0-canary.15

### Minor Changes

- Unify public package shape around `@yolk-sdk/agent` subpaths, fold React/OAuth/provider/skillset/voice APIs into the agent package, and rename Vercel Workflow imports to `@yolk-sdk/vercel-workflows`.

### Patch Changes

- Updated dependencies
  - @yolk-sdk/agent@0.1.0-canary.15

## 0.1.0-canary.14

### Patch Changes

- @yolk-sdk/agent@0.1.0-canary.14

## 0.1.0-canary.13

### Minor Changes

- Add model-visible message envelopes with timestamps, author display names, and annotations.

### Patch Changes

- Updated dependencies
- Updated dependencies [3797339]
  - @yolk-sdk/agent@0.1.0-canary.13

## 0.0.1-canary.12

### Patch Changes

- Updated dependencies [b5a297a]
  - @yolk-sdk/agent@0.0.1-canary.12

## 0.0.1-canary.11

### Patch Changes

- Updated dependencies [0c7ed24]
  - @yolk-sdk/agent@0.0.1-canary.11

## 0.0.1-canary.10

### Patch Changes

- @yolk-sdk/agent@0.0.1-canary.10

## 0.0.1-canary.9

### Patch Changes

- Updated dependencies
  - @yolk-sdk/agent@0.0.1-canary.9

## 0.0.1-canary.8

### Patch Changes

- Updated dependencies [76d5c21]
  - @yolk-sdk/agent@0.0.1-canary.8

## 0.0.1-canary.7

### Patch Changes

- @yolk-sdk/agent@0.0.1-canary.7

## 0.0.1-canary.6

### Patch Changes

- Updated dependencies
  - @yolk-sdk/agent@0.0.1-canary.6

## 0.0.1-canary.5

### Patch Changes

- @yolk-sdk/agent@0.0.1-canary.5

## 0.0.1-canary.4

### Patch Changes

- Updated dependencies [992ae2c]
  - @yolk-sdk/agent@0.0.1-canary.4

## 0.0.1-canary.3

### Patch Changes

- @yolk-sdk/agent@0.0.1-canary.3

## 0.0.1-canary.2

### Patch Changes

- 55bc6c7: Prepare next canary release.
- Updated dependencies [55bc6c7]
  - @yolk-sdk/agent@0.0.1-canary.2

## 0.0.1-canary.1

### Patch Changes

- Prepare next canary release.
- Updated dependencies
  - @yolk-sdk/agent@0.0.1-canary.1

## 0.0.1-canary.0

### Patch Changes

- 4232c86: Prepare first public canary release.
- Updated dependencies [4232c86]
  - @yolk-sdk/agent@0.0.1-canary.0
