# Agent Chat UI

App-local chat UI over `@yolk/client`. Headless-ready first; move stable APIs to `packages/*` only after they settle.

## Boundaries

- `playground.tsx` owns page composition/wiring: text chat, voice hook, activity, console, input state.
- `use-agent-chat.ts` is the headless React hook: transport, abort, reducer dispatch, callbacks. No UI imports.
- `agent-chat-core.ts` is pure reducer/selectors over `AgentClientState`; test in `agent-chat-core.test.ts`.
- `agent-chat-items.ts` projects protocol/client state to `AgentChatItem[]`; test every new item/status in `agent-chat-items.test.ts`.
- `agent-conversation.tsx` renders `AgentChatItem[]`; no transport or protocol mutation.
- `agent-composer.tsx` owns input UX only.
- `agent-console-dialog.tsx` is test harness chrome: auth/status/config/display toggles stay out of chat layout.
- `agent-status.tsx` owns console status controls: Codex auth, text reasoning effort, Realtime transcription model, model/status badges.
- `agent-activity-model.ts` maps events to activity rows; `agent-activity.tsx` renders them.

## Chat Model

- Prefer chat language: `AgentChatItem`, `buildAgentChatItems`; avoid “timeline”.
- Stable messages come from protocol `AgentMessage[]`; streaming text/reasoning remain drafts until finalized.
- `AgentClientState.liveMessages` anchors completed assistant/tool turns during an active run; render `messages + liveMessages + drafts`.
- Tool rows derive from `AgentToolRun` (`Called`/`Running`/`Completed`) keyed by tool call id; timing lives in the run state.
- Render tool calls at the assistant message position; never append live tool rows after the current assistant draft.
- Pending agent state is an `AssistantStatus` item (`Thinking`, `Responding`, `Running …`), not fabricated reasoning.
- User and assistant drafts are render items; keep projection pure and deterministic.
- Tool result display names come from prior assistant tool calls; fall back to tool call id.

## UX Rules

- Textarea stays focused and enabled; submit is disabled while text run or voice mode is active.
- Enter submits; Shift+Enter inserts newline; ignore Enter while IME composing.
- Auto-scroll only when user is near bottom.
- Show provider reasoning only (`LLMReasoningDelta` / `Assistant.reasoning`); never invent reasoning.
- Inline tools/reasoning are optional toggles; debug/status chrome belongs in console/activity, not core chat.
- Reasoning effort is disabled while text is running; transcription model is disabled while voice is connecting/live.
- Realtime transcription selection belongs in console/status, not composer/chat.
- Keep touch targets ≥44px and dynamic status accessible (`role="status"`, `aria-live="polite"`).

## References

- `.repos/ai` and `.repos/opencode` model tools as message parts; prefer that over detached tool arrays.
- `.repos/t3code` is layout inspiration only; do not copy UI implementation.
- `lib/agents/AGENTS.md` covers server/provider/runtime wiring.
- `packages/AGENTS.md` covers reusable package boundaries.
