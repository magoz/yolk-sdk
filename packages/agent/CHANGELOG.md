# @yolk-sdk/agent

## 0.1.0-canary.30

### Patch Changes

- 4148be9: Poll empty durable run continuation chunks and abort promptly while waiting.

## 0.1.0-canary.29

### Patch Changes

- Expose terminal agent event detection and add Workflow terminal commit-barrier helpers.

## 0.1.0-canary.28

### Patch Changes

- 90b0558: Fix Anthropic streamed usage deltas and include cache tokens in input totals.

## 0.1.0-canary.27

### Patch Changes

- Add durable run continuation and HITL resume client helpers.

## 0.1.0-canary.26

### Minor Changes

- Add replay-safe workflow event sequencing and chat projection helpers.

## 0.1.0-canary.25

### Patch Changes

- Fix connector provider pagination, Google scoped OAuth, Gmail drafts/send-as, LinkedIn queued email lookup, and R2 public URL handling.

## 0.1.0-canary.24

## 0.1.0-canary.23

### Patch Changes

- e8ac8ce: Support URL-backed image and PDF attachment lowering in agent providers.

## 0.1.0-canary.22

### Patch Changes

- 378cd92: Turn recoverable tool execution failures into model-visible error tool results, add transcript repair/validation helpers, and preflight dangling tool calls before provider lowering.

## 0.1.0-canary.21

### Patch Changes

- Surface typed provider failure metadata, retry state, and retry-aware chat items.

## 0.1.0-canary.20

### Patch Changes

- Add text document attachment helpers.

## 0.1.0-canary.19

## 0.1.0-canary.18

## 0.1.0-canary.17

### Patch Changes

- 92d966b: Expose structured model-visible tool error details.
- 6a6d7a6: Add helpers for model-visible recoverable tool failures.

## 0.1.0-canary.16

### Minor Changes

- ca545a6: Add pure agent compaction utilities under `@yolk-sdk/agent/compaction`.

## 0.1.0-canary.15

### Minor Changes

- Unify public package shape around `@yolk-sdk/agent` subpaths, fold React/OAuth/provider/skillset/voice APIs into the agent package, and rename Vercel Workflow imports to `@yolk-sdk/vercel-workflows`.

## 0.1.0-canary.14

## 0.1.0-canary.13

### Minor Changes

- Add model-visible message envelopes with timestamps, author display names, and annotations.
- 3797339: Add model-visible message envelope fields for timestamps, author display names, and annotations.

## 0.0.1-canary.12

### Patch Changes

- b5a297a: Add HITL response helpers and serializable question results.

## 0.0.1-canary.11

### Patch Changes

- 0c7ed24: Drain HTTP agent streams after terminal events.

## 0.0.1-canary.10

## 0.0.1-canary.9

### Patch Changes

- Add typed attachment sources for inline media, URLs, and host-owned refs.

## 0.0.1-canary.8

### Patch Changes

- 76d5c21: Add document chat content parts with provider lowering.

## 0.0.1-canary.7

## 0.0.1-canary.6

### Patch Changes

- Add package-owned task subagent helpers for non-recursive tool exposure, result formatting, and protocol-aligned subagent run ids.

## 0.0.1-canary.5

## 0.0.1-canary.4

### Patch Changes

- 992ae2c: Require exact HITL request matches before resuming runtime sessions.

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
