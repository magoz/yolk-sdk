export type AgentWorkflowInput = {
  readonly userId: string
  readonly request: unknown
}

// App-owned token strategy, not an SDK transport contract. The client only posts
// `{ hitlResponses }` to the run endpoint; this route authorizes run access, and
// the agent loop validates `requestId`/`toolCallId` before executing anything.
export const agentWorkflowHitlHookToken = (input: { readonly runId: string }) =>
  `agent-hitl:${input.runId}`
