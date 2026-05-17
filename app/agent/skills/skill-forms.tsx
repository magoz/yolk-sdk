'use client'

import { useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import { createAgentSkillAction } from '@/lib/core/agent/create-agent-skill-action'
import { deleteAgentSkillAction } from '@/lib/core/agent/delete-agent-skill-action'
import { toggleAgentSkillAction } from '@/lib/core/agent/toggle-agent-skill-action'
import { updateAgentSkillAction } from '@/lib/core/agent/update-agent-skill-action'
import type { AgentSkill } from '@/lib/services/db/schema'

type ActionState = {
  readonly message?: string
}

const formValue = (formData: FormData, key: string) => String(formData.get(key) ?? '')

export function CreateSkillForm() {
  const router = useRouter()
  const [state, setState] = useState<ActionState>({})
  const [pending, startTransition] = useTransition()

  return (
    <Card>
      <CardHeader>
        <CardTitle>Create skill</CardTitle>
        <CardDescription>Skills appear in agent context and can be loaded by name.</CardDescription>
      </CardHeader>
      <CardContent>
        <form
          className="space-y-4"
          action={formData => {
            startTransition(() => {
              void createAgentSkillAction({
                name: formValue(formData, 'name'),
                description: formValue(formData, 'description'),
                content: formValue(formData, 'content')
              }).then(result => {
                setState({ message: result._tag === 'Success' ? 'Skill created' : result.message })
                if (result._tag === 'Success') {
                  router.refresh()
                }
              })
            })
          }}
        >
          <div className="grid gap-2">
            <Label htmlFor="new-skill-name">Name</Label>
            <Input id="new-skill-name" name="name" placeholder="review-code" required />
          </div>
          <div className="grid gap-2">
            <Label htmlFor="new-skill-description">Description</Label>
            <Input
              id="new-skill-description"
              name="description"
              placeholder="Review code changes for correctness"
              required
            />
          </div>
          <div className="grid gap-2">
            <Label htmlFor="new-skill-content">Instructions</Label>
            <Textarea
              id="new-skill-content"
              name="content"
              placeholder="Use this skill when…"
              className="min-h-40"
              required
            />
          </div>
          <div className="flex min-h-10 items-center gap-3">
            <Button type="submit" disabled={pending}>
              {pending ? 'Creating…' : 'Create skill'}
            </Button>
            {state.message ? (
              <p className="text-sm text-muted-foreground" aria-live="polite">
                {state.message}
              </p>
            ) : null}
          </div>
        </form>
      </CardContent>
    </Card>
  )
}

function SkillCard({ skill }: { readonly skill: AgentSkill }) {
  const router = useRouter()
  const [state, setState] = useState<ActionState>({})
  const [pending, startTransition] = useTransition()

  return (
    <Card size="sm">
      <CardHeader>
        <CardTitle>{skill.name}</CardTitle>
        <CardDescription>{skill.enabled ? 'Enabled' : 'Disabled'}</CardDescription>
      </CardHeader>
      <CardContent>
        <form
          className="space-y-4"
          action={formData => {
            startTransition(() => {
              void updateAgentSkillAction({
                id: skill.id,
                name: formValue(formData, 'name'),
                description: formValue(formData, 'description'),
                content: formValue(formData, 'content'),
                enabled: skill.enabled
              }).then(result => {
                setState({ message: result._tag === 'Success' ? 'Saved' : result.message })
                if (result._tag === 'Success') {
                  router.refresh()
                }
              })
            })
          }}
        >
          <div className="grid gap-2">
            <Label htmlFor={`${skill.id}-name`}>Name</Label>
            <Input id={`${skill.id}-name`} name="name" defaultValue={skill.name} required />
          </div>
          <div className="grid gap-2">
            <Label htmlFor={`${skill.id}-description`}>Description</Label>
            <Input
              id={`${skill.id}-description`}
              name="description"
              defaultValue={skill.description}
              required
            />
          </div>
          <div className="grid gap-2">
            <Label htmlFor={`${skill.id}-content`}>Instructions</Label>
            <Textarea
              id={`${skill.id}-content`}
              name="content"
              defaultValue={skill.content}
              className="min-h-40"
              required
            />
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <Button type="submit" disabled={pending}>
              {pending ? 'Saving…' : 'Save'}
            </Button>
            <Button
              type="button"
              variant="outline"
              disabled={pending}
              onClick={() => {
                startTransition(() => {
                  void toggleAgentSkillAction({ id: skill.id, enabled: !skill.enabled }).then(result => {
                    setState({
                      message: result._tag === 'Success' ? (skill.enabled ? 'Disabled' : 'Enabled') : result.message
                    })
                    if (result._tag === 'Success') {
                      router.refresh()
                    }
                  })
                })
              }}
            >
              {skill.enabled ? 'Disable' : 'Enable'}
            </Button>
            <Button
              type="button"
              variant="destructive"
              disabled={pending}
              onClick={() => {
                startTransition(() => {
                  void deleteAgentSkillAction({ id: skill.id }).then(result => {
                    setState({ message: result._tag === 'Success' ? 'Deleted' : result.message })
                    if (result._tag === 'Success') {
                      router.refresh()
                    }
                  })
                })
              }}
            >
              Delete
            </Button>
            {state.message ? (
              <p className="text-sm text-muted-foreground" aria-live="polite">
                {state.message}
              </p>
            ) : null}
          </div>
        </form>
      </CardContent>
    </Card>
  )
}

export function SkillList({ skills }: { readonly skills: ReadonlyArray<AgentSkill> }) {
  return skills.length === 0 ? (
    <p className="rounded-xl border border-dashed p-6 text-sm text-muted-foreground">No skills yet.</p>
  ) : (
    <div className="space-y-4">
      {skills.map(skill => (
        <SkillCard key={skill.id} skill={skill} />
      ))}
    </div>
  )
}
