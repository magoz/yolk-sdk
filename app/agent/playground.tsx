'use client'

import type { FormEvent } from 'react'
import type { AgentEvent, Content } from '@yolk/protocol'
import { useEffect, useReducer, useRef, useState } from 'react'
import { LoaderCircleIcon, SendIcon, SquareIcon } from 'lucide-react'
import {
  applyAgentEvent,
  initialAgentClientState,
  markAgentAborted,
  markAgentError,
  streamAgentEvents
} from '@yolk/client'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Textarea } from '@/components/ui/textarea'
import { OpenAiCodexAuthPanel } from './openai-codex-auth-panel'

type AgentPlaygroundProps = {
  readonly sessionId: string
  readonly openAiCodexConnected: boolean
}

type AgentUiAction =
  | { readonly _tag: 'Event'; readonly event: AgentEvent }
  | { readonly _tag: 'Error' }
  | { readonly _tag: 'Abort' }

const reducer = (state: typeof initialAgentClientState, action: AgentUiAction) => {
  switch (action._tag) {
    case 'Event':
      return applyAgentEvent(state, action.event)
    case 'Error':
      return markAgentError(state)
    case 'Abort':
      return markAgentAborted(state)
  }
}

const errorMessage = (error: unknown) =>
  error instanceof Error ? error.message : 'Agent request failed'

const isAbortError = (error: unknown) => error instanceof Error && error.name === 'AbortError'

const contentPreview = (content: Content) =>
  typeof content === 'string' ? content : content.map(part => part._tag).join(', ')

const statusVariant = (status: typeof initialAgentClientState.status) => {
  switch (status) {
    case 'done':
      return 'secondary'
    case 'error':
      return 'destructive'
    case 'aborted':
    case 'idle':
    case 'running':
      return 'outline'
  }
}

export function AgentPlayground({ sessionId, openAiCodexConnected }: AgentPlaygroundProps) {
  const [state, dispatch] = useReducer(reducer, initialAgentClientState)
  const [input, setInput] = useState('')
  const [lastPrompt, setLastPrompt] = useState('')
  const [error, setError] = useState<string | null>(null)
  const abortControllerRef = useRef<AbortController | null>(null)
  const isRunning = state.status === 'running'
  const displayedError = error ?? state.error

  useEffect(() => () => {
    abortControllerRef.current?.abort()
  }, [])

  const runAgent = async (content: string) => {
    const controller = new AbortController()
    abortControllerRef.current = controller

    try {
      for await (const event of streamAgentEvents({ sessionId, content, signal: controller.signal })) {
        dispatch({ _tag: 'Event', event })
      }
    } catch (caught) {
      if (controller.signal.aborted || isAbortError(caught)) {
        dispatch({ _tag: 'Abort' })
        setError(null)
        return
      }

      dispatch({ _tag: 'Error' })
      setError(errorMessage(caught))
    } finally {
      if (abortControllerRef.current === controller) {
        abortControllerRef.current = null
      }
    }
  }

  const handleSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    const content = input.trim()

    if (content.length === 0 || isRunning || abortControllerRef.current !== null) {
      return
    }

    setInput('')
    setLastPrompt(content)
    setError(null)
    void runAgent(content)
  }

  const handleStop = () => {
    abortControllerRef.current?.abort()
  }

  return (
    <main className="min-h-screen bg-[radial-gradient(circle_at_top_left,var(--color-muted),transparent_34rem)] p-4 md:p-8">
      <div className="mx-auto grid min-h-[calc(100vh-4rem)] max-w-6xl gap-6 lg:grid-cols-[0.82fr_1.18fr]">
        <section className="flex flex-col justify-between rounded-3xl border border-foreground/10 bg-background/80 p-6 shadow-sm backdrop-blur md:p-8">
          <div className="space-y-5">
            <Badge variant="outline" className="uppercase tracking-[0.18em]">
              Agent console
            </Badge>
            <div className="space-y-3">
              <h1 className="text-4xl font-semibold tracking-tight md:text-6xl">Yolk agent</h1>
              <p className="max-w-md text-sm leading-6 text-muted-foreground md:text-base">
                Minimal server-run text agent using the reusable protocol, loop, runtime, and
                client packages. No durable persistence yet; calculator tool calls are enabled.
              </p>
            </div>
          </div>

          <div className="mt-10 space-y-4">
            <OpenAiCodexAuthPanel initialConnected={openAiCodexConnected} />
            <div className="grid gap-3 text-xs text-muted-foreground">
              <div className="flex items-center justify-between border-t border-foreground/10 pt-3">
                <span>Session</span>
                <code className="rounded bg-muted px-2 py-1 text-foreground">{sessionId}</code>
              </div>
              <div className="flex items-center justify-between border-t border-foreground/10 pt-3">
                <span>Status</span>
                <Badge variant={statusVariant(state.status)}>{state.status}</Badge>
              </div>
            </div>
          </div>
        </section>

        <section className="flex min-h-[34rem] flex-col rounded-3xl border border-foreground/10 bg-card shadow-sm">
          <div className="flex items-center justify-between border-b border-foreground/10 px-5 py-4">
            <div>
              <p className="text-sm font-medium">Conversation</p>
              <p className="text-xs text-muted-foreground">NDJSON events from /api/agent</p>
            </div>
            {isRunning ? <LoaderCircleIcon className="size-4 animate-spin text-muted-foreground" /> : null}
          </div>

          <div className="flex-1 space-y-4 overflow-y-auto p-5">
            {lastPrompt.length > 0 ? (
              <Card size="sm" className="ml-auto max-w-[85%] bg-primary text-primary-foreground">
                <CardContent>{lastPrompt}</CardContent>
              </Card>
            ) : (
              <Card size="sm" className="border-dashed bg-transparent shadow-none">
                <CardHeader>
                  <CardTitle>Ask anything</CardTitle>
                  <CardDescription>
                    This first slice is one-shot text with a calculator tool. Ask something like
                    “what is 19 * 23?” to test tool calling.
                  </CardDescription>
                </CardHeader>
              </Card>
            )}

            {state.text.length > 0 ? (
              <Card size="sm" className="max-w-[85%]">
                <CardContent className="whitespace-pre-wrap leading-6">{state.text}</CardContent>
              </Card>
            ) : null}

            {state.activeToolCalls.length > 0 ? (
              <div className="flex flex-wrap gap-2">
                {state.activeToolCalls.map(call => (
                  <Badge key={call.id} variant="outline">
                    {call.name}
                  </Badge>
                ))}
              </div>
            ) : null}

            {state.toolResults.length > 0 ? (
              <div className="flex flex-wrap gap-2">
                {state.toolResults.map(result => (
                  <Badge key={result.toolCallId} variant="secondary">
                    tool: {contentPreview(result.content)}
                  </Badge>
                ))}
              </div>
            ) : null}

            {displayedError !== null ? (
              <Card size="sm" className="border-destructive/20 bg-destructive/5 text-destructive">
                <CardContent>{displayedError}</CardContent>
              </Card>
            ) : null}
          </div>

          <form onSubmit={handleSubmit} className="border-t border-foreground/10 p-4">
            <div className="flex gap-2">
              <Textarea
                value={input}
                onChange={event => setInput(event.target.value)}
                placeholder="Ask the agent..."
                className="min-h-12 resize-none"
                disabled={isRunning}
                aria-label="Agent prompt"
              />
              {isRunning ? (
                <Button type="button" size="icon-lg" variant="destructive" onClick={handleStop}>
                  <SquareIcon />
                  <span className="sr-only">Stop</span>
                </Button>
              ) : (
                <Button type="submit" size="icon-lg" disabled={input.trim().length === 0}>
                  <SendIcon />
                  <span className="sr-only">Send</span>
                </Button>
              )}
            </div>
          </form>
        </section>
      </div>
    </main>
  )
}
