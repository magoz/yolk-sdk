import { resolveTools, type ToolModule } from '@yolk/tool-registry'
import type { AgentToolContext } from './tool-context'

export const resolveAgentToolSet = (input: {
  readonly modules: ReadonlyArray<ToolModule<AgentToolContext>>
  readonly context: AgentToolContext
}) => resolveTools(input.modules, input.context)
