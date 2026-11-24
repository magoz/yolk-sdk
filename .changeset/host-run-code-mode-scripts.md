---
'@yolk-sdk/agent': minor
'@yolk-sdk/codemode': minor
---

Run code mode scripts outside a model turn, gate them to reads, mark tools that call a model, and
keep message envelopes on chat items.

`@yolk-sdk/codemode`:

- `runCodeModeScript({ executor, code, nested, parentCallId, limits?, deadline?, store?, beforeNestedCall?, afterNestedCall?, staging? })`
  runs one script without a model tool call and returns a `CodeModeScriptResult`: `ok`, the JSON
  `value` and `storeWrites` of a successful script or its `error`, the unbounded `output`, every
  nested call (`calls`, `CodeModeScriptCall` with `refusal`), the bounded `nestedCalls` record,
  `usage`, `usageIncomplete`, `inputRequired`, `staged`, `timeoutMs` and `wallTimeMs`. It never
  fails; interrupting it aborts the script and cancels running nested calls. `makeCodeModeTool` now
  runs every script through it, so dispatch, limits, the deadline clamp, the executor backstop, the
  store and both hooks are one path; its results are unchanged.
- `beforeNestedCall` also receives the called `tool` (`NestedTool`) and the call's effective
  `access`, and may refuse with `new CodeModeNestedCallRefused({ code, message })`: the script sees
  `error.code`, and the call's `refusal` keeps both. Existing hooks (`{ call, context }`, string
  failures) keep working. A hook that throws or dies now refuses the call (`The call could not be
admitted.`, recorded as its `refusal`) instead of escaping the call.
- `readOnlyNestedCallGate({ admit? })`: a ready-made `beforeNestedCall` that admits only calls whose
  effective access is `read` and refuses approval-gated and `invokesModel` tools, failing closed,
  with codes `unavailable`, `approval_required`, `invokes_model` and `not_read`. `admit` relaxes only
  the access check.
- `makeClassifierTool` sets `invokesModel: true`.
- `CodeModeLimits`, `defaultCodeModeLimits`, `CodeModeStagingOptions` and the deadline constants
  move to the new script module; they are exported from the root as before.

`@yolk-sdk/agent`:

- `ResolvedToolSet.nestedExecutor({ parentCallId })` returns the `NestedToolExecutor` a
  nested-access registration gets, bound to a host id instead of a tool call (nested ids
  `<parentCallId>/<seq>`, ledgered under parent key `parentCallId`), without staging. It is a
  required field: hosts that build `ResolvedToolSet` values by hand (test fakes) must add it. The
  warning for code-mode-only tools without a nested-access registration now says they stay
  reachable through it.
- `ToolRegistration.invokesModel` and the `makeTool` option mark a tool that calls a model when it
  runs. `resolveTools` copies it to `ToolMetadata.invokesModel` and `NestedTool.invokesModel`; it is
  never sent to providers. The `subagent` tool sets it.
- React: `buildAgentChatMessages` keeps assistant message envelopes (`createdAtMs`, `author`,
  `annotations`) from the transcript, as live events already did, so `toAgentMessages` round-trips
  them. `buildAgentChatItems` copies a message's envelope onto its `UserMessage` and
  `AssistantMessage` items (`AgentChatItemEnvelope`, each field only when set), so hosts render
  annotated host-authored messages without reading their own snapshots.
