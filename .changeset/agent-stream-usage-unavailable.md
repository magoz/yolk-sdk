---
'@yolk-sdk/agent': minor
---

Signal when a streamed model call completes without the usage report it asked for (#109). `LLMDone` and the protocol `LLMStreamEnd` gain an optional `usageUnavailable: true`, which the loop forwards from the provider's `Done` onto that model stream's `LLMStreamEnd`. Providers set it when:

- streamed chat (generic OpenAI-compatible chat, Vercel AI Gateway with `streaming: true`, OpenCode Go `chat-completions`): the stream ends after its finish chunk without the usage chunk `stream_options.include_usage` requested;
- Codex: its EOF-completion compatibility completes a stream without `response.completed`, or it recovers a `response.completed` without readable output (whose usage is then unreadable too) and no usage was emitted;
- Claude and native Messages (OpenCode Go `messages`): `message_stop` arrives without a `message_delta` carrying usage, so only the partial `message_start` usage (if any) was reported.

These turns still complete normally, as before, since failing them would re-run and re-bill the model; hosts can now tell "usage was requested but never arrived" from "no usage" and decide how to account for it. Grok and OpenCode Go Responses streams fail without `response.completed`, and Messages streams fail without `message_stop`, so they never complete that way. The field is absent otherwise (JSON responses, complete streams) and on events recorded before it existed, so persisted event streams decode unchanged, and no event or `LLMEvent` tag is added.
