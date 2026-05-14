import { Suspense, type ReactNode } from 'react'
import { Config, Effect, Option } from 'effect'
import { FetchHttpClient, HttpClient, HttpClientRequest } from 'effect/unstable/http'
import * as Schema from 'effect/Schema'
import { cookies } from 'next/headers'
import { Layer } from 'effect'
import { AppLayer } from '@/lib/layers'
import { NextEffect } from '@/lib/next-effect'
import { hasOpenAiCodexAuth } from '@/lib/core/agent/openai-codex-auth'
import { hasAnthropicClaudeAuth } from '@/lib/core/agent/anthropic-claude-auth'
import { getSession } from '@/lib/services/auth/get-session'
import { reportError } from '@/lib/services/telemetry/report-error'
import { loadProjectMcpServers } from '@/lib/agents/mcp/file-source'
import { AgentPlayground, type AgentRuntimeInfo } from './playground'

export type AgentRuntime = 'next' | 'cloudflare' | 'workflow'

type AgentRuntimePageProps = {
  readonly runtime: AgentRuntime
}

class CloudflareAgentUnavailableError extends Schema.TaggedErrorClass<CloudflareAgentUnavailableError>()(
  'CloudflareAgentUnavailableError',
  {
    message: Schema.String
  }
) {}

function PageSkeleton() {
  return (
    <main className="min-h-screen bg-background p-6">
      <div className="mx-auto grid min-h-[calc(100vh-3rem)] max-w-5xl place-items-center">
        <div className="h-40 w-full max-w-2xl animate-pulse rounded-3xl bg-foreground/[0.03]" />
      </div>
    </main>
  )
}

function PageMessage({
  title,
  children
}: {
  readonly title: string
  readonly children: ReactNode
}) {
  return (
    <main className="min-h-screen bg-background p-6">
      <div className="mx-auto grid min-h-[calc(100vh-3rem)] max-w-3xl place-items-center">
        <div className="space-y-3 rounded-2xl border border-foreground/10 bg-card p-6 text-sm shadow-sm">
          <h1 className="text-base font-medium text-foreground">{title}</h1>
          <div className="text-muted-foreground">{children}</div>
        </div>
      </div>
    </main>
  )
}

function ErrorMessage() {
  return (
    <PageMessage title="Agent page failed">
      <p>Check logs for details.</p>
    </PageMessage>
  )
}

function CloudflareUnavailableMessage({ message }: { readonly message: string }) {
  return (
    <PageMessage title="Cloudflare runtime unavailable">
      <p>{message}</p>
      <p className="mt-2">
        Required env: <code>CLOUDFLARE_AGENT_URL</code>, <code>YOLK_APP_URL</code>,{' '}
        <code>YOLK_CLOUDFLARE_BRIDGE_SECRET</code>.
      </p>
    </PageMessage>
  )
}

const encodeJson = (value: unknown) =>
  Schema.encodeUnknownEffect(Schema.UnknownFromJsonString)(value)

const cloudflareWebSocketUrl = (url: string, sessionId: string) =>
  Effect.try({
    try: () => {
      const parsed = new URL(url)
      parsed.protocol = parsed.protocol === 'https:' ? 'wss:' : 'ws:'
      parsed.pathname = `/connect/${encodeURIComponent(sessionId)}`
      return parsed.toString()
    },
    catch: error => error
  }).pipe(
    Effect.mapError(
      error =>
        new CloudflareAgentUnavailableError({
          message: error instanceof Error ? error.message : 'Invalid Cloudflare agent URL'
        })
    )
  )

const requireConfigOption = (name: string, option: Option.Option<string>) =>
  Option.match(option, {
    onNone: () => Effect.fail(new CloudflareAgentUnavailableError({ message: `Missing ${name}` })),
    onSome: Effect.succeed
  })

const bootstrapCloudflareAgent = (input: { readonly sessionId: string; readonly userId: string }) =>
  Effect.gen(function* () {
    const workerUrl = yield* requireConfigOption(
      'CLOUDFLARE_AGENT_URL',
      yield* Config.option(Config.string('CLOUDFLARE_AGENT_URL'))
    )
    const appUrl = yield* requireConfigOption(
      'YOLK_APP_URL',
      yield* Config.option(Config.string('YOLK_APP_URL'))
    )
    const bridgeSecret = yield* requireConfigOption(
      'YOLK_CLOUDFLARE_BRIDGE_SECRET',
      yield* Config.option(Config.string('YOLK_CLOUDFLARE_BRIDGE_SECRET'))
    )
    const mcpServers = yield* loadProjectMcpServers()
    const client = yield* HttpClient.HttpClient
    const body = yield* encodeJson({
      userId: input.userId,
      tokenEndpoint: `${appUrl}/api/internal/cloudflare/codex-token`,
      codexResponsesEndpoint: `${appUrl}/api/internal/cloudflare/codex-responses`,
      bridgeSecret,
      mcpServers
    })
    const response = yield* client.execute(
      HttpClientRequest.post(`${workerUrl}/bootstrap/${encodeURIComponent(input.sessionId)}`).pipe(
        HttpClientRequest.setHeaders({
          accept: 'application/json',
          'content-type': 'application/json'
        }),
        HttpClientRequest.bodyText(body, 'application/json')
      )
    )

    if (response.status < 200 || response.status >= 300) {
      return yield* Effect.fail(
        new CloudflareAgentUnavailableError({
          message: `Bootstrap failed with status ${response.status}`
        })
      )
    }

    return yield* cloudflareWebSocketUrl(workerUrl, input.sessionId)
  })

const nextRuntimeInfo: AgentRuntimeInfo = {
  _tag: 'Next',
  label: 'Next runtime',
  detail: 'Text runs in /api/agent. Voice uses Realtime routes.'
}

const cloudflareRuntimeInfo = (webSocketUrl: string): AgentRuntimeInfo => ({
  _tag: 'Cloudflare',
  label: 'Cloudflare runtime',
  detail: 'Text runs in Worker/Durable Object. Voice uses Realtime routes.',
  webSocketUrl
})

const workflowRuntimeInfo: AgentRuntimeInfo = {
  _tag: 'Workflow',
  label: 'Vercel Workflow runtime',
  detail: 'Text runs in a Vercel Workflow with durable stream replay.'
}

async function Content({ runtime }: AgentRuntimePageProps): Promise<ReactNode> {
  await cookies()

  return await NextEffect.runPromise(
    Effect.gen(function* () {
      const session = yield* getSession()
      const openAiCodexConnected = yield* hasOpenAiCodexAuth(session.user.id)
      const anthropicClaudeConnected = yield* hasAnthropicClaudeAuth(session.user.id)
      const sessionId = `agent-${runtime}-${session.user.id}`
      const runtimeDetails = yield* (runtime === 'cloudflare'
        ? Effect.map(
            bootstrapCloudflareAgent({ sessionId, userId: session.user.id }),
            cloudflareRuntimeInfo
          )
        : Effect.succeed(runtime === 'workflow' ? workflowRuntimeInfo : nextRuntimeInfo))

      return (
        <AgentPlayground
          sessionId={sessionId}
          openAiCodexConnected={openAiCodexConnected}
          anthropicClaudeConnected={anthropicClaudeConnected}
          runtime={runtimeDetails}
        />
      )
    }).pipe(
      Effect.withSpan(`page.agent.${runtime}`),
      Effect.provide(Layer.merge(AppLayer, FetchHttpClient.layer)),
      Effect.scoped,
      Effect.catchTag('UnauthenticatedError', () => NextEffect.redirect('/login')),
      Effect.catchTag('CloudflareAgentUnavailableError', error =>
        Effect.succeed(<CloudflareUnavailableMessage message={error.message} />)
      ),
      Effect.catch(error =>
        NextEffect.isNavigationError(error)
          ? Effect.fail(error)
          : reportError(error, { operation: `page.agent.${runtime}` }).pipe(
              Effect.as(<ErrorMessage />)
            )
      )
    )
  )
}

export function AgentRuntimePage({ runtime }: AgentRuntimePageProps) {
  return (
    <Suspense fallback={<PageSkeleton />}>
      <Content runtime={runtime} />
    </Suspense>
  )
}
