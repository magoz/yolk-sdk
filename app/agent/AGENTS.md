# Agent Chat UI

App-local parts-native chat UI. `@yolk/client` is transport-only here; move stable APIs to `packages/*` only after they settle.

## Boundaries

- `playground.tsx` owns page composition/wiring: text chat, voice hook, activity, console, input state.
- `use-agent-chat.ts` is the headless React hook: transport, abort, reducer dispatch, callbacks. No UI imports.
- `agent-chat-core.ts` is pure reducer/selectors over parts-native `AgentChatState`; test in `agent-chat-core.test.ts`.
- `agent-chat-messages.ts` owns `AgentChatMessage`/`AgentChatPart`, AgentEvent → parts reduction, and `toAgentMessages()` protocol replay.
- `agent-chat-items.ts` projects `AgentChatMessage[]` to `AgentChatItem[]`; test every new item/status in `agent-chat-items.test.ts`.
- `agent-conversation.tsx` renders `AgentChatItem[]`; no transport or protocol mutation.
- `agent-composer.tsx` owns input UX only: textarea, image picker/dropzone/paste, multi-image preview/remove.
- `image-attachment-content.ts` maps composer text+images state to protocol `Content`; test it without importing full playground.
- `agent-console-dialog.tsx` is test harness chrome: auth/status/config/display toggles stay out of chat layout.
- `agent-status.tsx` owns console status controls: Codex auth, text reasoning effort, Realtime transcription model, model/capability/status badges.
- `agent-activity-model.ts` maps lifecycle/tool/retry/compaction events to activity rows; `agent-activity.tsx` renders them.

## Chat Model

- Prefer chat language: `AgentChatMessage`, `AgentChatPart`, `AgentChatItem`; avoid “timeline”.
- `AgentChatState.chatMessages` is UI source of truth; protocol `AgentMessage[]` is replay format only.
- Use `toAgentMessages(chatMessages)` before text transport; keep protocol conversion at the boundary.
- Agent events update parts directly: text/reasoning stream as parts; tool calls transition `Called` → `Running` → `Completed`.
- Tool rows are anchored by `ToolCall` parts; preserve `startedAtMs`/`endedAtMs` when later `ToolResult` events re-merge results.
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
- Show provider reasoning only (`LLMReasoningDelta` / `Assistant.reasoning`); never invent reasoning.
- Inline tools/reasoning are optional toggles; debug/status chrome belongs in console/activity, not core chat.
- Reasoning effort is disabled while text is running; transcription model is disabled while voice is connecting/live.
- Realtime transcription selection belongs in console/status, not composer/chat.
- Keep touch targets ≥44px and dynamic status accessible (`role="status"`, `aria-live="polite"`).

## Image TODOs

- Add server/route image payload limits; never trust client compression.
- Keep provider capability copy in sync with `agentTextCapabilities`; do not hardcode image support in UI.
- Consider richer image failure UI: per-file reason, retry, and remove failed attachments without clearing valid ones.
- Add full-suite E2E coverage when image flow becomes less route-stubbed.

## References

- `.repos/ai` and `.repos/opencode` model tools as message parts; prefer that over detached tool arrays.
- `.repos/t3code` is layout inspiration only; do not copy UI implementation.
- Keep tests for live result visibility, row-before-draft anchoring, orphan result fallback, and status labels.
- `lib/agents/AGENTS.md` covers server/provider/runtime wiring.
- `packages/AGENTS.md` covers reusable package boundaries.
