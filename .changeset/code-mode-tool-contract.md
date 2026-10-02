---
'@yolk-sdk/agent': minor
'@yolk-sdk/connectors': patch
'@yolk-sdk/mcp': patch
---

Add the code mode tool contract (ADR 0002, step 1) without adding code mode itself.

- Output schemas: `makeTool({ output })` lowers an Effect Schema into declaration-only
  `ToolDef.outputSchema` the same way as `parameters`. Connector tool registrations pass the action
  `outputSchema` through, and `mcpToolToToolDef` passes a plain-object MCP `outputSchema` through.
  Output schemas are never sent to providers and never validate results.
- Exposure: `ToolDef.callableBy` (`all` default, `model`, `codemode`) and, for `codemode` only,
  `discovery` (`listed` default, `search`), typed on `makeTool` options as the `ToolExposure`
  union. Protocol helpers `isCodeModeCallable`, `isCodeModeFailClosed`, `providerToolDefs`,
  `isProviderToolDef`, and `toolDiscovery` implement the rules. Approval, input, interaction,
  activated background, `question`, and `subagent` tools never run from code mode; `resolveTools`
  fails `codemode_unsupported_tool` when they are marked `codemode` and `invalid_tool_exposure` for
  `discovery` without `codemode`, and warns when codemode-only tools have no nested-access tool.
- Codemode-only tools never reach providers: `run`, `runModelTurn`, capability checks, and the
  OpenAI Realtime session builders omit them. Provider-issued calls to them fail closed as unknown
  tools (`prepareToolBatch` synthetic error result, `ResolvedToolSet.execute` `not_found`, voice
  denial) without dispatch.
- Nested tool access: registrations with `nestedToolAccess: true` receive a `nested`
  `NestedToolExecutor` scoped to the same resolution and host context. Its `tools` list the
  code-mode-callable tools (excluding nested-access registrations) with their module ids; its
  `execute` runs through the resolved execute path and returns model-visible error results for
  unknown, disabled, or non-callable tools and tool failures. Nested call ids follow
  `<parentToolCallId>/<seq>`. Decorators outside `ResolvedToolSet.execute` (for example a wrapped
  `ToolExecutor`) do not see nested calls.
- Module descriptions: `ToolModule` accepts an optional `description`, carried on `NestedTool` as
  `moduleDescription` for code mode listing and search.
- Nested-call record: optional `ToolResult.nestedCalls` (`NestedToolCalls`) and summed
  `ToolResult.usage`, built with `recordNestedToolCall` / `nestedToolCallResultFields` within
  exported bounds (256 calls, 8 KiB arguments per call, 32 KiB in total, 500-character errors).
  They round-trip as plain JSON and are dropped by `toolResultMessageFromResult`, so transcripts
  and providers never see them.
