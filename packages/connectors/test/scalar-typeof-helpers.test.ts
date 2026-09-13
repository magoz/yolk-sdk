import { Effect, Layer, Predicate } from 'effect'
import * as Schema from 'effect/Schema'
import { describe, expect, it } from '@effect/vitest'
import { resolveTools } from '@yolk-sdk/agent/tools'
import {
  ActionResult,
  defineAction,
  defineConnector,
  makeIntegration,
  optionalStringConfig,
  requiredStringConfig
} from '@yolk-sdk/connectors'
import { makeConnectorToolModule } from '@yolk-sdk/connectors/agent'
import { createR2Object, updateR2Object, R2ObjectClient } from '@yolk-sdk/connectors/r2-storage'
import type { R2ObjectCondition } from '@yolk-sdk/connectors/r2-storage'

const EchoInput = Schema.Struct({ text: Schema.String })

const EchoOutput = Schema.Struct({ value: Schema.String })

const echoAction = defineAction({
  id: 'test.echo',
  description: 'Echo test action.',
  inputSchema: EchoInput,
  outputSchema: EchoOutput,
  execute: ({ input }) => Effect.succeed(ActionResult.success({ value: input.text }))
})

const textAction = defineAction({
  id: 'test.text',
  description: 'Return a string payload.',
  inputSchema: Schema.Struct({}),
  outputSchema: Schema.String,
  execute: () => Effect.succeed(ActionResult.success('plain'))
})

const TestConnector = defineConnector({
  id: 'test',
  actions: [echoAction, textAction]
})

const integration = makeIntegration({ connectorId: 'test' })

const budget = { maxBytes: 10, maxMetadataBytes: 1000, maxErrorBodyBytes: 32 }

const bytes = new Uint8Array([0, 255, 128])

describe('connector scalar config helpers', () => {
  it.effect('requiredStringConfig keeps non-empty strings including padded values', () =>
    Effect.gen(function* () {
      const padded = makeIntegration({ connectorId: 'test', config: { chatId: ' a ' } })
      const value = yield* requiredStringConfig(padded, 'chatId')
      expect(value).toBe(' a ')
    })
  )

  it.effect('requiredStringConfig fails for blank and non-string primitives', () =>
    Effect.gen(function* () {
      const cases = [
        makeIntegration({ connectorId: 'test' }),
        makeIntegration({ connectorId: 'test', config: { chatId: '   ' } }),
        makeIntegration({ connectorId: 'test', config: { chatId: 1 } }),
        makeIntegration({ connectorId: 'test', config: { chatId: Number.NaN } }),
        makeIntegration({ connectorId: 'test', config: { chatId: Number.POSITIVE_INFINITY } }),
        makeIntegration({ connectorId: 'test', config: { chatId: true } }),
        makeIntegration({ connectorId: 'test', config: { chatId: null } }),
        makeIntegration({ connectorId: 'test', config: { chatId: ['x'] } }),
        makeIntegration({ connectorId: 'test', config: { chatId: { x: 'y' } } }),
        makeIntegration({
          connectorId: 'test',
          config: { chatId: Object('boxed') }
        })
      ]

      for (const candidate of cases) {
        const result = yield* requiredStringConfig(candidate, 'chatId').pipe(Effect.result)
        expect(result._tag).toBe('Failure')
      }
    })
  )

  it('optionalStringConfig returns only trimmed-nonempty strings', () => {
    expect(
      optionalStringConfig(
        makeIntegration({ connectorId: 'test', config: { publicUrl: 'ok' } }),
        'publicUrl'
      )
    ).toBe('ok')
    expect(
      optionalStringConfig(
        makeIntegration({ connectorId: 'test', config: { publicUrl: '  ' } }),
        'publicUrl'
      )
    ).toBeUndefined()
    expect(
      optionalStringConfig(makeIntegration({ connectorId: 'test' }), 'publicUrl')
    ).toBeUndefined()
    expect(
      optionalStringConfig(
        makeIntegration({ connectorId: 'test', config: { publicUrl: 0 } }),
        'publicUrl'
      )
    ).toBeUndefined()
    expect(
      optionalStringConfig(
        makeIntegration({ connectorId: 'test', config: { publicUrl: Number.NaN } }),
        'publicUrl'
      )
    ).toBeUndefined()
    expect(
      optionalStringConfig(
        makeIntegration({ connectorId: 'test', config: { publicUrl: () => 'fn' } }),
        'publicUrl'
      )
    ).toBeUndefined()
    expect(
      optionalStringConfig(
        makeIntegration({ connectorId: 'test', config: { publicUrl: [] } }),
        'publicUrl'
      )
    ).toBeUndefined()
  })
})

describe('connector agent scalar success and resolver discriminants', () => {
  it.effect('serializes object success as JSON and keeps string success unquoted', () =>
    Effect.gen(function* () {
      const toolSet = yield* resolveTools(
        [makeConnectorToolModule(TestConnector, { integration, layer: Layer.empty })],
        {}
      )

      const objectResult = yield* toolSet.execute({
        id: 'call_1',
        name: 'test.echo',
        params: { text: 'hi' }
      })

      const stringResult = yield* toolSet.execute({ id: 'call_2', name: 'test.text', params: {} })

      expect(objectResult).toMatchObject({
        toolCallId: 'call_1',
        content: JSON.stringify({ value: 'hi' }),
        structuredContent: { value: 'hi' }
      })
      expect(stringResult).toMatchObject({
        toolCallId: 'call_2',
        content: 'plain',
        structuredContent: 'plain'
      })
    })
  )

  it.effect('accepts function integration and access resolvers', () =>
    Effect.gen(function* () {
      const toolSet = yield* resolveTools(
        [
          makeConnectorToolModule(TestConnector, {
            integration: () => Effect.succeed(integration),
            layer: Layer.empty,
            access: () => 'read'
          })
        ],
        {}
      )

      const result = yield* toolSet.execute({
        id: 'call_3',
        name: 'test.echo',
        params: { text: 'fn' }
      })

      expect(toolSet.metadata).toContainEqual({
        moduleId: 'test',
        name: 'test.echo',
        access: 'read'
      })
      expect(result).toMatchObject({
        toolCallId: 'call_3',
        content: JSON.stringify({ value: 'fn' })
      })
    })
  )
})

describe('R2 expectedEtag presence still selects etag vs absent', () => {
  it.effect('create stays absent and update with string etag stays etag', () =>
    Effect.gen(function* () {
      const conditions: R2ObjectCondition[] = []

      const layer = Layer.succeed(R2ObjectClient, {
        put: req => {
          conditions.push(req.condition)

          return Effect.succeed({ etag: '"opaque"', size: req.bytes.byteLength })
        },
        get: () => Effect.succeed({ etag: '"opaque"', size: 3, bytes })
      })

      const r2 = makeIntegration({ connectorId: 'r2-storage' })

      yield* createR2Object(r2, { bucket: 'bucket', key: 'x', bytes }, budget).pipe(
        Effect.provide(layer)
      )
      yield* updateR2Object(
        r2,
        { bucket: 'bucket', key: 'x', expectedEtag: '"old"', bytes },
        budget
      ).pipe(Effect.provide(layer))

      expect(conditions).toEqual([{ kind: 'absent' }, { kind: 'etag', etag: '"old"' }])
    })
  )
})

describe('pinned Predicate scalar parity table', () => {
  it('matches Effect Predicate isString/isNumber/isFunction on hostile primitives', () => {
    const fn = () => 1
    expect(Predicate.isString('x')).toBe(true)
    expect(Predicate.isString('')).toBe(true)
    expect(Predicate.isString(1)).toBe(false)
    expect(Predicate.isString(Number.NaN)).toBe(false)
    expect(Predicate.isString(Number.POSITIVE_INFINITY)).toBe(false)
    expect(Predicate.isString(undefined)).toBe(false)
    expect(Predicate.isString(null)).toBe(false)
    expect(Predicate.isString(fn)).toBe(false)
    expect(Predicate.isString([])).toBe(false)
    expect(Predicate.isString(Object('boxed'))).toBe(false)

    expect(Predicate.isNumber(0)).toBe(true)
    expect(Predicate.isNumber(Number.NaN)).toBe(true)
    expect(Predicate.isNumber(Number.NEGATIVE_INFINITY)).toBe(true)
    expect(Predicate.isNumber('1')).toBe(false)
    expect(Predicate.isNumber(Object(1))).toBe(false)
    expect(Predicate.isNumber(fn)).toBe(false)
    expect(Predicate.isNumber(null)).toBe(false)
    expect(Predicate.isNumber(undefined)).toBe(false)
    expect(Predicate.isNumber([])).toBe(false)

    expect(Predicate.isFunction(fn)).toBe(true)
    expect(Predicate.isFunction(async () => 1)).toBe(true)
    expect(Predicate.isFunction(class Target {})).toBe(true)
    expect(Predicate.isFunction('fn')).toBe(false)
    expect(Predicate.isFunction(1)).toBe(false)
    expect(Predicate.isFunction(null)).toBe(false)
    expect(Predicate.isFunction(undefined)).toBe(false)
    expect(Predicate.isFunction([])).toBe(false)
  })
})
