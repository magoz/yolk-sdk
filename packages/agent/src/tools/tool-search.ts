const k1 = 1.2

const b = 0.75

/** Lowercase word tokens; splits on non-alphanumerics and camelCase boundaries. */
export const toolSearchTokens = (text: string): ReadonlyArray<string> =>
  text
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(token => token.length > 0)

/** One searchable document: the text BM25 ranks it by. */
export type ToolSearchDocument<A> = {
  readonly value: A
  readonly text: string
}

/**
 * BM25 over each document's text; ties keep input order, and only documents matching at least one
 * query word are returned. A query without words returns the first `limit` documents. Shared by
 * `tool_search` and code mode `searchTools`.
 */
export const rankToolSearchDocuments = <A>(
  documents: ReadonlyArray<ToolSearchDocument<A>>,
  query: string,
  limit: number
): ReadonlyArray<A> => {
  const bounded = Math.max(0, Math.floor(limit))

  const indexed = documents.map(document => {
    const tokens = toolSearchTokens(document.text)
    const frequencies = new Map<string, number>()

    for (const token of tokens) frequencies.set(token, (frequencies.get(token) ?? 0) + 1)

    return { value: document.value, frequencies, length: tokens.length }
  })

  const terms = [...new Set(toolSearchTokens(query))]

  if (terms.length === 0) return indexed.slice(0, bounded).map(document => document.value)

  const averageLength =
    indexed.reduce((total, document) => total + document.length, 0) / Math.max(1, indexed.length)

  const inverse = new Map(
    terms.map((term): readonly [string, number] => {
      const containing = indexed.filter(document => document.frequencies.has(term)).length

      return [term, Math.log(1 + (indexed.length - containing + 0.5) / (containing + 0.5))]
    })
  )

  return indexed
    .flatMap((document, index) => {
      const score = terms.reduce((total, term) => {
        const frequency = document.frequencies.get(term) ?? 0

        if (frequency === 0) return total

        const norm = k1 * (1 - b + (b * document.length) / Math.max(1, averageLength))

        return total + ((inverse.get(term) ?? 0) * frequency * (k1 + 1)) / (frequency + norm)
      }, 0)

      return score > 0 ? [{ document, index, score }] : []
    })
    .sort((left, right) => right.score - left.score || left.index - right.index)
    .slice(0, bounded)
    .map(entry => entry.document.value)
}
