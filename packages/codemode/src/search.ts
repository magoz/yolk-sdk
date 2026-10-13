import { rankToolSearchDocuments, toolSearchTokens } from '@yolk-sdk/agent/tools'
import type { CodeModeCatalogTool } from './catalog.ts'

/** Default number of `searchTools` results. */
export const defaultCodeModeSearchLimit = 8

export type CodeModeSearchOptions = {
  readonly limit?: number
  readonly namespace?: string
}

export type CodeModeSearchHit = {
  /** The identifier scripts call as `tools.<name>(args)`, or for a stage-only tool the name
   * scripts pass to `stage(name, args)`.
   */
  readonly name: string
  readonly description: string
  /** A stage-only tool (ADR 0007): no `tools` binding, only `stage()` it. */
  readonly stageOnly?: true
}

/**
 * BM25 (the shared `rankToolSearchDocuments`) over each tool's identifier, raw name, description,
 * namespace, and namespace description. Ties keep catalog order. A query without words lists the
 * (namespace-filtered) tools in catalog order.
 */
export const searchCodeModeTools = (
  catalog: ReadonlyArray<CodeModeCatalogTool>,
  query: string,
  options: CodeModeSearchOptions = {}
): ReadonlyArray<CodeModeSearchHit> => {
  const scoped =
    options.namespace === undefined
      ? catalog
      : catalog.filter(tool => tool.namespace === options.namespace)

  const hit = (tool: CodeModeCatalogTool): CodeModeSearchHit =>
    tool.exposure === 'stage'
      ? { name: tool.name, description: tool.description, stageOnly: true }
      : { name: tool.identifier, description: tool.description }

  return rankToolSearchDocuments(
    scoped.map(tool => ({
      value: tool,
      text: [
        tool.identifier,
        tool.name,
        tool.description,
        tool.namespace,
        tool.namespaceDescription ?? ''
      ].join(' ')
    })),
    query,
    options.limit ?? defaultCodeModeSearchLimit
  ).map(hit)
}

/** Lowercase word tokens of code mode search (the shared `toolSearchTokens`). */
export const codeModeSearchTokens = toolSearchTokens
