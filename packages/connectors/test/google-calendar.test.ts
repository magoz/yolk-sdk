import { Effect, Layer, Predicate } from 'effect'
import * as Schema from 'effect/Schema'
import { describe, expect, it } from '@effect/vitest'
import { makeTool } from '@yolk-sdk/agent/tools'
import {
  ConnectorHttpClient,
  ConnectorHttpResponse,
  CredentialResolver,
  makeCredentialBinding,
  makeIntegration,
  OAuthCredential,
  type ConnectorHttpRequest
} from '@yolk-sdk/connectors'
import {
  googleCalendarCreateEventAction,
  GoogleCalendarCreateEventInput,
  googleCalendarDeleteEventAction,
  GoogleCalendarDeleteEventInput,
  GoogleCalendarEventDateTime,
  GoogleCalendarEventIdInput,
  googleCalendarEventsScope,
  googleCalendarGetEventAction,
  googleCalendarUpdateEventAction,
  GoogleCalendarUpdateEventInput,
  googleConnectorId,
  GoogleOAuthCredentialSlot
} from '@yolk-sdk/connectors/google'

const isJsonObject = (value: Schema.Json | undefined): value is Schema.JsonObject =>
  Predicate.isObjectOrArray(value) && !Array.isArray(value)

const objectField = (value: Schema.Json | undefined, key: string) =>
  isJsonObject(value) && Object.hasOwn(value, key) ? value[key] : undefined

const objectKeys = (value: Schema.Json | undefined): Array<string> =>
  isJsonObject(value) ? Object.keys(value) : []

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
        ['both boundary kinds', { date: '2026-05-21', dateTime: '2026-05-21T10:00:00Z' }],
        ['date with excess field', { date: '2026-05-21', extra: true }],
        ['dateTime with excess field', { dateTime: '2026-05-21T10:00:00Z', extra: true }]
      ]

      for (const [label, input] of invalidBoundaries) {
        const result = yield* Schema.decodeUnknownEffect(GoogleCalendarEventDateTime)(input).pipe(
          Effect.result
        )

        expect(result._tag, label).toBe('Failure')

        const encoded = yield* Schema.encodeUnknownEffect(GoogleCalendarEventDateTime)(input).pipe(
          Effect.result
        )

        expect(encoded._tag, `${label} during encoding`).toBe('Failure')
      }
    })
  )

  it.effect('advertises two strict non-null alternatives through makeTool', () =>
    Effect.gen(function* () {
      const registration = makeTool({
        name: googleCalendarCreateEventAction.id,
        description:
          googleCalendarCreateEventAction.description ?? 'Create a Google Calendar event.',
        parameters: googleCalendarCreateEventAction.inputSchema,
        access: 'write',
        execute: () => Effect.die('schema-only test')
      })

      const parameters = yield* Schema.decodeUnknownEffect(Schema.Json)(registration.def.parameters)

      const properties = objectField(parameters, 'properties')
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
  )
})

const calendarIntegration = makeIntegration({
  connectorId: googleConnectorId,
  credentialBindings: [
    makeCredentialBinding({ slotId: GoogleOAuthCredentialSlot.id, credentialRef: 'google' })
  ]
})

const calendarCredentials = Layer.succeed(
  CredentialResolver,
  CredentialResolver.of({
    resolve: () =>
      Effect.succeed(
        OAuthCredential.make({
          provider: 'google',
          accessToken: 'access-token',
          expiresAt: Date.now() + 60_000,
          scopes: [googleCalendarEventsScope]
        })
      )
  })
)

/** Records every request; answers each with `status` and an empty JSON event. */
const recordingCalendarHttp = (requests: Array<ConnectorHttpRequest>, status = 200) =>
  Layer.succeed(
    ConnectorHttpClient,
    ConnectorHttpClient.of({
      request: request => {
        requests.push(request)

        return Effect.succeed(
          ConnectorHttpResponse.make({
            status,
            headers: { 'content-type': 'application/json' },
            body: status === 204 ? '' : '{}'
          })
        )
      }
    })
  )

const eventsUrl = 'https://www.googleapis.com/calendar/v3/calendars/primary/events'

const writeCases = [
  {
    name: 'create',
    execute: googleCalendarCreateEventAction.execute,
    status: 200,
    input: {
      summary: 'Planning',
      start: { dateTime: '2026-05-21T10:00:00Z' },
      end: { dateTime: '2026-05-21T10:30:00Z' },
      attendees: [{ email: 'guest@example.test' }]
    },
    url: eventsUrl
  },
  {
    name: 'update',
    execute: googleCalendarUpdateEventAction.execute,
    status: 200,
    input: { eventId: 'event_1', summary: 'Renamed' },
    url: `${eventsUrl}/event_1`
  },
  {
    name: 'delete',
    execute: googleCalendarDeleteEventAction.execute,
    status: 204,
    input: { eventId: 'event_1' },
    url: `${eventsUrl}/event_1`
  }
] as const

describe('Google Calendar sendUpdates', () => {
  it.effect.each(writeCases)('$name sends the chosen sendUpdates as a query parameter', write =>
    Effect.gen(function* () {
      const requests: Array<ConnectorHttpRequest> = []

      yield* write
        .execute({
          integration: calendarIntegration,
          input: { ...write.input, sendUpdates: 'externalOnly' }
        })
        .pipe(
          Effect.provide(
            Layer.merge(calendarCredentials, recordingCalendarHttp(requests, write.status))
          )
        )

      expect(requests).toHaveLength(1)
      expect(requests[0]?.url).toBe(`${write.url}?sendUpdates=externalOnly`)
      expect(requests[0]?.body ?? '').not.toContain('sendUpdates')
    })
  )

  it.effect.each(writeCases)('$name sends no sendUpdates when the caller omits it', write =>
    Effect.gen(function* () {
      const requests: Array<ConnectorHttpRequest> = []

      yield* write
        .execute({ integration: calendarIntegration, input: write.input })
        .pipe(
          Effect.provide(
            Layer.merge(calendarCredentials, recordingCalendarHttp(requests, write.status))
          )
        )

      expect(requests[0]?.url).toBe(write.url)
    })
  )

  it.effect('deletes through executeTyped with GoogleCalendarDeleteEventInput', () =>
    Effect.gen(function* () {
      const requests: Array<ConnectorHttpRequest> = []

      const result = yield* googleCalendarDeleteEventAction
        .executeTyped({
          integration: calendarIntegration,
          input: GoogleCalendarDeleteEventInput.make({ eventId: 'event_1', sendUpdates: 'all' })
        })
        .pipe(
          Effect.provide(Layer.merge(calendarCredentials, recordingCalendarHttp(requests, 204)))
        )

      expect(result).toMatchObject({
        _tag: 'Success',
        value: { deleted: true, eventId: 'event_1' }
      })
      expect(requests[0]?.url).toBe(`${eventsUrl}/event_1?sendUpdates=all`)
    })
  )

  it.effect.each(writeCases)('$name sends an explicit "none"', write =>
    Effect.gen(function* () {
      const requests: Array<ConnectorHttpRequest> = []

      yield* write
        .execute({
          integration: calendarIntegration,
          input: { ...write.input, sendUpdates: 'none' }
        })
        .pipe(
          Effect.provide(
            Layer.merge(calendarCredentials, recordingCalendarHttp(requests, write.status))
          )
        )

      expect(requests[0]?.url).toBe(`${write.url}?sendUpdates=none`)
    })
  )

  it.effect('keeps accepting existing GoogleCalendarEventIdInput deletes on executeTyped', () =>
    Effect.gen(function* () {
      const requests: Array<ConnectorHttpRequest> = []

      const result = yield* googleCalendarDeleteEventAction
        .executeTyped({
          integration: calendarIntegration,
          input: GoogleCalendarEventIdInput.make({ eventId: 'event_1' })
        })
        .pipe(
          Effect.provide(Layer.merge(calendarCredentials, recordingCalendarHttp(requests, 204)))
        )

      expect(result).toMatchObject({ _tag: 'Success' })
      expect(requests[0]?.url).toBe(`${eventsUrl}/event_1`)
    })
  )

  it.effect('sends sendUpdates through executeTyped on create and update', () =>
    Effect.gen(function* () {
      const requests: Array<ConnectorHttpRequest> = []
      const layer = Layer.merge(calendarCredentials, recordingCalendarHttp(requests))

      yield* googleCalendarCreateEventAction
        .executeTyped({
          integration: calendarIntegration,
          input: GoogleCalendarCreateEventInput.make({
            summary: 'Planning',
            start: { dateTime: '2026-05-21T10:00:00Z' },
            end: { dateTime: '2026-05-21T10:30:00Z' },
            sendUpdates: 'all'
          })
        })
        .pipe(Effect.provide(layer))

      yield* googleCalendarUpdateEventAction
        .executeTyped({
          integration: calendarIntegration,
          input: GoogleCalendarUpdateEventInput.make({ eventId: 'event_1', sendUpdates: 'all' })
        })
        .pipe(Effect.provide(layer))

      expect(requests.map(request => request.url)).toEqual([
        `${eventsUrl}?sendUpdates=all`,
        `${eventsUrl}/event_1?sendUpdates=all`
      ])
    })
  )

  // Action descriptions always reach the model; providers that flatten tool schemas (Anthropic)
  // drop an optional enum's values and description, so each write description must explain them.
  it('explains every sendUpdates value and the default in each write description', () => {
    for (const action of [
      googleCalendarCreateEventAction,
      googleCalendarUpdateEventAction,
      googleCalendarDeleteEventAction
    ]) {
      expect(action.description).toContain('"all" every guest')
      expect(action.description).toContain(
        '"externalOnly" only guests who do not use Google Calendar'
      )
      expect(action.description).toContain('"none" nobody')
      expect(action.description).toContain('Without sendUpdates, Google normally notifies nobody')
    }

    expect(googleCalendarUpdateEventAction.description).toContain('replace the whole guest list')
  })

  it.effect('keeps the sendUpdates description in the registry tool schema', () =>
    Effect.gen(function* () {
      const registration = makeTool({
        name: googleCalendarUpdateEventAction.id,
        description: googleCalendarUpdateEventAction.description ?? '',
        parameters: googleCalendarUpdateEventAction.inputSchema,
        access: 'write',
        execute: () => Effect.die('schema-only test')
      })

      const parameters = yield* Schema.decodeUnknownEffect(Schema.Json)(registration.def.parameters)
      const sendUpdates = objectField(objectField(parameters, 'properties'), 'sendUpdates')

      expect(JSON.stringify(sendUpdates)).toContain('only guests who do not use Google Calendar')
    })
  )

  it.effect('encodes calendar and event ids before the sendUpdates query', () =>
    Effect.gen(function* () {
      const requests: Array<ConnectorHttpRequest> = []

      yield* googleCalendarDeleteEventAction
        .execute({
          integration: calendarIntegration,
          input: {
            calendarId: 'team@group.calendar.google.com',
            eventId: 'a/b?c',
            sendUpdates: 'all'
          }
        })
        .pipe(
          Effect.provide(Layer.merge(calendarCredentials, recordingCalendarHttp(requests, 204)))
        )

      expect(requests[0]?.url).toBe(
        'https://www.googleapis.com/calendar/v3/calendars/team%40group.calendar.google.com/events/a%2Fb%3Fc?sendUpdates=all'
      )
    })
  )

  it.effect('leaves get_event without sendUpdates', () =>
    Effect.gen(function* () {
      const registration = makeTool({
        name: googleCalendarGetEventAction.id,
        description: googleCalendarGetEventAction.description ?? '',
        parameters: googleCalendarGetEventAction.inputSchema,
        access: 'read',
        execute: () => Effect.die('schema-only test')
      })

      const parameters = yield* Schema.decodeUnknownEffect(Schema.Json)(registration.def.parameters)

      expect(objectKeys(objectField(parameters, 'properties')).sort()).toEqual([
        'calendarId',
        'eventId'
      ])
    })
  )

  it.effect.each(writeCases)('$name rejects an unknown sendUpdates before any request', write =>
    Effect.gen(function* () {
      const requests: Array<ConnectorHttpRequest> = []

      const result = yield* write
        .execute({
          integration: calendarIntegration,
          input: { ...write.input, sendUpdates: 'everyone' }
        })
        .pipe(
          Effect.provide(
            Layer.merge(calendarCredentials, recordingCalendarHttp(requests, write.status))
          ),
          Effect.result
        )

      expect(result._tag).toBe('Failure')
      expect(requests).toHaveLength(0)
    })
  )

  it.effect.each([
    googleCalendarCreateEventAction,
    googleCalendarUpdateEventAction,
    googleCalendarDeleteEventAction
  ])('advertises sendUpdates as an optional enum on $id', action =>
    Effect.gen(function* () {
      const registration = makeTool({
        name: action.id,
        description: action.description ?? '',
        parameters: action.inputSchema,
        access: 'write',
        execute: () => Effect.die('schema-only test')
      })

      const parameters = yield* Schema.decodeUnknownEffect(Schema.Json)(registration.def.parameters)
      const sendUpdates = objectField(objectField(parameters, 'properties'), 'sendUpdates')

      // Optional fields lower to `anyOf: [<schema>, null]`; null decodes as absent.
      const alternatives = objectField(sendUpdates, 'anyOf')

      const enumMember = Array.isArray(alternatives)
        ? alternatives.find(member => objectField(member, 'enum') !== undefined)
        : undefined

      expect(objectField(enumMember, 'enum')).toEqual(['all', 'externalOnly', 'none'])
      expect(objectField(parameters, 'required')).not.toContain('sendUpdates')
    })
  )
})
