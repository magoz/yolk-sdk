---
'@yolk-sdk/agent': patch
---

Declare an object root on provider-facing tool parameter schemas derived from Effect unions, and surface machine provider error codes on OpenAI-compatible HTTP failures.

`makeTool` now stamps a missing root `type` as `"object"` (unions compile to typeless `anyOf`), which strict OpenAI-compatible upstreams such as DeepSeek behind OpenCode Go require; call validation still runs against the original Effect Schema. The OpenAI Chat Completions and Responses HTTP error paths now extract the envelope `code`/`type` into `provider.providerCode` for kind classification and host diagnostics; free-text upstream messages stay out of `LLMError` per the existing sanitization policy.
