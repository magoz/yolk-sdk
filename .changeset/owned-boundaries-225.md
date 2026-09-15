---
'@yolk-sdk/agent': minor
'@yolk-sdk/mcp': minor
---

`WebRtcPeerConnectionLike.addTrack` on `@yolk-sdk/agent/voice/browser` is a void command (was unused `unknown`). Hosts and fakes must not read a sender. Real `RTCPeerConnection.addTrack` remains assignable. No export-map change.

Voice raw-argument JSON on `@yolk-sdk/agent/voice`: `protocolToolCallFromVoice` and `decideVoiceToolCall` admit finite JSON. Actual `null` / `false` / `0` still admit as those values. Raw text `1e999` uses the existing malformed fallbacks instead of publishing `Infinity` (projection params `'1e999'`; approval display `{ argumentsJson: '1e999' }`). Nested overflow takes the same fallbacks. Do not demonstrate with `JSON.stringify(Infinity)` (that is `null`). Execution schema validation and approval identifiers/gates are unchanged.

`@yolk-sdk/mcp/client` and `@yolk-sdk/mcp/protocol` export Schema owners `InitializeClientInfo`, `InitializeParams`, `InitializedNotification`, and `ToolsCallParams`. Prefer Schema owners for new construction. Compatibility `makeJsonRpcRequest`, `makeInitializeParams`, and `makeInitializedNotification` remain and omit `params` when `undefined`. No new export subpath.
