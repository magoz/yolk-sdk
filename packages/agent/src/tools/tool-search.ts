import { Effect, Option } from 'effect'
import * as Schema from 'effect/Schema'
import {
  ToolDef,
  ToolResult,
  toolSearchToolName,
  type ToolSearchActivation
} from '@yolk-sdk/agent/protocol'
import type { ToolRegistration } from './registry.ts'

// Standard BM25 parameters: `k1` saturates repeated terms, `b` normalizes by document length.
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

/** Default and maximum number of tools one `tool_search` call activates. */
export const defaultToolSearchLimit = 5

export const maxToolSearchLimit = 20

const ToolSearchParams = Schema.Struct({
  query: Schema.String,
  limit: Schema.optional(
    Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: maxToolSearchLimit }))
  )
})

const decodeToolSearchParams = Schema.decodeUnknownOption(ToolSearchParams)

const toolSearchDescription = [
  'Find and load tools that are not declared yet: they become callable directly from your next step on, for the rest of the conversation.',
  'Search by what the tool should do. Loaded tools keep their own approval rules.'
].join(' ')

// The provider-facing schema of `ToolSearchParams`, with model guidance.
const toolSearchParameters = {
  type: 'object',
  properties: {
    query: {
      type: 'string',
      description: 'What the tool should do, in a few words (for example "list open issues").'
    },
    limit: {
      type: 'integer',
      minimum: 1,
      maximum: maxToolSearchLimit,
      description: `How many tools to load (default ${defaultToolSearchLimit}).`
    }
  },
  required: ['query'],
  additionalProperties: false
} satisfies ToolDef['parameters']

const toolSearchResultText = (tools: ReadonlyArray<ToolDef>) =>
  tools.length === 0
    ? 'No tools matched. Try other words.'
    : [
        `Loaded ${tools.length} tool${tools.length === 1 ? '' : 's'}; call them directly from your next step:`,
        ...tools.map(tool => `- ${tool.name}: ${tool.description.split('\n')[0] ?? ''}`)
      ].join('\n')

/**
 * The package `tool_search` tool over the deferred tools of one resolution (ADR 0007). Its result
 * names the activated tools in `structuredContent.toolSearch.activated`; the loop declares them
 * from the next request on (`declaredToolDefs`). Read access: it changes nothing outside the
 * transcript.
 */
export const makeToolSearchTool = <Context>(
  deferred: ReadonlyArray<{ readonly def: ToolDef; readonly searchText?: string }>
): ToolRegistration<Context> => ({
  def: ToolDef.make({
    name: toolSearchToolName,
    description: toolSearchDescription,
    parameters: toolSearchParameters,
    callableBy: 'model'
  }),
  access: 'read',
  execute: ({ call }) =>
    Effect.sync(() =>
      Option.match(decodeToolSearchParams(call.params), {
        onNone: () =>
          ToolResult.make({
            toolCallId: call.id,
            content: `Invalid ${toolSearchToolName} arguments: pass { query: string, limit?: 1 to ${maxToolSearchLimit} }.`,
            isError: true
          }),
        onSome: params => {
          const found = rankToolSearchDocuments(
            deferred.map(tool => ({
              value: tool.def,
              text: [tool.def.name, tool.def.description, tool.searchText ?? ''].join(' ')
            })),
            params.query,
            params.limit ?? defaultToolSearchLimit
          )

          const activation: ToolSearchActivation = {
            toolSearch: { activated: found.map(tool => tool.name) }
          }

          return ToolResult.make({
            toolCallId: call.id,
            content: toolSearchResultText(found),
            structuredContent: activation
          })
        }
      })
    )
})
