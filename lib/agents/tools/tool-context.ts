export type AgentToolSurface = 'text' | 'voice'

export type AgentToolContext = {
  readonly surface: AgentToolSurface
  readonly route: string
  readonly userId: string
}
