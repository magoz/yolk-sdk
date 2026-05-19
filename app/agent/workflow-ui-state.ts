import type { AgentRunStatus } from '@yolk-sdk/agent/client'

export const isAgentTextBusy = (input: {
  readonly isRunning: boolean
  readonly isWorkflowResuming: boolean
}) => input.isRunning || input.isWorkflowResuming

export const isWorkflowResumeDisabled = (input: {
  readonly status: AgentRunStatus
  readonly isTextBusy: boolean
}) => input.status === 'done' || input.isTextBusy
