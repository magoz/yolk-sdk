import { Option, Predicate } from 'effect'
import * as Schema from 'effect/Schema'
import {
  renderDeclarations,
  renderToolOutputType,
  renderToolSample,
  schemaToType,
  toCodemodeIdentifier
} from '@earendil-works/pi-codemode/declarations'
import { isDeferredTool, toolDiscovery } from '@yolk-sdk/agent/protocol'
import type { RunInstruction } from '@yolk-sdk/agent/loop'
import type { NestedTool } from '@yolk-sdk/agent/tools'
import type { CodeModeJsonSchema } from './executor.ts'

/** How a nested tool reaches scripts: `all` tools are also direct model tools; `listed` and
 * `search` are the two discovery modes of `codemode`-only tools; `stage` marks a stageable tool
 * (approval-gated, ADR 0007): found by search, never callable, only passed to `stage()`.
 */
export type CodeModeToolExposure = 'all' | 'listed' | 'search' | 'pinned' | 'stage'

/** One nested tool as scripts see it. */
export type CodeModeCatalogTool = {
  /** Raw tool name; scripts may call `tools["<name>"](args)`. */
  readonly name: string
  /** Identifier for `tools.<identifier>(args)` (invalid identifier characters become `_`). */
  readonly identifier: string
  /**
   * How scripts call this tool, used to prefix its rejections: `tools.<identifier>`, or
   * `tools["<name>"]` when an earlier tool already has the identifier (see `codeModeCallLabels`;
   * when the name is taken too, the tool is unreachable and the label only names it).
   */
  readonly callLabel: string
  /** The tool's `ToolModule.id`. */
  readonly namespace: string
  /** The module's `ToolModule.description`, when set. */
  readonly namespaceDescription?: string
  readonly description: string
  readonly inputSchema: CodeModeJsonSchema
  /** The declared output schema, or `{ type: 'string' }` for text results. */
  readonly outputSchema: CodeModeJsonSchema
  /** True when the tool declares an output schema (calls resolve to `structuredContent`). */
  readonly structured: boolean
  readonly exposure: CodeModeToolExposure
}

const textOutputSchema: CodeModeJsonSchema = { type: 'string' }

/**
 * The call label of each tool name, in order, as pi binds `tools`: each tool takes
 * `tools[<identifier>]` unless an earlier tool holds that key (first tool wins), then
 * `tools[<name>]` if still free. The label is `tools.<identifier>` for the tool that holds its
 * identifier, otherwise `tools["<name>"]`. The executor guard and the host rejection prefix share
 * it, so both name a call the same way.
 */
export const codeModeCallLabels = (names: ReadonlyArray<string>): ReadonlyArray<string> => {
  const bound = new Set<string>()

  return names.map(name => {
    const identifier = toCodemodeIdentifier(name)
    const ownsIdentifier = !bound.has(identifier)

    bound.add(identifier)
    bound.add(name)

    return ownsIdentifier ? `tools.${identifier}` : `tools[${JSON.stringify(name)}]`
  })
}

/** Catalog of nested tools in resolution order. */
export const codeModeCatalog = (
  tools: ReadonlyArray<NestedTool>
): ReadonlyArray<CodeModeCatalogTool> => {
  const labels = codeModeCallLabels(tools.map(({ def }) => def.name))

  return tools.map(({ def, moduleId, moduleDescription }, index) => {
    const tool: CodeModeCatalogTool = {
      name: def.name,
      identifier: toCodemodeIdentifier(def.name),
      callLabel: labels[index] ?? `tools[${JSON.stringify(def.name)}]`,
      namespace: moduleId,
      description: def.description,
      inputSchema: def.parameters,
      outputSchema: def.outputSchema ?? textOutputSchema,
      structured: def.outputSchema !== undefined,
      // A deferred tool's declaration is not in model context until activated: scripts find it
      // by search like a codemode-only `search` tool (ADR 0007).
      exposure: toolDiscovery(def) ?? (isDeferredTool(def) ? 'search' : 'all')
    }

    return moduleDescription === undefined
      ? tool
      : { ...tool, namespaceDescription: moduleDescription }
  })
}

/**
 * Catalog entries of the stageable tools (ADR 0007). Stageable tools are approval-gated, so scripts
 * can only `stage()` them whatever their `callableBy` (stage-only `codemode` ones are also never
 * declared to the model): searchable and describable, never callable (no `tools` binding), so
 * their call label is the `stage()` call that records them.
 */
export const codeModeStageOnlyCatalog = (
  stageable: ReadonlyArray<NestedTool>
): ReadonlyArray<CodeModeCatalogTool> =>
  stageable.map(({ def, moduleId, moduleDescription }) => {
    const tool: CodeModeCatalogTool = {
      name: def.name,
      identifier: toCodemodeIdentifier(def.name),
      callLabel: `stage(${JSON.stringify(def.name)})`,
      namespace: moduleId,
      description: def.description,
      inputSchema: def.parameters,
      outputSchema: def.outputSchema ?? textOutputSchema,
      structured: def.outputSchema !== undefined,
      exposure: 'stage'
    }

    return moduleDescription === undefined
      ? tool
      : { ...tool, namespaceDescription: moduleDescription }
  })

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
  estimateCodeModeTokens(declarationMembers([tool]))

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
  /** Tools placed in the description, in catalog order: every `all` tool, and the `listed` tools
   * that fit the budget.
   */
  readonly listed: ReadonlyArray<CodeModeCatalogTool>
  /** Namespaces (catalog order) with callable tools the description does not list. */
  readonly unlistedNamespaces: ReadonlyArray<string>
}

/**
 * Chooses the tools the description lists. `all` tools are always placed, outside the budget
 * (the model already has their declarations), and so are `pinned` tools. `listed` tools fill
 * `budget` estimated tokens fairly across namespaces: each round, every namespace still in play
 * places its cheapest remaining tool; a namespace whose next tool does not fit drops out. `search`
 * tools are never candidates.
 */
export const selectCodeModeListing = (
  catalog: ReadonlyArray<CodeModeCatalogTool>,
  budget: number
): CodeModeListing => {
  const candidates = catalog.flatMap((tool, index): ReadonlyArray<Candidate> =>
    tool.exposure === 'listed' ? [{ tool, index, cost: candidateCost(tool) }] : []
  )

  const queues = new Map(
    [...groupByNamespace(candidates)].map(([namespace, group]) => [
      namespace,
      [...group].sort((left, right) => left.cost - right.cost || left.index - right.index)
    ])
  )

  const placed = new Set(
    catalog.flatMap((tool, index) =>
      tool.exposure === 'all' || tool.exposure === 'pinned' ? [index] : []
    )
  )

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
  'Call tools as `await tools.<id>(args)`. Arguments must be plain JSON (no `NaN`, `undefined` array items, `Map`, or functions). A call resolves to the declared result type and rejects with an Error whose message starts with `tools.<id>:` when the tool fails. Calls still running when the script ends are cancelled, so await every call (use `Promise.all` for parallel calls).',
  'Only the script output and its return value come back to you: filter and aggregate inside the script and return a small JSON value.'
].join('\n')

const stageLine = (reviewToolName: string) =>
  `- \`await stage(name, args)\`: record a call of a stageable tool for review instead of running it; resolves to \`{ staged: true, key, index }\`. Nothing runs until a person approves the plan through the \`${reviewToolName}\` tool, which the result tells you how to call. Once a script stages, it may only run read tools; a script that already ran a write tool cannot stage. \`searchTools\` marks approval-gated tools \`stageOnly: true\`: they have no \`tools\` binding, only \`stage()\` them.`

/** Stageable tool names listed in the description; the rest are summarized with a count. */
const maxListedStageableTools = 20

/**
 * Stageable tools the description names: `pinned` ones first, never `search` or deferred ones
 * (whose declaration is not in model context; scripts find them by search, ADR 0007).
 */
type StageableNames = {
  readonly pinned: ReadonlyArray<string>
  readonly listed: ReadonlyArray<string>
}

const listedStageableNames = (staging: CodeModeStagingDescription): StageableNames => ({
  pinned: staging.tools.flatMap(({ def }) => (toolDiscovery(def) === 'pinned' ? [def.name] : [])),
  listed: staging.tools.flatMap(({ def }) => {
    const discovery = toolDiscovery(def)

    return discovery === 'search' || discovery === 'pinned' || isDeferredTool(def) ? [] : [def.name]
  })
})

const hasStageableNames = (names: StageableNames) =>
  names.pinned.length > 0 || names.listed.length > 0

/** `pinned` names are always shown; the cap applies to the others. */
const stageableSection = (names: StageableNames) => {
  const room = Math.max(0, maxListedStageableTools - names.pinned.length)
  const hidden = names.listed.length - room

  return [
    '## Stageable tools',
    'Approval-gated tools a script cannot call through `tools`, only stage with `await stage("<name>", args)` (arguments as for the tool of the same name):',
    ...[...names.pinned, ...names.listed.slice(0, room)].map(name => `- \`${name}\``),
    ...(hidden > 0 ? [`- … and ${hidden} more (find them with \`searchTools\`).`] : [])
  ].join('\n')
}

const globalLines = (store: boolean) => [
  '- `text(value)` and `console.log(...values)`: append text to the output.',
  '- `image(dataUrl)`: append a base64 image (a `data:` URL or `{ type: "image", data, mimeType }`).',
  '- `exit()`: end the script successfully.',
  '- `ALL_TOOLS`: `{ name, description }` of every callable tool.',
  '- `await searchTools(query, { limit?, namespace? })`: find tools by topic; resolves to `Array<{ name: string; description: string }>` (default limit 8).',
  '- `await describeTool(name)`: the description and TypeScript declaration of a tool, or `undefined`.',
  '- `await describeNamespace(name)`: `{ name, description?, tools: Array<{ name, description }> }` for a namespace, or `undefined`.',
  ...(store
    ? [
        '- `store(key, value)` and `load(key)`: keep small JSON values for later scripts; writes are saved only when the script succeeds.'
      ]
    : [])
]

const namespaceSection = (namespace: string, tools: ReadonlyArray<CodeModeCatalogTool>) => {
  const declared = tools.filter(tool => tool.exposure !== 'all')
  const direct = tools.filter(tool => tool.exposure === 'all')

  const description = tools.find(
    tool => tool.namespaceDescription !== undefined
  )?.namespaceDescription

  return [
    `### ${namespace}`,
    ...(description === undefined ? [] : [description]),
    ...(declared.length > 0 ? ['```ts', declarationMembers(declared), '```'] : []),
    ...direct.map(directToolLine)
  ].join('\n')
}

// Fixed text: never derived from `search` tools or from which tools did not fit the budget.
const unlistedToolsLine =
  'More tools may be callable than are listed here: find them with `await searchTools(query, { namespace? })` and read one with `await describeTool(name)` or `await describeNamespace(name)` before calling it.'

/** Staged tool plans as the description shows them (`NestedToolStagingDescription`). */
export type CodeModeStagingDescription = {
  readonly tools: ReadonlyArray<NestedTool>
  readonly reviewToolName: string
}

export type CodeModeDescriptionInput = {
  readonly tools: ReadonlyArray<NestedTool>
  readonly inlineBudget?: number
  /** Mention `store()`/`load()` persistence. */
  readonly store?: boolean
  /** Document `stage()` and list the stageable tools that are neither `search` nor deferred. */
  readonly staging?: CodeModeStagingDescription
}

/**
 * The code mode tool description: intro, globals one per line, then nested tools grouped by
 * namespace, then one fixed line pointing to `searchTools`/`describeTool`/`describeNamespace`.
 * `all` tools get one line each outside the budget; `listed` tools are declared within the inline
 * budget; `search` tools never contribute, so adding or removing them (even whole namespaces of
 * them) leaves the text byte-identical. With `staging` (and stageable tools), `stage()` is listed
 * with the globals and the stageable tool names follow the nested tools; `search` and deferred
 * stageable tools are never named, so they leave the text byte-identical too once any stageable
 * tool exists.
 */
export const renderCodeModeDescription = (input: CodeModeDescriptionInput): string => {
  const catalog = codeModeCatalog(input.tools)

  const listing = selectCodeModeListing(catalog, input.inlineBudget ?? defaultCodeModeInlineBudget)

  const sections = [...groupByNamespace(listing.listed.map(tool => ({ tool })))].map(
    ([namespace, items]) =>
      namespaceSection(
        namespace,
        items.map(item => item.tool)
      )
  )

  const staging =
    input.staging !== undefined && input.staging.tools.length > 0 ? input.staging : undefined

  const stageableNames =
    staging === undefined ? { pinned: [], listed: [] } : listedStageableNames(staging)

  return [
    intro,
    [
      'Globals:',
      ...globalLines(input.store === true),
      ...(staging === undefined ? [] : [stageLine(staging.reviewToolName)])
    ].join('\n'),
    sections.length === 0
      ? 'Nested tools: none are listed here.'
      : ['## Nested tools by namespace', ...sections].join('\n\n'),
    ...(hasStageableNames(stageableNames) ? [stageableSection(stageableNames)] : []),
    unlistedToolsLine
  ].join('\n\n')
}

/**
 * `describeTool` text: the description and TypeScript declaration of one tool. A stage-only tool
 * has no `tools` binding, so it is described as the `stage()` call that records it.
 */
export const describeCodeModeTool = (tool: CodeModeCatalogTool): string =>
  tool.exposure === 'stage'
    ? [
        tool.description,
        `Stage-only (approval-gated): record a call with \`await stage(${JSON.stringify(tool.name)}, args)\`; it runs only after a person approves the plan.`,
        `args: ${schemaToType(tool.inputSchema)}`
      ].join('\n\n')
    : renderToolSample(declarationTool(tool))

/**
 * Finds a tool by identifier or raw name. A stageable tool's exact raw name wins first: it has no
 * binding, so a callable tool sharing its identifier (`archive-resource` vs `archive_resource`)
 * must not answer for it; callable lookups keep identifier precedence, as their bindings do.
 */
export const findCodeModeTool = (
  catalog: ReadonlyArray<CodeModeCatalogTool>,
  name: string
): CodeModeCatalogTool | undefined =>
  catalog.find(tool => tool.exposure === 'stage' && tool.name === name) ??
  catalog.find(tool => tool.identifier === name) ??
  catalog.find(tool => tool.name === name)

/** The instruction key of the code mode catalog (`catalog: 'instructions'`, ADR 0007). */
export const codeModeCatalogInstructionKey = 'yolk.codemode.catalog'

const CodeModeCatalogNamespace = Schema.Struct({
  name: Schema.String,
  description: Schema.optional(Schema.String),
  /** Every tool scripts reach in the namespace: callable and stage-only. */
  count: Schema.Number,
  /** Tools the listing shows. */
  shown: Schema.Number,
  /** The rendered declarations and direct tool lines of the shown tools. */
  listing: Schema.String
})

/** The catalog an instruction message records as its state (JSON, never model-visible). */
export const CodeModeCatalogSummary = Schema.Struct({
  namespaces: Schema.Array(CodeModeCatalogNamespace),
  /** Stageable tool names the catalog lists: `pinned` ones, then the others (never `search` or
   * deferred ones). */
  stageable: Schema.Struct({
    pinned: Schema.Array(Schema.String),
    listed: Schema.Array(Schema.String)
  })
})

export type CodeModeCatalogSummary = typeof CodeModeCatalogSummary.Type

const decodeCatalogSummary = Schema.decodeUnknownOption(CodeModeCatalogSummary)

const encodeCatalogSummary = Schema.encodeOption(CodeModeCatalogSummary)

const namespaceListing = (tools: ReadonlyArray<CodeModeCatalogTool>) => {
  const declared = tools.filter(tool => tool.exposure !== 'all')
  const direct = tools.filter(tool => tool.exposure === 'all')

  return [
    ...(declared.length > 0 ? ['```ts', declarationMembers(declared), '```'] : []),
    ...direct.map(directToolLine)
  ].join('\n')
}

/**
 * The catalog of one resolution: every namespace with its tool count and description, and the
 * listing of the tools the inline budget (or `pinned`) places. `search` and stage-only tools are
 * counted, never listed.
 */
export const summarizeCodeModeCatalog = (input: {
  readonly tools: ReadonlyArray<NestedTool>
  readonly staging?: CodeModeStagingDescription
  readonly inlineBudget?: number
}): CodeModeCatalogSummary => {
  const catalog = codeModeCatalog(input.tools)
  const stageOnly = input.staging === undefined ? [] : codeModeStageOnlyCatalog(input.staging.tools)
  const listing = selectCodeModeListing(catalog, input.inlineBudget ?? defaultCodeModeInlineBudget)
  const listedByNamespace = groupByNamespace(listing.listed.map(tool => ({ tool })))

  const namespaces = [...groupByNamespace([...catalog, ...stageOnly].map(tool => ({ tool })))].map(
    ([name, items]) => {
      const shown = (listedByNamespace.get(name) ?? []).map(item => item.tool)

      const description = items.find(item => item.tool.namespaceDescription !== undefined)?.tool
        .namespaceDescription

      const namespace = {
        name,
        count: items.length,
        shown: shown.length,
        listing: namespaceListing(shown)
      }

      return description === undefined ? namespace : { ...namespace, description }
    }
  )

  return {
    namespaces,
    stageable:
      input.staging === undefined ? { pinned: [], listed: [] } : listedStageableNames(input.staging)
  }
}

const namespaceLine = (namespace: CodeModeCatalogSummary['namespaces'][number]) => {
  const count = namespace.count === 1 ? '1 tool' : `${namespace.count} tools`

  const label =
    namespace.shown === namespace.count
      ? count
      : namespace.shown === 0
        ? `${count}, none listed`
        : `${count}, ${namespace.shown} listed`

  return `- \`${namespace.name}\` (${label})${namespace.description === undefined ? '' : `: ${namespace.description}`}`
}

/** The full catalog text of an instruction message. */
export const renderCodeModeCatalog = (summary: CodeModeCatalogSummary): string =>
  [
    '# Code mode catalog',
    'Tools `codemode` scripts can call, by namespace; the latest catalog in the conversation replaces any earlier one. Call a listed tool as `await tools.<id>(args)`; find the others with `await searchTools(query, { namespace })` and read one with `await describeTool(name)` before calling it.',
    ['## Namespaces', ...summary.namespaces.map(namespaceLine)].join('\n'),
    ...summary.namespaces.flatMap(namespace =>
      namespace.listing.length === 0 ? [] : [`### ${namespace.name}\n${namespace.listing}`]
    ),
    ...(hasStageableNames(summary.stageable) ? [stageableSection(summary.stageable)] : [])
  ].join('\n\n')

/**
 * The host instruction of the code mode catalog: its state is the encoded summary, and its render
 * the full catalog (every change renders it whole, see `RunInstruction.render`) or a removal notice.
 */
export const codeModeCatalogInstruction = (input: {
  readonly tools: ReadonlyArray<NestedTool>
  readonly staging?: CodeModeStagingDescription
  readonly inlineBudget?: number
}): RunInstruction => {
  const summary = summarizeCodeModeCatalog(input)

  return {
    key: codeModeCatalogInstructionKey,
    state:
      summary.namespaces.length === 0
        ? undefined
        : Option.getOrUndefined(encodeCatalogSummary(summary)),
    render: current => {
      const decoded = current === undefined ? Option.none() : decodeCatalogSummary(current)

      return Option.isNone(decoded)
        ? 'Code mode tools are no longer available: do not call previously listed code mode tools.'
        : renderCodeModeCatalog(decoded.value)
    }
  }
}

/**
 * The code mode description when the catalog is delivered as an instruction: invariant across
 * catalog changes (only staging availability adds the `stage()` line).
 */
export const renderCodeModeInstructedDescription = (input: {
  readonly store?: boolean
  readonly staging?: CodeModeStagingDescription
}): string =>
  [
    intro,
    [
      'Globals:',
      ...globalLines(input.store === true),
      ...(input.staging === undefined ? [] : [stageLine(input.staging.reviewToolName)])
    ].join('\n'),
    'The tools scripts can call are in the "Code mode catalog" (namespaces, tool counts and listed tools; the latest one applies). Find the others with `await searchTools(query, { namespace? })` and read one with `await describeTool(name)` before calling it.'
  ].join('\n\n')
