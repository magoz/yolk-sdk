import { Suspense } from 'react'
import { Config, Effect, Option } from 'effect'
import { FetchHttpClient, HttpClient, HttpClientRequest } from 'effect/unstable/http'
import * as Schema from 'effect/Schema'
import { cookies } from 'next/headers'
import { Layer } from 'effect'
import { AppLayer } from '@/lib/layers'
import { NextEffect } from '@/lib/next-effect'
import { hasOpenAiCodexAuth } from '@/lib/core/agent/openai-codex-auth'
import { getSession } from '@/lib/services/auth/get-session'
import { reportError } from '@/lib/services/telemetry/report-error'
import { AgentPlayground } from './playground'

export const dynamic = 'force-dynamic'

function PageSkeleton() {
  return (
    <main className="min-h-screen bg-background p-6">
      <div className="mx-auto grid min-h-[calc(100vh-3rem)] max-w-5xl place-items-center">
        <div className="h-40 w-full max-w-2xl animate-pulse rounded-3xl bg-foreground/[0.03]" />
      </div>
    </main>
  )
}

function ErrorMessage() {
  return (
    <main className="min-h-screen bg-background p-6">
      <div className="mx-auto grid min-h-[calc(100vh-3rem)] max-w-3xl place-items-center">
        <div className="rounded-2xl border border-destructive/20 bg-destructive/5 p-6 text-sm text-destructive">
          Agent page failed to load.
        </div>
      </div>
    </main>
  )
}

const encodeJson = (value: unknown) => Schema.encodeUnknownEffect(Schema.UnknownFromJsonString)(value)

const cloudflareWebSocketUrl = (url: string, sessionId: string) =>
  Effect.try({
    try: () => {
      const parsed = new URL(url)
      parsed.protocol = parsed.protocol === 'https:' ? 'wss:' : 'ws:'
      parsed.pathname = `/connect/${encodeURIComponent(sessionId)}`
      return parsed.toString()
    },
    catch: error => error
  })

const bootstrapCloudflareAgent = (input: { readonly sessionId: string; readonly userId: string }) =>
  Effect.gen(function* () {
    const workerUrl = yield* Config.option(Config.string('CLOUDFLARE_AGENT_URL'))
    const appUrl = yield* Config.option(Config.string('YOLK_APP_URL'))
    const bridgeSecret = yield* Config.option(Config.string('YOLK_CLOUDFLARE_BRIDGE_SECRET'))

    if (Option.isNone(workerUrl) || Option.isNone(appUrl) || Option.isNone(bridgeSecret)) {
      return Option.none<string>()
    }

    const client = yield* HttpClient.HttpClient
    const body = yield* encodeJson({
      userId: input.userId,
      tokenEndpoint: `${appUrl.value}/api/internal/cloudflare/codex-token`,
      codexResponsesEndpoint: `${appUrl.value}/api/internal/cloudflare/codex-responses`,
      bridgeSecret: bridgeSecret.value
    })
    const response = yield* client.execute(
      HttpClientRequest.post(`${workerUrl.value}/bootstrap/${encodeURIComponent(input.sessionId)}`).pipe(
        HttpClientRequest.setHeaders({
          accept: 'application/json',
          'content-type': 'application/json'
        }),
        HttpClientRequest.bodyText(body, 'application/json')
      )
    )

    if (response.status < 200 || response.status >= 300) {
      yield* Effect.logWarning('Cloudflare agent bootstrap failed', { status: response.status })
      return Option.none<string>()
    }

    const wsUrl = yield* cloudflareWebSocketUrl(workerUrl.value, input.sessionId)
    return Option.some(wsUrl)
  }).pipe(
    Effect.catch(error =>
      Effect.logWarning('Cloudflare agent disabled', { error }).pipe(Effect.as(Option.none<string>()))
    )
  )

async function Content() {
  await cookies()

  return await NextEffect.runPromise(
    Effect.gen(function* () {
      const session = yield* getSession()
      const openAiCodexConnected = yield* hasOpenAiCodexAuth(session.user.id)
      const sessionId = `agent-${session.user.id}`
      const cloudflareAgentUrl = openAiCodexConnected
        ? yield* bootstrapCloudflareAgent({ sessionId, userId: session.user.id })
        : Option.none<string>()

      return (
        <AgentPlayground
          sessionId={sessionId}
          openAiCodexConnected={openAiCodexConnected}
          cloudflareWebSocketUrl={Option.getOrUndefined(cloudflareAgentUrl)}
        />
      )
    }).pipe(
      Effect.withSpan('page.agent'),
      Effect.provide(Layer.merge(AppLayer, FetchHttpClient.layer)),
      Effect.scoped,
      Effect.catchTag('UnauthenticatedError', () => NextEffect.redirect('/login')),
      Effect.catch(error =>
        NextEffect.isNavigationError(error)
          ? Effect.fail(error)
          : reportError(error, { operation: 'page.agent' }).pipe(Effect.as(<ErrorMessage />))
      )
    )
  )
}

export default async function Page() {
  return (
    <Suspense fallback={<PageSkeleton />}>
      <Content />
    </Suspense>
  )
}
