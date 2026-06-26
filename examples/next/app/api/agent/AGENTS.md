# Agent API Routes

Route-local contracts for text, Workflow, commands, and Realtime agent endpoints.

## Routes

| Route                       | Role                                                        |
| --------------------------- | ----------------------------------------------------------- |
| `route.ts`                  | Stateless text NDJSON via Next runtime                      |
| `workflow/route.ts`         | Start Vercel Workflow and stream NDJSON                     |
| `workflow/[runId]/route.ts` | Resume/cancel Workflow runs and append HITL responses by id |
| `commands/route.ts`         | Authenticated command list/render                           |
| `realtime/call/route.ts`    | OpenAI Realtime SDP exchange                                |
| `realtime/tool/route.ts`    | Voice tool execution bridge                                 |

## Text Runtime

- Text route delegates provider/tool/prompt construction to `makeAgentTextResponse` / `makeAgentTextRuntime`.
- Shared text runtime construction lives in `examples/next/lib/agents/workflow-runtime/text-response.ts` for both `/api/agent` and Workflow.
- Request body is `AgentRouteRequest`: `sessionId`, non-empty `messages`, optional `hitlResponses`, optional `model`, optional `reasoningEffort`.
- Validate image/PDF count, MIME, base64, per-attachment size, and total payload before provider calls.
- Return in-band protocol `AgentError` for runtime failures after stream starts.

## Workflow Runtime

- `workflow/route.ts` calls Vercel `start(runAgentWorkflow, ...)`, returns `run.getReadable()` and `x-workflow-run-id`.
- `workflow/[runId]/route.ts` uses `getRun(runId)` for replay/cancellation and `resumeHook` for one-response HITL resume.
- GET replay accepts optional `startIndex`; HITL resume returns `x-workflow-stream-tail-index` for
  the stream tail before the returned body.
- HITL resume body is `{ hitlResponses: [response] }`; route/workflow own hook-token routing, not the SDK client.
- Current hook token is run-scoped; route auth must authorize run ownership, and loop response matching validates `requestId`/`toolCallId`.
- HITL resume captures `getTailIndex()` via `startIndex: -1` before `resumeHook`, then returns replay after that tail index.
- Workflow routes use route-model helpers for response/header contracts; keep tests beside helpers.
- Workflow `[runId]` handlers may use `Effect.runPromise` + raw `Response`; start route stays `HttpEffect` + `HttpServerResponse.raw(...)`.

## Commands + Realtime

- Commands require auth and render command macros as prompt text; no model/provider calls here.
- Realtime `/call` uses `OPENAI_API_KEY` and raw SDP.
- Realtime `/tool` uses `@yolk-sdk/agent/voice`; current voice toolset is `web_fetch` + `web_search` + knowledge + storage + optional Telegram.

## Tests

- Route-model tests cover Workflow stream headers/resume/cancel without starting real Workflow runs.
- Route-handler tests cover schema failures, provider/tool failures, image/PDF validation, and NDJSON errors.
- Keep transport tests below Playwright unless browser-visible `/agent` behavior is under test.
