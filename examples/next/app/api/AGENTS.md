# API Routes

HTTP boundaries for auth, agent text/Workflow/commands/Realtime + voice STT/TTS, knowledge files, and internal Cloudflare bridges. CRUD/product mutations belong in server actions, not routes.

See `examples/next/patterns/EFFECT_API_ROUTES.md` for the canonical route pattern.

## Routes

| Route                                          | Role                                   |
| ---------------------------------------------- | -------------------------------------- |
| `auth/[...all]/route.ts`                       | better-auth Next handler               |
| `agent/*`                                      | See `agent/AGENTS.md`                   |
| `knowledge/files/route.ts`                     | Authenticated knowledge file download  |
| `internal/cloudflare/codex-token/route.ts`     | Internal DO token bridge               |
| `internal/cloudflare/codex-responses/route.ts` | Internal DO Codex streaming HTTP proxy |
| `internal/cloudflare/AGENTS.md`                | Bridge auth/header/token contracts     |

## Status Conventions

- Unauthenticated: `401`.
- Invalid body/schema: `400`.
- Missing/invalid provider auth: `409`.
- Upstream provider quota/rate limit (OpenAI 429 incl. `insufficient_quota`): `429` with a distinct message.
- Upstream OAuth/provider failure: `502`.
- Unknown boundary failure: `500` with generic body.

## Agent Routes

- See `agent/AGENTS.md` for route-local text/Workflow/commands/Realtime contracts.
- Text runtime construction lives in `makeAgentTextResponse` / `makeAgentTextRuntime`; route wrappers keep auth/status boundaries thin.
- See `internal/cloudflare/AGENTS.md` before changing bridge auth, token response shapes, or proxy header allowlists.
- Keep Codex proxy allowlist logic in `internal/cloudflare/codex-responses/route-model.ts`; never forward cookies or bridge secrets upstream.

## Exceptions

- `auth/[...all]/route.ts` may use `Effect.runPromise()` to construct better-auth's handler at the Next boundary.
- Agent-route exceptions live in `agent/AGENTS.md`.
- `internal/cloudflare/*` routes require `YOLK_CLOUDFLARE_BRIDGE_SECRET`; do not expose to browsers.
- Browser/WebRTC specifics stay in `examples/next/app/agent/use-realtime-voice.ts` and `examples/next/lib/agents/realtime/*`, not route bodies.

## Anti-Patterns

- API route for CRUD/domain mutation — use `examples/next/lib/core` server action.
- Raw `JSON.parse` for HTTP bodies — use Schema/HttpServerRequest helpers.
- Swallowing route errors silently — report boundary failures via telemetry.
