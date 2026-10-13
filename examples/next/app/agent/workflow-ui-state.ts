import { Predicate } from 'effect'
import type { AgentStatus } from '@yolk-sdk/agent/protocol'

export const isAgentTextBusy = (input: {
  readonly isRunning: boolean
  readonly isWaiting: boolean
  readonly isWorkflowResuming: boolean
}) => input.isRunning || input.isWaiting || input.isWorkflowResuming

export const isWorkflowResumeDisabled = (input: {
  readonly status: AgentStatus
  readonly isTextBusy: boolean
}) => Predicate.isTagged(input.status, 'Done') || input.isTextBusy
