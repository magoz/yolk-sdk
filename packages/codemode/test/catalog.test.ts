import { Effect } from 'effect'
import { describe, expect, it } from '@effect/vitest'
import { compactWindowMessages } from '@yolk-sdk/agent/compaction'
import { instructionMessages } from '@yolk-sdk/agent/loop'
import {
  isInstructionMessage,
  ToolApprovalPolicy,
  ToolDef,
  UserMessage
} from '@yolk-sdk/agent/protocol'
import { resolveTools, type NestedTool } from '@yolk-sdk/agent/tools'
import {
  codeModeCatalog,
  codeModeCatalogInstructionKey,
  makeCodeModeTool,
  renderCodeModeDescription,
  searchCodeModeTools,
  selectCodeModeListing,
  type CodeModeExecutor
} from '../src/index.ts'
import { context, moduleOf, queryTool, type TestContext } from './fixtures.ts'

const unusedExecutor: CodeModeExecutor = {
  execute: () => Promise.reject(new Error('not used'))
}

const nestedTool = (
  moduleId: string,
  name: string,
  options: {
    readonly exposure?: 'all' | 'listed' | 'search' | 'pinned'
    readonly description?: string
    readonly outputSchema?: ToolDef['outputSchema']
    readonly moduleDescription?: string
  } = {}
): NestedTool => {
  const exposure = options.exposure ?? 'listed'

  const def = ToolDef.make({
    name,
    description: options.description ?? `${name} tool`,
    parameters: {
      type: 'object',
      properties: { query: { type: 'string' } },
      required: ['query']
    },
    outputSchema: options.outputSchema,
    callableBy: exposure === 'all' ? undefined : 'codemode',
    discovery: exposure === 'all' ? undefined : exposure
  })

  return options.moduleDescription === undefined
    ? { moduleId, def }
    : { moduleId, def, moduleDescription: options.moduleDescription }
}

const listedNames = (tools: ReadonlyArray<NestedTool>, budget: number) =>
  selectCodeModeListing(codeModeCatalog(tools), budget).listed.map(
    tool => `${tool.namespace}.${tool.name}`
  )

describe('code mode catalog', () => {
  it('maps exposure, identifiers, and output schemas', () => {
    const catalog = codeModeCatalog([
      nestedTool('crm', 'crm-find', { exposure: 'search' }),
      nestedTool('crm', 'crm_list', { outputSchema: { type: 'object' } }),
      nestedTool('docs', 'docs_search', { exposure: 'all' })
    ])

    expect(catalog.map(tool => [tool.identifier, tool.exposure, tool.structured])).toEqual([
      ['crm_find', 'search', false],
      ['crm_list', 'listed', true],
      ['docs_search', 'all', false]
    ])
    expect(catalog[0]?.outputSchema).toEqual({ type: 'string' })
  })

  it('labels each tool the way scripts reach it: first identifier wins, then the raw name', () => {
    const catalog = codeModeCatalog([
      nestedTool('a', '123'),
      nestedTool('a', 'a-b'),
      nestedTool('a', 'a.b'),
      nestedTool('a', 'plain')
    ])

    expect(catalog.map(tool => tool.callLabel)).toEqual([
      'tools._23',
      'tools.a_b',
      'tools["a.b"]',
      'tools.plain'
    ])
  })

  it('lists listed tools with declarations, direct tools with one line, and never search tools', () => {
    const description = renderCodeModeDescription({
      tools: [
        nestedTool('crm', 'crm_list', {
          description: 'List deals',
          outputSchema: { type: 'array', items: { type: 'string' } }
        }),
        nestedTool('crm', 'crm_secret', { exposure: 'search', description: 'Hidden tool' }),
        nestedTool('docs', 'docs_search', { exposure: 'all' }),
        nestedTool('mail', 'mail_send', { exposure: 'search' })
      ]
    })

    expect(description).toContain('Call tools as `await tools.<id>(args)`')
    expect(description).toContain('Calls still running when the script ends are cancelled')
    expect(description).toContain(
      '/** List deals */\n  crm_list(args: { query: string; }): Promise<Array<string>>;'
    )
    expect(description).toContain(
      '- `tools.docs_search(args)` takes the arguments of the `docs_search` tool and resolves to `string`.'
    )
    expect(description).not.toContain('crm_secret')
    expect(description).not.toContain('Hidden tool')
    expect(description).not.toContain('mail_send')
    // No per-namespace hints: a namespace of only search tools gets no heading.
    expect(description).not.toContain('### mail')
    expect(description).not.toContain('More tools: `await searchTools(query, { namespace')
    expect(description).toContain(
      'More tools may be callable than are listed here: find them with `await searchTools(query, { namespace? })`'
    )
    expect(description).not.toContain('store(key, value)')
  })

  it('fills the budget fairly, one cheapest tool per namespace per round', () => {
    const small = (moduleId: string, index: number) => nestedTool(moduleId, `${moduleId}_${index}`)

    const tools = [
      small('a', 1),
      small('a', 2),
      small('a', 3),
      small('b', 1),
      small('b', 2),
      small('b', 3)
    ]

    const each = toolCost(small('a', 1))

    // Four tools fit: two per namespace, never three from one.
    expect(listedNames(tools, each * 4)).toEqual(['a.a_1', 'a.a_2', 'b.b_1', 'b.b_2'])
    expect(listedNames(tools, each * 4 - 1)).toEqual(['a.a_1', 'a.a_2', 'b.b_1'])
    expect(listedNames(tools, 0)).toEqual([])
  })

  it('drops a namespace whose next tool does not fit while others keep placing', () => {
    const huge = nestedTool('a', 'a_huge', { description: 'x'.repeat(4_000) })

    const tools = [
      nestedTool('a', 'a_1'),
      huge,
      nestedTool('a', 'a_2'),
      nestedTool('b', 'b_1'),
      nestedTool('b', 'b_2'),
      nestedTool('b', 'b_3')
    ]

    const each = toolCost(nestedTool('a', 'a_1'))

    // a places a_1 then a_2 (cheapest first), then its next (a_huge) does not fit and a drops out.
    expect(listedNames(tools, each * 5)).toEqual(['a.a_1', 'a.a_2', 'b.b_1', 'b.b_2', 'b.b_3'])

    const listing = selectCodeModeListing(codeModeCatalog(tools), each * 5)

    expect(listing.unlistedNamespaces).toEqual(['a'])
  })

  it('lists direct tools outside the budget; the budget applies only to listed tools', () => {
    const tools = [
      nestedTool('a', 'a_direct', { exposure: 'all' }),
      nestedTool('a', 'a_listed'),
      nestedTool('b', 'b_direct', { exposure: 'all', description: 'y'.repeat(4_000) })
    ]

    expect(listedNames(tools, 0)).toEqual(['a.a_direct', 'b.b_direct'])
    expect(listedNames(tools, toolCost(nestedTool('a', 'a_listed')))).toEqual([
      'a.a_direct',
      'a.a_listed',
      'b.b_direct'
    ])

    const description = renderCodeModeDescription({ tools, inlineBudget: 0 })

    expect(description).toContain('`tools.a_direct(args)`')
    expect(description).toContain('`tools.b_direct(args)`')
    expect(description).not.toContain('a_listed')
  })

  it('shows module descriptions under the namespace heading', () => {
    const description = renderCodeModeDescription({
      tools: [
        nestedTool('crm', 'crm_list', { moduleDescription: 'Customer relationship records.' }),
        nestedTool('vault', 'vault_find', {
          exposure: 'search',
          moduleDescription: 'Secret vault.'
        })
      ]
    })

    expect(description).toContain('### crm\nCustomer relationship records.\n```ts')
    expect(description).not.toContain('Secret vault.')
  })

  it('keeps the description stable when search tools change', () => {
    const base = [
      nestedTool('crm', 'crm_list'),
      nestedTool('crm', 'crm_find', { exposure: 'search' }),
      nestedTool('docs', 'docs_search', { exposure: 'all' })
    ]

    const changed = [
      nestedTool('crm', 'crm_list'),
      nestedTool('crm', 'crm_find', { exposure: 'search', description: 'Changed description' }),
      nestedTool('crm', 'crm_new', { exposure: 'search' }),
      nestedTool('docs', 'docs_search', { exposure: 'all' }),
      nestedTool('crm', 'crm_more', { exposure: 'search' })
    ]

    expect(renderCodeModeDescription({ tools: changed })).toBe(
      renderCodeModeDescription({ tools: base })
    )
  })

  it('keeps the description byte-identical when a namespace of only search tools comes or goes', () => {
    const base = [
      nestedTool('crm', 'crm_list'),
      nestedTool('docs', 'docs_search', { exposure: 'all' })
    ]

    const withSearchNamespace = [
      nestedTool('vault', 'vault_find', { exposure: 'search', moduleDescription: 'Vault.' }),
      ...base,
      nestedTool('vault', 'vault_read', { exposure: 'search' })
    ]

    for (const inlineBudget of [0, 3_000]) {
      expect(renderCodeModeDescription({ tools: withSearchNamespace, inlineBudget })).toBe(
        renderCodeModeDescription({ tools: base, inlineBudget })
      )
    }

    expect(
      renderCodeModeDescription({ tools: [nestedTool('vault', 'v', { exposure: 'search' })] })
    ).toBe(renderCodeModeDescription({ tools: [] }))
  })
})

const toolCost = (tool: NestedTool) => {
  // Smallest budget that lists the tool on its own.
  let budget = 0

  while (selectCodeModeListing(codeModeCatalog([tool]), budget).listed.length === 0) {
    budget++
  }

  return budget
}

describe('code mode description through resolveTools', () => {
  it.effect('renders the resolved description from the nested tools of the resolution', () =>
    Effect.gen(function* () {
      const tool = makeCodeModeTool<TestContext>({ executor: unusedExecutor, inlineBudget: 2_000 })

      const toolSet = yield* resolveTools(
        [
          moduleOf('host', [tool]),
          moduleOf('docs', [
            queryTool('search_docs'),
            queryTool('lookup', { structured: true, exposure: { callableBy: 'codemode' } }),
            queryTool('hidden', { exposure: { callableBy: 'codemode', discovery: 'search' } })
          ])
        ],
        context
      )

      const def = toolSet.tools.find(entry => entry.name === 'codemode')

      expect(tool.def.description).toContain('Nested tools: none are listed here.')
      expect(def?.description).toContain('lookup(args: { query: string; }): Promise<{ hits: Array<')
      expect(def?.description).toContain('`tools.search_docs(args)`')
      expect(def?.description).not.toContain('hidden')
      expect(def?.parameters).toMatchObject({
        type: 'object',
        properties: {
          code: {
            type: 'string',
            description: expect.stringContaining('the body of an async function')
          }
        },
        required: ['code']
      })
      expect(toolSet.metadata.find(entry => entry.name === 'codemode')?.access).toBe('write')
    })
  )
})

describe('searchTools', () => {
  const catalog = codeModeCatalog([
    nestedTool('crm', 'crm-find-contact', {
      description: 'Find a contact by email',
      exposure: 'search'
    }),
    nestedTool('crm', 'crmListDeals', { description: 'List open deals' }),
    nestedTool('mail', 'mail_send', { description: 'Send an email message', exposure: 'all' }),
    nestedTool('mail', 'mail_search', { description: 'Search mailbox messages' }),
    nestedTool('billing', 'ledger_read', {
      description: 'Read entries',
      exposure: 'search',
      moduleDescription: 'Invoices and payments'
    })
  ])

  it('ranks by BM25 over identifiers, names, descriptions, and namespaces', () => {
    expect(searchCodeModeTools(catalog, 'contact email').map(hit => hit.name)).toEqual([
      'crm_find_contact',
      'mail_send'
    ])
    expect(searchCodeModeTools(catalog, 'deals')[0]).toEqual({
      name: 'crmListDeals',
      description: 'List open deals'
    })
    // Namespace matches count: both mail tools, shorter document first.
    expect(searchCodeModeTools(catalog, 'mail').map(hit => hit.name)).toEqual([
      'mail_search',
      'mail_send'
    ])
  })

  it('filters by namespace, limits results, and lists tools for empty queries', () => {
    expect(
      searchCodeModeTools(catalog, 'email', { namespace: 'mail' }).map(hit => hit.name)
    ).toEqual(['mail_send'])
    expect(searchCodeModeTools(catalog, 'mail', { limit: 1 })).toHaveLength(1)
    expect(searchCodeModeTools(catalog, '  ', { namespace: 'crm' }).map(hit => hit.name)).toEqual([
      'crm_find_contact',
      'crmListDeals'
    ])
    expect(searchCodeModeTools(catalog, 'unrelated')).toEqual([])
  })

  it('indexes namespace descriptions', () => {
    expect(searchCodeModeTools(catalog, 'invoices').map(hit => hit.name)).toEqual(['ledger_read'])
  })
})

describe('pinned tools', () => {
  it('are always listed, outside the inline budget', () => {
    const tools = [
      nestedTool('crm', 'crm_pinned', { exposure: 'pinned' }),
      nestedTool('crm', 'crm_listed'),
      nestedTool('crm', 'crm_hidden', { exposure: 'search' })
    ]

    expect(listedNames(tools, 0)).toEqual(['crm.crm_pinned'])
  })
})

describe('catalog instructions', () => {
  const resolveInstructed = (tools: ReadonlyArray<Parameters<typeof moduleOf>[1][number]>) =>
    resolveTools(
      [
        moduleOf('host', [makeCodeModeTool({ executor: unusedExecutor, catalog: 'instructions' })]),
        moduleOf('crm', tools)
      ],
      context
    )

  const instructionOf = (toolSet: Effect.Success<ReturnType<typeof resolveInstructed>>) => {
    const instruction = toolSet.instructions.find(
      candidate => candidate.key === codeModeCatalogInstructionKey
    )

    if (instruction === undefined) throw new Error('Missing catalog instruction')

    return instruction
  }

  const descriptionOf = (toolSet: Effect.Success<ReturnType<typeof resolveInstructed>>) =>
    toolSet.tools.find(tool => tool.name === 'codemode')?.description

  it.effect('keep the description invariant and render every namespace with its count', () =>
    Effect.gen(function* () {
      const small = yield* resolveInstructed([
        queryTool('crm_list', { exposure: { callableBy: 'codemode' } })
      ])

      const large = yield* resolveInstructed([
        queryTool('crm_list', { exposure: { callableBy: 'codemode' } }),
        queryTool('crm_find', { exposure: { callableBy: 'codemode', discovery: 'search' } })
      ])

      expect(descriptionOf(large)).toBe(descriptionOf(small))
      expect(descriptionOf(large)).toContain('"Code mode catalog"')
      expect(descriptionOf(large)).not.toContain('crm_list')

      const first = instructionOf(large).render(instructionOf(large).state)

      expect(first).toContain('# Code mode catalog')
      expect(first).toContain('- `crm` (2 tools, 1 listed)')
      expect(first).toContain('crm_list')
      expect(first).not.toContain('crm_find')
    })
  )

  it.effect('render every change as the whole catalog, so the latest one stands alone', () =>
    Effect.gen(function* () {
      const before = instructionOf(
        yield* resolveInstructed([queryTool('crm_list', { exposure: { callableBy: 'codemode' } })])
      )

      const searchAdded = instructionOf(
        yield* resolveInstructed([
          queryTool('crm_list', { exposure: { callableBy: 'codemode' } }),
          queryTool('crm_find', { exposure: { callableBy: 'codemode', discovery: 'search' } })
        ])
      )

      const listedAdded = instructionOf(
        yield* resolveInstructed([
          queryTool('crm_list', { exposure: { callableBy: 'codemode' } }),
          queryTool('crm_get', { exposure: { callableBy: 'codemode' } })
        ])
      )

      const counted = searchAdded.render(searchAdded.state)
      const listed = listedAdded.render(listedAdded.state)

      expect(counted).toContain('# Code mode catalog')
      expect(counted).toContain('replaces any earlier one')
      expect(counted).toContain('- `crm` (2 tools, 1 listed)')
      expect(counted).toContain('crm_list')
      expect(listed).toContain('crm_get')
      expect(before.render(undefined)).toContain('no longer available')
    })
  )

  it.effect('survive compaction whole: the kept latest message carries the full catalog', () =>
    Effect.gen(function* () {
      const user = UserMessage.make({ content: 'hello' })

      const before = instructionOf(
        yield* resolveInstructed([queryTool('crm_list', { exposure: { callableBy: 'codemode' } })])
      )

      const after = instructionOf(
        yield* resolveInstructed([
          queryTool('crm_list', { exposure: { callableBy: 'codemode' } }),
          queryTool('crm_find', { exposure: { callableBy: 'codemode', discovery: 'search' } })
        ])
      )

      const first = instructionMessages([user], [before])
      const filler = UserMessage.make({ content: 'filler '.repeat(400) })
      const changed = instructionMessages([user, ...first, filler], [after])

      const compacted = compactWindowMessages(
        [user, ...first, filler, ...changed, filler, UserMessage.make({ content: 'latest' })],
        {
          strategy: 'test',
          thresholdTokens: 10,
          tailMessageCount: 1,
          makeSummaryMessage: () => UserMessage.make({ content: 'summary' })
        }
      ).messages

      const kept = compacted.filter(isInstructionMessage)

      expect(kept).toHaveLength(1)
      expect(kept[0]?.content).toContain('# Code mode catalog')
      expect(kept[0]?.content).toContain('- `crm` (2 tools, 1 listed)')
      expect(kept[0]?.content).toContain('crm_list')
    })
  )

  it.effect('are absent in the default description mode', () =>
    Effect.gen(function* () {
      const toolSet = yield* resolveTools(
        [
          moduleOf('host', [makeCodeModeTool({ executor: unusedExecutor })]),
          moduleOf('crm', [queryTool('crm_list', { exposure: { callableBy: 'codemode' } })])
        ],
        context
      )

      expect(toolSet.instructions).toEqual([])
      expect(toolSet.tools.find(tool => tool.name === 'codemode')?.description).toContain(
        'crm_list'
      )
    })
  )
})

describe('deferred tools', () => {
  it('are found by search, never listed: their declaration is not in model context', () => {
    const deferred: NestedTool = {
      moduleId: 'github',
      def: ToolDef.make({
        name: 'list_issues',
        description: 'List issues',
        parameters: { type: 'object' },
        loading: 'deferred'
      })
    }

    const tools = [deferred, nestedTool('github', 'get_me', { exposure: 'all' })]

    expect(codeModeCatalog(tools).map(tool => tool.exposure)).toEqual(['search', 'all'])
    expect(renderCodeModeDescription({ tools })).not.toContain('list_issues')
    expect(searchCodeModeTools(codeModeCatalog(tools), 'issues').map(hit => hit.name)).toEqual([
      'list_issues'
    ])
  })
})

describe('stageable tools in the description', () => {
  const approval = ToolApprovalPolicy.make({ mode: 'manual' })

  const stageable = (name: string, discovery?: 'listed' | 'search' | 'pinned'): NestedTool => ({
    moduleId: 'cms',
    def:
      discovery === undefined
        ? ToolDef.make({
            name,
            description: `${name} tool`,
            parameters: { type: 'object' },
            approval,
            staging: true
          })
        : ToolDef.make({
            name,
            description: `${name} tool`,
            parameters: { type: 'object' },
            approval,
            staging: true,
            callableBy: 'codemode',
            discovery
          })
  })

  it('always names pinned stage-only tools, past the cap', () => {
    const tools = [
      ...Array.from({ length: 25 }, (_, index) => stageable(`bulk_${index}`)),
      stageable('archive', 'pinned')
    ]

    const description = renderCodeModeDescription({
      tools: [],
      staging: { tools, reviewToolName: 'review_plan' }
    })

    expect(description).toContain('- `archive`')
    expect(description).toContain('… and 6 more')
  })

  it('keeps the instructed description invariant when the first stageable tool connects', () => {
    const registration = makeCodeModeTool({ executor: unusedExecutor, catalog: 'instructions' })

    const describe = (tools: ReadonlyArray<NestedTool>) =>
      registration.describe?.({ tools: [], staging: { tools, reviewToolName: 'review_plan' } })

    expect(describe([stageable('archive', 'search')])).toBe(describe([]))
    expect(describe([])).toContain('`await stage(name, args)`')
  })
})
