import type { AgentUsage } from '@yolk/protocol'
import { Badge } from '@/components/ui/badge'

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

type AgentUsageBadgeProps = {
  readonly usage: AgentUsage
  readonly hasUsage: boolean
}

export function AgentUsageBadge({ usage, hasUsage }: AgentUsageBadgeProps) {
  if (!hasUsage) {
    return null
  }

  return (
    <Badge
      variant="outline"
      className="hidden font-mono tabular-nums sm:inline-flex"
      title={formatUsageDetail(usage)}
      role="status"
      aria-live="polite"
    >
      {formatUsageSummary(usage)}
    </Badge>
  )
}

type AgentUsagePanelProps = {
  readonly usage: AgentUsage
  readonly hasUsage: boolean
}

export function AgentUsagePanel({ usage, hasUsage }: AgentUsagePanelProps) {
  if (!hasUsage) {
    return <Badge variant="outline">none yet</Badge>
  }

  return (
    <div className="flex flex-wrap justify-end gap-1.5 font-mono tabular-nums">
      <Badge variant="secondary">{formatUsageSummary(usage)}</Badge>
      <Badge variant="outline">in {formatTokenCount(usage.input.total)}</Badge>
      <Badge variant="outline">out {formatTokenCount(usage.output.total)}</Badge>
      {usage.output.reasoning !== undefined && usage.output.reasoning > 0 ? (
        <Badge variant="outline">reasoning {formatTokenCount(usage.output.reasoning)}</Badge>
      ) : null}
      {usage.input.cacheRead !== undefined && usage.input.cacheRead > 0 ? (
        <Badge variant="outline">cached {formatTokenCount(usage.input.cacheRead)}</Badge>
      ) : null}
    </div>
  )
}
