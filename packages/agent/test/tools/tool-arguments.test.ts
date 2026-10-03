import { Effect, Predicate, Result, SchemaGetter, SchemaParser, Stream } from 'effect'
import * as Schema from 'effect/Schema'
import { describe, expect, it } from '@effect/vitest'
import { LoopConfig, runToolBatch, ToolExecutor, type ToolError } from '@yolk-sdk/agent/loop'
import {
  BackgroundToolAccepted,
  ToolCall,
  ToolDef,
  ToolResult,
  type ToolJsonSchema
} from '@yolk-sdk/agent/protocol'
import {
  EmptyToolParams,
  makeInputTool,
  makeInteractionTool,
  makeQuestionToolModule,
  makeSubagentToolModule,
  makeTool,
  omitNullOptionalToolArguments,
  questionToolName,
  resolveTools,
  subagentToolName,
  toolJsonSchemaFromSchema,
  type InteractionActionResult,
  type ToolRegistration
} from '../../src/tools/index.ts'

const ok = (call: ToolCall) =>
  Effect.succeed(ToolResult.make({ toolCallId: call.id, content: 'ok' }))

// Captures decoded params so tests can assert what the business handler received.
const capturingTool = <S extends Schema.Schema<unknown> & { readonly DecodingServices: never }>(
  parameters: S,
  options: { readonly background?: boolean } = {}
) => {
  const received: Array<S['Type']> = []

  const tool = makeTool({
    name: 'probe',
    description: 'Probe arguments.',
    access: 'read',
    parameters,
    ...options,
    execute: ({ call, params }) => {
      received.push(params)

      return ok(call)
    }
  })

  return { tool, received }
}

const resolveOne = (tool: ToolRegistration<unknown>) =>
  resolveTools([{ id: 'test', tools: [tool] }], undefined)

const call = (params: unknown, name = 'probe') => ToolCall.make({ id: 'call_1', name, params })

const OptionalArgs = Schema.Struct({
  operation: Schema.Literals(['get', 'search']),
  query: Schema.optional(Schema.String),
  limit: Schema.optional(Schema.Number),
  pageSize: Schema.Number.pipe(Schema.withDecodingDefault(Effect.succeed(20))),
  clearable: Schema.optional(Schema.NullOr(Schema.String)),
  nested: Schema.optional(Schema.Struct({ tag: Schema.optional(Schema.String) }))
})

describe('tool argument decoding', () => {
  it('keeps advertised parameters identical to the original schema lowering', () => {
    const { tool } = capturingTool(OptionalArgs)

    expect(JSON.stringify(tool.def.parameters)).toBe(
      JSON.stringify(toolJsonSchemaFromSchema(OptionalArgs))
    )
    // The advertised JSON codec admits null for Schema.optional fields...
    expect(tool.def.parameters).toMatchObject({
      properties: { query: { anyOf: [{ type: 'string' }, { type: 'null' }] } }
    })
  })

  it.effect('decodes null on optional fields as absent and applies decoding defaults', () =>
    Effect.gen(function* () {
      const { tool, received } = capturingTool(OptionalArgs)
      const toolSet = yield* resolveOne(tool)

      const result = yield* toolSet.execute(
        call({
          operation: 'get',
          query: null,
          limit: null,
          pageSize: null,
          clearable: null,
          nested: { tag: null }
        })
      )

      expect(result).toMatchObject({ content: 'ok' })
      expect(result.isError).toBeUndefined()
      expect(received).toHaveLength(1)

      const params = received[0]

      expect(params?.query).toBeUndefined()
      expect(params?.limit).toBeUndefined()
      expect(params?.nested?.tag).toBeUndefined()
      // withDecodingDefault still applies to null.
      expect(params?.pageSize).toBe(20)
      // Schema.optional(Schema.NullOr(X)) keeps null: it is a meaningful "clear".
      expect(params).toHaveProperty('clearable', null)
    })
  )

  it.effect('null on optional fields decodes like omission', () =>
    Effect.gen(function* () {
      const { tool, received } = capturingTool(OptionalArgs)
      const toolSet = yield* resolveOne(tool)

      yield* toolSet.execute(call({ operation: 'search', query: null, nested: null }))
      yield* toolSet.execute(call({ operation: 'search' }))

      expect(received[0]?.query).toBeUndefined()
      expect(received[0]?.nested).toBeUndefined()
      expect(received[0]?.pageSize).toBe(received[1]?.pageSize)
      expect(received[0]?.operation).toBe(received[1]?.operation)
    })
  )

  it.effect('treats undefined-valued keys from in-process callers as absent', () =>
    Effect.gen(function* () {
      const { tool, received } = capturingTool(OptionalArgs)

      const result = yield* tool.execute({
        context: undefined,
        call: call({ operation: 'get', query: undefined, nested: { tag: undefined } })
      })

      expect(result.isError).toBeUndefined()
      expect(received[0]?.query).toBeUndefined()
      expect(received[0]?.pageSize).toBe(20)

      const required = yield* tool.execute({
        context: undefined,
        call: call({ operation: undefined })
      })

      expect(required).toMatchObject({ isError: true, structuredContent: { reason: 'validation' } })
    })
  )

  it.effect('still rejects null on required non-nullable fields with a model-visible error', () =>
    Effect.gen(function* () {
      const { tool, received } = capturingTool(OptionalArgs)
      const toolSet = yield* resolveOne(tool)

      const result = yield* toolSet.execute(call({ operation: null }))

      expect(result).toMatchObject({
        toolCallId: 'call_1',
        isError: true,
        content: expect.stringContaining('Invalid probe arguments'),
        structuredContent: { type: 'model_visible_tool_error', reason: 'validation' }
      })
      expect(received).toHaveLength(0)
    })
  )

  it.effect('rejects non-finite number strings accepted by the JSON codec', () =>
    Effect.gen(function* () {
      const { tool, received } = capturingTool(OptionalArgs)
      const toolSet = yield* resolveOne(tool)

      for (const value of ['NaN', 'Infinity', '-Infinity']) {
        const result = yield* toolSet.execute(call({ operation: 'get', limit: value }))

        expect(result).toMatchObject({
          isError: true,
          content: expect.stringContaining('Expected a finite number'),
          structuredContent: { reason: 'validation' }
        })

        const validated = yield* (
          tool.validate?.(call({ operation: 'get', pageSize: value })) ?? Effect.void
        ).pipe(Effect.result)

        expect(Result.isFailure(validated)).toBe(true)

        if (Result.isFailure(validated)) {
          expect(validated.failure.cause).toBe('validation')
        }
      }

      expect(received).toHaveLength(0)
    })
  )

  it.effect('validate accepts advertised null optionals and rejects required nulls', () =>
    Effect.gen(function* () {
      const { tool } = capturingTool(OptionalArgs)
      const validate = tool.validate

      expect(validate).toBeDefined()

      if (validate === undefined) return

      yield* validate(call({ operation: 'get', query: null, limit: null }))

      const invalid = yield* validate(call({ operation: 'get', query: 1 })).pipe(Effect.result)

      expect(Result.isFailure(invalid)).toBe(true)
    })
  )
})

describe('registry null omission for optional non-nullable properties', () => {
  const OptionalKeyArgs = Schema.Struct({
    task: Schema.String,
    model: Schema.optionalKey(Schema.Literals(['fast', 'deep'])),
    clear: Schema.optionalKey(Schema.NullOr(Schema.String))
  })

  it.effect('drops null on Schema.optionalKey fields but keeps declared nullable values', () =>
    Effect.gen(function* () {
      const { tool, received } = capturingTool(OptionalKeyArgs)
      const toolSet = yield* resolveOne(tool)

      // Advertised without null: strict-mode models still send it.
      expect(tool.def.parameters).toMatchObject({
        properties: { model: { type: 'string', enum: ['fast', 'deep'] } }
      })

      const result = yield* toolSet.execute(call({ task: 'x', model: null, clear: null }))

      expect(result.isError).toBeUndefined()
      expect(received[0]).toEqual({ task: 'x', clear: null })
      expect(Object.hasOwn(received[0] ?? {}, 'model')).toBe(false)

      const required = yield* toolSet.execute(call({ task: null }))

      expect(required).toMatchObject({ isError: true, structuredContent: { reason: 'validation' } })
    })
  )

  it.effect('accepts null runtime selections on the subagent tool', () =>
    Effect.gen(function* () {
      const received: Array<unknown> = []

      const toolSet = yield* resolveTools(
        [
          makeSubagentToolModule({
            subagents: [{ name: 'general', description: 'General worker.' }],
            models: [{ id: 'model-a', description: 'Model A.' }],
            reasoningEfforts: [{ value: 'low', description: 'Low effort.' }],
            execute: ({ call, params }) => {
              received.push(params)

              return ok(call)
            }
          })
        ],
        undefined
      )

      const result = yield* toolSet.execute(
        call(
          {
            description: 'Look around',
            prompt: 'Explore',
            subagent_type: 'general',
            model: null,
            reasoning_effort: null
          },
          subagentToolName
        )
      )

      expect(result.isError).toBeUndefined()
      expect(received).toEqual([
        { description: 'Look around', prompt: 'Explore', subagent_type: 'general' }
      ])
    })
  )

  it.effect('normalizes raw registrations guided by their advertised JSON Schema', () =>
    Effect.gen(function* () {
      const received: Array<unknown> = []

      const parameters: ToolJsonSchema = {
        type: 'object',
        properties: {
          action: {
            anyOf: [{ $ref: '#/$defs/Create' }, { $ref: '#/$defs/Delete' }]
          },
          items: { type: 'array', items: { $ref: '#/$defs/Item' } },
          nullable: { type: ['string', 'null'] },
          unknown: {},
          constrained: { allOf: [{ type: 'string' }, { minLength: 1 }] }
        },
        required: ['action'],
        $defs: {
          Create: {
            type: 'object',
            properties: { kind: { const: 'create' }, title: { type: 'string' } },
            required: ['kind'],
            additionalProperties: false
          },
          Delete: {
            type: 'object',
            properties: { kind: { const: 'delete' }, reason: { type: 'string' } },
            required: ['kind'],
            additionalProperties: false
          },
          Item: {
            type: 'object',
            properties: { id: { type: 'string' }, note: { type: 'string' } },
            required: ['id']
          }
        }
      }

      const raw: ToolRegistration<unknown> = {
        def: ToolDef.make({ name: 'probe', description: 'Raw MCP-like tool.', parameters }),
        access: 'read',
        execute: ({ call }) => {
          received.push(call.params)

          return ok(call)
        }
      }

      const toolSet = yield* resolveOne(raw)

      yield* toolSet.execute(
        call({
          action: { kind: 'delete', reason: null },
          items: [{ id: 'a', note: null }],
          nullable: null,
          unknown: null,
          constrained: null
        })
      )

      expect(received).toEqual([
        {
          action: { kind: 'delete' },
          items: [{ id: 'a' }],
          nullable: null,
          unknown: null
        }
      ])
    })
  )

  it('never drops a null that another allOf conjunct declares or requires', () => {
    const composed: ToolJsonSchema = {
      anyOf: [
        {
          allOf: [
            { type: 'object', properties: { kind: { const: 'a' } }, required: ['kind'] },
            { type: 'object', properties: { clear: { type: ['string', 'null'] } } }
          ]
        },
        {
          type: 'object',
          properties: { kind: { const: 'b' }, other: { type: 'string' } },
          required: ['kind']
        }
      ]
    }

    const meaningful = { kind: 'a', clear: null }

    // `clear` is declared (nullable) by A's second conjunct: keep it.
    expect(omitNullOptionalToolArguments(composed, meaningful)).toBe(meaningful)
    // `other` is only declared by sibling member B: a strict-mode null means "not sent".
    expect(omitNullOptionalToolArguments(composed, { kind: 'a', other: null })).toEqual({
      kind: 'a'
    })

    const requiredElsewhere: ToolJsonSchema = {
      allOf: [
        { type: 'object', properties: { id: { type: 'string' } } },
        { type: 'object', required: ['id'] }
      ]
    }

    const nullId = { id: null }

    // Optional in one conjunct, required in another: leave it for the decoder to reject.
    expect(omitNullOptionalToolArguments(requiredElsewhere, nullId)).toBe(nullId)
  })

  it('never drops a null declared or required by a nested conjunction', () => {
    const nullable: ToolJsonSchema = {
      type: 'object',
      properties: { clear: { type: ['string', 'null'] } }
    }

    const kindA: ToolJsonSchema = {
      type: 'object',
      properties: { kind: { const: 'a' } },
      required: ['kind']
    }

    const memberB: ToolJsonSchema = {
      type: 'object',
      properties: { kind: { const: 'b' }, clear: { type: 'string' } },
      required: ['kind']
    }

    const meaningful = { kind: 'a', clear: null }

    // A's nullable `clear` sits behind a nested allOf / $ref / union, in either conjunct order.
    const variants: ReadonlyArray<ToolJsonSchema> = [
      { anyOf: [{ allOf: [kindA, { allOf: [nullable] }] }, memberB] },
      { anyOf: [{ allOf: [{ allOf: [nullable] }, kindA] }, memberB] },
      {
        anyOf: [{ allOf: [{ $ref: '#/$defs/Base' }, kindA] }, memberB],
        $defs: { Base: { allOf: [nullable] } }
      },
      { anyOf: [{ allOf: [kindA, { anyOf: [nullable, { type: 'object' }] }] }, memberB] }
    ]

    for (const parameters of variants) {
      expect(omitNullOptionalToolArguments(parameters, meaningful)).toBe(meaningful)
    }

    const requiredNested: ToolJsonSchema = {
      allOf: [
        { type: 'object', properties: { id: { type: 'string' } } },
        { allOf: [{ type: 'object', required: ['id'] }] }
      ]
    }

    const nullId = { id: null }

    expect(omitNullOptionalToolArguments(requiredNested, nullId)).toBe(nullId)
  })

  it('leaves ambiguous unions and required properties untouched', () => {
    const parameters: ToolJsonSchema = {
      anyOf: [
        { type: 'object', properties: { a: { type: 'string' } } },
        { type: 'object', properties: { a: { type: 'number' } } }
      ]
    }

    const params = { a: null }

    expect(omitNullOptionalToolArguments(parameters, params)).toBe(params)

    const required: ToolJsonSchema = {
      type: 'object',
      properties: { a: { type: 'string' } },
      required: ['a']
    }

    expect(omitNullOptionalToolArguments(required, params)).toBe(params)
  })
})

describe('background tool argument validation', () => {
  const BackgroundArgs = Schema.Struct({
    target: Schema.String,
    note: Schema.optional(Schema.String),
    mode: Schema.optionalKey(Schema.Literals(['fast', 'slow']))
  })

  const receipt = BackgroundToolAccepted.make({ version: 1, executionId: 'owner:call_1' })

  it.effect('validates business arguments with optional nulls before admission', () =>
    Effect.gen(function* () {
      const { tool, received } = capturingTool(BackgroundArgs, { background: true })
      const accepted: Array<ToolCall> = []

      const toolSet = yield* resolveTools([{ id: 'test', tools: [tool] }], undefined, {
        backgroundHost: {
          accept: input =>
            Effect.sync(() => {
              accepted.push(input.call)

              return receipt
            })
        }
      })

      const args = { target: 'x', note: null, mode: null }

      const background = yield* toolSet.execute(call({ execution: 'background', arguments: args }))

      expect(background.isError).toBeUndefined()
      expect(accepted.map(item => item.params)).toEqual([{ target: 'x', note: null }])

      const foreground = yield* toolSet.execute(call({ execution: 'foreground', arguments: args }))

      expect(foreground).toMatchObject({ content: 'ok' })
      expect(received[0]?.note).toBeUndefined()

      const invalid = yield* toolSet.execute(
        call({ execution: 'background', arguments: { target: null } })
      )

      expect(invalid).toMatchObject({
        isError: true,
        structuredContent: { type: 'model_visible_tool_error', reason: 'validation' }
      })
      expect(accepted).toHaveLength(1)
    })
  )
})

describe('question tool argument decoding', () => {
  const params = {
    questions: [
      {
        id: 'choice',
        prompt: 'Pick one',
        options: null,
        multiple: null,
        allowCustom: null,
        required: null
      }
    ]
  }

  it.effect('loop accepts null optional prompt fields and requests the question', () =>
    Effect.gen(function* () {
      const executor = {
        execute: (toolCall: ToolCall): Effect.Effect<ToolResult, ToolError> => ok(toolCall)
      }

      const events = yield* runToolBatch({
        calls: [call(params, questionToolName)],
        tools: [ToolDef.make({ name: questionToolName, description: 'Ask', parameters: {} })]
      }).pipe(
        Stream.runCollect,
        Effect.provide(LoopConfig.defaultLayer),
        Effect.provideService(ToolExecutor, executor)
      )

      const requested = Array.from(events).find(event =>
        Predicate.isTagged(event, 'QuestionRequested')
      )

      expect(requested).toBeDefined()

      if (requested === undefined || !Predicate.isTagged(requested, 'QuestionRequested')) return

      const [question] = requested.request.questions

      expect(question?.id).toBe('choice')
      expect(question?.options).toBeUndefined()
      expect(question?.multiple).toBeUndefined()
      expect(JSON.parse(JSON.stringify(requested.request.questions))).toEqual([
        { id: 'choice', prompt: 'Pick one' }
      ])
    })
  )

  it.effect('question registration decodes null optional prompt fields', () =>
    Effect.gen(function* () {
      const toolSet = yield* resolveTools(
        [
          makeQuestionToolModule({
            execute: ({ call, params }) =>
              Effect.succeed(
                ToolResult.make({
                  toolCallId: call.id,
                  content: String(params.questions[0]?.options === undefined)
                })
              )
          })
        ],
        undefined
      )

      const result = yield* toolSet.execute(call(params, questionToolName))

      expect(result).toMatchObject({ content: 'true' })
      expect(result.isError).toBeUndefined()
    })
  )
})

describe('interaction and input call arguments', () => {
  const Proposal = Schema.Struct({
    folder: Schema.String,
    note: Schema.optional(Schema.String),
    tag: Schema.optionalKey(Schema.String)
  })

  const Draft = Schema.Struct({ title: Schema.String, note: Schema.optional(Schema.String) })

  it.effect('interaction call params accept advertised nulls; handlers see them omitted', () =>
    Effect.gen(function* () {
      const handled: Array<unknown> = []

      const registration = makeInteractionTool({
        name: 'document',
        description: 'Review a document',
        access: 'write',
        callParameters: Proposal,
        response: Draft,
        actions: {
          publish: {
            label: 'Publish',
            execute: ({ call }) => {
              handled.push(call.params)

              return Effect.succeed<InteractionActionResult>({
                outcome: 'completed',
                content: 'published'
              })
            }
          }
        }
      })

      const toolSet = yield* resolveTools([{ id: 'documents', tools: [registration] }], undefined, {
        interactionHost: {
          read: () => Effect.succeed(undefined),
          claim: () => Effect.die('unused'),
          settle: () => Effect.die('unused')
        }
      })

      const view = toolSet.interactions['document']

      expect(view).toBeDefined()

      if (view === undefined) return

      // `note` is Schema.optional (advertised nullable); `tag` is optionalKey (registry-omitted).
      yield* view.validateCall({ folder: 'drafts', note: null, tag: null })

      const required = yield* view.validateCall({ folder: null }).pipe(Effect.result)

      expect(Result.isFailure(required)).toBe(true)

      const action = registration.interaction?.actions['publish']

      yield* (
        action?.execute({
          data: { title: 'Final' },
          context: undefined,
          submissionId: 'submission_1',
          call: call({ folder: 'drafts', note: null }, 'document')
        }) ?? Effect.void
      )

      expect(handled).toEqual([{ folder: 'drafts' }])
    })
  )

  it.effect('input call params accept advertised nulls; user responses stay strict', () =>
    Effect.gen(function* () {
      const registration = makeInputTool({
        name: 'draft',
        description: 'Collect a draft.',
        callParameters: Proposal,
        response: Draft
      })

      const toolSet = yield* resolveTools([{ id: 'draft', tools: [registration] }], undefined)
      const view = toolSet.inputs['draft']

      expect(view).toBeDefined()

      if (view === undefined) return

      yield* view.validateCall({ folder: 'drafts', note: null, tag: null })

      const response = yield* view.validateResponse({ title: 'x', note: null }).pipe(Effect.result)

      expect(Result.isFailure(response)).toBe(true)
    })
  )
})

// Mirrors an app-owned closed-input declaration whose JSON codec link bypasses its own parser.
const closedDeclaration = <S extends Schema.Top>(schema: S) =>
  Schema.declareConstructor<S['Type'], S['Encoded']>()(
    [schema],
    ([codec]) =>
      (input, _ast, options) =>
        SchemaParser.decodeUnknownEffect(codec)(input, { ...options, onExcessProperty: 'error' }),
    {
      toCodecJson: ([inner]) =>
        Schema.link<S['Type']>()(inner, {
          decode: SchemaGetter.passthrough(),
          encode: SchemaGetter.passthrough()
        })
    }
  )

const expectValidationError = (result: ToolResult, key: string) =>
  expect(result).toMatchObject({
    isError: true,
    content: expect.stringMatching(new RegExp(`Unknown arguments? (?:"[^"]*", )*"${key}"`)),
    structuredContent: {
      type: 'model_visible_tool_error',
      reason: 'validation',
      message: expect.stringContaining(key)
    }
  })

describe('unknown tool argument keys', () => {
  const Nested = Schema.Struct({
    id: Schema.String,
    note: Schema.optional(Schema.String),
    child: Schema.optional(Schema.Struct({ tag: Schema.String }))
  })

  const Operations = Schema.Union([
    Schema.Struct({ kind: Schema.Literal('create'), title: Schema.optional(Schema.String) }),
    Schema.Struct({ kind: Schema.Literal('delete'), reason: Schema.optional(Schema.String) })
  ])

  it.effect(
    'rejects unknown keys at the root, nested, and in union branches before execution',
    () =>
      Effect.gen(function* () {
        const nested = capturingTool(Nested)
        const nestedSet = yield* resolveOne(nested.tool)

        expectValidationError(yield* nestedSet.execute(call({ id: 'a', start: 'x' })), 'start')
        expectValidationError(
          yield* nestedSet.execute(call({ id: 'a', child: { tag: 't', extra: true } })),
          'extra'
        )

        const union = capturingTool(Operations)
        const unionSet = yield* resolveOne(union.tool)

        expectValidationError(
          yield* unionSet.execute(call({ kind: 'delete', reason: 'r', force: true })),
          'force'
        )

        const validated = yield* (
          nested.tool.validate?.(call({ id: 'a', start: 'x' })) ?? Effect.void
        ).pipe(Effect.result)

        expect(Result.isFailure(validated)).toBe(true)
        expect(nested.received).toHaveLength(0)
        expect(union.received).toHaveLength(0)
      })
  )

  it.effect('keeps closed-input declarations closed through the JSON codec', () =>
    Effect.gen(function* () {
      const Closed = closedDeclaration(Nested)
      const { tool, received } = capturingTool(Closed)
      const toolSet = yield* resolveOne(tool)

      expect(JSON.stringify(tool.def.parameters)).toBe(
        JSON.stringify(toolJsonSchemaFromSchema(Closed))
      )

      expectValidationError(yield* toolSet.execute(call({ id: 'a', start: 'x' })), 'start')
      expectValidationError(
        yield* toolSet.execute(call({ id: 'a', child: { tag: 't', extra: 1 } })),
        'extra'
      )
      expect(received).toHaveLength(0)

      const result = yield* toolSet.execute(call({ id: 'a', note: null, child: null }))

      expect(result.isError).toBeUndefined()
      expect(received[0]?.note).toBeUndefined()
      expect(received[0]?.child).toBeUndefined()
    })
  )

  it.effect('drops null on another union branch field but rejects a real value there', () =>
    Effect.gen(function* () {
      const { tool, received } = capturingTool(Operations)
      const toolSet = yield* resolveOne(tool)

      // Provider-flattened schemas (Anthropic) show every branch's fields to the model.
      const accepted = yield* toolSet.execute(call({ kind: 'delete', title: null, reason: 'r' }))

      expect(accepted.isError).toBeUndefined()
      expect(received).toEqual([{ kind: 'delete', reason: 'r' }])

      expectValidationError(
        yield* toolSet.execute(call({ kind: 'delete', title: 'kept?' })),
        'title'
      )
    })
  )

  it.effect('names unknown keys and lists the allowed keys at their path', () =>
    Effect.gen(function* () {
      const { tool } = capturingTool(Nested)
      const toolSet = yield* resolveOne(tool)

      const root = yield* toolSet.execute(call({ id: 'a', start: 'x' }))

      expect(root.content).toContain('Invalid probe arguments: SchemaError(')
      expect(root.content).toContain(
        'Unknown argument "start". Allowed arguments: id, note, child.'
      )

      const nested = yield* toolSet.execute(call({ id: 'a', child: { tag: 't', extra: true } }))

      expect(nested.content).toContain('Unknown argument "extra" in "child". Allowed there: tag.')

      const union = capturingTool(Operations)
      const unionSet = yield* resolveOne(union.tool)
      const branch = yield* unionSet.execute(call({ kind: 'delete', reason: 'r', force: true }))

      expect(branch.content).toContain('Unknown argument "force". Allowed arguments: kind, reason.')

      const empty = capturingTool(EmptyToolParams)
      const emptySet = yield* resolveOne(empty.tool)
      const none = yield* emptySet.execute(call({ verbose: true }))

      expect(none.content).toContain('Unknown argument "verbose". Allowed arguments: none.')
    })
  )

  it.effect('rejects null on a key no union member declares instead of dropping it', () =>
    Effect.gen(function* () {
      const Task = Schema.Struct({
        id: Schema.String,
        dueDate: Schema.optional(Schema.NullOr(Schema.String))
      })

      const { tool, received } = capturingTool(Task)
      const toolSet = yield* resolveOne(tool)

      // A misspelled "clear" must not silently succeed without clearing anything.
      expectValidationError(yield* toolSet.execute(call({ id: 'a', due_date: null })), 'due_date')
      expect(received).toHaveLength(0)

      yield* toolSet.execute(call({ id: 'a', dueDate: null }))

      expect(received).toEqual([{ id: 'a', dueDate: null }])
    })
  )

  it.effect('reports every unknown key and every invalid field in one error', () =>
    Effect.gen(function* () {
      const { tool, received } = capturingTool(Nested)
      const toolSet = yield* resolveOne(tool)

      const result = yield* toolSet.execute(
        call({ id: 1, start: 'x', end: 'y', child: { tag: 't', extra: true } })
      )

      expect(received).toHaveLength(0)
      expect(result.content).toContain(
        'Unknown arguments "start", "end". Allowed arguments: id, note, child.'
      )
      expect(result.content).toContain('Unknown argument "extra" in "child". Allowed there: tag.')
      expect(result.content).toContain('Expected string')
    })
  )

  it.effect('rejects unknown keys on root empty-struct and no-argument tools', () =>
    Effect.gen(function* () {
      for (const parameters of [Schema.Struct({}), EmptyToolParams]) {
        const { tool, received } = capturingTool(parameters)
        const toolSet = yield* resolveOne(tool)

        expect(tool.def.parameters).toMatchObject({ type: 'object', additionalProperties: false })

        const result = yield* toolSet.execute(call({ verbose: true, limit: 3 }))

        expect(received).toHaveLength(0)
        expect(result.content).toContain(
          'Unknown arguments "verbose", "limit". Allowed arguments: none.'
        )

        const accepted = yield* toolSet.execute(call({}))

        expect(accepted.isError).toBeUndefined()
      }
    })
  )

  it.effect('keeps an own __proto__ argument an own key so it is rejected', () =>
    Effect.gen(function* () {
      const { tool, received } = capturingTool(
        Schema.Struct({ id: Schema.String, mode: Schema.optionalKey(Schema.String) })
      )

      const toolSet = yield* resolveOne(tool)

      // JSON.parse creates an own `__proto__` key; normalization must not turn it into a prototype.
      const params: unknown = JSON.parse('{"id":"x","mode":null,"__proto__":null}')
      const result = yield* toolSet.execute(call(params))

      expect(received).toHaveLength(0)
      expectValidationError(result, '__proto__')
    })
  )

  it.effect('selects the union member that declares every sent key', () =>
    Effect.gen(function* () {
      const { tool, received } = capturingTool(
        Schema.Union([
          Schema.Struct({ a: Schema.String }),
          Schema.Struct({ a: Schema.String, b: Schema.String })
        ])
      )

      const toolSet = yield* resolveOne(tool)

      yield* toolSet.execute(call({ a: 'x', b: 'y' }))

      expect(received).toEqual([{ a: 'x', b: 'y' }])
    })
  )

  it.effect('rejects unknown keys in background business calls before admission', () =>
    Effect.gen(function* () {
      const { tool } = capturingTool(Nested, { background: true })
      let accepted = 0

      const toolSet = yield* resolveTools([{ id: 'test', tools: [tool] }], undefined, {
        backgroundHost: {
          accept: () =>
            Effect.sync(() => {
              accepted++

              return BackgroundToolAccepted.make({ version: 1, executionId: 'owner:call_1' })
            })
        }
      })

      expectValidationError(
        yield* toolSet.execute(
          call({ execution: 'background', arguments: { id: 'a', start: 'x' } })
        ),
        'start'
      )
      expect(accepted).toBe(0)
    })
  )

  it.effect('loop rejects unknown keys in question prompts', () =>
    Effect.gen(function* () {
      const executor = {
        execute: (toolCall: ToolCall): Effect.Effect<ToolResult, ToolError> => ok(toolCall)
      }

      const events = yield* runToolBatch({
        calls: [
          call(
            { questions: [{ id: 'choice', prompt: 'Pick one', placeholder: 'x' }] },
            questionToolName
          )
        ],
        tools: [ToolDef.make({ name: questionToolName, description: 'Ask', parameters: {} })]
      }).pipe(
        Stream.runCollect,
        Effect.provide(LoopConfig.defaultLayer),
        Effect.provideService(ToolExecutor, executor)
      )

      expect(Array.from(events).some(event => Predicate.isTagged(event, 'QuestionRequested'))).toBe(
        false
      )
      expect(
        Array.from(events).find(event => Predicate.isTagged(event, 'ToolExecutionCompleted'))
      ).toMatchObject({
        result: {
          isError: true,
          content: expect.stringContaining(
            'Unknown argument "placeholder" in "questions.0". Allowed there: id, prompt, options, multiple, allowCustom, required.'
          ),
          structuredContent: { type: 'question_invalid' }
        }
      })
    })
  )
})
