# @yolk-sdk/oauth

Provider-neutral OAuth credential contracts for hosted token brokers and local credential sources.

## Install

```bash
pnpm add @yolk-sdk/oauth@canary effect
```

Canary APIs are unstable. Keep all `@yolk-sdk/*` packages on the same version.

## Imports

```ts
import {
  OAuthAccessToken,
  credentialSourceFromBroker,
  isTokenFresh,
  shouldRefreshToken,
  tokenRemainingTtlMs
} from '@yolk-sdk/oauth'
```

## Credential source

```ts
import { credentialSourceFromBroker } from '@yolk-sdk/oauth'

const source = credentialSourceFromBroker({
  providerId: 'openai-codex',
  subject: 'opaque-host-subject',
  requestToken: request => brokerClient(request)
})
```

Provider packages consume credential sources. Hosts implement brokers and storage.

## Token freshness

```ts
import { shouldRefreshToken, tokenRemainingTtlMs } from '@yolk-sdk/oauth'

const remaining = tokenRemainingTtlMs(token, Date.now())
const needsRefresh = shouldRefreshToken(token, Date.now(), 60_000)
```

## Host responsibilities

- Store, encrypt, refresh, revoke, and audit tokens.
- Avoid logging access or refresh tokens.
- Map opaque subjects to users/sessions outside this package.
- Implement broker transport, auth, rate limits, and policy.

## Boundaries

- No provider-specific endpoints or scopes.
- No token persistence, filesystem, DB, keychain, app auth, or framework code.
- No product concepts; subjects are opaque strings.
