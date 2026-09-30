---
'@yolk-sdk/agent': patch
---

Vercel AI Gateway conformance fixtures are now verified live recordings.

The four `@yolk-sdk/agent/providers/vercel/conformance` fixtures (plain text, DeepSeek reasoning, tool-call deltas, error envelope) were recorded from the live Gateway on 2026-09-30 by `pnpm conformance:gateway --live` with the synthetic account label `synthetic` (`evidence: 'verified'`), and the four Gateway conformance cases now record that live observation in `observed`. The recordings show `delta.reasoning` (with `delta.reasoning_details`) for DeepSeek reasoning, `usage` on the finish event, several events per network chunk, and a 404 `model_not_found` envelope without `error.code` for unknown models.
