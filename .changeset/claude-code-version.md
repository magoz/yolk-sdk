---
'@yolk-sdk/agent': patch
---

Identify the Claude subscription transport as Claude Code 2.1.299 (was 2.1.112). Anthropic gates newer models by the Claude Code version in the user agent and billing header: Claude Opus 5.5 answered HTTP 400 `claude_code_version_too_old` (needs 2.1.280 or newer). The billing header algorithm (salt, sampled positions, version suffix) is unchanged in 2.1.299.
