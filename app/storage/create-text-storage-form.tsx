'use client'

import { useState, useTransition } from 'react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import { createFileStorageObjectAction } from '@/lib/core/storage/create-file-storage-object-action'
import { createTextStorageObjectAction } from '@/lib/core/storage/create-text-storage-object-action'

export function CreateTextStorageForm() {
  const [message, setMessage] = useState<string | undefined>()
  const [isPending, startTransition] = useTransition()

  return (
    <div className="space-y-4">
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
      <form
        className="rounded-lg border p-4 space-y-4"
        action={formData => {
          startTransition(() => {
            void createFileStorageObjectAction(formData).then(result => {
              setMessage(result._tag === 'Success' ? 'Indexed file' : result.message)
            })
          })
        }}
      >
        <div className="space-y-1.5">
          <Label htmlFor="file">File</Label>
          <Input
            id="file"
            name="file"
            type="file"
            accept=".txt,.md,.markdown,.csv,.json,.pdf,.docx,.xlsx,.pptx,text/plain,text/markdown,text/csv,application/json,application/pdf,application/vnd.openxmlformats-officedocument.wordprocessingml.document,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,application/vnd.openxmlformats-officedocument.presentationml.presentation"
            required
          />
          <p className="text-sm text-muted-foreground">Supports text, markdown, CSV, JSON, PDF, DOCX, XLSX, and PPTX.</p>
        </div>
        <Button type="submit" disabled={isPending}>
          {isPending ? 'Indexing…' : 'Index file'}
        </Button>
      </form>
    </div>
  )
}
