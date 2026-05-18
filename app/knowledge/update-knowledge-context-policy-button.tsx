'use client'

import { useState, useTransition } from 'react'
import { updateKnowledgeContextPolicyAction } from '@/lib/core/knowledge/update-knowledge-context-policy-action'

type KnowledgeContextPolicy = 'pinned' | 'routable' | 'searchable' | 'archival'

const policies: ReadonlyArray<{ readonly value: KnowledgeContextPolicy; readonly label: string }> = [
  { value: 'pinned', label: 'Pinned' },
  { value: 'routable', label: 'Routable' },
  { value: 'searchable', label: 'Searchable' },
  { value: 'archival', label: 'Archival' }
]

const policyFromValue = (value: string): KnowledgeContextPolicy | undefined => {
  switch (value) {
    case 'pinned':
    case 'routable':
    case 'searchable':
    case 'archival':
      return value
    default:
      return undefined
  }
}

export function UpdateKnowledgeContextPolicyButton({
  id,
  label,
  contextPolicy
}: {
  readonly id: string
  readonly label: string
  readonly contextPolicy: KnowledgeContextPolicy
}) {
  const [message, setMessage] = useState<string | undefined>()
  const [selectedPolicy, setSelectedPolicy] = useState(contextPolicy)
  const [isPending, startTransition] = useTransition()

  return (
    <div className="flex flex-col gap-1">
      <select
        className="h-8 rounded-md border border-input bg-background px-2 text-sm shadow-xs disabled:cursor-not-allowed disabled:opacity-50"
        disabled={isPending}
        aria-label={`Set context policy for ${label}`}
        value={selectedPolicy}
        onChange={event => {
          const nextPolicy = policyFromValue(event.currentTarget.value)
          if (nextPolicy === undefined) {
            setMessage('Invalid policy')
            return
          }
          setSelectedPolicy(nextPolicy)
          startTransition(() => {
            void updateKnowledgeContextPolicyAction({ id, contextPolicy: nextPolicy }).then(result => {
              if (result._tag === 'Error') {
                setMessage(result.message)
                setSelectedPolicy(contextPolicy)
              } else {
                setMessage(undefined)
              }
            })
          })
        }}
      >
        {policies.map(policy => <option key={policy.value} value={policy.value}>{policy.label}</option>)}
      </select>
      {message ? <span className="text-xs text-destructive">{message}</span> : null}
    </div>
  )
}
