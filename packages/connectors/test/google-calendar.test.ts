import { Effect } from 'effect'
import * as Schema from 'effect/Schema'
import { describe, expect, it } from '@effect/vitest'
import { makeTool } from '@yolk-sdk/agent/tools'
import {
  googleCalendarCreateEventAction,
  GoogleCalendarEventDateTime
} from '@yolk-sdk/connectors/google'

const objectField = (value: unknown, key: string): unknown =>
  typeof value === 'object' && value !== null
    ? Object.getOwnPropertyDescriptor(value, key)?.value
    : undefined

const objectKeys = (value: unknown): Array<string> =>
  typeof value === 'object' && value !== null ? Object.keys(value) : []

describe('Google Calendar event date/time boundaries', () => {
  it.effect('decodes date-only and timed boundaries', () =>
    Effect.gen(function* () {
      const decode = Schema.decodeUnknownEffect(GoogleCalendarEventDateTime)

      expect(yield* decode({ date: '2026-05-21' })).toEqual({ date: '2026-05-21' })
      expect(
        yield* decode({
          dateTime: '2026-05-21T10:00:00-04:00',
          timeZone: 'America/New_York'
        })
      ).toEqual({ dateTime: '2026-05-21T10:00:00-04:00', timeZone: 'America/New_York' })
    })
  )

  it.effect('rejects invalid boundaries', () =>
    Effect.gen(function* () {
      const invalidBoundaries: ReadonlyArray<readonly [string, unknown]> = [
        ['null date', { date: null }],
        ['null dateTime', { dateTime: null }],
        ['empty date', { date: '' }],
        ['empty dateTime', { dateTime: '' }],
        ['whitespace date', { date: '   ' }],
        ['whitespace dateTime', { dateTime: '   ' }],
        ['neither boundary', {}],
        ['timezone only', { timeZone: 'UTC' }],
        ['both boundary kinds', { date: '2026-05-21', dateTime: '2026-05-21T10:00:00Z' }]
      ]

      for (const [label, input] of invalidBoundaries) {
        const result = yield* Schema.decodeUnknownEffect(GoogleCalendarEventDateTime)(input).pipe(
          Effect.result
        )

        expect(result._tag, label).toBe('Failure')
      }
    })
  )

  it('advertises two strict non-null alternatives through makeTool', () => {
    const registration = makeTool({
      name: googleCalendarCreateEventAction.id,
      description: googleCalendarCreateEventAction.description ?? 'Create a Google Calendar event.',
      parameters: googleCalendarCreateEventAction.inputSchema,
      access: 'write',
      execute: () => Effect.die('schema-only test')
    })

    const properties = objectField(registration.def.parameters, 'properties')
    const start = objectField(properties, 'start')
    const end = objectField(properties, 'end')
    const alternatives = objectField(start, 'anyOf')

    expect(Array.isArray(alternatives)).toBe(true)

    if (!Array.isArray(alternatives)) return

    expect(alternatives).toHaveLength(2)
    expect(end).toEqual(start)

    const dateOnly = alternatives[0]
    const timed = alternatives[1]
    const dateOnlyProperties = objectField(dateOnly, 'properties')
    const timedProperties = objectField(timed, 'properties')
    const date = objectField(dateOnlyProperties, 'date')
    const dateTime = objectField(timedProperties, 'dateTime')

    expect(dateOnly).toMatchObject({
      type: 'object',
      required: ['date'],
      additionalProperties: false
    })
    expect(timed).toMatchObject({
      type: 'object',
      required: ['dateTime'],
      additionalProperties: false
    })
    expect(objectKeys(dateOnlyProperties).sort()).toEqual(['date', 'timeZone'])
    expect(objectKeys(timedProperties).sort()).toEqual(['dateTime', 'timeZone'])
    expect(objectField(date, 'type')).toBe('string')
    expect(objectField(dateTime, 'type')).toBe('string')
    expect(JSON.stringify(date)).not.toContain('null')
    expect(JSON.stringify(dateTime)).not.toContain('null')
  })
})
