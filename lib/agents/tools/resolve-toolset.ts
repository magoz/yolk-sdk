import { resolveTools, type ToolModule } from '@yolk-sdk/agent/tools'
import type { AgentToolContext } from './tool-context'

export const resolveAgentToolSet = (input: {
  readonly modules: ReadonlyArray<ToolModule<AgentToolContext>>
  readonly context: AgentToolContext
}) => resolveTools(input.modules, input.context)
