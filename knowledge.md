# Knowledge package design

## Motivation

Agents without a filesystem still need durable, structured knowledge.

Yolk currently has `@yolk-sdk/rag` for domain-free retrieval primitives and app-owned `/storage` code for user uploads. That split is correct, but it leaves a missing layer: agent-native knowledge semantics.

RAG answers: "Which text chunks match this query?"

Knowledge answers:

- What is this thing?
- Who owns it?
- What can the agent cite?
- What should always be in context?
- What is raw evidence vs current synthesis?
- Which blob or derived artifact backs it?
- Which objects support, contradict, supersede, or mention each other?
- Which representation should be indexed for text, image, audio, video, or table content?

The package should make those states explicit instead of hiding them in app-specific rows or prompt conventions.

## North star

`@yolk-sdk/knowledge` is a domain-free knowledge substrate for applications that run agents.

It should let an app combine:

- Postgres for catalog, permissions, lifecycle, graph, text search, chunks, embeddings.
- R2 or equivalent blob storage for originals and derived artifacts.
- `@yolk-sdk/rag` for chunking, embedding, and retrieval mechanics.
- Agent tools for typed read/write operations over knowledge objects.

The agent should not need shell access or a filesystem. It should query and maintain a typed, citable, permissioned knowledge store.

## Package-first, app-first

Start with package-shaped contracts and pure models, using the Yolk app as the first implementation.

```txt
packages/knowledge/          # domain-free contracts, schemas, pure logic
lib/services/knowledge/      # app adapters: Drizzle, R2, extraction, providers
lib/core/knowledge/          # app use-cases/actions, auth and policy
app/storage or app/knowledge # UI
```

Package owns semantics. App owns infrastructure and policy.

## Relationship to RAG

Keep `@yolk-sdk/rag` dumb and reusable.

```txt
KnowledgeObject
  -> Representation
  -> RagDocument
  -> RagChunk
  -> retrieval context
```

`@yolk-sdk/rag` should continue to know nothing about users, permissions, R2, product roles, or operating protocols.

`@yolk-sdk/knowledge` decides what a thing is, how authoritative it is, how it is cited, and whether it belongs in agent context.

## Core model

### KnowledgeObject

The logical thing the user and agent reason about.

Examples:

- "Big vision"
- "Investor update Q1"
- "Pricing screenshot"
- "Agent storage decision"
- "YC memo PDF"

Initial roles:

```txt
source             # raw uploaded/imported thing
note               # user-authored text
operating_protocol # agent instruction/context
knowledge_map      # routes agent to relevant knowledge areas
compiled_truth     # current synthesis backed by evidence
decision           # durable product/org/architecture decision
```

### Artifact

A physical blob or generated file backing an object.

One object can have multiple artifacts because the same logical thing can have originals and derived files.

Examples:

```txt
PDF object
  original.pdf
  extracted.txt
  thumbnail.png

Image object
  original.png
  ocr.txt
  caption.json
  thumbnail.webp

Web page object
  original.html
  readable.md
  screenshot.png
```

Artifacts live in R2. Postgres stores their catalog rows.

### Representation

An agent-readable or indexable view of an object/artifact.

Examples:

- extracted PDF text
- OCR text
- image caption
- audio transcript
- video summary
- table extraction
- model-generated description

Representations are what retrieval indexes. They may live inline in Postgres when small, or point to artifact blobs when large.

### Chunk

The retrieval unit derived from a representation.

Chunks and embeddings live in Postgres, usually through `@yolk-sdk/rag` mechanics.

### Provenance

Where knowledge came from and why it is trusted.

Examples:

- user upload
- direct user statement
- URL import
- generated extraction
- model summary
- external API

Provenance enables citations and source precedence.

### Link

Typed relationship between objects.

Initial link types:

```txt
cites
supports
contradicts
supersedes
mentions
derived_from
related_to
```

## Context policy

Do not rely on vector search for every important thing.

Some objects must be considered before the agent knows what to search for.

```txt
pinned     # always considered for agent startup/context assembly
routable   # included in knowledge maps/resolvers
searchable # normal retrieval
archival   # direct lookup only, excluded from default retrieval
```

Examples:

- Big vision: `pinned`
- Knowledge map: `pinned` or `routable`
- Product decision: `routable` + `searchable`
- Uploaded PDF: `searchable`
- Old logs: `archival`

## GBrain influence

This design borrows several proven ideas from GBrain, but makes them app-native instead of filesystem-native.

Direct inspirations:

- `AGENTS.md` -> operating protocol object.
- `llms.txt` -> knowledge map object.
- `skills/RESOLVER.md` -> routable dispatcher object.
- Compiled truth + timeline -> synthesized current state plus evidence trail.
- Brain-first lookup -> search knowledge before external APIs.
- Citations/source precedence -> provenance and cited answers.
- Markdown/git as system of record, DB as derived cache -> adapted to Postgres catalog plus R2 artifacts.

Yolk's difference: no filesystem required. Agents interact through typed tools over Postgres/R2.

## Storage architecture

Assumption:

```txt
Postgres
  knowledge objects
  artifact catalog
  representations
  provenance
  links
  chunks
  embeddings
  statuses

R2
  original files
  extracted text sidecars
  thumbnails
  transcripts
  generated structured artifacts
```

Postgres remains the queryable control plane. R2 stores bytes.

## Candidate tables

```txt
knowledgeObject
  id
  owner scope fields (app-owned adapter concern)
  role
  title
  status
  contextPolicy
  metadata
  createdAt
  updatedAt

knowledgeArtifact
  id
  objectId
  kind              # original | extracted_text | thumbnail | transcript | caption | structured
  r2Key
  mediaType
  byteSize
  checksum
  createdAt

knowledgeRepresentation
  id
  objectId
  artifactId?
  modality          # text | image | audio | video | table
  contentText?
  summary?
  model?
  status
  metadata

knowledgeChunk
  id
  objectId
  representationId
  position
  content
  embedding
  tokenCount
  metadata

knowledgeProvenance
  id
  objectId
  artifactId?
  sourceKind
  sourceLabel
  sourceUrl?
  observedAt
  metadata

knowledgeLink
  id
  fromObjectId
  toObjectId
  type
  metadata
```

The package should define contracts and schemas. The app decides exact DB columns, auth fields, indexes, and R2 layout.

## R2 layout sketch

```txt
knowledge/{objectId}/original/{artifactId}
knowledge/{objectId}/derived/text/{artifactId}.txt
knowledge/{objectId}/derived/thumb/{artifactId}.png
knowledge/{objectId}/derived/transcript/{artifactId}.json
knowledge/{objectId}/derived/structured/{artifactId}.json
```

The R2 layout is an adapter detail, not a package requirement.

## Image handling

Images are first-class knowledge.

Ingestion flow:

1. Store original image artifact in R2.
2. Create image representation.
3. Generate OCR text when possible.
4. Generate caption/description and visual entities.
5. Embed text representations.
6. Optionally add native image embeddings later.

This lets the agent answer questions like "find the screenshot with the pricing table" without treating images as opaque blobs.

## Package boundaries

`@yolk-sdk/knowledge` should not import:

- Next.js
- React
- Drizzle
- R2/S3 SDKs
- provider SDKs
- app auth/session code
- app DB schema

It may define:

- schemas and ADTs
- store interfaces
- artifact-store interfaces
- context assembly helpers
- provenance and citation helpers
- agent tool adapter helpers that require host-provided scope resolution

App adapters implement:

- `DrizzleKnowledgeStoreLayer`
- `R2KnowledgeArtifactStoreLayer`
- extractor/provider layers
- user/workspace/project permission policy
- server actions and UI

## Initial package surface

Keep v0 small.

```txt
@yolk-sdk/knowledge/objects
@yolk-sdk/knowledge/artifacts
@yolk-sdk/knowledge/representations
@yolk-sdk/knowledge/provenance
@yolk-sdk/knowledge/links
@yolk-sdk/knowledge/store
@yolk-sdk/knowledge/context
@yolk-sdk/knowledge/agent
```

Avoid implementing all roles at once. Start with current `/storage` needs plus pinned context.

## Decisions for v0

- Create a real package now: `@yolk-sdk/knowledge`.
- Use `knowledge` naming for new app internals and UI direction.
- Create new knowledge tables; do not adapt `storageObject` as the long-term model.
- Use R2 now for artifacts. The app can provision/access it through Alchemy/S3-compatible infrastructure.
- Inject pinned knowledge into the agent immediately.
- Start with user-owned knowledge unless/until workspace/project scope becomes concrete.

User-owned v0 means app tables include `userId` and all reads/writes are scoped to the authenticated user. The package stays generic: it never models users directly, only caller-provided scopes.

## Implementation plan

### Phase 1 — package skeleton

Create `packages/knowledge` as a domain-free package.

Exports:

```txt
@yolk-sdk/knowledge
@yolk-sdk/knowledge/objects
@yolk-sdk/knowledge/artifacts
@yolk-sdk/knowledge/representations
@yolk-sdk/knowledge/provenance
@yolk-sdk/knowledge/links
@yolk-sdk/knowledge/store
@yolk-sdk/knowledge/context
@yolk-sdk/knowledge/agent
```

Initial files:

```txt
packages/knowledge/
  AGENTS.md
  package.json
  tsconfig.json
  src/
    index.ts
    objects.ts
    artifacts.ts
    representations.ts
    provenance.ts
    links.ts
    store.ts
    context.ts
    agent.ts
    errors.ts
```

Keep root exports explicit. No broad barrels.

### Phase 2 — package contracts

Model only stable primitives:

- `KnowledgeObject`
- `KnowledgeArtifact`
- `KnowledgeRepresentation`
- `KnowledgeProvenance`
- `KnowledgeLink`
- `KnowledgeContextPolicy`
- `KnowledgeObjectRole`
- `KnowledgeLifecycleStatus`
- `KnowledgeStore`
- `KnowledgeArtifactStore`

Package rules:

- Use Effect Schema at boundaries.
- Reject empty ids/titles/content refs.
- No app users, auth, Drizzle, R2 SDK, provider SDKs, Next.js, React, or Node-only imports.
- Agent helpers require host-provided scope resolution.

### Phase 3 — database schema

Add new app tables in `lib/services/db/schema.ts`:

```txt
knowledgeObject
knowledgeArtifact
knowledgeRepresentation
knowledgeProvenance
knowledgeLink
knowledgeChunk
```

Use `userId` on `knowledgeObject` for v0 ownership. Child tables inherit ownership through `objectId` joins.

Keep embeddings/chunks in Postgres. Use pgvector + full-text indexes on `knowledgeChunk`, mirroring current RAG mechanics but without coupling to `storageObject`.

### Phase 4 — R2 artifact adapter

Add app-owned artifact storage service:

```txt
lib/services/knowledge/
  live-layer.ts
  errors.ts
```

Responsibilities:

- implement `KnowledgeStore` over Drizzle/Postgres
- implement `KnowledgeArtifactStore` over R2/S3-compatible storage
- keep R2 key layout app-owned
- keep Alchemy/S3 dependencies out of `@yolk-sdk/knowledge`

Initial R2 key convention:

```txt
knowledge/{objectId}/original/{artifactId}
knowledge/{objectId}/derived/text/{artifactId}.txt
knowledge/{objectId}/derived/thumb/{artifactId}.png
knowledge/{objectId}/derived/transcript/{artifactId}.json
knowledge/{objectId}/derived/structured/{artifactId}.json
```

### Phase 5 — domain functions and UI

Add app domain functions under `lib/core/knowledge/`:

- create text knowledge object
- create file knowledge object
- list user knowledge objects
- get knowledge object
- delete knowledge object
- mark object pinned/searchable/archival

Move UI direction from `/storage` to `/knowledge`. If route migration is too much for v0, keep `/storage` temporarily but use knowledge internals.

### Phase 6 — extraction and indexing

For text-extractable artifacts:

1. Store original artifact in R2.
2. Create representation rows.
3. Extract text/OCR/transcript/caption as applicable.
4. Store derived artifacts when useful.
5. Create chunks + embeddings in Postgres.
6. Mark representation/object ready or error.

Images are first-class:

- OCR text when available.
- Vision caption/description.
- Visual entity metadata.
- Text embeddings over OCR/caption first.
- Native image embeddings later.

### Phase 7 — pinned agent context

Wire pinned knowledge into agent startup.

Flow:

1. Resolve authenticated user.
2. Load `contextPolicy = pinned` objects.
3. Prefer compact representations/summaries over full raw content.
4. Pack into bounded context.
5. Inject before normal user message handling.

Pinned context should include at least:

- operating protocols
- knowledge maps
- big vision / current product truth
- durable decisions marked pinned

Normal retrieval remains query-driven through searchable chunks.

### Phase 8 — migration from current storage

After v0 works, migrate existing `storageObject`/`ragDocument` data into knowledge tables.

Do not block initial modeling on migration. Current storage can coexist until the knowledge path is stable.

## Validation plan

- `pnpm packages:check` after adding package.
- `pnpm tsc` after DB/app wiring.
- `pnpm lint` after app/package wiring.
- `pnpm test:run` after domain/service behavior exists.
- Add package tests for schema validation and context packing.
- Add app service tests for object/artifact lifecycle, chunk search, and pinned context loading.

## Open questions

- Rename UI immediately to `/knowledge`, or keep `/storage` as redirect/compat?
- Does Postgres store extracted text inline, R2-only, or hybrid by size?
- How strict is source precedence in v0?
- Which objects are pinned by default?
- When introduce workspace/project scope?
- Should current `/storage` data migrate immediately or after v0 stabilizes?
