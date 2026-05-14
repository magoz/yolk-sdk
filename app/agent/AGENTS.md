# Agent Chat UI

App-local conversation UI over headless `@yolk/react` chat state.

## Boundaries

- `page.tsx` is a runtime chooser; runtime pages live at `/agent/next`, `/agent/cloudflare`, and `/agent/workflow`.
- `runtime-page.tsx` owns shared server bootstrap/session wiring for runtime pages.
- `/agent/next` uses `/api/agent` NDJSON only.
- `/agent/cloudflare` bootstraps direct Cloudflare WS only; missing env/bootstrap shows explicit error, no Next fallback; remote MCP config is loaded by Next and passed in bootstrap.
- `/agent/workflow` uses `/api/agent/workflow`, starts a Vercel Workflow run, and reads the durable stream returned by `run.getReadable()`.
- Workflow runtime records `x-workflow-run-id` in Activity, can replay the durable stream by run id, and stop requests cancel the Workflow run.
- Workflow resume is for interrupted/aborted active runs only; keep resume disabled after `done` to avoid replaying completed stream chunks into duplicate UI messages.
- Workflow stop is optimistic in the UI: it aborts the browser stream and calls `run.cancel()`, but Vercel may not preempt an already-running model step immediately.
- Cloudflare session ids must be URL-safe before building `/connect/:sessionId`; avoid raw `:` in browser WS paths.
- `playground.tsx` owns page composition/wiring: text chat transport selection, voice hook, activity, console, input state.
- `@yolk/react` owns headless hook/core/messages/items; app imports `useAgentChat`, `buildAgentChatItems`, and chat item types.
- `agent-conversation.tsx` renders `AgentChatItem[]` and message action callbacks; no transport or protocol mutation.
- `agent-composer.tsx` owns input UX only: textarea, image picker/dropzone/paste, multi-image preview/remove.
- Slash command UI stays in `agent-composer.tsx`; command route transport stays in `command-client.ts` using Effect `HttpClient`.
- Slash command parsing/selection helpers stay pure in `slash-command-model.ts`; test keyboard/index/hint behavior there.
- `image-attachment-content.ts` maps composer text+images state to protocol `Content`; test it without importing full playground.
- `agent-console-dialog.tsx` is test harness chrome: auth/status/config/display toggles stay out of chat layout.
- `agent-status.tsx` owns console status controls: Codex/Claude auth, text model, text reasoning effort, Realtime transcription model, capability/status badges.
- `agent-activity-model.ts` maps lifecycle/tool/retry/compaction events to activity rows; `agent-activity.tsx` renders them.
- `agent-usage-meter.tsx` formats provider-normalized token usage/context budget for header/console chrome.
- `message-edit-model.ts` owns pure edit shortcut/save-state helpers; keep keyboard semantics testable outside JSX.

## Chat Model

- Prefer chat language: `AgentChatMessage`, `AgentChatPart`, `AgentChatItem`; avoid “timeline”.
- `AgentChatState.chatMessages` is UI source of truth; protocol `AgentMessage[]` is replay format only.
- Cloudflare reconnect snapshots are transport/runtime state; UI reload hydration from `SessionSnapshot` is not implemented yet.
- Use `toAgentMessages(chatMessages)` before text transport; keep protocol conversion at the boundary.
- Agent events update parts directly: text/reasoning stream as parts; tools track input, approval, execution, completion, denial, and errors.
- Text may begin after reasoning in the same assistant turn; keep it streaming from first `LLMTextDelta`, not only final `AssistantMessage`.
- Tool rows are anchored by `ToolCall` parts; preserve `startedAtMs`/`endedAtMs` across lifecycle events.
- Tool-origin error results (`ToolResult.isError`) render as failed tool output, distinct from transport/tool execution errors.
- Render standalone `ToolResult` only for orphan results.
- Pending agent state is an `AssistantStatus` item (`Thinking`, `Responding`, `Running …`), not fabricated reasoning.
- Voice user draft is transient UI only; completed voice transcripts append protocol user messages into chat parts.
- Image attachments are `ImagePart` base64 data URLs at the UI boundary; `toAgentMessages()` preserves multipart user content.
- Keep projection pure/deterministic; use Effect `Array`/`Option` helpers over mutable/null side channels.

## UX Rules

- Textarea stays focused and enabled; submit is disabled while text run or voice mode is active.
- Image attach supports picker, drag/drop, and clipboard paste; max 4 images; downscale/compress before protocol conversion.
- Gate image attach/drop/paste from `agentTextCapabilities.input.image`; console exposes text/image/audio + tools support.
- Enter submits; Shift+Enter inserts newline; ignore Enter while IME composing.
- Auto-scroll only when user is near bottom.
- Message actions are turn-level: delete removes a user+assistant turn; regenerate starts from an assistant message.
- Editing is user-message-only in app UI; save replaces text content and reruns from that turn.
- Edit textarea shortcuts: Enter saves, Shift+Enter newline, Escape cancels; keep Save disabled for blank/unchanged edits.
- Text-only edits are app policy; multimodal `Content` support remains headless package capability.
- App-created transient messages must include `turnId` and `sequence`; keep IDs compatible but do not parse them for behavior.
- Show provider reasoning only (`LLMReasoningDelta` / assistant reasoning parts); never invent reasoning.
- Inline tools/reasoning are optional toggles; debug/status chrome belongs in console/activity, not core chat.
- Token usage/context meter belongs in header/console chrome, driven by `UsageUpdate`, `AgentEnd`, and compaction lifecycle only.
- Reasoning effort is disabled while text is running; transcription model is disabled while voice is connecting/live.
- Text model picker is disabled while text is running; selected model is forwarded through `@yolk/react`/`@yolk/agent/client` to Next, Workflow, or Cloudflare runtimes.
- Realtime transcription selection belongs in console/status, not composer/chat.
- Keep touch targets ≥44px and dynamic status accessible (`role="status"`, `aria-live="polite"`).

## Image TODOs

- Server route validates image count, MIME, base64 shape, per-image size, and total payload before provider calls; UI compression is convenience only.
- Keep provider capability copy in sync with `agentTextCapabilities`; do not hardcode image support in UI.
- Add full-suite E2E coverage when image flow becomes less route-stubbed.

## Voice lifecycle

- Guard stale async WebRTC starts/stops; close peer/data/media resources on cancel/failure.
- Completed transcripts append as protocol user messages; interim audio drafts remain transient UI state.
- Voice tool calls route through `/api/agent/realtime/tool`; do not execute tools in the browser hook.

## References

- `.repos/ai` and `.repos/opencode` model tools as message parts; prefer that over detached tool arrays.
- `.repos/t3code` is layout inspiration only; do not copy UI implementation.
- Keep tests for live result visibility, row-before-draft anchoring, orphan result fallback, and status labels.
- `lib/agents/AGENTS.md` covers server/provider/runtime wiring.
- `packages/AGENTS.md` covers reusable package boundaries.
