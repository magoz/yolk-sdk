export type AgentWorkflowInput = {
  readonly userId: string
  readonly request: unknown
}

// App-owned token strategy, not an SDK transport contract: one token per pause. The turn plus
// the number of answers its batch already took is unique per pause, so resuming an earlier
// pause's token finds no hook rather than a later pause's. Which pause an answer goes to is the
// resume route's decision: the client names the pause (the `eventId` of its `AgentAwaitingInput`)
// with `?pause=`, and the route matches the stored pause by that id, never by the token.
export const agentWorkflowHitlHookToken = (input: {
  readonly runId: string
  readonly turn: number
  readonly answers: number
}) => `agent-hitl:${input.runId}:${input.turn}:${input.answers}`
