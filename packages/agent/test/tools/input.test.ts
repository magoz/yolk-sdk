import { Effect } from 'effect'
import * as Schema from 'effect/Schema'
import { describe, expect, it } from '@effect/vitest'
import { ToolError } from '@yolk-sdk/agent/loop'
import { ToolApprovalPolicy, ToolCall, ToolDef } from '@yolk-sdk/agent/protocol'
import {
  makeInputTool,
  makeInputToolDef,
  makeInputToolModule,
  resolveTools,
  type ToolModule
} from '../../src/tools/index.ts'

// JSON Schema lowering drops this custom refinement (it lowers to { type: 'string' }),
// so the JSON hint admits 'evil' while the original Effect Schema owns execution validation.
const NotEvil = Schema.String.pipe(
  Schema.refine((value): value is string => value !== 'evil', { identifier: 'NotEvil' })
)

const contactResponse = Schema.Struct({
  email: Schema.String
})

type TestContext = {
  readonly marker: string
}

const context: TestContext = { marker: 'test' }

const evenRegistration = makeInputTool({
  name: 'word',
  description: 'Collect a word.',
  response: NotEvil,
  renderer: 'text-field',
  title: 'Word'
})

const evenModule: ToolModule<TestContext> = {
  id: 'word',
  tools: [evenRegistration]
}

describe('makeInputTool', () => {
  it('advertises a serializable descriptor without approval or background', () => {
    expect(evenRegistration.def.name).toBe('word')
    expect(evenRegistration.def.approval).toBeUndefined()
    expect(evenRegistration.def.background).toBeUndefined()
    expect(evenRegistration.def.execution).toBeUndefined()
    expect(evenRegistration.def.input?.kind).toBe('text-field')
    expect(evenRegistration.def.input?.title).toBe('Word')
    expect(evenRegistration.access).toBe('read')
    expect(JSON.parse(JSON.stringify(evenRegistration.def))).toEqual(
      JSON.parse(JSON.stringify(evenRegistration.def))
    )
  })

  it('advertises object-root parameters for no-argument input definitions', () => {
    const def = makeInputToolDef({ name: 'draft', description: 'Collect a draft.' })
    expect(def.parameters).toMatchObject({ type: 'object', additionalProperties: false })
  })

  it.effect('fences raw input executors in the resolved registry', () =>
    Effect.gen(function* () {
      let executed = false

      const toolSet = yield* resolveTools(
        [
          {
            id: 'raw',
            tools: [
              {
                ...evenRegistration,
                execute: () => {
                  executed = true

                  return Effect.fail(
                    new ToolError({ tool: 'word', cause: 'execution', message: 'unexpected' })
                  )
                }
              }
            ]
          }
        ],
        context
      )

      const error = yield* toolSet
        .execute(ToolCall.make({ id: 'raw', name: 'word', params: {} }))
        .pipe(Effect.flip)

      expect(error.cause).toBe('unavailable')
      expect(executed).toBe(false)
    })
  )

  it('defaults the renderer to custom', () => {
    const registration = makeInputTool({
      name: 'contact',
      description: 'Collect contact details.',
      response: contactResponse
    })

    expect(registration.def.input?.kind).toBe('custom')
  })

  it.effect('exposes the original Effect validator through resolved inputs', () =>
    Effect.gen(function* () {
      const toolSet = yield* resolveTools([evenModule], context)

      const handler = toolSet.inputs['word']

      if (handler === undefined) {
        throw new Error('Expected resolved input handler')
      }

      // The JSON hint admits 'evil'; the original schema rejects it.
      yield* Effect.flip(handler.validateResponse('evil'))
      yield* handler.validateResponse('kind')
      expect(handler.formatContent({ name: 'word', data: 'kind' })).toContain('word')
    })
  )

  it.effect('fails closed on direct dispatch without synthesizing user data', () =>
    Effect.gen(function* () {
      const toolSet = yield* resolveTools([evenModule], context)
      const call = ToolCall.make({ id: 'call_1', name: 'word', params: {} })

      const error = yield* toolSet.execute(call).pipe(Effect.flip)

      expect(error).toBeInstanceOf(ToolError)
      expect(error.cause).toBe('unavailable')
    })
  )

  it.effect('rejects approval on input registrations', () =>
    Effect.gen(function* () {
      const input = evenRegistration.def.input

      if (input === undefined) {
        throw new Error('Expected input descriptor')
      }

      const def = ToolDef.make({
        name: 'word',
        description: 'Collect a word.',
        parameters: {},
        approval: ToolApprovalPolicy.make({ mode: 'manual' }),
        input
      })

      const failure = yield* resolveTools(
        [{ id: 'word', tools: [{ ...evenRegistration, def }] }],
        context
      ).pipe(Effect.flip)

      expect(failure.cause).toBe('input_unsupported_policy')
    })
  )

  it.effect('rejects background on input registrations', () =>
    Effect.gen(function* () {
      const failure = yield* resolveTools(
        [{ id: 'word', tools: [{ ...evenRegistration, background: true }] }],
        context
      ).pipe(Effect.flip)

      expect(failure.cause).toBe('input_unsupported_policy')
    })
  )

  it.effect('requires a schema-backed registration for input defs', () =>
    Effect.gen(function* () {
      const def = makeInputToolDef({
        name: 'advertised',
        description: 'Advertised without a validator.',
        renderer: 'custom'
      })

      const failure = yield* resolveTools(
        [
          {
            id: 'advertised',
            tools: [
              {
                def,
                access: 'read',
                execute: ({ call }) =>
                  Effect.fail(
                    new ToolError({ tool: call.name, cause: 'unavailable', message: 'nope' })
                  )
              }
            ]
          }
        ],
        context
      ).pipe(Effect.flip)

      expect(failure.cause).toBe('input_validation_required')
    })
  )

  it.effect('rejects duplicate input tool names', () =>
    Effect.gen(function* () {
      const failure = yield* resolveTools([evenModule, evenModule], context).pipe(Effect.flip)

      expect(failure.cause).toBe('duplicate_tool')
    })
  )

  it('supports custom content projection and modules', () => {
    const inputModule = makeInputToolModule({
      name: 'contact',
      description: 'Collect contact details.',
      response: contactResponse,
      formatContent: ({ name, data }) => `Contact ${name}: ${JSON.stringify(data)}`
    })

    expect(inputModule.id).toBe('contact')
    expect(inputModule.tools[0]?.def.input?.kind).toBe('custom')
    expect(
      inputModule.tools[0]?.input?.formatContent({ name: 'contact', data: { email: 'x' } })
    ).toBe('Contact contact: {\"email\":\"x\"}')
  })
})
