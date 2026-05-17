'use client'

import { useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import { createAgentCommandAction } from '@/lib/core/agent/create-agent-command-action'
import { deleteAgentCommandAction } from '@/lib/core/agent/delete-agent-command-action'
import { toggleAgentCommandAction } from '@/lib/core/agent/toggle-agent-command-action'
import { updateAgentCommandAction } from '@/lib/core/agent/update-agent-command-action'
import type { AgentCommand } from '@/lib/services/db/schema'

type ActionState = {
  readonly message?: string
}

const formValue = (formData: FormData, key: string) => String(formData.get(key) ?? '')

export function CreateCommandForm() {
  const router = useRouter()
  const [state, setState] = useState<ActionState>({})
  const [pending, startTransition] = useTransition()

  return (
    <Card>
      <CardHeader>
        <CardTitle>Create command</CardTitle>
        <CardDescription>Commands expand slash prompts before a run.</CardDescription>
      </CardHeader>
      <CardContent>
        <form
          className="space-y-4"
          action={formData => {
            startTransition(() => {
              void createAgentCommandAction({
                name: formValue(formData, 'name'),
                description: formValue(formData, 'description'),
                template: formValue(formData, 'template')
              }).then(result => {
                setState({ message: result._tag === 'Success' ? 'Command created' : result.message })
                if (result._tag === 'Success') router.refresh()
              })
            })
          }}
        >
          <div className="grid gap-2">
            <Label htmlFor="new-command-name">Name</Label>
            <Input id="new-command-name" name="name" placeholder="review" required />
          </div>
          <div className="grid gap-2">
            <Label htmlFor="new-command-description">Description</Label>
            <Input id="new-command-description" name="description" placeholder="Review current work" />
          </div>
          <div className="grid gap-2">
            <Label htmlFor="new-command-template">Template</Label>
            <Textarea
              id="new-command-template"
              name="template"
              placeholder="Review this change: $ARGUMENTS"
              className="min-h-32"
              required
            />
          </div>
          <div className="flex min-h-10 items-center gap-3">
            <Button type="submit" disabled={pending}>
              {pending ? 'Creating…' : 'Create command'}
            </Button>
            {state.message ? <p className="text-sm text-muted-foreground" aria-live="polite">{state.message}</p> : null}
          </div>
        </form>
      </CardContent>
    </Card>
  )
}

function CommandCard({ command }: { readonly command: AgentCommand }) {
  const router = useRouter()
  const [state, setState] = useState<ActionState>({})
  const [pending, startTransition] = useTransition()

  return (
    <Card size="sm">
      <CardHeader>
        <CardTitle>/{command.name}</CardTitle>
        <CardDescription>{command.enabled ? 'Enabled' : 'Disabled'}</CardDescription>
      </CardHeader>
      <CardContent>
        <form
          className="space-y-4"
          action={formData => {
            startTransition(() => {
              void updateAgentCommandAction({
                id: command.id,
                name: formValue(formData, 'name'),
                description: formValue(formData, 'description'),
                template: formValue(formData, 'template'),
                enabled: command.enabled
              }).then(result => {
                setState({ message: result._tag === 'Success' ? 'Saved' : result.message })
                if (result._tag === 'Success') router.refresh()
              })
            })
          }}
        >
          <div className="grid gap-2">
            <Label htmlFor={`${command.id}-name`}>Name</Label>
            <Input id={`${command.id}-name`} name="name" defaultValue={command.name} required />
          </div>
          <div className="grid gap-2">
            <Label htmlFor={`${command.id}-description`}>Description</Label>
            <Input id={`${command.id}-description`} name="description" defaultValue={command.description} />
          </div>
          <div className="grid gap-2">
            <Label htmlFor={`${command.id}-template`}>Template</Label>
            <Textarea
              id={`${command.id}-template`}
              name="template"
              defaultValue={command.template}
              className="min-h-32"
              required
            />
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <Button type="submit" disabled={pending}>{pending ? 'Saving…' : 'Save'}</Button>
            <Button
              type="button"
              variant="outline"
              disabled={pending}
              onClick={() => {
                startTransition(() => {
                  void toggleAgentCommandAction({ id: command.id, enabled: !command.enabled }).then(result => {
                    setState({ message: result._tag === 'Success' ? (command.enabled ? 'Disabled' : 'Enabled') : result.message })
                    if (result._tag === 'Success') router.refresh()
                  })
                })
              }}
            >
              {command.enabled ? 'Disable' : 'Enable'}
            </Button>
            <Button
              type="button"
              variant="destructive"
              disabled={pending}
              onClick={() => {
                startTransition(() => {
                  void deleteAgentCommandAction({ id: command.id }).then(result => {
                    setState({ message: result._tag === 'Success' ? 'Deleted' : result.message })
                    if (result._tag === 'Success') router.refresh()
                  })
                })
              }}
            >
              Delete
            </Button>
            {state.message ? <p className="text-sm text-muted-foreground" aria-live="polite">{state.message}</p> : null}
          </div>
        </form>
      </CardContent>
    </Card>
  )
}

export function CommandList({ commands }: { readonly commands: ReadonlyArray<AgentCommand> }) {
  return commands.length === 0 ? (
    <p className="rounded-xl border border-dashed p-6 text-sm text-muted-foreground">No commands yet.</p>
  ) : (
    <div className="space-y-4">
      {commands.map(command => <CommandCard key={command.id} command={command} />)}
    </div>
  )
}
