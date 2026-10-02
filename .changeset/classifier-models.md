---
'@yolk-sdk/agent': minor
'@yolk-sdk/emulators': patch
---

Add classifier models (ADR 0003). The new `@yolk-sdk/agent/classification` subpath is a provider-neutral contract for models that answer typed questions about one `state` (a string, JSON object, or JSON array) with probabilities: Effect Schemas for `boolean`, `choice` (2-255 options), and `score` (2-10 levels) questions and their answers, `ClassificationRequest`, `ClassificationResult` with token usage and optional `costUsd`, the `ClassifierModel` service, a typed `classify` helper whose choice answers infer the union of their option keys, and typed errors (`ClassificationRequestInvalid`, `ClassificationProviderError`, `ClassificationResponseInvalid`, which keeps the billed usage). Every answer is checked against its question; probabilities are never renormalized.

Add `@yolk-sdk/agent/providers/vercel/ai-gateway-classifier`: a `ClassifierModel` layer over AI Gateway `POST /v1/evaluate` (Gateway calls this evaluation) with `typesafe-ai/jev` by default and the same Gateway credential as the chat provider (`AI_GATEWAY_API_KEY`, falling back to `VERCEL_OIDC_TOKEN`). It passes `providerOptions` through, maps `providerMetadata.gateway.cost` to `usage.costUsd`, keeps `x-ai-gateway-evaluation-fallback-*` headers in `providerMetadata.evaluationFallbackHeaders`, reads confidence from the answer or `providerMetadata.typesafe.confidence`, and maps Gateway error envelopes to sanitized typed errors.

`@yolk-sdk/agent/providers/vercel/conformance` also exports four classifier `read` cases (boolean, choice, score, error envelope) with synthetic, unverified fixtures (`vercelAiGatewayClassifierConformanceCases`, `vercelAiGatewayClassifierConformanceFixtures`, `VercelAiGatewayClassifierConformanceConfig`), apart from the unchanged chat cases.

`@yolk-sdk/emulators/gateway` answers the classifier route `POST /v1/evaluate` fixture-only from those recordings, with its own unverified manifest (`gatewayEvaluateEmulatorRoutes`), ledger, faults, scripted errors, and control plane (`emulator.evaluate`, `/_emulate/evaluate/*`). The chat route, its manifest, and its top-level APIs are unchanged; `GatewayEmulator` gains `evaluate`.
