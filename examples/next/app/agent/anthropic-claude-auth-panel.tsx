'use client'

import { useState, useTransition, type FormEvent } from 'react'
import { toast } from 'sonner'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { deleteAnthropicClaudeTokenAction } from '@/lib/core/agent/delete-anthropic-claude-token-action'
import { exchangeAnthropicClaudeOAuthCodeAction } from '@/lib/core/agent/exchange-anthropic-claude-oauth-code-action'
import { startAnthropicClaudeOAuthAction } from '@/lib/core/agent/start-anthropic-claude-oauth-action'

type AnthropicClaudeAuthPanelProps = {
  readonly initialConnected: boolean
}

export function AnthropicClaudeAuthPanel({ initialConnected }: AnthropicClaudeAuthPanelProps) {
  const [connected, setConnected] = useState(initialConnected)
  const [authUrl, setAuthUrl] = useState<string | null>(null)
  const [authorizationCode, setAuthorizationCode] = useState('')
  const [isPending, startTransition] = useTransition()

  const handleConnect = () => {
    startTransition(async () => {
      const result = await startAnthropicClaudeOAuthAction()

      if (result._tag === 'Error') {
        toast.error(result.message)
        return
      }

      setAuthUrl(result.authUrl)
      setAuthorizationCode('')
      window.open(result.authUrl, '_blank', 'noopener,noreferrer')
    })
  }

  const handleSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()

    startTransition(async () => {
      const result = await exchangeAnthropicClaudeOAuthCodeAction({ authorizationCode })

      if (result._tag === 'Error') {
        toast.error(result.message)
        return
      }

      setConnected(true)
      setAuthUrl(null)
      setAuthorizationCode('')
      toast.success('Anthropic Claude connected')
    })
  }

  const handleCancel = () => {
    setAuthUrl(null)
    setAuthorizationCode('')
  }

  const handleDisconnect = () => {
    startTransition(async () => {
      const result = await deleteAnthropicClaudeTokenAction()

      if (result._tag === 'Error') {
        toast.error(result.message)
        return
      }

      setConnected(false)
      setAuthUrl(null)
      setAuthorizationCode('')
      toast.success('Anthropic Claude disconnected')
    })
  }

  return (
    <div className="rounded-2xl border border-foreground/10 bg-card/70 p-4 text-sm">
      <div className="flex items-start justify-between gap-3">
        <div className="space-y-1">
          <p className="font-medium">Claude subscription</p>
          <p className="text-xs leading-5 text-muted-foreground">
            Connect Anthropic Claude OAuth for Pro/Max subscription access.
          </p>
        </div>
        <Badge variant={connected ? 'secondary' : 'outline'}>
          {connected ? 'connected' : 'optional'}
        </Badge>
      </div>

      {authUrl === null ? (
        <div className="mt-4 flex flex-wrap gap-2">
          <Button type="button" size="sm" onClick={handleConnect} disabled={isPending}>
            {connected ? 'Reconnect' : 'Connect'}
          </Button>
          {connected ? (
            <Button
              type="button"
              size="sm"
              variant="outline"
              onClick={handleDisconnect}
              disabled={isPending}
            >
              Disconnect
            </Button>
          ) : null}
        </div>
      ) : (
        <form
          className="mt-4 rounded-xl border border-dashed border-primary/50 bg-primary/5 p-3"
          onSubmit={handleSubmit}
        >
          <label htmlFor="anthropic-claude-oauth-code" className="text-xs font-medium">
            Paste Claude authorization code
          </label>
          <Input
            id="anthropic-claude-oauth-code"
            className="mt-2"
            value={authorizationCode}
            onChange={event => setAuthorizationCode(event.currentTarget.value)}
            placeholder="code#state"
            autoComplete="off"
          />
          <p className="mt-2 text-xs text-muted-foreground" aria-live="polite">
            Complete Claude login, then paste the returned code here.
          </p>
          <div className="mt-3 flex flex-wrap gap-2">
            <Button type="submit" size="sm" disabled={isPending || authorizationCode.trim() === ''}>
              Save
            </Button>
            <Button
              type="button"
              size="sm"
              variant="outline"
              onClick={() => window.open(authUrl, '_blank', 'noopener,noreferrer')}
            >
              Reopen
            </Button>
            <Button type="button" size="sm" variant="outline" onClick={handleCancel}>
              Cancel
            </Button>
          </div>
        </form>
      )}
    </div>
  )
}
