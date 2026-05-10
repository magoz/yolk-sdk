'use client'

import { useEffect, useRef, useState, useTransition } from 'react'
import { toast } from 'sonner'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { checkOpenAiCodexDeviceFlowAction } from '@/lib/core/agent/check-openai-codex-device-flow-action'
import { deleteOpenAiCodexTokenAction } from '@/lib/core/agent/delete-openai-codex-token-action'
import { startOpenAiCodexDeviceFlowAction } from '@/lib/core/agent/start-openai-codex-device-flow-action'

type DeviceFlow = {
  readonly userCode: string
  readonly verificationUrl: string
  readonly deviceAuthId: string
  readonly interval: number
}

type OpenAiCodexAuthPanelProps = {
  readonly initialConnected: boolean
}

export function OpenAiCodexAuthPanel({ initialConnected }: OpenAiCodexAuthPanelProps) {
  const [connected, setConnected] = useState(initialConnected)
  const [deviceFlow, setDeviceFlow] = useState<DeviceFlow | null>(null)
  const [isPending, startTransition] = useTransition()
  const pollingRef = useRef<ReturnType<typeof setInterval> | null>(null)

  useEffect(() => {
    return () => {
      if (pollingRef.current !== null) {
        clearInterval(pollingRef.current)
      }
    }
  }, [])

  const stopPolling = () => {
    if (pollingRef.current !== null) {
      clearInterval(pollingRef.current)
      pollingRef.current = null
    }
  }

  const pollDeviceFlow = (flow: DeviceFlow) => {
    const intervalMs = (flow.interval + 3) * 1000

    pollingRef.current = setInterval(async () => {
      const result = await checkOpenAiCodexDeviceFlowAction({
        deviceAuthId: flow.deviceAuthId,
        userCode: flow.userCode
      })

      if (result._tag === 'Pending') {
        return
      }

      stopPolling()

      if (result._tag === 'Success') {
        setConnected(true)
        setDeviceFlow(null)
        toast.success('OpenAI Codex connected')
        return
      }

      setDeviceFlow(null)
      toast.error(result.message)
    }, intervalMs)
  }

  const handleConnect = () => {
    startTransition(async () => {
      const result = await startOpenAiCodexDeviceFlowAction()

      if (result._tag === 'Error') {
        toast.error(result.message)
        return
      }

      const flow = {
        userCode: result.userCode,
        verificationUrl: result.verificationUrl,
        deviceAuthId: result.deviceAuthId,
        interval: result.interval
      }

      setDeviceFlow(flow)
      window.open(flow.verificationUrl, '_blank', 'noopener,noreferrer')
      pollDeviceFlow(flow)
    })
  }

  const handleCancel = () => {
    stopPolling()
    setDeviceFlow(null)
  }

  const handleDisconnect = () => {
    startTransition(async () => {
      const result = await deleteOpenAiCodexTokenAction()

      if (result._tag === 'Error') {
        toast.error(result.message)
        return
      }

      setConnected(false)
      setDeviceFlow(null)
      toast.success('OpenAI Codex disconnected')
    })
  }

  return (
    <div className="rounded-2xl border border-foreground/10 bg-card/70 p-4 text-sm">
      <div className="flex items-start justify-between gap-3">
        <div className="space-y-1">
          <p className="font-medium">ChatGPT subscription</p>
          <p className="text-xs leading-5 text-muted-foreground">
            Connect OpenAI Codex OAuth for Plus/Pro/Max subscription access.
          </p>
        </div>
        <Badge variant={connected ? 'secondary' : 'outline'}>{connected ? 'connected' : 'optional'}</Badge>
      </div>

      {deviceFlow === null ? (
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
        <div className="mt-4 rounded-xl border border-dashed border-primary/50 bg-primary/5 p-3">
          <p className="text-xs font-medium">Enter this code in OpenAI</p>
          <p className="mt-2 rounded-lg bg-background px-3 py-2 text-center font-mono text-2xl font-semibold tracking-[0.2em]">
            {deviceFlow.userCode}
          </p>
          <p className="mt-2 text-xs text-muted-foreground" aria-live="polite">
            Waiting for authorization…
          </p>
          <div className="mt-3 flex flex-wrap gap-2">
            <Button
              type="button"
              size="sm"
              variant="outline"
              onClick={() => window.open(deviceFlow.verificationUrl, '_blank', 'noopener,noreferrer')}
            >
              Reopen
            </Button>
            <Button type="button" size="sm" variant="outline" onClick={handleCancel}>
              Cancel
            </Button>
          </div>
        </div>
      )}
    </div>
  )
}
