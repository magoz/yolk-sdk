import { Effect, Predicate, Result } from 'effect'
import * as Schema from 'effect/Schema'
import * as SchemaIssue from 'effect/SchemaIssue'
import { describe, expect, it } from '@effect/vitest'
import { ToolExecutor } from '@yolk-sdk/agent/loop'
import {
  decodeToolJsonSchema,
  ToolCall,
  ToolDef,
  ToolJsonSchema,
  ToolJsonSchemaObject,
  ToolResult
} from '@yolk-sdk/agent/protocol'
import {
  EmptyToolParams,
  makeTool as makeSchemaTool,
  makeToolExecutorLayer,
  modelVisibleToolError,
  modelVisibleToolErrorStructuredContent,
  resolveTools,
  type ToolModule,
  type ToolRegistration
} from '../../src/tools'

type TestContext = {
  readonly enabled: boolean
}

const makeToolDef = (name: string) =>
  ToolDef.make({
    name,
    description: `${name} tool`,
    parameters: {
      type: 'object',
      properties: {},
      additionalProperties: false
    }
  })

const makeTool = (name: string): ToolRegistration<TestContext> => ({
  def: makeToolDef(name),
  access: 'read',
  execute: ({ call }) => Effect.succeed(ToolResult.make({ toolCallId: call.id, content: name }))
})

const gatedTool: ToolRegistration<TestContext> = {
  def: makeToolDef('gated'),
  access: 'write',
  isEnabled: context => Effect.succeed(context.enabled),
  execute: ({ call }) => Effect.succeed(ToolResult.make({ toolCallId: call.id, content: 'gated' }))
}

const makeModule = (
  tools: ReadonlyArray<ToolRegistration<TestContext>>
): ToolModule<TestContext> => ({
  id: 'test',
  tools
})

describe('resolveTools', () => {
  it.effect('resolves tool definitions and metadata', () =>
    Effect.gen(function* () {
      const toolSet = yield* resolveTools([makeModule([makeTool('echo')])], { enabled: true })

      expect(toolSet.tools.map(tool => tool.name)).toEqual(['echo'])
      expect(toolSet.metadata).toEqual([{ moduleId: 'test', name: 'echo', access: 'read' }])
    })
  )

  it.effect('filters disabled tools', () =>
    Effect.gen(function* () {
      const toolSet = yield* resolveTools([makeModule([gatedTool])], { enabled: false })

      expect(toolSet.tools).toEqual([])
      expect(toolSet.metadata).toEqual([])
    })
  )

  it.effect('executes resolved tools through ToolExecutor layer', () =>
    Effect.gen(function* () {
      const toolSet = yield* resolveTools([makeModule([makeTool('echo')])], { enabled: true })

      const executor = yield* Effect.provide(
        Effect.gen(function* () {
          const service = yield* ToolExecutor

          return yield* service.execute({ id: 'call_1', name: 'echo', params: {} })
        }),
        makeToolExecutorLayer(toolSet)
      )

      expect(executor).toMatchObject({ toolCallId: 'call_1', content: 'echo' })
    })
  )

  it.effect('fails unknown tool execution as not found', () =>
    Effect.gen(function* () {
      const toolSet = yield* resolveTools([makeModule([makeTool('echo')])], { enabled: true })

      const result = yield* Effect.provide(
        Effect.gen(function* () {
          const service = yield* ToolExecutor

          return yield* service.execute({ id: 'call_1', name: 'missing', params: {} })
        }),
        makeToolExecutorLayer(toolSet)
      ).pipe(Effect.result)

      expect(Result.isFailure(result)).toBe(true)

      if (Result.isFailure(result)) {
        expect(Predicate.isTagged(result.failure, 'ToolError')).toBe(true)

        if (Predicate.isTagged(result.failure, 'ToolError')) {
          expect(result.failure.cause).toBe('not_found')
        }
      }
    })
  )

  it.effect('rejects duplicate tool names', () =>
    Effect.gen(function* () {
      const result = yield* resolveTools([makeModule([makeTool('echo'), makeTool('echo')])], {
        enabled: true
      }).pipe(Effect.result)

      expect(Result.isFailure(result)).toBe(true)

      if (Result.isFailure(result)) {
        expect(Predicate.isTagged(result.failure, 'ToolRegistryError')).toBe(true)

        if (Predicate.isTagged(result.failure, 'ToolRegistryError')) {
          expect(result.failure.cause).toBe('duplicate_tool')
        }
      }
    })
  )

  it.effect('derives tool parameters from Effect Schema and decodes before execute', () =>
    Effect.gen(function* () {
      const tool = makeSchemaTool({
        name: 'schema_echo',
        description: 'Echo schema input.',
        parameters: Schema.Struct({
          text: Schema.String.pipe(Schema.annotate({ description: 'Text to echo.' }))
        }),
        access: 'read',
        execute: ({ call, params }) =>
          Effect.succeed(ToolResult.make({ toolCallId: call.id, content: params.text }))
      })

      const toolSet = yield* resolveTools([makeModule([tool])], { enabled: true })

      const result = yield* toolSet.execute({
        id: 'call_1',
        name: 'schema_echo',
        params: { text: 'hi' }
      })

      expect(result.content).toBe('hi')
      expect(toolSet.tools[0]?.parameters).toMatchObject({
        type: 'object',
        properties: { text: { type: 'string', description: 'Text to echo.' } },
        required: ['text']
      })
    })
  )

  it.effect('derives an object root for union tool parameters without changing decoding', () =>
    Effect.gen(function* () {
      const tool = makeSchemaTool({
        name: 'union_probe',
        description: 'Probe union input.',
        parameters: Schema.Union([
          Schema.Struct({ operation: Schema.Literal('upsert'), title: Schema.String }),
          Schema.Struct({ operation: Schema.Literal('delete'), slug: Schema.String })
        ]),
        access: 'write',
        execute: ({ call, params }) =>
          Effect.succeed(ToolResult.make({ toolCallId: call.id, content: params.operation }))
      })

      // Strict OpenAI-compatible upstreams reject a typeless combinator root.
      expect(tool.def.parameters).toMatchObject({
        type: 'object',
        anyOf: [expect.anything(), expect.anything()]
      })

      const toolSet = yield* resolveTools([makeModule([tool])], { enabled: true })

      const result = yield* toolSet.execute({
        id: 'call_1',
        name: 'union_probe',
        params: { operation: 'delete', slug: 'note' }
      })

      expect(result.content).toBe('delete')
    })
  )

  it.effect('leaves non-object combinator roots untouched', () =>
    Effect.gen(function* () {
      const snapshot = (parameters: typeof ToolJsonSchema.Type) =>
        Schema.decodeUnknownEffect(Schema.Record(Schema.String, Schema.Json))(parameters)

      const numberTool = makeSchemaTool({
        name: 'number_probe',
        description: 'Probe number input.',
        parameters: Schema.Number,
        access: 'read',
        execute: ({ call, params }) =>
          Effect.succeed(ToolResult.make({ toolCallId: call.id, content: `${params}` }))
      })

      const numberSnapshot = yield* snapshot(numberTool.def.parameters)

      expect(Object.hasOwn(numberSnapshot, 'type')).toBe(false)
      expect(numberSnapshot).toMatchObject({ anyOf: expect.any(Array) })

      const unknownTool = makeSchemaTool({
        name: 'unknown_probe',
        description: 'Probe unknown input.',
        parameters: Schema.Unknown,
        access: 'read',
        execute: ({ call }) =>
          Effect.succeed(ToolResult.make({ toolCallId: call.id, content: 'ok' }))
      })

      expect(yield* snapshot(unknownTool.def.parameters)).toEqual({})

      const toolSet = yield* resolveTools([makeModule([numberTool, unknownTool])], {
        enabled: true
      })

      const result = yield* toolSet.execute({ id: 'call_1', name: 'number_probe', params: 5 })

      expect(result.content).toBe('5')
    })
  )

  it.effect('stamps recursive union roots after reference inlining', () =>
    Effect.gen(function* () {
      interface FilterLeaf {
        readonly op: 'leaf'
        readonly value: string
      }

      interface FilterBranch {
        readonly op: 'branch'
        readonly kids: ReadonlyArray<FilterLeaf | FilterBranch>
      }

      const FilterValueSchema = Schema.Union([
        Schema.Struct({ op: Schema.Literal('leaf'), value: Schema.String }),
        Schema.Struct({
          op: Schema.Literal('branch'),
          kids: Schema.Array(
            Schema.suspend((): Schema.Codec<FilterLeaf | FilterBranch> => FilterValueSchema)
          )
        })
      ])

      const tool = makeSchemaTool({
        name: 'filter_probe',
        description: 'Probe recursive input.',
        parameters: FilterValueSchema,
        access: 'read',
        execute: ({ call, params }) =>
          Effect.succeed(ToolResult.make({ toolCallId: call.id, content: params.op }))
      })

      // The compiler emits recursive roots as a $ref the registry inlines;
      // it currently inlines shared members too, so no $defs survive here.
      expect(tool.def.parameters).toMatchObject({
        type: 'object',
        anyOf: [expect.anything(), expect.anything()]
      })

      const toolSet = yield* resolveTools([makeModule([tool])], { enabled: true })

      const result = yield* toolSet.execute({
        id: 'call_1',
        name: 'filter_probe',
        params: { op: 'branch', kids: [{ op: 'leaf', value: 'x' }] }
      })

      expect(result.content).toBe('branch')
    })
  )

  it('rejects non-portable custom JSON Schema output with the synchronous constructor error owner', () => {
    // rc.115 drops invalid ordinary examples; a custom compiler hook can still
    // produce non-portable output. Exercise the constructor's own boundary.
    const nonfiniteExample = Schema.Finite.check(
      Schema.makeFilter(() => true, { toJsonSchema: () => ({ examples: [Infinity] }) })
    )

    const fields = [nonfiniteExample, nonfiniteExample.annotate({ identifier: 'NonfiniteExample' })]

    for (const field of fields) {
      let caught: unknown

      try {
        makeSchemaTool({
          name: 'nonfinite_example',
          description: 'Invalid JSON Schema example.',
          parameters: Schema.Struct({ n: field }),
          access: 'read',
          execute: ({ call }) =>
            Effect.succeed(ToolResult.make({ toolCallId: call.id, content: 'unreachable' }))
        })
      } catch (error) {
        caught = error
      }

      expect(caught).toBeInstanceOf(Error)
      expect(Schema.isSchemaError(caught)).toBe(false)

      if (caught instanceof Error) {
        expect(SchemaIssue.isIssue(caught.cause)).toBe(true)
        expect(caught.message).toContain('JSON Schema')
      }
    }
  })

  it.effect('derives empty object parameters for no-arg tools', () =>
    Effect.gen(function* () {
      const tool = makeSchemaTool({
        name: 'empty',
        description: 'No args.',
        parameters: Schema.Struct({}),
        access: 'read',
        execute: ({ call }) =>
          Effect.succeed(ToolResult.make({ toolCallId: call.id, content: 'ok' }))
      })

      const toolSet = yield* resolveTools([makeModule([tool])], { enabled: true })

      expect(toolSet.tools[0]?.parameters).toEqual({
        type: 'object',
        properties: {},
        required: [],
        additionalProperties: false
      })
    })
  )

  it.effect('derives provider-safe parameters for empty tool params', () =>
    Effect.gen(function* () {
      const tool = makeSchemaTool({
        name: 'empty_params',
        description: 'No args.',
        parameters: EmptyToolParams,
        access: 'read',
        execute: ({ call }) =>
          Effect.succeed(ToolResult.make({ toolCallId: call.id, content: 'ok' }))
      })

      const toolSet = yield* resolveTools([makeModule([tool])], { enabled: true })

      expect(toolSet.tools[0]?.parameters).toEqual({
        type: 'object',
        properties: {},
        required: [],
        additionalProperties: false
      })
      expect(toolSet.tools[0]?.parameters).not.toHaveProperty('anyOf')
    })
  )

  it.effect('returns model-visible errors for invalid tool params', () =>
    Effect.gen(function* () {
      const tool = makeSchemaTool({
        name: 'empty_params',
        description: 'No args.',
        parameters: EmptyToolParams,
        access: 'read',
        execute: ({ call }) =>
          Effect.succeed(ToolResult.make({ toolCallId: call.id, content: 'ok' }))
      })

      const toolSet = yield* resolveTools([makeModule([tool])], { enabled: true })

      const result = yield* toolSet.execute({
        id: 'call_1',
        name: 'empty_params',
        params: { extra: true }
      })

      expect(result).toMatchObject({
        toolCallId: 'call_1',
        content: expect.stringContaining('Invalid empty_params arguments: SchemaError('),
        isError: true,
        structuredContent: {
          type: 'model_visible_tool_error',
          tool: 'empty_params',
          reason: 'validation',
          message: expect.stringContaining('Invalid empty_params arguments: SchemaError(')
        }
      })
    })
  )

  it.effect('passes Schema.SchemaError through validate and execute', () =>
    Effect.gen(function* () {
      const captured: Schema.SchemaError[] = []

      const tool = makeSchemaTool({
        name: 'empty_params',
        description: 'No args.',
        parameters: EmptyToolParams,
        access: 'read',
        invalidParamsMessage: error => {
          captured.push(error)

          return `typed:${String(error)}`
        },
        execute: ({ call }) =>
          Effect.succeed(ToolResult.make({ toolCallId: call.id, content: 'ok' }))
      })

      const call = ToolCall.make({
        id: 'call_1',
        name: 'empty_params',
        params: { extra: true }
      })

      const validateParams = tool.validate

      if (validateParams === undefined) {
        return yield* Effect.fail(new Error('makeTool empty_params registration omitted validate'))
      }

      const validated = yield* validateParams(call).pipe(Effect.result)

      expect(Result.isFailure(validated)).toBe(true)

      if (!Result.isFailure(validated)) {
        return yield* Effect.fail(
          new Error('expected makeTool validate to fail Schema.SchemaError')
        )
      }

      const validateError = captured[0]

      if (validateError === undefined) {
        return yield* Effect.fail(new Error('expected validate to capture Schema.SchemaError'))
      }

      expect(validated.failure.message).toBe(`typed:${String(validateError)}`)
      expect(validated.failure.cause).toBe('validation')
      expect(Schema.isSchemaError(validateError)).toBe(true)
      expect(String(validateError)).toBe(`SchemaError(${validateError.message})`)

      const executed = yield* tool.execute({ call, context: { enabled: true } })
      const executeError = captured[1]

      expect(captured).toHaveLength(2)

      if (executeError === undefined) {
        return yield* Effect.fail(new Error('expected execute to capture Schema.SchemaError'))
      }

      expect(executed).toMatchObject({
        toolCallId: 'call_1',
        content: `typed:${String(executeError)}`,
        isError: true,
        structuredContent: {
          type: 'model_visible_tool_error',
          tool: 'empty_params',
          reason: 'validation',
          message: `typed:${String(executeError)}`
        }
      })
      expect(Schema.isSchemaError(executeError)).toBe(true)
      expect(String(executeError)).toBe(`SchemaError(${executeError.message})`)
      expect(executeError).not.toBe(validateError)
    })
  )

  it.effect('returns model-visible errors from tool execution', () =>
    Effect.gen(function* () {
      const tool = makeSchemaTool({
        name: 'visible_error',
        description: 'Returns a model-visible error.',
        parameters: EmptyToolParams,
        access: 'read',
        execute: () =>
          Effect.fail(
            modelVisibleToolError({
              tool: 'visible_error',
              message: 'Try another input.',
              reason: 'invalid_input',
              details: { code: 'bad_input' }
            })
          )
      })

      const toolSet = yield* resolveTools([makeModule([tool])], { enabled: true })

      const result = yield* toolSet.execute({
        id: 'call_1',
        name: 'visible_error',
        params: {}
      })

      expect(result).toMatchObject({
        toolCallId: 'call_1',
        content: 'Try another input.',
        isError: true,
        structuredContent: {
          type: 'model_visible_tool_error',
          tool: 'visible_error',
          reason: 'invalid_input',
          message: 'Try another input.',
          details: { code: 'bad_input' }
        }
      })
    })
  )

  it('omits structured error details and makeTool background unless present', () => {
    const omitted = modelVisibleToolErrorStructuredContent(
      modelVisibleToolError({
        tool: 't',
        message: 'm',
        reason: 'not_found'
      })
    )

    expect(Object.keys(omitted)).toEqual(['type', 'tool', 'reason', 'message'])
    expect(JSON.stringify(omitted)).toBe(
      '{"type":"model_visible_tool_error","tool":"t","reason":"not_found","message":"m"}'
    )

    const present = modelVisibleToolErrorStructuredContent(
      modelVisibleToolError({
        tool: 't',
        message: 'm',
        reason: 'not_found',
        details: { code: 'missing' }
      })
    )

    expect(Object.keys(present)).toEqual(['type', 'tool', 'reason', 'message', 'details'])
    expect(JSON.stringify(present)).toBe(
      '{"type":"model_visible_tool_error","tool":"t","reason":"not_found","message":"m","details":{"code":"missing"}}'
    )

    const reads: Array<string> = []

    const registration = makeSchemaTool({
      name: 'echo',
      description: 'echo',
      parameters: EmptyToolParams,
      access: 'read',
      get background() {
        reads.push('background')

        return false
      },
      execute: ({ call }) => Effect.succeed(ToolResult.make({ toolCallId: call.id, content: 'x' }))
    })

    expect(reads).toEqual(['background', 'background', 'background', 'background'])
    expect(Object.keys(registration)).toEqual([
      'def',
      'background',
      'validate',
      'access',
      'approval',
      'isEnabled',
      'execute'
    ])
    expect(registration.background).toBe(false)
    expect(Object.keys(registration.def)).toEqual([
      'name',
      'description',
      'parameters',
      'approval',
      'background'
    ])
    expect(JSON.stringify(registration.def)).toBe(
      '{"name":"echo","description":"echo","parameters":{"type":"object","properties":{},"required":[],"additionalProperties":false},"background":false}'
    )

    const omittedBackground = makeSchemaTool({
      name: 'echo',
      description: 'echo',
      parameters: EmptyToolParams,
      access: 'read',
      execute: ({ call }) => Effect.succeed(ToolResult.make({ toolCallId: call.id, content: 'x' }))
    })

    expect(Object.keys(omittedBackground)).toEqual([
      'def',
      'validate',
      'access',
      'approval',
      'isEnabled',
      'execute'
    ])
    expect(Object.hasOwn(omittedBackground, 'background')).toBe(false)
    expect(Object.keys(omittedBackground.def)).toEqual([
      'name',
      'description',
      'parameters',
      'approval'
    ])
  })
})

const toolDefFields = (parameters: unknown) => ({
  name: 'echo',
  description: 'echo',
  parameters
})

const expectRejectedParameters = (parameters: unknown) => {
  const decoded = Schema.decodeUnknownResult(ToolDef)(toolDefFields(parameters))
  const schemaDecoded = Schema.decodeUnknownResult(ToolJsonSchema)(parameters)

  expect(Result.isFailure(decoded)).toBe(true)
  expect(Result.isFailure(schemaDecoded)).toBe(true)
  expect(decodeToolJsonSchema(parameters)._tag).toBe('None')

  if (Result.isFailure(decoded)) {
    expect(Schema.isSchemaError(decoded.failure)).toBe(true)
    expect(decoded.failure.message).toContain('JSON Schema')
  }
}

describe('ToolDef.parameters JSON Schema representation', () => {
  it('admits boolean schemas, plain objects, DAG aliases, and own __proto__/constructor without cloning', () => {
    const leaf = { type: 'string' }

    const objectParameters = {
      type: 'object',
      properties: { flag: true, a: leaf, b: leaf },
      additionalProperties: false,
      'x-vendor': { note: 'annotation' }
    }

    const objectDef = ToolDef.make({
      name: 'echo',
      description: 'echo',
      parameters: objectParameters
    })

    const booleanDef = ToolDef.make({
      name: 'echo',
      description: 'echo',
      parameters: true
    })

    const nullProto = Object.assign(Object.create(null), { type: 'object' })
    Object.defineProperty(nullProto, '__proto__', {
      value: { type: 'string' },
      enumerable: true,
      configurable: true,
      writable: true
    })
    Object.defineProperty(nullProto, 'constructor', {
      value: 'owned',
      enumerable: true,
      configurable: true,
      writable: true
    })

    expect(objectDef.parameters).toBe(objectParameters)
    expect(booleanDef.parameters).toBe(true)
    expect(
      ToolDef.make({
        name: 'echo',
        description: 'echo',
        parameters: false
      }).parameters
    ).toBe(false)
    expect(
      ToolDef.make({
        name: 'echo',
        description: 'echo',
        parameters: nullProto
      }).parameters
    ).toBe(nullProto)
    expect(Object.getOwnPropertyDescriptor(nullProto, '__proto__')?.value).toEqual({
      type: 'string'
    })
    expect(Object.getOwnPropertyDescriptor(nullProto, 'constructor')?.value).toBe('owned')
    expect(decodeToolJsonSchema(objectParameters)._tag).toBe('Some')
    expect(decodeToolJsonSchema(true)._tag).toBe('Some')
    expect(Schema.decodeUnknownResult(ToolDef)(toolDefFields(objectParameters))._tag).toBe(
      'Success'
    )
    expect(Schema.decodeUnknownResult(ToolDef)(toolDefFields(nullProto))._tag).toBe('Success')
  })

  it('rejects accessors without invoking them, plus nonfinite/exotic/cyclic/sparse data', () => {
    let reads = 0

    const accessorDocument = {
      type: 'object',
      get extra() {
        reads += 1

        return 1
      }
    }

    const cyclic = { type: 'object' }

    Object.assign(cyclic, { self: cyclic })
    const sparseItems: Array<{ type: string }> = []
    sparseItems[1] = { type: 'string' }
    sparseItems.length = 2

    class Custom {
      type = 'object'
    }

    expectRejectedParameters(accessorDocument)

    const objectDecoded = Schema.decodeUnknownResult(ToolJsonSchemaObject)(accessorDocument)

    expect(Result.isFailure(objectDecoded)).toBe(true)

    if (Result.isFailure(objectDecoded)) {
      expect(objectDecoded.failure.message).toContain('Expected a plain JSON Schema object')
    }

    expect(reads).toBe(0)

    let rejectedByConstructor = false

    try {
      ToolDef.make({
        name: 'echo',
        description: 'echo',
        parameters: accessorDocument
      })
    } catch (error) {
      if (!(error instanceof Error)) throw error

      expect(SchemaIssue.isIssue(error.cause)).toBe(true)
      rejectedByConstructor = true
    }

    expect(rejectedByConstructor).toBe(true)
    expect(reads).toBe(0)

    const rejected = [
      'object',
      1,
      null,
      [{ type: 'object' }],
      { n: Infinity },
      { n: Number.NaN },
      { extra: () => undefined },
      { extra: undefined },
      { default: new Date('2020-01-01T00:00:00.000Z') },
      { default: new Map() },
      new Date('2020-01-01T00:00:00.000Z'),
      new Map(),
      new Custom(),
      cyclic,
      { type: 'object', items: sparseItems }
    ]

    for (const parameters of rejected) {
      expectRejectedParameters(parameters)
    }
  })
})
