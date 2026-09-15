import { describe, expect, it } from '@effect/vitest'
import {
  replaceLoneSurrogatesDeep,
  type inferTextDocumentMimeType,
  type textDocumentMimeTypeFromFilename
} from '@yolk-sdk/agent/protocol'

type Equal<A, B> =
  (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false

const replaceLoneSurrogatesDeepReturnsUnknown: Equal<
  ReturnType<typeof replaceLoneSurrogatesDeep>,
  unknown
> = true

describe('text document MIME inference', () => {
  it('keeps public helper return types as string or undefined', () => {
    const filenameReturnType: Equal<
      ReturnType<typeof textDocumentMimeTypeFromFilename>,
      string | undefined
    > = true

    const inferredReturnType: Equal<
      ReturnType<typeof inferTextDocumentMimeType>,
      string | undefined
    > = true

    expect(filenameReturnType).toBe(true)
    expect(inferredReturnType).toBe(true)
  })
})

describe('replaceLoneSurrogatesDeep object-predicate5', () => {
  it('keeps the public return type unknown', () => {
    expect(replaceLoneSurrogatesDeepReturnsUnknown).toBe(true)

    const walked: unknown = replaceLoneSurrogatesDeep({ text: 'ok' })

    expect(walked).toEqual({ text: 'ok' })
  })

  it('walks arrays, returns null, and leaves functions untouched', () => {
    const fn = () => 'broken \uD800'

    expect(replaceLoneSurrogatesDeep(['a\uD800', 1, null, true])).toEqual([
      'a\uFFFD',
      1,
      null,
      true
    ])
    expect(replaceLoneSurrogatesDeep(null)).toBe(null)
    expect(replaceLoneSurrogatesDeep(fn)).toBe(fn)
  })

  it('rebuilds boxed strings through own enumerable keys', () => {
    expect(replaceLoneSurrogatesDeep(Object('a\uD800b'))).toEqual({
      '0': 'a',
      '1': '\uFFFD',
      '2': 'b'
    })
  })

  it('walks proxy objects and UTF-16 keys without treating the proxy as a string', () => {
    const value = new Proxy({ text: 'broken \uD800 high', ['bad\uDC00key']: 'low \uDC00 tail' }, {})

    expect(replaceLoneSurrogatesDeep(value)).toEqual({
      text: 'broken \uFFFD high',
      ['bad\uFFFDkey']: 'low \uFFFD tail'
    })
  })

  it('keeps valid surrogate pairs on array objects', () => {
    expect(replaceLoneSurrogatesDeep(['hello 👋🎉', { count: 3 }])).toEqual([
      'hello 👋🎉',
      { count: 3 }
    ])
  })
})
