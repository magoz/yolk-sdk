import type { MergedSkillset } from '@yolk-sdk/agent/skillset'

export type AgentToolSurface = 'text' | 'voice'

export type AgentToolContext = {
  readonly surface: AgentToolSurface
  readonly route: string
  readonly userId: string
  readonly sessionId?: string
  readonly subagent?: boolean
  readonly skillset?: MergedSkillset
}
