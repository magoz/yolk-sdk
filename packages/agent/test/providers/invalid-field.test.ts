import { describe, expect, it } from '@effect/vitest'
import * as Result from 'effect/Result'
import * as Schema from 'effect/Schema'
import { invalidFieldOf } from '../../src/providers/invalid-field-internal.ts'

const decodeFailure = (schema: Schema.Codec<unknown, unknown>, input: Schema.Json) => {
  const result = Schema.decodeUnknownResult(schema)(input)

  if (Result.isSuccess(result)) throw new Error('expected the decode to fail')

  return invalidFieldOf(input, result.failure)
}

describe('invalidFieldOf', () => {
  it('names the root when the payload is not an object', () => {
    expect(decodeFailure(Schema.Struct({ a: Schema.String }), 'secret')).toEqual({
      path: '$',
      received: 'string'
    })
  })

  it('names a missing required field', () => {
    expect(decodeFailure(Schema.Struct({ a: Schema.String }), {})).toEqual({
      path: '$.a',
      received: 'missing'
    })
  })

  it('collapses array indices and reports the JSON type found', () => {
    const schema = Schema.Struct({ items: Schema.Array(Schema.Struct({ id: Schema.String })) })

    expect(decodeFailure(schema, { items: [{ id: 'ok' }, { id: [1] }] })).toEqual({
      path: '$.items[].id',
      received: 'array'
    })
  })

  it('masks field names that are not identifiers', () => {
    const schema = Schema.Struct({ 'secret value': Schema.Number })

    expect(decodeFailure(schema, { 'secret value': null })).toEqual({
      path: '$.?',
      received: 'null'
    })
  })
})
