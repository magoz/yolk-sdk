'use client'

import { useState, useTransition } from 'react'
import { Button } from '@/components/ui/button'
import { deleteKnowledgeObjectAction } from '@/lib/core/knowledge/delete-knowledge-object-action'

export function DeleteKnowledgeObjectButton({
  id,
  label,
  onDeleteOptimistic
}: {
  readonly id: string
  readonly label: string
  readonly onDeleteOptimistic: (id: string) => void
}) {
  const [message, setMessage] = useState<string | undefined>()
  const [isPending, startTransition] = useTransition()

  return (
    <div className="flex items-center gap-2">
      <Button
        type="button"
        variant="ghost"
        size="sm"
        disabled={isPending}
        aria-label={`Delete ${label}`}
        onClick={() => {
          startTransition(async () => {
            onDeleteOptimistic(id)
            const result = await deleteKnowledgeObjectAction(id)
            if (result._tag === 'Error') {
              setMessage(result.message)
              return
            }
            setMessage(undefined)
          })
        }}
      >
        {isPending ? 'Deleting…' : 'Delete'}
      </Button>
      {message ? <span className="text-xs text-destructive">{message}</span> : null}
    </div>
  )
}
