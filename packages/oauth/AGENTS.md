# OAuth Contracts

`@yolk/oauth` defines provider-neutral OAuth credential contracts for hosted token brokers and local credential sources.

## Boundaries

- No provider-specific URLs, scopes, token schemas, or SDKs.
- No token persistence, encryption, DB, filesystem, keychain, Next.js, Cloudflare, or app auth.
- No user/team/org/product concepts; subjects are opaque host-owned identifiers.
- Access tokens are wire values; hosts/providers must avoid logging them.

## Public model

| Export area | Purpose |
| ----------- | ------- |
| `token` | broker request/response schemas and TTL helpers |
| `source` | generic credential source and token broker client types |
| `error` | provider-neutral OAuth/token broker errors |

## Design rules

- Host owns refresh tokens and storage.
- Provider packages own vendor refresh/device-flow mechanics.
- Runtime packages consume credential sources, not OAuth storage.
- Prefer explicit minimum TTL checks before provider requests.
