import { Predicate } from 'effect'
import {
  renderDeclarations,
  renderToolOutputType,
  renderToolSample,
  toCodemodeIdentifier
} from '@earendil-works/pi-codemode/declarations'
import { toolDiscovery } from '@yolk-sdk/agent/protocol'
import type { NestedTool } from '@yolk-sdk/agent/tools'
import type { CodeModeJsonSchema } from './executor.ts'

/** How a nested tool reaches scripts: `all` tools are also direct model tools; `listed` and
 * `search` are the two discovery modes of `codemode`-only tools.
 */
export type CodeModeToolExposure = 'all' | 'listed' | 'search'

/** One nested tool as scripts see it. */
export type CodeModeCatalogTool = {
  /** Raw tool name; scripts may call `tools["<name>"](args)`. */
  readonly name: string
  /** Identifier for `tools.<identifier>(args)` (invalid identifier characters become `_`). */
  readonly identifier: string
  /** The tool's `ToolModule.id`. */
  readonly namespace: string
  readonly description: string
  readonly inputSchema: CodeModeJsonSchema
  /** The declared output schema, or `{ type: 'string' }` for text results. */
  readonly outputSchema: CodeModeJsonSchema
  /** True when the tool declares an output schema (calls resolve to `structuredContent`). */
  readonly structured: boolean
  readonly exposure: CodeModeToolExposure
}

const textOutputSchema: CodeModeJsonSchema = { type: 'string' }

/** Catalog of nested tools in resolution order. */
export const codeModeCatalog = (
  tools: ReadonlyArray<NestedTool>
): ReadonlyArray<CodeModeCatalogTool> =>
  tools.map(({ def, moduleId }) => ({
    name: def.name,
    identifier: toCodemodeIdentifier(def.name),
    namespace: moduleId,
    description: def.description,
    inputSchema: def.parameters,
    outputSchema: def.outputSchema ?? textOutputSchema,
    structured: def.outputSchema !== undefined,
    exposure: toolDiscovery(def) ?? 'all'
  }))

/** Default inline budget of the nested tool listing, in estimated tokens. */
export const defaultCodeModeInlineBudget = 3000

/** Estimated tokens of a text: four characters per token, rounded up. */
export const estimateCodeModeTokens = (text: string): number => Math.ceil(text.length / 4)

const maxShortTypeChars = 60

const shortType = (schema: CodeModeJsonSchema): string => {
  const rendered = renderToolOutputType(schema)

  if (rendered.length <= maxShortTypeChars) return rendered

  if (!Predicate.isBoolean(schema)) {
    if (schema.type === 'array') return 'Array<unknown>'

    if (schema.type === 'object') return 'object'
  }

  return 'unknown'
}

// Declarations only read names, descriptions, and schemas; `execute` is never called.
const declarationTool = (tool: CodeModeCatalogTool) => ({
  name: tool.name,
  description: tool.description,
  inputSchema: tool.inputSchema,
  outputSchema: tool.outputSchema,
  execute: () => undefined
})

const directToolLine = (tool: CodeModeCatalogTool) =>
  `- \`tools.${tool.identifier}(args)\` takes the arguments of the \`${tool.name}\` tool and resolves to \`${shortType(tool.outputSchema)}\`.`

const declarationMembers = (tools: ReadonlyArray<CodeModeCatalogTool>) =>
  renderDeclarations({ tools: tools.map(declarationTool) })

type Candidate = {
  readonly tool: CodeModeCatalogTool
  readonly index: number
  readonly cost: number
}

const candidateCost = (tool: CodeModeCatalogTool) =>
  estimateCodeModeTokens(
    tool.exposure === 'all' ? directToolLine(tool) : declarationMembers([tool])
  )

const groupByNamespace = <A extends { readonly tool: CodeModeCatalogTool }>(
  items: ReadonlyArray<A>
): ReadonlyMap<string, ReadonlyArray<A>> => {
  const groups = new Map<string, Array<A>>()

  for (const item of items) {
    const group = groups.get(item.tool.namespace)

    if (group === undefined) {
      groups.set(item.tool.namespace, [item])
    } else {
      group.push(item)
    }
  }

  return groups
}

export type CodeModeListing = {
  /** Tools placed in the description, in catalog order. */
  readonly listed: ReadonlyArray<CodeModeCatalogTool>
  /** Namespaces (catalog order) with callable tools the description does not list. */
  readonly unlistedNamespaces: ReadonlyArray<string>
}

/**
 * Chooses the tools the description lists within `budget` estimated tokens, fairly across
 * namespaces: each round, every namespace still in play places its cheapest remaining tool; a
 * namespace whose next tool does not fit drops out. `search` tools are never candidates.
 */
export const selectCodeModeListing = (
  catalog: ReadonlyArray<CodeModeCatalogTool>,
  budget: number
): CodeModeListing => {
  const candidates = catalog.flatMap((tool, index): ReadonlyArray<Candidate> =>
    tool.exposure === 'search' ? [] : [{ tool, index, cost: candidateCost(tool) }]
  )

  const queues = new Map(
    [...groupByNamespace(candidates)].map(([namespace, group]) => [
      namespace,
      [...group].sort((left, right) => left.cost - right.cost || left.index - right.index)
    ])
  )

  const placed = new Set<number>()
  const inPlay = new Set(queues.keys())
  let remaining = budget

  while (inPlay.size > 0) {
    for (const [namespace, queue] of queues) {
      if (!inPlay.has(namespace)) continue

      const next = queue.shift()

      if (next === undefined || next.cost > remaining) {
        inPlay.delete(namespace)
        continue
      }

      placed.add(next.index)
      remaining -= next.cost
    }
  }

  const unlisted = new Set(
    catalog.flatMap((tool, index) => (placed.has(index) ? [] : [tool.namespace]))
  )

  return {
    listed: catalog.filter((_, index) => placed.has(index)),
    unlistedNamespaces: [...new Set(catalog.map(tool => tool.namespace))].filter(namespace =>
      unlisted.has(namespace)
    )
  }
}

const intro = [
  'Run a JavaScript script that calls tools and returns only what matters.',
  '`code` is the body of an async function: top-level `await` and `return` work. Write plain JavaScript; simple TypeScript annotations are stripped. There is no Node.js, network, filesystem, `require`, `fetch`, or timers.',
  'Call tools as `await tools.<id>(args)`. A call resolves to the declared result type and rejects with an Error when the tool fails. Calls still running when the script ends are cancelled, so await every call (use `Promise.all` for parallel calls).',
  'Only the script output and its return value come back to you: filter and aggregate inside the script and return a small JSON value.'
].join('\n')

const globalLines = (store: boolean) => [
  '- `text(value)` and `console.log(...values)`: append text to the output.',
  '- `image(dataUrl)`: append a base64 image (a `data:` URL or `{ type: "image", data, mimeType }`).',
  '- `exit()`: end the script successfully.',
  '- `ALL_TOOLS`: `{ name, description }` of every callable tool.',
  '- `await searchTools(query, { limit?, namespace? })`: find tools by topic; resolves to `Array<{ name: string; description: string }>` (default limit 8).',
  '- `await describeTool(name)`: the description and TypeScript declaration of a tool, or `undefined`.',
  '- `await describeNamespace(name)`: `{ name, tools: Array<{ name, description }> }` for a namespace, or `undefined`.',
  ...(store
    ? [
        '- `store(key, value)` and `load(key)`: keep small JSON values for later scripts; writes are saved only when the script succeeds.'
      ]
    : [])
]

const namespaceSection = (
  namespace: string,
  tools: ReadonlyArray<CodeModeCatalogTool>,
  unlisted: boolean
) => {
  const declared = tools.filter(tool => tool.exposure !== 'all')
  const direct = tools.filter(tool => tool.exposure === 'all')

  return [
    `### ${namespace}`,
    ...(declared.length > 0 ? ['```ts', declarationMembers(declared), '```'] : []),
    ...direct.map(directToolLine),
    ...(unlisted
      ? [`- More tools: \`await searchTools(query, { namespace: ${JSON.stringify(namespace)} })\`.`]
      : [])
  ].join('\n')
}

export type CodeModeDescriptionInput = {
  readonly tools: ReadonlyArray<NestedTool>
  readonly inlineBudget?: number
  /** Mention `store()`/`load()` persistence. */
  readonly store?: boolean
}

/**
 * The code mode tool description: intro, globals one per line, then nested tools grouped by
 * namespace within the inline budget. `codemode` + `search` tools never appear, so the text only
 * changes when listed or direct tools change, or a namespace gains or loses unlisted tools.
 */
export const renderCodeModeDescription = (input: CodeModeDescriptionInput): string => {
  const catalog = codeModeCatalog(input.tools)

  const listing = selectCodeModeListing(catalog, input.inlineBudget ?? defaultCodeModeInlineBudget)

  const unlisted = new Set(listing.unlistedNamespaces)
  const listedByNamespace = groupByNamespace(listing.listed.map(tool => ({ tool })))
  const namespaces = [...new Set(catalog.map(tool => tool.namespace))]

  const sections = namespaces.flatMap(namespace => {
    const tools = (listedByNamespace.get(namespace) ?? []).map(item => item.tool)

    return tools.length === 0 && !unlisted.has(namespace)
      ? []
      : [namespaceSection(namespace, tools, unlisted.has(namespace))]
  })

  return [
    intro,
    ['Globals:', ...globalLines(input.store === true)].join('\n'),
    sections.length === 0
      ? 'Nested tools: none are callable from scripts here.'
      : ['## Nested tools by namespace', ...sections].join('\n\n')
  ].join('\n\n')
}

/** `describeTool` text: the description and TypeScript declaration of one tool. */
export const describeCodeModeTool = (tool: CodeModeCatalogTool): string =>
  renderToolSample(declarationTool(tool))

/** Finds a tool by identifier or raw name. */
export const findCodeModeTool = (
  catalog: ReadonlyArray<CodeModeCatalogTool>,
  name: string
): CodeModeCatalogTool | undefined =>
  catalog.find(tool => tool.identifier === name) ?? catalog.find(tool => tool.name === name)
