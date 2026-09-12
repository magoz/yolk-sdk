# @yolk-sdk/vercel-workflows

## 0.1.0-canary.76

### Patch Changes

- 8f5ea35: Add host-only retrieval for Google Drive download/export, Gmail, Outlook, IMAP/POP3, Notion, Telegram, Todoist attachments, Fortnox preview/archive, and R2 gets, plus bounded Dropbox/OneDrive writes and conditional R2 puts. Preserve GET-only binary adapters, base64 attachment actions, and R2 presigning. OneDrive update requires acknowledgeOverwrite and is unconditional, not CAS; Dropbox revision and R2 ETag preconditions stay strict. Add Fortnox list_supplier_invoice_files and Todoist list_comments read actions. Drive bytes default to drive.file with host-only drive.readonly opt-in; Fortnox archive/connectfile slots are opt-in and not added to the combined hint. No generic agent byte actions or app wiring.
- 34b4275: Add a host-only Dropbox original-byte download helper, `downloadDropboxFile`, on `@yolk-sdk/connectors/dropbox`. It mirrors the host-only OneDrive original-byte helper, but Dropbox never follows content redirects. It reuses the existing `dropbox.oauth` binding through a new `files.content.read` scope and `DropboxContentReadOAuthCredentialSlot` (now also included in `DropboxCombinedOAuthCredentialSlot`), calls the Dropbox content endpoint once through the optional bounded binary HTTP port, returns allowlisted `Dropbox-API-Result` metadata plus untouched bytes, and sanitizes failures to typed codes. Default Dropbox actions and agent serialization are unchanged. Hosts still implement connection-time network policy, streamed limits, and app-owned file materialization/read tools.

## 0.1.0-canary.75

### Minor Changes

- 7f238d8: Add a host-only OneDrive/SharePoint original-byte download helper and an optional bounded binary HTTP port. Reuse existing Microsoft read credentials, resolve remote item identities, sanitize failures, and strip all original headers on download redirects. Default Microsoft actions and agent serialization are unchanged. Hosts still implement connection-time network policy, streamed limits, and app-owned file materialization/read tools.

## 0.1.0-canary.74

### Patch Changes

- 79fe70b: Reject disabled question calls without entering HITL, and distinguish matching subagent
  observations from terminal child completion without charging nested usage. Supply deterministic
  zero-based read/sleep attempt indices to `awaitWorkflowChild` so durable hosts can bound
  observation polling and apply capped backoff while preserving existing zero-argument callbacks.

## 0.1.0-canary.73

### Patch Changes

- 6672571: Add opt-in background subagent acknowledgements without premature child-completion events,
  public whole-batch HITL preflight, and generic bounded Workflow tool orchestration and durable
  child read/sleep seams. Preserve inline subagent compatibility and logical usage identity.
  The Next example wires independent foreground/background child workflows with owned durable
  reservations/results and tombstone-first explicit Stop cancellation.
- 2749df0: Add Effect-native `resolveMessageAttachmentSources` and `resolveMessagesAttachmentSources` protocol helpers. Traverse user, assistant, and tool-result media, including nested assistant provider tool results, while preserving metadata and ordering without mutation or caching. Document host-owned fresh signing inside provider retries, native PDF/image tool results, and bounded attachment transport.

  Validate Gmail discovery attachment sizes as nonnegative integers and omit malformed optional size metadata. Keep download limits, decoded-byte validation, authorization, storage, and extraction policy host-owned.

## 0.1.0-canary.72

### Patch Changes

- 79b6ff8: Align installation examples with the SDK's Effect version, correct Google connector tool wiring, document Outlook optional read inputs, and date previously released canary migrations.
- 9897531: Add `@yolk-sdk/connectors/fortnox` with nine read-only actions for company information and list/get customers, invoices, suppliers, and supplier invoices. Include typed schemas, pagination, resource-scoped OAuth credential hints, provider failure handling, and agent-tool access metadata. Hosts retain HTTP execution, OAuth lifecycle, credentials, and policy; Fortnox OAuth scopes themselves still grant read and write access.
- 782092d: Normalize null and blank optional inputs for Outlook message search and listing, including null page sizes, before execution. Direct connector callers and generated agent tools now share the compatibility behavior while preserving real cursors, input validation, application-mailbox guards, and provider failures.

## 0.1.0-canary.71

## 0.1.0-canary.70

## 0.1.0-canary.69

## 0.1.0-canary.68

### Patch Changes

- 73e7a9b: Refresh public guidance for durable user-message events, voice WebSocket wiring, Calendar event boundaries, and Workflow testing.

## 0.1.0-canary.67

### Patch Changes

- 0da67d1: Add replay-safe durable user-message events and skip empty tool-batch steps when a workflow model turn continues without tool calls.
- 57795cf: Refresh public package descriptions, connector access guidance, and documented package subpaths.

## 0.1.0-canary.66

### Patch Changes

- Document the `workflow@^5.0.0-beta.42` requirement, the `./testing` subpath, and region-pinned streaming behavior in the published README.

## 0.1.0-canary.65

### Patch Changes

- a2b7057: Require `workflow@^5.0.0-beta.42`: the 5.x line makes Vercel Workflow runs region-pinned
  (multi-region default since 5.0.0-beta.33), serving storage, queuing, and durable streams
  region-locally instead of routing through `iad1`. Verified against the real v5 local world by the
  package directive integration tests.

## 0.1.0-canary.64

### Minor Changes

- a9bd5e2: Add a `./testing` subpath exporting `TestWorkflowWorld`, a behavioral Vercel
  Workflow platform emulator for host tests: run lifecycle, append-only durable
  streams with close-once -> HTTP 409 "already completed" conflicts, a step
  executor honoring `fn.maxRetries` with 1-based `getStepMetadata().attempt`
  metadata, hooks/resume, cancellation, a `VercelWorkflowsSdkClient` adapter for
  `VercelWorkflows.layerFromSdk`, and a `testWorkflowModule` surface for mocking
  the ambient `workflow` module.

## 0.1.0-canary.63

## 0.1.0-canary.62

## 0.1.0-canary.61

## 0.1.0-canary.60

## 0.1.0-canary.59

### Patch Changes

- a5581f7: Refresh public package documentation with verified imports, runtime boundaries, and host responsibilities.

## 0.1.0-canary.58

## 0.1.0-canary.57

### Patch Changes

- da9e8ba: Refresh package documentation with runtime requirements, host responsibilities, subpath boundaries, and corrected usage examples.
- de55946: Classify Codex context-window failures as context overflow, support endpoint-specific input budgets, expose subagent usage and redacted typed error summaries (including partial failed-run usage), reject subagent streams without terminal events, and clarify that ChatGPT Codex ignores output-token configuration. Carry tool-owned nested-model usage through durable workflow state and HITL failures, preserve wire-safe partial-progress failures, and normalize Workflow turn limits to positive integers.

## 0.1.0-canary.56

## 0.1.0-canary.55

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
