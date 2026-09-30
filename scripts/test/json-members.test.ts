import { describe, expect, it } from 'vitest'
import { scanJsonObjects, unredactedMembers, type JsonMember } from '../json-members.ts'

const objectsOf = (text: string) => {
  const objects: Array<ReadonlyArray<JsonMember>> = []
  const scanned = scanJsonObjects(text, members => objects.push(members))

  return { scanned, objects }
}

describe('json-members', () => {
  it('reports every member in wire order, repeated keys included, inner objects first', () => {
    const { scanned, objects } = objectsOf(
      ' {"a":"x","b":{"c":1.5e3},"a":null,"d":[true,false,"s"],"us\\u0065r":"\\"q\\""} '
    )

    expect(scanned).toBe(true)
    expect(objects).toEqual([
      [{ key: 'c', kind: 'number', text: undefined }],
      [
        { key: 'a', kind: 'string', text: 'x' },
        { key: 'b', kind: 'object', text: undefined },
        { key: 'a', kind: 'null', text: undefined },
        { key: 'd', kind: 'array', text: undefined },
        { key: 'user', kind: 'string', text: '"q"' }
      ]
    ])
  })

  it('rejects anything but exactly one valid JSON value', () => {
    for (const text of [
      '',
      '{"a":1',
      '{"a":1}}',
      '{"a":1} {"b":2}',
      '{a:1}',
      '{"a":01}',
      '{"a":"unterminated}',
      '{"a":"raw\ncontrol"}',
      '[1,]',
      'data: {"a":1}',
      `${'['.repeat(300)}${']'.repeat(300)}`
    ]) {
      expect(
        scanJsonObjects(text, () => undefined),
        text
      ).toBe(false)
    }

    expect(scanJsonObjects('[[],{},"",0,-1.25,true,null]', () => undefined)).toBe(true)
  })

  it('flags non-placeholder values and repeated redacted keys only', () => {
    expect(
      unredactedMembers(
        '{"user":"redacted","key":null,"other":"x","nested":{"key":""},"list":[{"user":7}]}',
        ['user', 'key'],
        'redacted'
      )
    ).toEqual(new Set(['user']))
    expect(unredactedMembers('{"key":"redacted","key":"redacted"}', ['key'], 'redacted')).toEqual(
      new Set(['key'])
    )
    expect(unredactedMembers('{"key":"redacted"}', ['key'], 'redacted')).toEqual(new Set())
    expect(unredactedMembers('{"key":', ['key'], 'redacted')).toBeUndefined()
  })
})
