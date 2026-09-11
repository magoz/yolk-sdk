import { Effect } from 'effect'
import * as Schema from 'effect/Schema'
import { describe, expect, it } from '@effect/vitest'
import { BackgroundToolAccepted, ToolCall, ToolDef, ToolResult } from '@yolk-sdk/agent/protocol'
import { ToolError } from '@yolk-sdk/agent/loop'
import {
  makeTool,
  questionToolName,
  subagentToolName,
  resolveTools,
  type BackgroundToolHost,
  type ToolRegistration
} from '../../src/tools/index.ts'
import { toOpenAiRequestBody } from '../../src/providers/openai/provider.ts'
import { toAnthropicClaudeRequestBody } from '../../src/providers/anthropic/claude-provider.ts'
import { toOpenAiCodexRequestBody } from '../../src/providers/openai/codex-provider.ts'

class Nested extends Schema.Class<Nested>('Nested')({ value: Schema.String }) {}
const paramsSchema = Schema.Struct({
  execution: Schema.String,
  arguments: Schema.Number.pipe(Schema.check(Schema.isFinite())),
  background: Schema.Boolean,
  nested: Nested
})
const params = { execution: 'business', arguments: 42, background: false, nested: { value: 'yes' } }
const request = (execution: string, args: unknown = params) =>
  ToolCall.make({
    id: 'call-1',
    name: 'work',
    params: { execution, arguments: args }
  })
const receipt = BackgroundToolAccepted.make({ version: 1, executionId: 'owner:call-1' })
const registration = (execute: (call: ToolCall) => Effect.Effect<ToolResult, ToolError>) =>
  makeTool({
    name: 'work',
    description: 'Work',
    access: 'write',
    background: true,
    parameters: paramsSchema,
    execute: ({ call }) => execute(call)
  })
const resolve = (tool: ToolRegistration<unknown>, host?: BackgroundToolHost<unknown>) =>
  resolveTools(
    [{ id: 'test', tools: [tool] }],
    {},
    host === undefined ? {} : { backgroundHost: host }
  )

const inline = (call: ToolCall) =>
  Effect.succeed(ToolResult.make({ toolCallId: call.id, content: 'done' }))

describe('native background tools', () => {
  it.effect('retains exact original definitions and inline behavior without a host', () =>
    Effect.gen(function* () {
      const tool = registration(inline)
      const set = yield* resolve(tool)
      expect(set.tools[0]).toBe(tool.def)
      expect(set.tools[0]?.execution).toBeUndefined()
      expect(set.tools[0]?.parameters).not.toHaveProperty('properties.execution.enum')
      expect(yield* set.execute(ToolCall.make({ id: 'plain', name: 'work', params }))).toEqual(
        ToolResult.make({ toolCallId: 'plain', content: 'done' })
      )
    })
  )

  it.effect('does not activate non-opted tools even with a host', () =>
    Effect.gen(function* () {
      let admissions = 0
      const tool = makeTool({
        name: 'work',
        description: '',
        access: 'read',
        parameters: paramsSchema,
        execute: ({ call }) => inline(call)
      })
      const set = yield* resolve(tool, {
        accept: () => {
          admissions++
          return Effect.succeed(receipt)
        }
      })
      expect(set.tools[0]).toBe(tool.def)
      yield* set.execute(ToolCall.make({ id: 'plain', name: 'work', params }))
      expect(admissions).toBe(0)
    })
  )

  it.effect(
    'strips the envelope without colliding with business keys; acceptance never executes inline',
    () =>
      Effect.gen(function* () {
        const inlineCalls: ToolCall[] = []
        const admitted: ToolCall[] = []
        const requests: ToolCall[] = []
        const set = yield* resolve(
          registration(call => {
            inlineCalls.push(call)
            return inline(call)
          }),
          {
            accept: input => {
              admitted.push(input.call)
              requests.push(input.request)
              return Effect.succeed(receipt)
            }
          }
        )
        const accepted = yield* set.execute(request('background'))
        expect(accepted.acceptance).toEqual(receipt)
        expect(accepted.isError).toBeUndefined()
        expect(accepted.content).toContain('not completion')
        expect(inlineCalls).toEqual([])
        expect(admitted[0]?.params).toEqual(params)
        expect(requests[0]).toEqual(request('background'))
        const completed = yield* set.execute(request('foreground'))
        expect(completed.acceptance).toBeUndefined()
        expect(inlineCalls[0]?.params).toEqual(params)
        expect(admitted).toHaveLength(1)
      })
  )

  it.effect(
    'rejects omitted/invalid/excess control fields and invalid business arguments before admission',
    () =>
      Effect.gen(function* () {
        let effects = 0
        const set = yield* resolve(
          registration(call => {
            effects++
            return inline(call)
          }),
          {
            accept: () => {
              effects++
              return Effect.succeed(receipt)
            }
          }
        )
        for (const input of [
          params,
          {},
          { execution: 'background' },
          { execution: 'later', arguments: params },
          { execution: 'background', arguments: params, extra: true }
        ]) {
          const result = yield* set
            .execute(ToolCall.make({ id: 'invalid', name: 'work', params: input }))
            .pipe(Effect.result)
          expect(result).toMatchObject({ _tag: 'Failure', failure: { cause: 'validation' } })
        }
        expect(effects).toBe(0)
      })
  )

  it.effect('fails closed on host rejection without falling back to inline execution', () =>
    Effect.gen(function* () {
      let effects = 0
      const set = yield* resolve(
        registration(call => {
          effects++
          return inline(call)
        }),
        {
          accept: () =>
            Effect.fail(new ToolError({ tool: 'work', cause: 'denied', message: 'Owner stopped' }))
        }
      )
      expect(yield* set.execute(request('background')).pipe(Effect.result)).toMatchObject({
        _tag: 'Failure',
        failure: { cause: 'denied' }
      })
      expect(effects).toBe(0)
    })
  )

  it.effect('requires a separate validation seam for raw opt-in registrations', () =>
    Effect.gen(function* () {
      const tool: ToolRegistration<unknown> = {
        def: ToolDef.make({ name: 'work', description: '', parameters: {}, background: true }),
        access: 'write',
        execute: ({ call }) => inline(call)
      }
      expect(
        yield* resolve(tool, { accept: () => Effect.succeed(receipt) }).pipe(Effect.result)
      ).toMatchObject({ _tag: 'Failure', failure: { cause: 'background_validation_required' } })
      expect((yield* resolve(tool)).tools[0]).toBe(tool.def)
    })
  )

  it.effect(
    'lets the host recover the same receipt on retry/replay without duplicate physical admission',
    () =>
      Effect.gen(function* () {
        const reservations = new Map<string, BackgroundToolAccepted>()
        let physicalStarts = 0
        const set = yield* resolve(registration(inline), {
          accept: ({ call }) =>
            Effect.sync(() => {
              const existing = reservations.get(call.id)
              if (existing !== undefined) return existing
              physicalStarts++
              reservations.set(call.id, receipt)
              return receipt
            })
        })
        const first = yield* set.execute(request('background'))
        const replay = yield* set.execute(request('background'))
        expect(replay).toEqual(first)
        expect(physicalStarts).toBe(1)
        expect(JSON.parse(JSON.stringify(first.acceptance))).toEqual({
          version: 1,
          executionId: 'owner:call-1'
        })
      })
  )

  it.effect('recovers a lost admission response on retry and rejects malformed receipts', () =>
    Effect.gen(function* () {
      let reserved = false
      let launches = 0
      const set = yield* resolve(registration(inline), {
        accept: () =>
          Effect.suspend(() => {
            if (reserved) return Effect.succeed(receipt)
            reserved = true
            launches++
            return Effect.fail(
              new ToolError({
                tool: 'work',
                cause: 'unavailable',
                message: 'Response lost after durable admission'
              })
            )
          })
      })
      expect(yield* set.execute(request('background')).pipe(Effect.result)).toMatchObject({
        _tag: 'Failure'
      })
      expect((yield* set.execute(request('background'))).acceptance).toEqual(receipt)
      expect(launches).toBe(1)
      const invalid = yield* resolve(registration(inline), {
        accept: () => Effect.succeed<BackgroundToolAccepted>({ version: 1, executionId: '' })
      })
      expect(yield* invalid.execute(request('background')).pipe(Effect.result)).toMatchObject({
        _tag: 'Failure',
        failure: { cause: 'execution' }
      })
    })
  )

  it.effect('rejects re-registration of activated definitions and loop-owned tool activation', () =>
    Effect.gen(function* () {
      expect([questionToolName, subagentToolName]).toEqual(['question', 'subagent'])
      const tool = registration(inline)
      const host = { accept: () => Effect.succeed(receipt) }
      const activated = yield* resolve(tool, host)
      const def = activated.tools[0]
      if (def === undefined) return
      expect(yield* resolve({ ...tool, def }).pipe(Effect.result)).toMatchObject({
        _tag: 'Failure',
        failure: { cause: 'background_definition_already_active' }
      })
      for (const name of [questionToolName, subagentToolName]) {
        const loopOwned = { ...tool, def: ToolDef.make({ ...tool.def, name }) }
        expect(yield* resolve(loopOwned, host).pipe(Effect.result)).toMatchObject({
          _tag: 'Failure',
          failure: { cause: 'background_unsupported_tool' }
        })
        // Without a host the opt-in flag is inert and the original definition is exposed unchanged.
        expect((yield* resolve(loopOwned)).tools[0]).toBe(loopOwned.def)
      }
    })
  )

  it.effect(
    'rejects unsupported reference/resource forms only during activation, before any effects',
    () =>
      Effect.gen(function* () {
        let effects = 0
        const unsupportedNodes = [
          ...[
            '#/properties/value',
            '#/properties/execution',
            '#/definitions/Value',
            '#',
            '#anchor',
            'other.json#/$defs/Value',
            '/schema',
            'https://example.test/schema'
          ].map($ref => ({ $ref })),
          { $id: 'https://example.test/schema' },
          { id: 'legacy-resource' },
          { $anchor: 'anchor' },
          { $dynamicAnchor: 'anchor' },
          { $dynamicRef: '#anchor' },
          { $recursiveRef: '#' },
          { $recursiveAnchor: true }
        ]
        const positions = (node: Readonly<Record<string, unknown>>) => [
          node,
          { properties: { value: node } },
          { $defs: { Value: node } },
          { definitions: { Value: node } },
          { items: node },
          { items: [node] },
          { prefixItems: [node] },
          { allOf: [node] },
          { anyOf: [node] },
          { oneOf: [node] },
          { additionalProperties: node },
          { patternProperties: { '^x': node } },
          { dependentSchemas: { value: node } },
          { dependencies: { value: node } },
          { not: node },
          { if: node },
          { then: node },
          { else: node },
          { contains: node },
          { propertyNames: node },
          { contentSchema: node },
          { unevaluatedProperties: node },
          { unevaluatedItems: node },
          { additionalItems: node }
        ]
        for (const node of unsupportedNodes) {
          for (const position of positions(node)) {
            const parameters = { type: 'object', ...position }
            const tool: ToolRegistration<unknown> = {
              def: ToolDef.make({ name: 'work', description: '', parameters, background: true }),
              access: 'write',
              validate: () =>
                Effect.sync(() => {
                  effects++
                }),
              execute: ({ call }) => {
                effects++
                return inline(call)
              }
            }
            const host = {
              accept: () => {
                effects++
                return Effect.succeed(receipt)
              }
            }
            expect(yield* resolve(tool, host).pipe(Effect.result)).toMatchObject({
              _tag: 'Failure',
              failure: { _tag: 'ToolRegistryError', cause: 'background_unsupported_schema' }
            })
            const plain = yield* resolve(tool)
            expect(plain.tools[0]).toBe(tool.def)
            expect(plain.tools[0]?.parameters).toBe(parameters)
            // A host alone never activates a non-opted tool or changes its schema.
            const disabled = { ...tool, background: false }
            expect((yield* resolve(disabled, host)).tools[0]).toBe(tool.def)
          }
        }
        expect(effects).toBe(0)
      })
  )

  it.effect(
    'preserves literal reference/resource-looking defaults/examples and ordinary $defs in provider payloads',
    () =>
      Effect.gen(function* () {
        const literal = {
          $id: 'business-id',
          $ref: '#/properties/execution',
          $dynamicRef: '#data',
          properties: { value: { $anchor: 'data' } }
        }
        const parameters = {
          type: 'object',
          properties: {
            value: {
              $ref: '#/$defs/Value',
              default: literal,
              examples: [literal],
              const: literal,
              enum: [literal]
            }
          },
          $defs: { Value: { type: 'object', default: literal, examples: [literal] } },
          default: literal,
          examples: [literal]
        }
        const tool: ToolRegistration<unknown> = {
          def: ToolDef.make({ name: 'work', description: '', parameters, background: true }),
          access: 'read',
          validate: () => Effect.void,
          execute: ({ call }) => inline(call)
        }
        const set = yield* resolve(tool, { accept: () => Effect.succeed(receipt) })
        const input = { model: 'test', systemPrompt: '', messages: [], tools: set.tools }
        const openai = yield* toOpenAiRequestBody(input, { maxCompletionTokens: 100 })
        const anthropic = yield* toAnthropicClaudeRequestBody(input, { maxTokens: 100 })
        const codex = yield* toOpenAiCodexRequestBody(input)
        for (const output of [
          openai.tools?.[0]?.function.parameters,
          anthropic.tools?.[0]?.input_schema,
          codex.tools?.[0]?.parameters
        ]) {
          expect(output).toMatchObject({
            properties: {
              arguments: {
                default: literal,
                examples: [literal],
                properties: {
                  value: {
                    $ref: '#/$defs/Value',
                    default: literal,
                    examples: [literal],
                    const: literal,
                    enum: [literal]
                  }
                }
              }
            },
            $defs: parameters.$defs
          })
        }
      })
  )

  it.effect(
    'lowers activated schemas through OpenAI, Codex and Anthropic without losing nested definitions',
    () =>
      Effect.gen(function* () {
        const set = yield* resolve(registration(inline), { accept: () => Effect.succeed(receipt) })
        const input = { model: 'test', systemPrompt: '', messages: [], tools: set.tools }
        const openai = yield* toOpenAiRequestBody(input, { maxCompletionTokens: 100 })
        const anthropic = yield* toAnthropicClaudeRequestBody(input, { maxTokens: 100 })
        const codex = yield* toOpenAiCodexRequestBody(input)
        for (const parameters of [
          openai.tools?.[0]?.function.parameters,
          anthropic.tools?.[0]?.input_schema,
          codex.tools?.[0]?.parameters
        ]) {
          expect(parameters).toMatchObject({
            type: 'object',
            required: ['execution', 'arguments'],
            additionalProperties: false,
            properties: {
              execution: { type: 'string', enum: ['foreground', 'background'] },
              arguments: {
                type: 'object',
                required: ['execution', 'arguments', 'background', 'nested'],
                properties: {
                  execution: { type: 'string' },
                  arguments: { type: 'number' },
                  background: { type: 'boolean' },
                  nested: { $ref: '#/$defs/Nested' }
                }
              }
            },
            $defs: { Nested: { type: 'object', required: ['value'] } }
          })
          expect(parameters).not.toHaveProperty('$ref')
        }
      })
  )
})

it.effect(
  'preserves makeTool structured invalid arguments with or without activation and custom messages',
  () =>
    Effect.gen(function* () {
      let effects = 0
      for (const custom of [false, true]) {
        const messages: unknown[] = []
        const tool = makeTool({
          name: 'work',
          description: '',
          access: 'write',
          background: true,
          parameters: paramsSchema,
          ...(custom
            ? {
                invalidParamsMessage: (error: unknown) => {
                  messages.push(error)
                  return 'Please fix business input'
                }
              }
            : {}),
          execute: ({ call }) => {
            effects++
            return inline(call)
          }
        })
        const plain = yield* resolve(tool)
        const activated = yield* resolve(tool, {
          accept: () => {
            effects++
            return Effect.succeed(receipt)
          }
        })
        const invalid = { ...params, arguments: 'wrong' }
        const expected = yield* plain.execute(
          ToolCall.make({ id: 'call-1', name: 'work', params: invalid })
        )
        expect(expected).toMatchObject({
          isError: true,
          structuredContent: {
            type: 'model_visible_tool_error',
            tool: 'work',
            reason: 'validation',
            message: expected.content
          }
        })
        for (const mode of ['foreground', 'background']) {
          const actual = yield* activated.execute(request(mode, invalid)).pipe(Effect.result)
          expect(actual).toMatchObject({ _tag: 'Success', success: expected })
        }
        if (custom) {
          expect(expected.content).toBe('Please fix business input')
          expect(messages).toHaveLength(3)
        }
      }
      expect(effects).toBe(0)
    })
)

it.effect(
  'does not convert raw validation or host admission ToolErrors into makeTool structured errors',
  () =>
    Effect.gen(function* () {
      let business = 0
      let admissions = 0
      const rawError = new ToolError({
        tool: 'work',
        cause: 'validation',
        message: 'raw policy validation'
      })
      const hostError = new ToolError({
        tool: 'work',
        cause: 'validation',
        message: 'host admission validation'
      })
      const raw: ToolRegistration<unknown> = {
        def: ToolDef.make({ name: 'work', description: '', parameters: {}, background: true }),
        access: 'write',
        validate: () => Effect.fail(rawError),
        execute: ({ call }) => {
          business++
          return inline(call)
        }
      }
      const rawSet = yield* resolve(raw, {
        accept: () => {
          admissions++
          return Effect.succeed(receipt)
        }
      })
      for (const mode of ['foreground', 'background']) {
        expect(yield* rawSet.execute(request(mode)).pipe(Effect.result)).toMatchObject({
          _tag: 'Failure',
          failure: rawError
        })
      }
      expect(admissions).toBe(0)
      const set = yield* resolve(
        registration(call => {
          business++
          return inline(call)
        }),
        {
          accept: () => {
            admissions++
            return Effect.fail(hostError)
          }
        }
      )
      expect(yield* set.execute(request('background')).pipe(Effect.result)).toMatchObject({
        _tag: 'Failure',
        failure: hostError
      })
      expect(admissions).toBe(1)
      expect(business).toBe(0)
    })
)
