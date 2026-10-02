# Classifier models

Status: accepted. The wire shape was confirmed by a live probe on 2026-10-02 (see Live observation).

Agents and hosts need fast, typed decisions about data: route a ticket, score urgency, check
whether a message approves a result. Classifier models such as TypeSafe's Jev answer typed
questions about supplied state with calibrated probabilities instead of generating text. Add a
provider-neutral classifier model to `@yolk-sdk/agent`, with AI Gateway as the first provider.

## Terms

- **Classifier model**: a model that answers typed questions about one `state` value. It does not
  chat or generate text.
- **Classification**: one request: a `state` (string, JSON object, or JSON array) and named
  questions, answered together. An array is one state, not a batch.
- **Question types**: `boolean` (binary classification), `choice` (one of named options), and
  `score` (ordinal levels, lowest first). All three return probabilities.

## Naming

Use "classifier" everywhere: `classify`, `ClassifierModel`, `ClassificationResult`, and the code
mode tool `classify`. All three question types are classification. AI Gateway and the AI SDK call
the capability "evaluation" (`/v1/evaluate`, `experimental_evaluate`); providers map that wire
name. "Evaluation" was rejected because it collides with agent evals and models read `evaluate` as
close to `eval`. "Decision" (TypeSafe, Laya, TanStack `decide()`) was rejected as vaguer. Docs
state that AI Gateway calls this evaluation.

## Jev at a glance

| Property | Value                                                                 |
| -------- | --------------------------------------------------------------------- |
| Latency  | 70–500 ms per request                                                 |
| Context  | 64,000 tokens per request; 32,000 for `state`                         |
| Price    | $0.042 per 1M input tokens; no output charge                          |
| Limits   | `choice` up to 255 options; `score` 2–10 levels                       |
| Gateway  | Per-request zero data retention and no training; evaluation fallbacks |

## Decision

### Placement

Classification is a model type on Yolk's existing provider stack: plain HTTP and Effect with no
new dependencies. Following `patterns/PACKAGE_ARCHITECTURE.md` (agent internals stay in
`packages/agent/src/*`) and the precedent of `providers/openai/speech`, it lives in
`@yolk-sdk/agent`:

- `@yolk-sdk/agent/classification`: core contract with no provider code. Boundary checks keep it
  free of Node, React, and provider SDKs.
- `@yolk-sdk/agent/providers/vercel/ai-gateway-classifier`: AI Gateway `POST /v1/evaluate`.
- `@yolk-sdk/agent/providers/vercel/conformance`: classifier conformance cases.
- `@yolk-sdk/emulators/gateway`: a fixture-driven `/v1/evaluate` route.

### Core contract

Effect Schemas own the request, answers, usage, and errors. This is a shape sketch; field names
follow Yolk protocol conventions in implementation.

```ts
type ClassifierQuestion =
  | { type: 'boolean'; instructions: string; criteria?: { true: string; false: string } }
  | { type: 'choice'; instructions: string; criteria: Record<string, string | Json> }
  | { type: 'score'; instructions: string; criteria: ReadonlyArray<string | Json> }

type ClassifierAnswer =
  | { type: 'boolean'; probability: number }
  | { type: 'choice'; choice: string; probabilities: Record<string, number>; confidence?: number }
  | { type: 'score'; score: number; probabilities: Record<string, number>; confidence?: number }

type ClassificationResult = {
  model: string
  answers: Record<string, ClassifierAnswer>
  usage?: { inputTokens: number; outputTokens: number; costUsd?: number }
  providerMetadata?: Json
}

interface ClassifierModel {
  classify(request: {
    state: string | Json
    questions: Record<string, ClassifierQuestion>
    providerOptions?: Json
  }): Effect<ClassificationResult, ClassificationError>
}
```

- A typed helper infers answer types from questions, so `answers.route.choice` is the union of
  the option keys.
- Probabilities are kept exactly as returned (rounded to two decimals by Jev) and never
  renormalized.
- Failures are typed errors, not result flags. Usage is recorded even when answers fail to decode,
  because the request was billed.
- Classification is a read with no side effects.

### AI Gateway provider

- Calls `POST https://ai-gateway.vercel.sh/v1/evaluate` with model `typesafe-ai/jev` by default.
- Reuses the existing Gateway credential config (`AI_GATEWAY_API_KEY`, falling back to
  `VERCEL_OIDC_TOKEN`), so hosts on Gateway need no new secret.
- Passes `providerOptions.gateway` through: `zeroDataRetention`, `only`, and `models` with one
  conditional evaluation fallback (for example re-run with a language model when confidence falls
  below a threshold). Reads the `x-ai-gateway-evaluation-fallback-*` headers into metadata.
- Maps Gateway `usage` and `providerMetadata.gateway.cost` into `ClassificationResult.usage`.

### Code mode integration

`@yolk-sdk/codemode` provides `makeClassifierTool({ classify, maxConcurrency })`, where
`classify` is the `ClassifierModel` `classify` function or the service value: an ordinary Yolk
tool registered with `callableBy: 'codemode'` and `discovery: 'listed'` (see
[Code mode](0002-code-mode.md)). Its calls receive input decoding and the nested-call record like
any other tool; the record carries token usage only, and the cost stays in the classifier result's
`structuredContent` (`usage.costUsd`). It caps concurrent classifications per script (default 100,
keyed by the parent tool call id of the nested call id `<parentToolCallId>/<seq>`) so
`Promise.all` over many items queues instead of flooding the provider. Scripts classify one item
per call.

### Other uses

Hosts may call `ClassifierModel` directly from app code or workflow steps: model routing (for
example choosing a stronger model for complex prompts), triage inside connector flows, and
guardrails. Classification stays separate from authorization: a classifier can say a command looks
destructive, but host policy decides whether it runs. An approval-policy hook that consults a
classifier is a possible later addition and stays host-owned.

## Live observation

Owner-approved probe of `POST /v1/evaluate` with `typesafe-ai/jev` and synthetic state, 2026-10-02:

- `choice` and `score` answers carry `confidence` on the answer, and AI Gateway repeats it in
  `providerMetadata.typesafe.confidence[questionId]`. Boolean answers have no confidence.
- Score levels are indexed from 0: `probabilities` keys are `"0"` to `"n-1"`, and `score` is the
  probability-weighted level index.
- `usage` is `{ inputTokens, outputTokens }`; `providerMetadata.gateway.cost` is a decimal USD
  string (about $0.00002 for one request with three questions).
- Latency from a European client: about 300 ms round trip per warm call (Gateway-reported provider
  time about 220–240 ms); 100 to 200 concurrent requests finished in 0.8–1.3 s with no rate-limit
  errors. A code mode script classifying 200 items through `makeClassifierTool` took 1.5–1.7 s.

The conformance fixtures stay `unverified` until they are re-recorded through the replay-verified
write gate.

## Open items

- **Other transports**: TypeSafe's System One protocol (`/v1/systemone`, `noul` for boolean) is
  served by TypeSafe directly, Gateway's `/typesafe` path, OpenRouter, and OpenCode Zen. Add one
  System One provider with a per-service base URL when a host needs it. Cloudflare Workers AI wraps
  System One in its own envelope and would serve `cloudflare/agent`.
- **OpenCode Go**: Jev is listed under OpenCode Zen; whether the Go subscription includes it is
  unknown.

## Rejected alternatives

- **A separate `@yolk-sdk/classification` package**: it would import Gateway config, HTTP, usage,
  errors, and conformance helpers from `@yolk-sdk/agent` anyway, against the rule that agent
  internals stay in one package.
- **Porting pi's System One client first**: a second credential and wire format for no capability
  Gateway lacks, and no access to evaluation fallbacks.
- **Depending on the AI SDK's `experimental_evaluate`**: Yolk providers are Effect-native and do
  not wrap the AI SDK; the API is also experimental.
- **A `models` global inside scripts** (pi's approach): a regular tool keeps one execution path,
  one call record, and one usage path for everything a script does.

## Implementation and acceptance plan

1. Owner-approved live probe of `/v1/evaluate` with a synthetic state to settle the confidence
   shape.
2. `@yolk-sdk/agent/classification`: schemas, `ClassifierModel` service, typed answer helper,
   errors, package exports, boundary-check coverage.
3. `providers/vercel/ai-gateway-classifier`: request lowering, response decoding, usage and cost,
   fallback metadata, `providerOptions` pass-through.
4. `@yolk-sdk/emulators/gateway`: deterministic `/v1/evaluate` route with fixtures, faults, and
   manifest entries.
5. Conformance cases for boolean, choice, score, and the error envelope, replayed from a synthetic
   live recording through the existing replay-verified write gate.
6. Docs page, smoke imports, and a changeset. `makeClassifierTool` follows in `@yolk-sdk/codemode`.

Tests must demonstrate:

- Every question type round-trips; answers keep their question IDs and types.
- A missing answer, a type mismatch, or a non-finite probability is a typed error, with usage kept.
- Probabilities are not renormalized.
- Credentials never appear in errors, metadata, or recordings.
- Gateway fallback headers and cost map into the result.
- The code mode classifier tool respects its concurrency cap and records usage per nested call.
