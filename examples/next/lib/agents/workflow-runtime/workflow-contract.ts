export type AgentWorkflowInput = {
  readonly userId: string
  readonly request: unknown
}

// App-owned token strategy, not an SDK transport contract: one token per pause. The turn plus
// the number of answers its batch already took is unique per pause, so a late duplicate of an
// earlier pause's answer never reaches a later pause's hook. The client only posts
// `{ hitlResponses }` to the run endpoint; the route resumes the stored pause holding the request.
export const agentWorkflowHitlHookToken = (input: {
  readonly runId: string
  readonly turn: number
  readonly answers: number
}) => `agent-hitl:${input.runId}:${input.turn}:${input.answers}`
