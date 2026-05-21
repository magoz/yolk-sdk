'use client'

import { useState, useTransition } from 'react'
import { toast } from 'sonner'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { deleteTelegramConnectorAction } from '@/lib/core/agent/delete-telegram-connector-action'
import { saveTelegramConnectorAction } from '@/lib/core/agent/save-telegram-connector-action'

type TelegramConnectorFormProps = {
  readonly initialConnected: boolean
  readonly initialChatId?: string
}

export function TelegramConnectorForm({
  initialConnected,
  initialChatId
}: TelegramConnectorFormProps) {
  const [connected, setConnected] = useState(initialConnected)
  const [chatId, setChatId] = useState(initialChatId ?? '')
  const [botToken, setBotToken] = useState('')
  const [isPending, startTransition] = useTransition()

  const handleSave = () => {
    startTransition(async () => {
      const result = await saveTelegramConnectorAction({ botToken, chatId })

      if (result._tag === 'Error') {
        toast.error(result.message)
        return
      }

      setConnected(true)
      setChatId(result.chatId)
      setBotToken('')
      toast.success('Telegram connected')
    })
  }

  const handleDisconnect = () => {
    startTransition(async () => {
      const result = await deleteTelegramConnectorAction()

      if (result._tag === 'Error') {
        toast.error(result.message)
        return
      }

      setConnected(false)
      setChatId('')
      setBotToken('')
      toast.success('Telegram disconnected')
    })
  }

  return (
    <section className="rounded-2xl border border-foreground/10 bg-card/70 p-5">
      <div className="flex items-start justify-between gap-3">
        <div className="space-y-1">
          <h2 className="text-lg font-medium">Telegram</h2>
          <p className="text-sm leading-6 text-muted-foreground">
            Configure a bot token and chat id. The agent gets a `telegram_send_message`
            tool after connect, including voice and subagent runs.
          </p>
        </div>
        <Badge variant={connected ? 'secondary' : 'outline'}>
          {connected ? 'connected' : 'optional'}
        </Badge>
      </div>

      <div className="mt-5 grid gap-4">
        <div className="grid gap-2">
          <Label htmlFor="telegram-bot-token">Bot token</Label>
          <Input
            id="telegram-bot-token"
            type="password"
            value={botToken}
            onChange={event => setBotToken(event.target.value)}
            placeholder={connected ? 'Paste token to replace' : '123456:ABC-DEF...'}
            autoComplete="off"
          />
        </div>

        <div className="grid gap-2">
          <Label htmlFor="telegram-chat-id">Chat id</Label>
          <Input
            id="telegram-chat-id"
            value={chatId}
            onChange={event => setChatId(event.target.value)}
            placeholder="-1001234567890"
            autoComplete="off"
          />
        </div>

        <div className="flex flex-wrap gap-2">
          <Button type="button" onClick={handleSave} disabled={isPending}>
            {connected ? 'Update' : 'Connect'}
          </Button>
          {connected ? (
            <Button
              type="button"
              variant="outline"
              onClick={handleDisconnect}
              disabled={isPending}
            >
              Disconnect
            </Button>
          ) : null}
        </div>
      </div>
    </section>
  )
}
