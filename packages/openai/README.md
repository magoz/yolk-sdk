# @yolk-sdk/openai

OpenAI-family OAuth helpers and agent provider mechanics for Yolk hosts.

## Install

```bash
pnpm add @yolk-sdk/openai@canary @yolk-sdk/agent@canary @yolk-sdk/oauth@canary effect
```

Canary APIs are unstable. Keep all `@yolk-sdk/*` packages on the same version.

## Subpaths

| Subpath | Purpose |
| --- | --- |
| `@yolk-sdk/openai` | Convenience root for Codex OAuth helpers |
| `@yolk-sdk/openai/codex` | Codex OAuth constants, token schemas, broker helpers, and auth headers |
| `@yolk-sdk/openai/codex-provider` | Codex `LLMProvider` layer, request lowering, SSE/JSON stream parsing, and usage mapping |
| `@yolk-sdk/openai/provider` | OpenAI API-key Chat Completions `LLMProvider` layer |

## Imports

```ts
import {
  makeOpenAiCodexBrokerRequest,
  makeOpenAiCodexTokenBrokerClient,
  openAiCodexAuthorizationHeaders,
  openAiCodexProviderId,
  toOpenAiCodexOAuthAccessToken
} from '@yolk-sdk/openai/codex'

import { makeOpenAiCodexProviderLayer } from '@yolk-sdk/openai/codex-provider'
import { makeOpenAiProviderLayer } from '@yolk-sdk/openai/provider'
```

## Codex provider layer

Use `makeOpenAiCodexProviderLayer` with `@yolk-sdk/agent/loop` when a host already owns Codex
OAuth/device-flow credentials.

```ts
import { FetchHttpClient } from 'effect/unstable/http'
import { Layer, Stream } from 'effect'
import { makeOpenAiCodexProviderLayer } from '@yolk-sdk/openai/codex-provider'
import { ContextTransformer, LoopConfig, run } from '@yolk-sdk/agent/loop'

const providerLayer = makeOpenAiCodexProviderLayer({
  token,
  defaultReasoningEffort: 'low',
  reasoningSummary: 'auto'
}).pipe(Layer.provide(FetchHttpClient.layer))

const runtimeLayer = Layer.mergeAll(
  ContextTransformer.identity,
  LoopConfig.defaultLayer,
  providerLayer
)

const events = run({
  messages,
  systemPrompt,
  tools,
  model: 'gpt-5.4'
}).pipe(Stream.provide(runtimeLayer))
```

The Codex provider:

- Lowers Yolk `LLMRequest` messages/tools/images/documents to Codex Responses input.
- Maps protocol `DocumentPart` to Responses `input_file`; the API-key chat provider rejects documents explicitly.
- Handles Codex JSON and SSE response bodies, including non-`event-stream` SSE bodies.
- Emits Yolk loop events: text deltas, reasoning deltas, tool calls, done, and usage.
- Preserves `originator` and optional `ChatGPT-Account-Id` auth headers.

Config:

| Option | Purpose |
| --- | --- |
| `token` | Required `OAuthAccessToken` from `@yolk-sdk/oauth` |
| `responsesUrl` | Optional Codex Responses URL override for tests/gateways |
| `defaultReasoningEffort` | Fallback reasoning effort when request omits one |
| `reasoningSummary` | Codex reasoning summary mode; defaults to `auto` |
| `extraHeaders` | Optional host/gateway headers |

## OpenAI API-key provider layer

`makeOpenAiProviderLayer` provides a Chat Completions-compatible `LLMProvider` for hosts with
an OpenAI API key.

```ts
import { Layer, Redacted } from 'effect'
import { FetchHttpClient } from 'effect/unstable/http'
import { makeOpenAiProviderLayer } from '@yolk-sdk/openai/provider'

const providerLayer = makeOpenAiProviderLayer({
  apiKey: Redacted.make(process.env.OPENAI_API_KEY ?? '')
}).pipe(Layer.provide(FetchHttpClient.layer))
```

Config:

| Option | Purpose |
| --- | --- |
| `apiKey` | Required redacted OpenAI API key |
| `chatCompletionsUrl` | Optional Chat Completions URL override |
| `maxCompletionTokens` | Optional output token limit override |
| `extraHeaders` | Optional host/gateway headers |

## Broker request

```ts
const request = makeOpenAiCodexBrokerRequest({
  subjectId: 'opaque-host-subject',
  minTtlSeconds: 60
})
```

Hosts route this request to an authenticated token broker. The package never stores refresh tokens.

## Authorization headers

```ts
const headers = openAiCodexAuthorizationHeaders(token)
```

Use these headers in host-owned Codex request adapters. Prefer
`makeOpenAiCodexProviderLayer` when executing the Yolk agent loop directly.

## Exposed constants

- Codex provider id and OAuth issuer.
- Device auth/user code/token URLs.
- Codex responses URL.
- Refresh buffer and token schemas.

## Host responsibilities

- Own device flow UI, session mapping, refresh-token storage, and policy.
- Provide token brokers through `@yolk-sdk/oauth` contracts.
- Own token lookup/refresh, telemetry, error reporting, and product routing.

## Boundaries

- No app users, sessions, DB, Better Auth, routes, or Durable Objects.
- No OpenAI SDK dependency.
- Provider layers depend only on Yolk agent/OAuth contracts plus Effect HTTP.
- Hosts own token storage, refresh, model routing, app policy, and telemetry.
