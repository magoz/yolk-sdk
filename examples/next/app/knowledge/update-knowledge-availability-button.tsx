'use client'

import { useState, useTransition } from 'react'
import { updateKnowledgeAvailabilityAction } from '@/lib/core/knowledge/update-knowledge-availability-action'
import type { KnowledgeAvailability } from '@/lib/core/knowledge/availability'

const availabilities: ReadonlyArray<{ readonly value: KnowledgeAvailability; readonly label: string }> = [
  { value: 'pinned', label: 'Pinned' },
  { value: 'searchable', label: 'Searchable' },
  { value: 'archived', label: 'Archived' }
]

const availabilityFromValue = (value: string): KnowledgeAvailability | undefined => {
  switch (value) {
    case 'pinned':
    case 'searchable':
    case 'archived':
      return value
    default:
      return undefined
  }
}

export function UpdateKnowledgeAvailabilityButton({
  id,
  label,
  availability
}: {
  readonly id: string
  readonly label: string
  readonly availability: KnowledgeAvailability
}) {
  const [message, setMessage] = useState<string | undefined>()
  const [selectedAvailability, setSelectedAvailability] = useState(availability)
  const [isPending, startTransition] = useTransition()

  return (
    <div className="flex flex-col gap-1">
      <select
        className="h-8 rounded-md border border-input bg-background px-2 text-sm shadow-xs disabled:cursor-not-allowed disabled:opacity-50"
        disabled={isPending}
        aria-label={`Set availability for ${label}`}
        value={selectedAvailability}
        onChange={event => {
          const nextAvailability = availabilityFromValue(event.currentTarget.value)
          if (nextAvailability === undefined) {
            setMessage('Invalid availability')
            return
          }
          setSelectedAvailability(nextAvailability)
          startTransition(() => {
            void updateKnowledgeAvailabilityAction({ id, availability: nextAvailability }).then(result => {
              if (result._tag === 'Error') {
                setMessage(result.message)
                setSelectedAvailability(availability)
              } else {
                setMessage(undefined)
              }
            })
          })
        }}
      >
        {availabilities.map(item => <option key={item.value} value={item.value}>{item.label}</option>)}
      </select>
      {message ? <span className="text-xs text-destructive">{message}</span> : null}
    </div>
  )
}
