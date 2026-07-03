'use client'

import { useState, useTransition } from 'react'
import { Button } from '@/components/ui/button'
import { deleteStorageObjectAction } from '@/lib/core/storage/delete-storage-object-action'

export function DeleteStorageSourceButton({
  id,
  label
}: {
  readonly id: string
  readonly label: string
}) {
  const [message, setMessage] = useState<string | undefined>()
  const [isPending, startTransition] = useTransition()

  return (
    <div className="flex items-center gap-2">
      {message ? (
        <p className="text-xs text-destructive" aria-live="polite">
          {message}
        </p>
      ) : null}
      <Button
        type="button"
        variant="destructive"
        size="sm"
        disabled={isPending}
        aria-label={`Delete ${label}`}
        onClick={() => {
          const confirmed = window.confirm(
            `Delete “${label}”? This removes it from storage search.`
          )
          if (!confirmed) {
            return
          }

          setMessage(undefined)
          startTransition(() => {
            void deleteStorageObjectAction({ id }).then(result => {
              if (result._tag === 'Error') {
                setMessage(result.message)
              }
            })
          })
        }}
      >
        {isPending ? 'Deleting…' : 'Delete'}
      </Button>
    </div>
  )
}
