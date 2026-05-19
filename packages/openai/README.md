# @yolk-sdk/openai

OpenAI-family provider mechanics for Codex/ChatGPT OAuth and broker integration.

## Install

```bash
pnpm add @yolk-sdk/openai@canary @yolk-sdk/oauth@canary effect
```

Canary APIs are unstable. Keep all `@yolk-sdk/*` packages on the same version.

## Imports

```ts
import {
  makeOpenAiCodexBrokerRequest,
  makeOpenAiCodexTokenBrokerClient,
  openAiCodexAuthorizationHeaders,
  openAiCodexProviderId,
  toOAuthAccessToken
} from '@yolk-sdk/openai'
```

## Broker request

```ts
const request = makeOpenAiCodexBrokerRequest({
  subject: 'opaque-host-subject',
  minimumTtlMs: 60_000
})
```

Hosts route this request to an authenticated token broker. The package never stores refresh tokens.

## Authorization headers

```ts
const headers = openAiCodexAuthorizationHeaders(token)
```

Use these headers in host-owned Codex request adapters.

## Exposed constants

- Codex provider id and OAuth issuer.
- Device auth/user code/token URLs.
- Codex responses URL.
- Refresh buffer and token schemas.

## Host responsibilities

- Own device flow UI, session mapping, refresh-token storage, and policy.
- Provide token brokers through `@yolk-sdk/oauth` contracts.
- Own network execution, telemetry, error reporting, and product routing.

## Boundaries

- No app users, sessions, DB, Better Auth, routes, or Durable Objects.
- No OpenAI SDK dependency.
- API-key mode can be added later without changing OAuth contracts.
