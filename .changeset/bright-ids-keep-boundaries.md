---
'@yolk-sdk/connectors': minor
'@yolk-sdk/harness': minor
'@yolk-sdk/knowledge': minor
'@yolk-sdk/sandbox': minor
---

Introduce selected branded identities while preserving string wire representations. This is a breaking pre-1.0 TypeScript API migration for hosts constructing the affected inputs or implementing adapters.

- Knowledge scope/document references use `KnowledgeScopeId` and `KnowledgeDocumentId` from `@yolk-sdk/knowledge/documents`, including store, chunking, ingestion, and search contracts. Decode external/persisted IDs with their schemas; construct trusted constants with `.make`.
- Harness Inbox/Driver lifecycle contracts distinguish `DrainToken` and `ParkGeneration` from `@yolk-sdk/harness/inbox`. Forward live returned values. These brands deliberately accept arbitrary strings and do not replace freshness, instance, or run-ownership checks.
- Sandbox `normalizeWorkspaceCwd` returns `NormalizedWorkspaceCwd`, exported from the root. Raw command cwd inputs remain strings; normalization preserves directory-name whitespace and proves lexical shape only, not filesystem confinement.
- Fortnox file discovery uses canonical `FortnoxGivenNumber` in both input and metadata; nonnumeric metadata is rejected. Invoice previews require `FortnoxDocumentNumber` and share invoice-read validation plus URL encoding rather than archive-ID restrictions. Archive IDs remain strings.
- `defineAction` returns additive `TypedConnectorAction` with `executeTyped`, accepting and validating decoded input without replaying wire transforms, and retaining output types. Existing dynamic `execute`/`invoke` paths remain compatible. Implementations still validate external output data.

Brands do not establish authorization or ownership. No database schema migration or agent-protocol ID changes are required.
