'use client'

import { useState, useTransition } from 'react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import { createTextStorageObjectAction } from '@/lib/core/storage/create-text-storage-object-action'

export function CreateTextStorageForm() {
  const [message, setMessage] = useState<string | undefined>()
  const [isPending, startTransition] = useTransition()

  return (
    <form
      className="rounded-lg border p-4 space-y-4"
      action={formData => {
        const title = String(formData.get('title') ?? '')
        const content = String(formData.get('content') ?? '')

        startTransition(() => {
          void createTextStorageObjectAction({ title, content }).then(result => {
            setMessage(result._tag === 'Success' ? 'Indexed' : result.message)
          })
        })
      }}
    >
      <div className="space-y-1.5">
        <Label htmlFor="title">Title</Label>
        <Input id="title" name="title" placeholder="Notes" />
      </div>
      <div className="space-y-1.5">
        <Label htmlFor="content">Text</Label>
        <Textarea id="content" name="content" placeholder="Paste text to index" required />
      </div>
      <div className="flex items-center gap-3">
        <Button type="submit" disabled={isPending}>
          {isPending ? 'Indexing…' : 'Index text'}
        </Button>
        {message ? <p className="text-sm text-muted-foreground">{message}</p> : null}
      </div>
    </form>
  )
}
