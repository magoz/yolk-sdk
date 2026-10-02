import { describe, expect, it } from '@effect/vitest'
import {
  InputDescriptor,
  InteractionActionDescriptor,
  InteractionDescriptor,
  isCodeModeCallable,
  isCodeModeFailClosed,
  isProviderToolDef,
  providerToolDefs,
  ToolApprovalPolicy,
  ToolDef,
  toolDiscovery
} from '@yolk-sdk/agent/protocol'

const def = (
  name: string,
  fields: {
    readonly callableBy?: ToolDef['callableBy']
    readonly discovery?: ToolDef['discovery']
    readonly approval?: ToolApprovalPolicy
    readonly input?: InputDescriptor
    readonly interaction?: InteractionDescriptor
    readonly execution?: 'background-v1'
  } = {}
) => ToolDef.make({ name, description: name, parameters: { type: 'object' }, ...fields })

const failClosedDefs = [
  def('approved', { approval: ToolApprovalPolicy.make({ mode: 'manual' }) }),
  def('typed_input', { input: InputDescriptor.make({ kind: 'text' }) }),
  def('picker', {
    interaction: InteractionDescriptor.make({
      kind: 'picker',
      actions: [InteractionActionDescriptor.make({ id: 'save', label: 'Save' })]
    })
  }),
  def('slow', { execution: 'background-v1' }),
  def('question'),
  def('subagent')
]

describe('tool exposure helpers', () => {
  it('defaults to callable by the model and code mode', () => {
    const plain = def('plain')

    expect(isCodeModeCallable(plain)).toBe(true)
    expect(isProviderToolDef(plain)).toBe(true)
    expect(toolDiscovery(plain)).toBeUndefined()
  })

  it('separates model-only and codemode-only tools', () => {
    expect(isCodeModeCallable(def('direct', { callableBy: 'model' }))).toBe(false)
    expect(isProviderToolDef(def('direct', { callableBy: 'model' }))).toBe(true)

    const scriptOnly = def('script', { callableBy: 'codemode' })

    expect(isCodeModeCallable(scriptOnly)).toBe(true)
    expect(isProviderToolDef(scriptOnly)).toBe(false)
    expect(toolDiscovery(scriptOnly)).toBe('listed')
    expect(toolDiscovery(def('hidden', { callableBy: 'codemode', discovery: 'search' }))).toBe(
      'search'
    )
  })

  it('never lets fail-closed tools run from code mode under any callableBy', () => {
    for (const base of failClosedDefs) {
      expect(isCodeModeFailClosed(base)).toBe(true)

      for (const callableBy of [undefined, 'all', 'model', 'codemode'] as const) {
        const exposed = ToolDef.make({ ...base, callableBy })

        expect(isCodeModeCallable(exposed)).toBe(false)
      }
    }
  })

  it('removes only codemode-only definitions from provider lists', () => {
    const tools = [
      def('a'),
      def('b', { callableBy: 'model' }),
      def('c', { callableBy: 'codemode' }),
      def('d', { callableBy: 'all' })
    ]

    expect(providerToolDefs(tools).map(tool => tool.name)).toEqual(['a', 'b', 'd'])

    const unchanged = [def('a')]

    expect(providerToolDefs(unchanged)).toBe(unchanged)
  })
})
