---
'@yolk-sdk/agent': minor
---

Signal when a streamed model call completes without the usage report it asked for (#109). `LLMDone` and the protocol `LLMStreamEnd` gain an optional `usageUnavailable: true`, which the loop forwards from the provider's `Done` onto that model stream's `LLMStreamEnd`. Providers set it when:

- streamed chat (generic OpenAI-compatible chat, Vercel AI Gateway with `streaming: true`, OpenCode Go `chat-completions`): the stream ends after its finish chunk without the usage chunk `stream_options.include_usage` requested;
- streamed Responses (Codex, Grok, OpenCode Go `responses`): `response.completed` carries no `usage`;
- Codex: its EOF-completion compatibility completes a stream without `response.completed` (including a premature cut, which it has always accepted), or it recovers a streamed `response.completed` whose `output` is missing or misses a required key (such as a function call's `call_id`), so the response, usage included, cannot be decoded;
- Claude and native Messages (OpenCode Go `messages`): `message_stop` arrives without a `message_delta` carrying an output count, so only the partial `message_start` usage (if any) was reported.

These turns kept their existing successful completion, since failing them would re-run and re-bill the model; hosts can now tell "usage was requested but never arrived" from "no usage" and decide how to account for it. Grok and OpenCode Go Responses streams fail without `response.completed`, and Messages streams fail without `message_stop`, so they never complete without a terminal event. Non-streamed (JSON) responses are never marked, including a Codex JSON response recovered without output. The field is absent when the report arrived and on events recorded before it existed, so persisted event streams decode unchanged, and no event or `LLMEvent` tag is added.
