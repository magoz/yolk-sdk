---
'@yolk-sdk/agent': patch
---

Name the failed check on malformed Chat Completions responses, and re-route OpenCode Go once.

Parser rejections in the OpenAI-compatible chat provider (stream payloads that are not JSON, chunks of the wrong shape, non-text reasoning, streamed tool calls without an id or name, tool arguments that are not JSON, usage without token counts, malformed JSON bodies, no choices) failed `invalid_response` without `provider` metadata, so hosts could not tell what went wrong. They now carry `provider.kind: 'invalid_response'` and a fixed `providerCode` from the new `openAiChatResponseIssues` (plus `stream` diagnostics when streamed). Messages are unchanged. Vercel AI Gateway and OpenCode Go chat inherit the codes.

OpenCode Go pins `x-opencode-session` to one upstream server, so retrying a malformed response under the same session reaches the server that just failed. `makeOpenCodeGoProviderLayer` now sends a request once more under `<session>.reroute` when it fails with a malformed-response code before emitting any event. Errors after the first event, model decisions such as `length`, and the second attempt's failure propagate as before.
