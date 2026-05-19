import { Context } from 'effect'
import type { Effect } from 'effect'
import type { ToolCall, ToolResult } from '@yolk-sdk/agent/protocol'
import type { ToolError } from '../error.ts'

export class ToolExecutor extends Context.Service<
  ToolExecutor,
  {
    readonly execute: (call: ToolCall) => Effect.Effect<ToolResult, ToolError>
  }
>()('@yolk-sdk/agent/loop/ToolExecutor') {}
