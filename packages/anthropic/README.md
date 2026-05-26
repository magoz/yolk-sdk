# @yolk-sdk/anthropic

Anthropic Claude OAuth helpers and agent provider mechanics for Yolk hosts.

## Install

```bash
pnpm add @yolk-sdk/anthropic@canary @yolk-sdk/agent@canary @yolk-sdk/oauth@canary effect
```

Canary APIs are unstable. Keep all `@yolk-sdk/*` packages on the same version.

## Subpaths

| Subpath | Purpose |
| --- | --- |
| `@yolk-sdk/anthropic` | Convenience root for Claude OAuth helpers |
| `@yolk-sdk/anthropic/claude` | Claude OAuth constants, auth URL helpers, broker helpers, and headers |
| `@yolk-sdk/anthropic/claude-provider` | Claude `LLMProvider` layer, request lowering, response/usage mapping |

## Imports

```ts
import {
  anthropicClaudeAuthorizationHeaders,
  anthropicClaudeProviderId,
  makeAnthropicClaudeAuthorizationUrl,
  makeAnthropicClaudeBrokerRequest,
  parseAnthropicClaudeAuthorizationCode
} from '@yolk-sdk/anthropic/claude'

import { makeAnthropicClaudeProviderLayer } from '@yolk-sdk/anthropic/claude-provider'
```

## Claude provider layer

Use `makeAnthropicClaudeProviderLayer` with `@yolk-sdk/agent/loop` when a host already owns
credential lookup and refresh.

```ts
import { FetchHttpClient } from 'effect/unstable/http'
import { Layer, Stream } from 'effect'
import { makeAnthropicClaudeProviderLayer } from '@yolk-sdk/anthropic/claude-provider'
import { ContextTransformer, LoopConfig, run } from '@yolk-sdk/agent/loop'

const providerLayer = makeAnthropicClaudeProviderLayer({ token }).pipe(
  Layer.provide(FetchHttpClient.layer)
)

const runtimeLayer = Layer.mergeAll(
  ContextTransformer.identity,
  LoopConfig.defaultLayer,
  providerLayer
)

const events = run({
  messages,
  systemPrompt,
  tools,
  model: 'claude-sonnet-4-6'
}).pipe(Stream.provide(runtimeLayer))
```

The provider:

- Lowers Yolk `LLMRequest` messages/tools/images/PDFs to Anthropic Messages API input.
- Preserves Claude subscription OAuth headers and Claude Code-compatible tool naming.
- Maps Anthropic message responses to Yolk loop events: text deltas, reasoning deltas, tool calls, done, and usage.
- Maps provider failures to typed `LLMError` causes for retry/context/rate-limit handling.

Default request headers include Claude subscription OAuth compatibility headers:

| Header | Default |
| --- | --- |
| `authorization` | Bearer access token from `token` |
| `anthropic-version` | `2023-06-01` |
| `anthropic-beta` | `claude-code-20250219,oauth-2025-04-20,interleaved-thinking-2025-05-14` |
| `user-agent` | `claude-cli/2.1.2 (external, cli)` |
| `x-app` | `cli` |

`extraHeaders` are applied last, so hosts can add gateway headers or override defaults.

Config:

| Option | Purpose |
| --- | --- |
| `token` | Required `OAuthAccessToken` from `@yolk-sdk/oauth` |
| `messagesUrl` | Optional Messages API override for tests/gateways |
| `maxTokens` | Optional output token limit override |
| `extraHeaders` | Optional host/gateway headers |

## OAuth URL

```ts
const url = makeAnthropicClaudeAuthorizationUrl({
  state: 'opaque-state',
  codeChallenge: 'pkce-code-challenge'
})
```

Hosts own PKCE verifier storage and callback routes.

## Callback parse

```ts
const parsed = parseAnthropicClaudeAuthorizationCode(callbackUrl)
```

## Broker request

```ts
const request = makeAnthropicClaudeBrokerRequest({
  subjectId: 'opaque-host-subject',
  minTtlSeconds: 60
})
```

## Host responsibilities

- Own OAuth verifier/state storage, callback handling, and refresh-token storage.
- Provide hosted or local credential sources through `@yolk-sdk/oauth`.
- Own token lookup/refresh, telemetry, and product permissions.

## Boundaries

- No app users, sessions, DB, Better Auth, routes, or Durable Objects.
- No Anthropic SDK dependency.
- Provider layers depend only on Yolk agent/OAuth contracts plus Effect HTTP.
- API-key mode can be added later without changing OAuth or provider-layer contracts.
