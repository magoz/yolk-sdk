import type { AgentUsage } from '@yolk/protocol'
import { Badge } from '@/components/ui/badge'
import {
  agentTextContextBudget,
  contextBudgetStatus,
  contextBudgetUsageRatio,
  type ContextBudget
} from '@/lib/agents/context-budget'

const tokenUnits = [
  { suffix: 'm', value: 1_000_000 },
  { suffix: 'k', value: 1_000 }
]

export const totalAgentUsageTokens = (usage: AgentUsage) => usage.input.total + usage.output.total

export const formatTokenCount = (tokens: number) => {
  const unit = tokenUnits.find(candidate => Math.abs(tokens) >= candidate.value)

  if (unit === undefined) {
    return `${tokens}`
  }

  const value = tokens / unit.value
  const rounded = value >= 10 ? Math.round(value) : Math.round(value * 10) / 10

  return `${rounded}${unit.suffix}`
}

export const formatUsageSummary = (usage: AgentUsage) =>
  `${formatTokenCount(totalAgentUsageTokens(usage))} tokens`

export const formatUsageDetail = (usage: AgentUsage) => {
  const detail = [
    `in ${formatTokenCount(usage.input.total)}`,
    `out ${formatTokenCount(usage.output.total)}`
  ]

  if (usage.output.reasoning !== undefined && usage.output.reasoning > 0) {
    detail.push(`reasoning ${formatTokenCount(usage.output.reasoning)}`)
  }

  if (usage.input.cacheRead !== undefined && usage.input.cacheRead > 0) {
    detail.push(`cached ${formatTokenCount(usage.input.cacheRead)}`)
  }

  return detail.join(' · ')
}

export const formatContextPercent = (tokens: number, budget: ContextBudget) =>
  `${Math.min(999, Math.round(contextBudgetUsageRatio(tokens, budget) * 100))}%`

export type AgentCompactionState =
  | { readonly _tag: 'Idle' }
  | { readonly _tag: 'Compacting'; readonly strategy: string }
  | {
      readonly _tag: 'Compacted'
      readonly strategy: string
      readonly beforeTokens?: number
      readonly afterTokens?: number
    }

const compactionLabel = (state: AgentCompactionState) => {
  switch (state._tag) {
    case 'Idle':
      return undefined
    case 'Compacting':
      return 'compacting'
    case 'Compacted':
      return 'compacted'
  }
}

const contextBadgeVariant = (tokens: number, budget: ContextBudget) =>
  contextBudgetStatus(tokens, budget) === 'compact' ? 'destructive' : 'outline'

const contextBadgeClassName = (tokens: number, budget: ContextBudget) =>
  contextBudgetStatus(tokens, budget) === 'warning'
    ? 'border-amber-500/60 text-amber-700 dark:text-amber-300'
    : undefined

type AgentUsageBadgeProps = {
  readonly usage: AgentUsage
  readonly hasUsage: boolean
  readonly contextTokens: number | null
  readonly compaction: AgentCompactionState
}

export function AgentUsageBadge({
  usage,
  hasUsage,
  contextTokens,
  compaction
}: AgentUsageBadgeProps) {
  if (!hasUsage) {
    return null
  }

  const tokens = contextTokens ?? usage.input.total
  const context = `${formatContextPercent(tokens, agentTextContextBudget)} ctx`
  const compacted = compactionLabel(compaction)

  return (
    <Badge
      variant={contextBadgeVariant(tokens, agentTextContextBudget)}
      className={`hidden font-mono tabular-nums sm:inline-flex ${contextBadgeClassName(tokens, agentTextContextBudget) ?? ''}`}
      title={`${formatUsageDetail(usage)} · context ${formatTokenCount(tokens)} / ${formatTokenCount(agentTextContextBudget.usableInputTokens)}`}
      role="status"
      aria-live="polite"
    >
      {formatUsageSummary(usage)} · {context}
      {compacted === undefined ? null : ` · ${compacted}`}
    </Badge>
  )
}

type AgentUsagePanelProps = {
  readonly usage: AgentUsage
  readonly hasUsage: boolean
  readonly contextTokens: number | null
  readonly compaction: AgentCompactionState
}

export function AgentUsagePanel({
  usage,
  hasUsage,
  contextTokens,
  compaction
}: AgentUsagePanelProps) {
  if (!hasUsage) {
    return <Badge variant="outline">none yet</Badge>
  }

  const tokens = contextTokens ?? usage.input.total
  const compacted = compactionLabel(compaction)

  return (
    <div className="flex flex-wrap justify-end gap-1.5 font-mono tabular-nums">
      <Badge variant="secondary">{formatUsageSummary(usage)}</Badge>
      <Badge
        variant={contextBadgeVariant(tokens, agentTextContextBudget)}
        className={contextBadgeClassName(tokens, agentTextContextBudget)}
      >
        ctx {formatContextPercent(tokens, agentTextContextBudget)}
      </Badge>
      <Badge variant="outline">in {formatTokenCount(usage.input.total)}</Badge>
      <Badge variant="outline">out {formatTokenCount(usage.output.total)}</Badge>
      <Badge variant="outline">
        window {formatTokenCount(agentTextContextBudget.usableInputTokens)}
      </Badge>
      {usage.output.reasoning !== undefined && usage.output.reasoning > 0 ? (
        <Badge variant="outline">reasoning {formatTokenCount(usage.output.reasoning)}</Badge>
      ) : null}
      {usage.input.cacheRead !== undefined && usage.input.cacheRead > 0 ? (
        <Badge variant="outline">cached {formatTokenCount(usage.input.cacheRead)}</Badge>
      ) : null}
      {compacted === undefined ? null : <Badge variant="outline">{compacted}</Badge>}
    </div>
  )
}
