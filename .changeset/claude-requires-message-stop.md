---
'@yolk-sdk/agent': patch
---

Fail Claude streams that end before `message_stop` instead of completing them.

Compatibility change: the Claude provider (`makeAnthropicClaudeProviderLayer`, `streamAnthropicClaudeResponse`) used to treat a stream that ended without `message_stop` (a cut connection, an empty body) as a normal answer and emitted `Done`. Like native Messages it now requires the terminal event: such a stream emits no `Done` and fails as non-retryable `invalid_response` with `responseIssue: 'missing_done'`, the loop's incomplete stream, even when a `message_delta` with a stop reason arrived (only `message_stop` ends a message). A `max_tokens` or `content_filter` stop reason still fails as that terminal, without `responseIssue`. Hosts that fold provider events directly now see an error instead of a short answer; harness hosts get the incomplete-stream recovery (`RecoverFull` / `Continue`). Native Messages (OpenCode Go `messages`), which already failed here, now also sets `responseIssue: 'missing_done'` on that error. Claude's JSON fallback still accepts a body without `stop_reason`.
