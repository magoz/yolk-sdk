# Agent API Routes

Route-local contracts for text, Workflow, commands, and Realtime agent endpoints.

## Routes

| Route                        | Role                                    |
| ---------------------------- | --------------------------------------- |
| `route.ts`                   | Stateless text NDJSON via Next runtime  |
| `workflow/route.ts`          | Start Vercel Workflow and stream NDJSON |
| `workflow/[runId]/route.ts`  | Resume/cancel Workflow runs and append HITL responses by id |
| `commands/route.ts`          | Authenticated command list/render       |
| `realtime/call/route.ts`     | OpenAI Realtime SDP exchange            |
| `realtime/tool/route.ts`     | Voice tool execution bridge             |

## Text Runtime

- Text route delegates provider/tool/prompt construction to `makeAgentTextResponse` / `makeAgentTextRuntime`.
- Request body is `AgentRouteRequest`: non-empty `messages`, optional `model`, optional `reasoningEffort`.
- Validate image count, MIME, base64, per-image size, and total payload before provider calls.
- Return in-band protocol `AgentError` for runtime failures after stream starts.

## Workflow Runtime

- `workflow/route.ts` calls Vercel `start(runAgentWorkflow, ...)`, returns `run.getReadable()` and `x-workflow-run-id`.
- `workflow/[runId]/route.ts` uses `getRun(runId)` for replay/cancellation and `resumeHook` for one-response HITL resume.
- Workflow routes use route-model helpers for response/header contracts; keep tests beside helpers.
- Workflow route handlers may use `Effect.runPromise` + raw `Response` because `workflow/api` returns Web-native run streams.

## Commands + Realtime

- Commands require auth and render command macros as prompt text; no model/provider calls here.
- Realtime `/call` uses `OPENAI_API_KEY` and raw SDP.
- Realtime `/tool` uses `@yolk-sdk/voice-runtime`; current voice toolset is `web_fetch` + `web_search` + storage.

## Tests

- Route-model tests cover Workflow stream headers/resume/cancel without starting real Workflow runs.
- Route-handler tests cover schema failures, provider/tool failures, image validation, and NDJSON errors.
- Keep transport tests below Playwright unless browser-visible `/agent` behavior is under test.
