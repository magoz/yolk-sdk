import type { CodeModeCatalogTool } from './catalog.ts'

/** Default number of `searchTools` results. */
export const defaultCodeModeSearchLimit = 8

const k1 = 1.2

const b = 0.75

/** Lowercase word tokens; splits on non-alphanumerics and camelCase boundaries. */
export const codeModeSearchTokens = (text: string): ReadonlyArray<string> =>
  text
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(token => token.length > 0)

type IndexedTool = {
  readonly tool: CodeModeCatalogTool
  readonly frequencies: ReadonlyMap<string, number>
  readonly length: number
}

const indexTool = (tool: CodeModeCatalogTool): IndexedTool => {
  const tokens = codeModeSearchTokens(
    [tool.identifier, tool.name, tool.description, tool.namespace].join(' ')
  )

  const frequencies = new Map<string, number>()

  for (const token of tokens) {
    frequencies.set(token, (frequencies.get(token) ?? 0) + 1)
  }

  return { tool, frequencies, length: tokens.length }
}

export type CodeModeSearchOptions = {
  readonly limit?: number
  readonly namespace?: string
}

export type CodeModeSearchHit = {
  /** The identifier scripts call as `tools.<name>(args)`. */
  readonly name: string
  readonly description: string
}

/**
 * BM25 over each tool's identifier, raw name, description, and namespace. Ties keep catalog order.
 * A query without words lists the (namespace-filtered) tools in catalog order.
 */
export const searchCodeModeTools = (
  catalog: ReadonlyArray<CodeModeCatalogTool>,
  query: string,
  options: CodeModeSearchOptions = {}
): ReadonlyArray<CodeModeSearchHit> => {
  const limit = Math.max(0, Math.floor(options.limit ?? defaultCodeModeSearchLimit))

  const scoped =
    options.namespace === undefined
      ? catalog
      : catalog.filter(tool => tool.namespace === options.namespace)

  const documents = scoped.map(indexTool)
  const terms = [...new Set(codeModeSearchTokens(query))]

  const hit = (tool: CodeModeCatalogTool): CodeModeSearchHit => ({
    name: tool.identifier,
    description: tool.description
  })

  if (terms.length === 0) {
    return documents.slice(0, limit).map(document => hit(document.tool))
  }

  const averageLength =
    documents.reduce((total, document) => total + document.length, 0) /
    Math.max(1, documents.length)

  const inverse = new Map(
    terms.map((term): readonly [string, number] => {
      const containing = documents.filter(document => document.frequencies.has(term)).length

      return [term, Math.log(1 + (documents.length - containing + 0.5) / (containing + 0.5))]
    })
  )

  return documents
    .map((document, index) => {
      const score = terms.reduce((total, term) => {
        const frequency = document.frequencies.get(term) ?? 0

        if (frequency === 0) return total

        const norm = k1 * (1 - b + (b * document.length) / Math.max(1, averageLength))

        return total + ((inverse.get(term) ?? 0) * frequency * (k1 + 1)) / (frequency + norm)
      }, 0)

      return { document, index, score }
    })
    .filter(entry => entry.score > 0)
    .sort((left, right) => right.score - left.score || left.index - right.index)
    .slice(0, limit)
    .map(entry => hit(entry.document.tool))
}
