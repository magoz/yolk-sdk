# @yolk-sdk/anthropic

Anthropic Claude OAuth mechanics and broker integration primitives.

## Install

```bash
pnpm add @yolk-sdk/anthropic@canary @yolk-sdk/oauth@canary effect
```

Canary APIs are unstable. Keep all `@yolk-sdk/*` packages on the same version.

## Imports

```ts
import {
  anthropicClaudeAuthorizationHeaders,
  anthropicClaudeProviderId,
  makeAnthropicClaudeAuthorizationUrl,
  makeAnthropicClaudeBrokerRequest,
  parseAnthropicClaudeAuthorizationCode
} from '@yolk-sdk/anthropic'
```

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
  subject: 'opaque-host-subject',
  minimumTtlMs: 60_000
})
```

## Host responsibilities

- Own OAuth verifier/state storage, callback handling, and refresh-token storage.
- Provide hosted or local credential sources through `@yolk-sdk/oauth`.
- Own provider requests, telemetry, and product permissions.

## Boundaries

- No app users, sessions, DB, Better Auth, routes, or Durable Objects.
- No Anthropic SDK dependency.
- API-key mode can be added later without changing OAuth contracts.
