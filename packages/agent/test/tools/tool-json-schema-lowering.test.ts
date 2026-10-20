import * as Schema from 'effect/Schema'
import { describe, expect, it } from '@effect/vitest'
import { toolJsonSchemaOmittedNullComment } from '@yolk-sdk/agent/protocol'
import { toolJsonSchemaFromSchema } from '@yolk-sdk/agent/tools'
import { withoutToolJsonSchemaOmittedNullMarker } from '../../src/protocol/tool-json-schema-marker.ts'
import { toolJsonSchemaFromDocument } from '../../src/tools/registry.ts'

const omitted = { type: 'null', $comment: toolJsonSchemaOmittedNullComment }

/** What `toolJsonSchemaFromSchema` produced before the omitted-null marker existed. */
const previousLowering = (schema: Schema.Top) =>
  toolJsonSchemaFromDocument(
    schema,
    Schema.toJsonSchemaDocument(schema, { onExcessProperty: 'error' })
  )

interface Node {
  readonly value: string
  readonly next?: Node | undefined
}

const Node = Schema.Struct({
  value: Schema.String,
  next: Schema.optional(Schema.suspend((): Schema.Codec<Node> => Node))
}).annotate({ identifier: 'Node' })

const Shared = Schema.Struct({
  id: Schema.String,
  note: Schema.optional(Schema.String)
}).annotate({ identifier: 'Shared' })

const Recurring = Schema.TaggedStruct('Recurring', { cron: Schema.String })

const OneTime = Schema.TaggedStruct('OneTime', {
  runAt: Schema.String,
  timezone: Schema.optional(Schema.String)
})

class Person extends Schema.Class<Person>('Person')({
  name: Schema.String,
  nick: Schema.optional(Schema.String)
}) {}

const families: ReadonlyArray<readonly [string, Schema.Top]> = [
  [
    'struct fields',
    Schema.Struct({
      required: Schema.String,
      optional: Schema.optional(Schema.Number),
      optionalKey: Schema.optionalKey(Schema.String),
      nullable: Schema.NullOr(Schema.String),
      clearable: Schema.optional(Schema.NullOr(Schema.String)),
      cleared: Schema.optionalKey(Schema.NullOr(Schema.Boolean)),
      undefinedOr: Schema.UndefinedOr(Schema.String),
      described: Schema.optional(Schema.String).annotate({ description: 'Described.' }),
      literals: Schema.optional(Schema.Literals(['a', 'b']))
    })
  ],
  [
    'unions',
    Schema.Struct({
      mode: Schema.Union([Schema.Literal('auto'), Schema.Struct({ value: Schema.String })])
    })
  ],
  ['root tagged union', Schema.Union([Recurring, OneTime])],
  [
    'optional tagged union',
    Schema.Struct({ spec: Schema.optional(Schema.Union([Recurring, OneTime])) })
  ],
  [
    'records',
    Schema.Struct({
      labels: Schema.Record(Schema.String, Schema.String),
      scores: Schema.Record(Schema.String, Schema.UndefinedOr(Schema.Number))
    })
  ],
  [
    'tuples',
    Schema.Struct({ pair: Schema.Tuple([Schema.String, Schema.optional(Schema.Number)]) })
  ],
  [
    'arrays',
    Schema.Struct({
      items: Schema.Array(
        Schema.Struct({ id: Schema.String, tag: Schema.optional(Schema.String) })
      ),
      nulls: Schema.Array(Schema.NullOr(Schema.String))
    })
  ],
  ['identified definitions', Schema.Struct({ a: Shared, b: Schema.optional(Shared) })],
  [
    'identified optional',
    Schema.Struct({
      note: Schema.optional(Schema.String).annotate({ identifier: 'OptionalNote' })
    })
  ],
  ['recursive suspend', Schema.Struct({ head: Schema.optional(Node) })],
  ['class', Schema.Struct({ person: Person, maybe: Schema.optional(Person) })],
  ['void', Schema.Struct({ v: Schema.optional(Schema.Void) })],
  [
    'authored $comment',
    Schema.Struct({
      x: Schema.String.annotate({ $comment: 'authored' }),
      y: Schema.optional(Schema.String.annotate({ $comment: 'authored' }))
    })
  ]
]

describe('tool JSON Schema lowering', () => {
  it.each(families)('equals Schema.toJsonSchemaDocument plus markers: %s', (_, schema) => {
    const lowered = toolJsonSchemaFromSchema(schema)
    const previous = previousLowering(schema)

    // Byte-identical, key order included.
    expect(JSON.stringify(withoutToolJsonSchemaOmittedNullMarker(lowered))).toBe(
      JSON.stringify(previous)
    )
  })

  it('emits no schema-authored $comment', () => {
    const lowered = JSON.stringify(
      toolJsonSchemaFromSchema(
        Schema.Struct({ x: Schema.String.annotate({ $comment: 'authored' }) })
      )
    )

    expect(lowered).not.toContain('$comment')
    expect(lowered).not.toContain('authored')
  })

  it('marks a recursive identified schema reached through Schema.suspend', () => {
    expect(toolJsonSchemaFromSchema(Schema.Struct({ head: Schema.optional(Node) }))).toEqual({
      type: 'object',
      properties: { head: { anyOf: [{ $ref: '#/$defs/Node' }, omitted] } },
      additionalProperties: false,
      $defs: {
        Node: {
          type: 'object',
          properties: {
            value: { type: 'string' },
            next: { anyOf: [{ $ref: '#/$defs/Node' }, omitted] }
          },
          required: ['value'],
          additionalProperties: false
        }
      }
    })
  })

  it('marks a definition first reached through Schema.suspend', () => {
    const viaSuspend = Schema.Struct({
      head: Schema.optional(Schema.suspend((): Schema.Codec<Node> => Node))
    })

    expect(toolJsonSchemaFromSchema(viaSuspend)).toMatchObject({
      properties: { head: { anyOf: [{ $ref: '#/$defs/Node' }, omitted] } },
      $defs: { Node: { properties: { next: { anyOf: [{ $ref: '#/$defs/Node' }, omitted] } } } }
    })
  })

  it('marks optional tuple elements and record values', () => {
    const number = {
      anyOf: [{ type: 'number' }, { type: 'string', enum: ['Infinity', '-Infinity', 'NaN'] }]
    }

    expect(
      toolJsonSchemaFromSchema(
        Schema.Struct({
          pair: Schema.Tuple([Schema.String, Schema.optional(Schema.Number)]),
          scores: Schema.Record(Schema.String, Schema.UndefinedOr(Schema.Number))
        })
      )
    ).toMatchObject({
      properties: {
        pair: { prefixItems: [{ type: 'string' }, { anyOf: [number, omitted] }] },
        scores: { additionalProperties: { anyOf: [number, omitted] } }
      }
    })
  })

  it('marks a shared definition whichever property reaches it first', () => {
    const shared = {
      type: 'object',
      properties: { id: { type: 'string' }, note: { anyOf: [{ type: 'string' }, omitted] } },
      required: ['id'],
      additionalProperties: false
    }

    const requiredFirst = toolJsonSchemaFromSchema(
      Schema.Struct({ a: Shared, b: Schema.optional(Shared) })
    )

    const optionalFirst = toolJsonSchemaFromSchema(
      Schema.Struct({ b: Schema.optional(Shared), a: Shared })
    )

    expect(requiredFirst).toMatchObject({ $defs: { Shared: shared } })
    expect(optionalFirst).toMatchObject({ $defs: { Shared: shared } })
  })
})
