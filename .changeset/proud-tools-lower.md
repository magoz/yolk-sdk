---
'@yolk-sdk/agent': patch
---

Lower union-root (`anyOf`) tool parameters to a single object schema in `toOpenAiRealtimeTool`; OpenAI Realtime hangs until a gateway timeout (504) on union-root function tools. Exposes `openAiRealtimeToolParameters`.
