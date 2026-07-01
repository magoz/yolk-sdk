'use client'

import { useState, useTransition } from 'react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import { createTextKnowledgeDocumentAction } from '@/lib/core/knowledge/create-text-knowledge-document-action'

export function CreateTextKnowledgeForm() {
  const [title, setTitle] = useState('')
  const [content, setContent] = useState('')
  const [pinned, setPinned] = useState(true)
  const [message, setMessage] = useState<string | undefined>()
  const [isPending, startTransition] = useTransition()

  return (
    <form
      className="space-y-4 rounded-xl border bg-card p-5 text-card-foreground shadow-xs"
      onSubmit={event => {
        event.preventDefault()
        startTransition(async () => {
          const result = await createTextKnowledgeDocumentAction({ title, content, pinned })
          if (result._tag === 'Success') {
            setTitle('')
            setContent('')
            setMessage('Saved knowledge')
          } else {
            setMessage(result.message)
          }
        })
      }}
    >
      <div>
        <h2 className="font-medium">Add knowledge</h2>
        <p className="text-sm text-muted-foreground">
          Save durable context the agent can use. Pinned items load before each text run.
        </p>
      </div>
      <div className="grid gap-2">
        <Label htmlFor="knowledge-title">Title</Label>
        <Input
          id="knowledge-title"
          name="title"
          value={title}
          onChange={event => setTitle(event.currentTarget.value)}
          placeholder="Big vision"
        />
      </div>
      <div className="grid gap-2">
        <Label htmlFor="knowledge-content">Content</Label>
        <Textarea
          id="knowledge-content"
          name="content"
          value={content}
          onChange={event => setContent(event.currentTarget.value)}
          placeholder="What should the agent remember?"
          className="min-h-36"
        />
      </div>
      <label className="flex items-center gap-2 text-sm text-muted-foreground">
        <input
          type="checkbox"
          checked={pinned}
          onChange={event => setPinned(event.currentTarget.checked)}
        />
        Pin into agent context
      </label>
      <div className="flex items-center gap-3">
        <Button type="submit" disabled={isPending || title.trim().length === 0 || content.trim().length === 0}>
          {isPending ? 'Saving…' : 'Save knowledge'}
        </Button>
        {message ? <p className="text-sm text-muted-foreground" aria-live="polite">{message}</p> : null}
      </div>
    </form>
  )
}
