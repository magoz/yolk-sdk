import { Effect } from 'effect'
import { describe, expect, it } from '@effect/vitest'
import { ToolDef } from '@yolk-sdk/agent/protocol'
import { resolveTools, type NestedTool } from '@yolk-sdk/agent/tools'
import {
  codeModeCatalog,
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
    readonly exposure?: 'all' | 'listed' | 'search'
    readonly description?: string
    readonly outputSchema?: ToolDef['outputSchema']
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

  return { moduleId, def }
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
    expect(description).toContain(
      '### mail\n- More tools: `await searchTools(query, { namespace: "mail" })`.'
    )
    expect(description).toContain('- More tools: `await searchTools(query, { namespace: "crm" })`.')
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

  it('counts direct tools against the budget', () => {
    const tools = [nestedTool('a', 'a_direct', { exposure: 'all' }), nestedTool('a', 'a_listed')]

    expect(listedNames(tools, 0)).toEqual([])
    expect(listedNames(tools, toolCost(tools[0] ?? nestedTool('a', 'x')))).toEqual(['a.a_direct'])
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

      expect(tool.def.description).toContain('Nested tools: none are callable from scripts here.')
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
    nestedTool('mail', 'mail_search', { description: 'Search mailbox messages' })
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
})
