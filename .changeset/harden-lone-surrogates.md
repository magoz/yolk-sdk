---
'@yolk-sdk/agent': patch
---

Harden model-produced text: `replaceLoneSurrogates`/`replaceLoneSurrogatesDeep` protocol utils, applied to lowered provider request bodies (OpenAI, Codex, Claude) and OpenAI Realtime client codec payloads so lone UTF-16 surrogates in replayed transcripts cannot poison model calls.
