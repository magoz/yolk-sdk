import { Match } from 'effect'
import type { AgentActivity, AgentBlockedKind, AgentStatus } from '@yolk-sdk/agent/protocol'

export const textStatusVariant = (status: AgentStatus) =>
  Match.value(status).pipe(
    Match.withReturnType<'secondary' | 'destructive' | 'outline'>(),
    Match.tag('Done', () => 'secondary'),
    Match.tag('Failed', () => 'destructive'),
    Match.tag('Idle', 'Working', 'Blocked', () => 'outline'),
    Match.exhaustive
  )

const blockedLabel = (kind: AgentBlockedKind) => {
  switch (kind) {
    case 'permission':
      return 'needs approval'
    case 'question':
      return 'needs answer'
    case 'auth':
      return 'needs sign-in'
  }
}

const activityLabel = (activity: AgentActivity) =>
  Match.value(activity).pipe(
    Match.tag('Busy', () => 'working'),
    Match.tag('Generating', () => 'generating'),
    Match.tag('Tools', current =>
      current.calls.length === 1 ? `running ${current.calls[0].name}` : 'running tools'
    ),
    Match.tag('Compacting', () => 'compacting'),
    Match.tag('Retrying', () => 'retrying'),
    Match.exhaustive
  )

export const textStatusLabel = (status: AgentStatus) =>
  Match.value(status).pipe(
    Match.tag('Idle', () => 'idle'),
    Match.tag('Working', current => activityLabel(current.activity)),
    Match.tag('Blocked', current => blockedLabel(current.kind)),
    Match.tag('Done', () => 'done'),
    Match.tag('Failed', () => 'failed'),
    Match.exhaustive
  )
