import { Effect, Logger, Predicate } from 'effect'
import * as Schema from 'effect/Schema'
import { describe, expect, it } from '@effect/vitest'
import { ToolError } from '@yolk-sdk/agent/loop'
import {
  BackgroundToolAccepted,
  InputDescriptor,
  providerToolDefs,
  ToolApprovalPolicy,
  ToolCall,
  ToolDef,
  ToolResult
} from '@yolk-sdk/agent/protocol'
import {
  EmptyToolParams,
  makeInputTool,
  makeQuestionToolRegistration,
  makeTool,
  resolveTools,
  type NestedToolExecutor,
  type ToolModule,
  type ToolRegistration
} from '../../src/tools'

type TestContext = {
  readonly tenant: string
  readonly enabled: boolean
}

const context: TestContext = { tenant: 'tenant_1', enabled: true }

const LookupParams = Schema.Struct({ query: Schema.String })

class LookupOutput extends Schema.Class<LookupOutput>('LookupOutput')({
  hits: Schema.Array(Schema.Struct({ id: Schema.String, score: Schema.Number }))
}) {}

const echoTool = (
  name: string,
  options: {
    readonly callableBy?: 'all' | 'model'
    readonly approval?: ToolApprovalPolicy
    readonly isEnabled?: (context: TestContext) => Effect.Effect<boolean>
    readonly seen?: Array<string>
  } = {}
) =>
  makeTool<TestContext, typeof LookupParams>({
    name,
    description: `${name} tool`,
    parameters: LookupParams,
    access: 'read',
    callableBy: options.callableBy,
    approval: options.approval,
    isEnabled: options.isEnabled,
    execute: ({ call, context, params, nested }) => {
      options.seen?.push(`${name}:${params.query}:${context.tenant}:${nested === undefined}`)

      return Effect.succeed(
        ToolResult.make({
          toolCallId: call.id,
          content: `${name}:${params.query}`,
          structuredContent: { query: params.query }
        })
      )
    }
  })

const scriptOnlyTool = (name: string, discovery?: 'listed' | 'search', seen?: Array<string>) =>
  makeTool<TestContext, typeof LookupParams>({
    name,
    description: `${name} tool`,
    parameters: LookupParams,
    output: LookupOutput,
    access: 'read',
    callableBy: 'codemode',
    discovery,
    execute: ({ call, params, context }) => {
      seen?.push(`${name}:${params.query}:${context.tenant}`)

      return Effect.succeed(
        ToolResult.make({
          toolCallId: call.id,
          content: `${name}:${params.query}`,
          structuredContent: { hits: [{ id: params.query, score: 1 }] }
        })
      )
    }
  })

type Captured = { nested?: NestedToolExecutor }

const scriptHost = (captured: Captured) =>
  makeTool<TestContext, typeof EmptyToolParams>({
    name: 'script_host',
    description: 'Runs nested calls',
    parameters: EmptyToolParams,
    access: 'write',
    nestedToolAccess: true,
    execute: ({ call, nested }) => {
      captured.nested = nested

      return Effect.succeed(ToolResult.make({ toolCallId: call.id, content: 'done' }))
    }
  })

const moduleOf = (
  id: string,
  tools: ReadonlyArray<ToolRegistration<TestContext>>
): ToolModule<TestContext> => ({ id, tools })

const nestedFrom = (
  modules: ReadonlyArray<ToolModule<TestContext>>,
  captured: Captured,
  resolveContext: TestContext = context
) =>
  Effect.gen(function* () {
    const toolSet = yield* resolveTools(modules, resolveContext)

    yield* toolSet.execute(ToolCall.make({ id: 'call_host', name: 'script_host', params: {} }))

    const nested = captured.nested

    if (nested === undefined) {
      return yield* Effect.die(new Error('Expected a nested executor'))
    }

    return { toolSet, nested }
  })

const call = (name: string, params: unknown, seq = 1) =>
  ToolCall.make({ id: `call_host/${seq}`, name, params })

const structured = (result: ToolResult) =>
  Schema.decodeUnknownOption(
    Schema.Struct({ type: Schema.String, reason: Schema.String, tool: Schema.String })
  )(result.structuredContent)

describe('makeTool output schemas and exposure', () => {
  it('lowers output schemas like parameters and keeps exposure on the definition', () => {
    const tool = scriptOnlyTool('lookup', 'search')

    expect(tool.def.outputSchema).toMatchObject({
      type: 'object',
      properties: { hits: { type: 'array' } },
      required: ['hits']
    })
    expect(tool.def.callableBy).toBe('codemode')
    expect(tool.def.discovery).toBe('search')

    const plain = echoTool('plain')

    expect(Object.hasOwn(plain.def, 'outputSchema')).toBe(false)
    expect(Object.hasOwn(plain.def, 'callableBy')).toBe(false)
    expect(Object.hasOwn(plain.def, 'discovery')).toBe(false)
    expect(Object.hasOwn(plain, 'nestedToolAccess')).toBe(false)
  })

  it.effect('round-trips exposure and output schema through ToolDef encoding', () =>
    Effect.gen(function* () {
      const def = scriptOnlyTool('lookup', 'listed').def
      const encoded = yield* Schema.encodeEffect(ToolDef)(def)

      const decoded = yield* Schema.decodeUnknownEffect(ToolDef)(
        JSON.parse(JSON.stringify(encoded))
      )

      expect(decoded.callableBy).toBe('codemode')
      expect(decoded.discovery).toBe('listed')
      expect(decoded.outputSchema).toEqual(def.outputSchema)
    })
  )
})

describe('resolveTools exposure rules', () => {
  const resolutionError = (tools: ReadonlyArray<ToolRegistration<TestContext>>) =>
    resolveTools([moduleOf('test', tools)], context).pipe(
      Effect.flip,
      Effect.map(error => error.cause)
    )

  const rawDef = (fields: {
    readonly name: string
    readonly callableBy?: ToolDef['callableBy']
    readonly discovery?: ToolDef['discovery']
    readonly approval?: ToolApprovalPolicy
    readonly input?: InputDescriptor
  }) => ToolDef.make({ description: 'raw', parameters: { type: 'object' }, ...fields })

  const raw = (def: ToolDef): ToolRegistration<TestContext> => ({
    def,
    access: 'read',
    execute: ({ call }) => Effect.succeed(ToolResult.make({ toolCallId: call.id, content: 'raw' }))
  })

  it.effect('rejects codemode-only exposure on every fail-closed tool', () =>
    Effect.gen(function* () {
      const policy = ToolApprovalPolicy.make({ mode: 'manual' })

      const failClosed: ReadonlyArray<ToolRegistration<TestContext>> = [
        raw(rawDef({ name: 'approved', callableBy: 'codemode', approval: policy })),
        {
          ...raw(rawDef({ name: 'registration_approved', callableBy: 'codemode' })),
          approval: policy
        },
        raw(
          rawDef({
            name: 'typed_input',
            callableBy: 'codemode',
            input: InputDescriptor.make({ kind: 'text' })
          })
        ),
        raw(rawDef({ name: 'question', callableBy: 'codemode' })),
        raw(rawDef({ name: 'subagent', callableBy: 'codemode' })),
        { ...raw(rawDef({ name: 'nested_host', callableBy: 'codemode' })), nestedToolAccess: true }
      ]

      for (const tool of failClosed) {
        expect(yield* resolutionError([tool])).toBe('codemode_unsupported_tool')
      }

      expect(
        yield* resolutionError([raw(rawDef({ name: 'listed_only', discovery: 'search' }))])
      ).toBe('invalid_tool_exposure')

      expect(
        yield* resolutionError([
          raw(rawDef({ name: 'model_listed', callableBy: 'model', discovery: 'listed' }))
        ])
      ).toBe('invalid_tool_exposure')
    })
  )

  it.effect('rejects codemode-only exposure on activated background tools only', () =>
    Effect.gen(function* () {
      const background = makeTool<TestContext, typeof LookupParams>({
        name: 'slow',
        description: 'slow',
        parameters: LookupParams,
        access: 'read',
        background: true,
        callableBy: 'codemode',
        execute: ({ call }) => Effect.succeed(ToolResult.make({ toolCallId: call.id, content: '' }))
      })

      // Inert without a host: an ordinary codemode-only tool.
      const inert = yield* resolveTools([moduleOf('test', [background])], context)

      expect(inert.tools.map(tool => tool.name)).toEqual(['slow'])

      const activated = yield* resolveTools([moduleOf('test', [background])], context, {
        backgroundHost: {
          accept: () =>
            Effect.succeed(BackgroundToolAccepted.make({ version: 1, executionId: 'x' }))
        }
      }).pipe(Effect.flip)

      expect(activated.cause).toBe('codemode_unsupported_tool')
    })
  )

  it.effect(
    'keeps codemode-only definitions resolved but off provider lists and direct dispatch',
    () =>
      Effect.gen(function* () {
        const seen: Array<string> = []

        const toolSet = yield* resolveTools(
          [moduleOf('test', [echoTool('visible'), scriptOnlyTool('hidden', 'search', seen)])],
          context
        )

        expect(toolSet.tools.map(tool => tool.name)).toEqual(['visible', 'hidden'])
        expect(providerToolDefs(toolSet.tools).map(tool => tool.name)).toEqual(['visible'])

        const failure = yield* toolSet
          .execute(ToolCall.make({ id: 'call_1', name: 'hidden', params: { query: 'q' } }))
          .pipe(Effect.flip)

        expect(Predicate.isTagged(failure, 'ToolError')).toBe(true)
        expect(failure.cause).toBe('not_found')
        expect(failure.message).toBe('Tool is not configured: hidden')
        expect(seen).toEqual([])
      })
  )

  it.effect('warns when codemode-only tools have no nested tool access registration', () =>
    Effect.gen(function* () {
      const messages: Array<unknown> = []
      const logger = Logger.make(options => messages.push(options.message))

      yield* resolveTools([moduleOf('test', [scriptOnlyTool('hidden')])], context).pipe(
        Effect.provide(Logger.layer([logger]))
      )

      expect(JSON.stringify(messages)).toContain(
        'Code-mode-only tools are unreachable without a nested tool access registration: hidden'
      )

      messages.length = 0

      yield* resolveTools(
        [moduleOf('test', [scriptOnlyTool('hidden'), scriptHost({})])],
        context
      ).pipe(Effect.provide(Logger.layer([logger])))

      expect(messages).toEqual([])
    })
  )
})

describe('nested tool executor', () => {
  it.effect('lists only code-mode-callable tools with their module ids', () =>
    Effect.gen(function* () {
      const captured: Captured = {}

      const { nested } = yield* nestedFrom(
        [
          moduleOf('core', [
            echoTool('shared'),
            echoTool('direct_only', { callableBy: 'model' }),
            echoTool('needs_approval', {
              callableBy: 'all',
              approval: ToolApprovalPolicy.make({ mode: 'manual' })
            }),
            makeQuestionToolRegistration<TestContext>({
              execute: ({ call }) =>
                Effect.succeed(ToolResult.make({ toolCallId: call.id, content: '' }))
            }),
            makeInputTool<TestContext, typeof Schema.String>({
              name: 'ask_word',
              description: 'Ask for a word',
              renderer: 'text',
              response: Schema.String
            }),
            scriptHost(captured)
          ]),
          moduleOf('docs', [scriptOnlyTool('docs_search', 'search')]),
          moduleOf('gated', [echoTool('disabled', { isEnabled: () => Effect.succeed(false) })])
        ],
        captured
      )

      expect(nested.tools.map(tool => [tool.moduleId, tool.def.name])).toEqual([
        ['core', 'shared'],
        ['docs', 'docs_search']
      ])
      expect(nested.tools[1]?.def.outputSchema).toBeDefined()
    })
  )

  it.effect('carries module descriptions on nested tools', () =>
    Effect.gen(function* () {
      const captured: Captured = {}

      const { nested } = yield* nestedFrom(
        [
          moduleOf('core', [scriptHost(captured), echoTool('shared')]),
          {
            id: 'docs',
            description: 'Product documentation',
            tools: [scriptOnlyTool('docs_search', 'search')]
          }
        ],
        captured
      )

      expect(
        nested.tools.map(tool => [tool.moduleId, tool.def.name, tool.moduleDescription])
      ).toEqual([
        ['core', 'shared', undefined],
        ['docs', 'docs_search', 'Product documentation']
      ])
      expect('moduleDescription' in (nested.tools[0] ?? {})).toBe(false)
    })
  )

  it.effect('executes through the resolved path with the same host context', () =>
    Effect.gen(function* () {
      const captured: Captured = {}
      const seen: Array<string> = []

      const { nested } = yield* nestedFrom(
        [
          moduleOf('test', [
            echoTool('shared', { seen }),
            scriptOnlyTool('hidden', 'listed', seen),
            scriptHost(captured)
          ])
        ],
        captured
      )

      const shared = yield* nested.execute(call('shared', { query: 'a' }, 1))
      const hidden = yield* nested.execute(call('hidden', { query: 'b' }, 2))

      expect(shared).toMatchObject({ toolCallId: 'call_host/1', content: 'shared:a' })
      expect(shared.isError).toBeUndefined()
      expect(hidden).toMatchObject({
        toolCallId: 'call_host/2',
        structuredContent: { hits: [{ id: 'b', score: 1 }] }
      })
      // Nested tools never receive their own nested executor (no recursion).
      expect(seen).toEqual(['shared:a:tenant_1:true', 'hidden:b:tenant_1'])
    })
  )

  it.effect('returns model-visible validation errors without executing', () =>
    Effect.gen(function* () {
      const captured: Captured = {}
      const seen: Array<string> = []

      const { nested } = yield* nestedFrom(
        [moduleOf('test', [echoTool('shared', { seen }), scriptHost(captured)])],
        captured
      )

      const result = yield* nested.execute(call('shared', { query: 42 }))

      expect(result.isError).toBe(true)
      expect(structured(result)).toMatchObject({
        _tag: 'Some',
        value: { type: 'model_visible_tool_error', reason: 'validation', tool: 'shared' }
      })
      expect(seen).toEqual([])
    })
  )

  it.effect('fails closed for unknown, disabled, model-only, fail-closed, and self calls', () =>
    Effect.gen(function* () {
      const captured: Captured = {}
      const seen: Array<string> = []

      const { nested } = yield* nestedFrom(
        [
          moduleOf('test', [
            echoTool('direct_only', { callableBy: 'model', seen }),
            echoTool('needs_approval', {
              approval: ToolApprovalPolicy.make({ mode: 'manual' }),
              seen
            }),
            echoTool('disabled', { isEnabled: () => Effect.succeed(false), seen }),
            scriptHost(captured)
          ])
        ],
        captured
      )

      const cases = [
        ['missing', 'not_found'],
        ['disabled', 'not_found'],
        ['direct_only', 'unavailable'],
        ['needs_approval', 'unavailable'],
        ['script_host', 'unavailable']
      ] as const

      for (const [name, reason] of cases) {
        const result = yield* nested.execute(call(name, { query: 'x' }))

        expect(result.isError).toBe(true)
        expect(result.toolCallId).toBe('call_host/1')
        expect(structured(result)).toMatchObject({
          _tag: 'Some',
          value: { type: 'model_visible_tool_error', reason, tool: name }
        })
      }

      expect(seen).toEqual([])
    })
  )

  it.effect('converts tool failures to error results and runs registration wrappers', () =>
    Effect.gen(function* () {
      const captured: Captured = {}
      const wrapped: Array<string> = []

      const failing: ToolRegistration<TestContext> = {
        def: ToolDef.make({
          name: 'failing',
          description: 'fails',
          parameters: { type: 'object' }
        }),
        access: 'read',
        execute: ({ call }) =>
          Effect.fail(
            new ToolError({ tool: call.name, cause: 'execution', message: 'upstream down' })
          )
      }

      const base = echoTool('guarded')

      // Host wrapper on the registration (for example an external action claim).
      const guarded: ToolRegistration<TestContext> = {
        ...base,
        execute: input => {
          wrapped.push(input.call.id)

          return input.context.tenant === 'tenant_1'
            ? base.execute(input)
            : Effect.fail(new ToolError({ tool: 'guarded', cause: 'denied', message: 'denied' }))
        }
      }

      const { nested } = yield* nestedFrom(
        [moduleOf('test', [failing, guarded, scriptHost(captured)])],
        captured
      )

      const failed = yield* nested.execute(call('failing', {}, 1))

      expect(failed).toMatchObject({
        toolCallId: 'call_host/1',
        content: 'upstream down',
        isError: true
      })

      const ok = yield* nested.execute(call('guarded', { query: 'z' }, 2))

      expect(ok.content).toBe('guarded:z')
      expect(wrapped).toEqual(['call_host/2'])
    })
  )

  it.effect('passes nested only to registrations that opt in, including raw ones', () =>
    Effect.gen(function* () {
      const received: Array<boolean> = []

      const rawHost: ToolRegistration<TestContext> = {
        def: ToolDef.make({ name: 'raw_host', description: 'raw', parameters: { type: 'object' } }),
        access: 'read',
        nestedToolAccess: true,
        execute: ({ call, nested }) => {
          received.push(nested !== undefined)

          return nested === undefined
            ? Effect.succeed(ToolResult.make({ toolCallId: call.id, content: 'none' }))
            : nested.execute(
                ToolCall.make({ id: `${call.id}/1`, name: 'shared', params: { query: 'r' } })
              )
        }
      }

      const toolSet = yield* resolveTools(
        [moduleOf('test', [echoTool('shared'), rawHost])],
        context
      )

      const result = yield* toolSet.execute(
        ToolCall.make({ id: 'call_raw', name: 'raw_host', params: {} })
      )

      expect(received).toEqual([true])
      expect(result).toMatchObject({ toolCallId: 'call_raw/1', content: 'shared:r' })
    })
  )
})

describe('nested tool description hook', () => {
  const describedHost = (seen: Array<ReadonlyArray<string>>) =>
    makeTool<TestContext, typeof EmptyToolParams>({
      name: 'script_host',
      description: 'Static fallback',
      parameters: EmptyToolParams,
      access: 'write',
      nestedToolAccess: true,
      describe: ({ tools }) => {
        const names = tools.map(tool => `${tool.moduleId}.${tool.def.name}`)

        seen.push(names)

        return `Callable: ${names.join(', ')}`
      },
      execute: ({ call }) => Effect.succeed(ToolResult.make({ toolCallId: call.id, content: 'ok' }))
    })

  it.effect('computes the resolved description from the nested tools of the resolution', () =>
    Effect.gen(function* () {
      const seen: Array<ReadonlyArray<string>> = []
      const host = describedHost(seen)

      const toolSet = yield* resolveTools(
        [
          moduleOf('host', [host]),
          moduleOf('docs', [
            echoTool('search_docs'),
            echoTool('model_only', { callableBy: 'model' }),
            scriptOnlyTool('lookup', 'search')
          ])
        ],
        context
      )

      const def = toolSet.tools.find(tool => tool.name === 'script_host')

      expect(def?.description).toBe('Callable: docs.search_docs, docs.lookup')
      expect(def?.parameters).toEqual(host.def.parameters)
      expect(def).toBeInstanceOf(ToolDef)
      expect(seen).toEqual([['docs.search_docs', 'docs.lookup']])
      // The registration keeps its static description outside resolution.
      expect(host.def.description).toBe('Static fallback')
      expect(toolSet.tools.find(tool => tool.name === 'search_docs')?.description).toBe(
        'search_docs tool'
      )
    })
  )

  it.effect('ignores describe on registrations without nested tool access', () =>
    Effect.gen(function* () {
      const plain: ToolRegistration<TestContext> = {
        ...echoTool('plain'),
        describe: () => 'should not apply'
      }

      const toolSet = yield* resolveTools([moduleOf('test', [plain])], context)

      expect(toolSet.tools[0]?.description).toBe('plain tool')
    })
  )
})
