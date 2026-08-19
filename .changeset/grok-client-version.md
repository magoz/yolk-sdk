---
'@yolk-sdk/agent': patch
---

Require a host-owned Grok CLI `clientVersion` on `XAiGrokProviderConfig`, sent as `x-grok-client-version`, because the xAI CLI proxy version-gates subscription requests and rejects missing or outdated versions with HTTP 426.
