---
'@yolk-sdk/agent': patch
'@yolk-sdk/emulators': patch
---

Default OpenCode Go to its documented base, `https://opencode.ai/inference/go/v1`.

`openCodeGoBaseUrl` and `openCodeGoSubscriptionUsageUrl` moved from `/zen/go/v1` to `/inference/go/v1`, the base OpenCode's Go docs list for every endpoint. The earlier base still answers; hosts pinning it through `baseUrl` or `url` are unaffected. The OpenCode Go conformance fixtures and `makeOpenCodeGoEmulator` routes follow the new paths.
