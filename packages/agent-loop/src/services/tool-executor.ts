import { Context } from 'effect'
import type { Effect } from 'effect'
import type { ToolCall, ToolResult } from '@yolk/protocol'
import type { ToolError } from '../error.ts'

export class ToolExecutor extends Context.Service<
  ToolExecutor,
  {
    readonly execute: (call: ToolCall) => Effect.Effect<ToolResult, ToolError>
  }
>()('@yolk/agent-loop/ToolExecutor') {}
