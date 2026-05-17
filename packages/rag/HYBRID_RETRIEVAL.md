# Hybrid Retrieval

Hybrid retrieval searches with both embeddings and keywords, then fuses the result lists.

## Why hybrid

Vector retrieval is strong for semantic questions and paraphrases:

- "which document explains login?"
- "notes about fundraising strategy"
- "uploaded docs related to database setup"

Vector retrieval is weaker for exact-match queries:

- symbols: `OpenAiCodexOAuth`
- file names and ids
- acronyms
- quoted phrases
- rare error strings

Keyword retrieval has the opposite shape: exact terms are strong, paraphrases are weak. Hybrid retrieval gives the agent both signals.

## Pipeline

`retrieveRag` defaults to `mode: 'hybrid'`.

1. Validate query, scope, limits, score knobs.
2. Run vector retrieval over `RagStore.searchChunks`.
3. Run keyword retrieval over `RagStore.searchChunksByText`.
4. Fuse lists with reciprocal rank fusion (RRF).
5. Trim to final `limit`.
6. Expand adjacent context chunks after fusion.

Vector and keyword searches are run concurrently where possible. The host store owns concrete indexing and query strategy.

## Reciprocal rank fusion

RRF scores results by rank, not raw database score:

```txt
fused += 1 / (rankConstant + rank)
```

Default `rankConstant` is `60`. This keeps fusion stable across stores because vector similarity and full-text rank are not directly comparable.

Example:

```txt
Vector:  A, B, C
Keyword: C, D, A

C and A win because both signals found them.
B and D can still survive because one signal found them strongly.
```

The returned `RagSearchResult.score` is the fused score in hybrid mode. `RagSearchResult.scores` preserves source scores:

```ts
{
  vector?: number
  text?: number
  fused?: number
}
```

## Limits

Hybrid retrieval overfetches candidates, then fuses down.

Defaults:

- final `limit`: `10`
- `vectorLimit`: `max(limit * 5, 40)`
- `textLimit`: `max(limit * 5, 40)`

For user-facing tools, keep final limits small and context expansion bounded. Overfetch is for candidate quality, not for model context size.

## Modes

Use `mode: 'hybrid'` by default.

Use `mode: 'vector'` when:

- benchmarking old behavior
- keyword indexes are unavailable
- the host wants lower DB work and can tolerate exact-term misses

## Store contract

`RagStore` has two retrieval primitives:

- `searchChunks`: vector nearest-neighbor retrieval
- `searchChunksByText`: keyword/full-text retrieval

Adapters choose implementation details. Postgres should prefer full-text search with a GIN index over `ILIKE '%query%'` scans.

## Postgres guidance

Recommended first index:

```sql
CREATE INDEX ragChunk_content_fts_idx
ON "ragChunk"
USING gin (to_tsvector('english', content));
```

Recommended query shape:

```sql
to_tsvector('english', content) @@ websearch_to_tsquery('english', $query)
ORDER BY ts_rank_cd(to_tsvector('english', content), websearch_to_tsquery('english', $query)) DESC
```

Search document titles/summaries later by adding generated/search-vector columns or matching expression indexes. Do not add unindexed concat expressions to hot paths.

## Performance

Hybrid costs more DB work than vector-only, but it should be fast with indexes:

- vector HNSW index for embeddings
- GIN full-text index for keyword search
- vector and text candidate limits around 40–100
- fusion in memory over small arrays

For Yolk today, query embedding latency will often dominate. Caching embeddings may matter more than DB micro-optimization.

## Semantics

- `minScore` applies to vector retrieval only.
- Keyword results can still enter the fused set when vector score is below threshold or absent.
- Context expansion happens after fusion to avoid over-expanding discarded candidates.
- Result order is fused order, not raw vector or raw keyword order.

## Testing

Test three layers:

1. Pure RRF ordering and score preservation.
2. Package retrieval calling both store methods in hybrid mode.
3. Adapter keyword behavior against the real database when available.

Keep vector-only tests with `mode: 'vector'` so regressions are easy to isolate.
