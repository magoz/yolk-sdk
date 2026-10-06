---
'@yolk-sdk/codemode': patch
---

Advance in lockstep with tool change previews in `@yolk-sdk/agent`; no code mode implementation changes. Hosts that stage tool calls: plan review previews now come from each tool's `changePreview` hook in `@yolk-sdk/agent`, which replaces `staging.preview`.
