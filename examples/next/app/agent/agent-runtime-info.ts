import { Data } from 'effect'

// Shared by the server bootstrap and client props; keep outside 'use client' modules.
export type AgentRuntimeInfo = Data.TaggedEnum<{
  readonly Next: {
    readonly label: string
    readonly detail: string
  }
  readonly Cloudflare: {
    readonly label: string
    readonly detail: string
    readonly webSocketUrl: string
  }
  readonly Workflow: {
    readonly label: string
    readonly detail: string
  }
}>

export const AgentRuntimeInfo = Data.taggedEnum<AgentRuntimeInfo>()
