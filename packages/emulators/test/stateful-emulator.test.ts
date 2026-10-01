/**
 * The shared `src/stateful-emulator.ts` wrapper's opt-in guarantees, over a fake core (no
 * `@emulators/core`): multi-segment `{name+}` parameters, raw parameter patterns (matched in full,
 * no `g` or `y` flag), the fail-closed mode (constant-text ledger entries for unrecognised
 * requests and Authorization headers, every parameter patterned at build, the bearer guarded as a
 * secret in queries, recorded headers, bodies, and plan-time reasons), and that an emulator
 * without `failClosed` keeps the earlier behaviour (the Dropbox and Notion suites cover it fully).
 */
import { Predicate } from 'effect'
import { describe, expect, it } from '@effect/vitest'
import {
  exactObject,
  isNotEmulated,
  makeStatefulEmulator,
  notEmulated,
  routeMatcher,
  statefulRoute,
  type StatefulEmulatorConfig,
  type StatefulRoute
} from '../src/stateful-emulator.ts'

type State = { writes: number }

const echo = statefulRoute<State, undefined, string>(
  {
    method: 'GET',
    path: '/files/{path+}',
    kind: 'connector',
    write: false,
    caseIds: ['synthetic.case'],
    evidence: 'unverified',
    params: { path: /^[a-z]+(?:\/[a-z]+)*$/ }
  },
  'none',
  request => request.params.path ?? '',
  (_state, path) => () => new Response(path)
)

const write = statefulRoute<State, undefined, string>(
  {
    method: 'POST',
    path: '/notes/{id}',
    kind: 'connector',
    write: true,
    caseIds: ['synthetic.case'],
    evidence: 'unverified',
    params: { id: /^[0-9]+$/ }
  },
  'json',
  request => (request.query.has('x') ? notEmulated(`query ${request.query.get('x')}`) : 'ok'),
  state => () => {
    state.writes += 1

    return new Response('written')
  }
)

/** A route whose plan echoes token-carrying input into its reason (two halves of the bearer). */
const echoPlan = statefulRoute<State, undefined, string>(
  {
    method: 'POST',
    path: '/echo/{id}',
    kind: 'connector',
    write: false,
    caseIds: ['synthetic.case'],
    evidence: 'unverified',
    params: { id: /^[0-9]+$/ }
  },
  'json',
  request => {
    const body = exactObject(request.json, 'the echo body', ['a', 'b'])

    if (isNotEmulated(body)) return body

    return [body.a, body.b].map(half => (Predicate.isString(half) ? half : '')).join('')
  },
  (_state, joined) => notEmulated(`the plan saw ${joined}`)
)

const build = (routes: ReadonlyArray<StatefulRoute<State, undefined>>, failClosed: boolean) => {
  const base: StatefulEmulatorConfig<State, undefined> = {
    routes,
    env: undefined,
    initial: { writes: 0 },
    buildSeed: () => ({ writes: 0 }),
    recordHeaders: [{ name: 'x-note', json: false }],
    clearRuntime: () => undefined,
    runtimeState: () => ({}),
    seedSummary: () => ({}),
    inputInvalid: (input, reason) => new Error(`${input}: ${reason}`)
  }

  const config: StatefulEmulatorConfig<State, undefined> = failClosed
    ? {
        ...base,
        failClosed: {
          unrecognised: 'synthetic: no route',
          unrecognisedAuthorization: 'synthetic: unrecognisable authorization'
        }
      }
    : base

  return makeStatefulEmulator(config, async dispatch => {
    let state = { writes: 0 }

    return {
      fetch: request => Promise.resolve(dispatch(state, request)),
      baseUrl: 'http://core.invalid',
      snapshot: () => ({ ...state }),
      restore: next => {
        state = { ...next }

        return Promise.resolve()
      },
      close: () => Promise.resolve()
    }
  })
}

const get = (path: string, headers: Record<string, string> = {}) =>
  new Request(`https://api.example.test${path}`, { headers })

describe('route templates', () => {
  it('matches {name+} across segments, each decoded once, and never a decoded slash', () => {
    const loose = statefulRoute<State, undefined, string>(
      { ...echo, path: '/files/{path+}', params: {} },
      'none',
      () => '',
      () => () => new Response('')
    )

    const match = routeMatcher([loose])

    expect(match('GET', '/files/a/b%20c')?.params).toEqual({ path: 'a/b c' })
    expect(match('GET', '/files/a%2Fb')).toBeUndefined()
    expect(match('GET', '/files/a//b')).toBeUndefined()
    expect(match('GET', '/files/%E0')).toBeUndefined()
  })

  it('a raw parameter outside its pattern matches no route', () => {
    const match = routeMatcher([echo])

    expect(match('GET', '/files/a/b')?.params).toEqual({ path: 'a/b' })
    expect(match('GET', '/files/a/B')).toBeUndefined()
    expect(match('GET', '/files/%61')).toBeUndefined()
  })

  it('a raw pattern must match the whole parameter, even when it is not anchored', () => {
    const unanchored = statefulRoute<State, undefined, string>(
      { ...echo, path: '/things/{id}', params: { id: /[a-z]+/ } },
      'none',
      () => '',
      () => () => new Response('')
    )

    const match = routeMatcher([unanchored])

    expect(match('GET', '/things/abc')?.params).toEqual({ id: 'abc' })
    // `abc` is only part of `abc%2Fdef`: no shape of this route (never decoded to `abc/def`).
    expect(match('GET', '/things/abc%2Fdef')).toBeUndefined()
    expect(match('GET', '/things/ABCabc')).toBeUndefined()
  })

  it('refuses a raw pattern with the g or y flag (matches depend on earlier ones)', () => {
    for (const pattern of [/^[a-z]+$/g, /[a-z]+/y]) {
      const flagged = statefulRoute<State, undefined, string>(
        { ...echo, path: '/things/{id}', params: { id: pattern } },
        'none',
        () => '',
        () => () => new Response('')
      )

      expect(() => routeMatcher([flagged])).toThrow('raw patterns take no g or y flag')
    }
  })
})

describe('fail-closed mode', () => {
  it('refuses to build with a route parameter that has no raw pattern', async () => {
    const unpatterned = statefulRoute<State, undefined, string>(
      { ...echo, params: {} },
      'none',
      () => '',
      () => () => new Response('')
    )

    await expect(build([unpatterned], true)).rejects.toThrow('needs raw patterns for path')
    // Without fail-closed mode the parameter needs no pattern (the earlier behaviour).
    await expect(build([unpatterned], false)).resolves.toBeDefined()
  })

  it('ledgers unrecognised requests and Authorization headers as constants', async () => {
    const api = await build([echo, write], true)
    const secret = 'synthetic-wrapper-secret'

    const answers = await Promise.all([
      api.fetch(get(`/files/A?${secret}=1`, { authorization: `Bearer ${secret}` })),
      api.fetch(get(`/files/a?q=${secret}`, { authorization: `Bearer ${secret} extra` })),
      api.fetch(get('/files/a', { authorization: `Basic ${secret}` })),
      api.fetch(new Request(`https://api.example.test/notes/${secret}`, { method: 'PATCH' }))
    ])

    expect(answers.map(answer => answer.status)).toEqual([400, 400, 400, 400])
    expect(
      api.ledger.entries().map(entry => [entry.method, entry.path, entry.notEmulated])
    ).toEqual([
      ['GET', '/<unrecognised>', 'synthetic: no route'],
      ['GET', '/<unrecognised>', 'synthetic: unrecognisable authorization'],
      ['GET', '/<unrecognised>', 'synthetic: unrecognisable authorization'],
      ['PATCH', '/<unrecognised>', 'synthetic: no route']
    ])

    const texts = await Promise.all(answers.map(answer => answer.text()))

    expect([...texts, JSON.stringify(api.ledger.entries())].join('\n')).not.toContain(secret)
  })

  it('guards the bearer: scrubbed everywhere, and a request repeating it is refused', async () => {
    const api = await build([echo, write], true)
    const secret = 'synthetic-wrapper-secret'
    const authorization = `Bearer ${secret}`

    const post = (path: string, body: string, headers: Record<string, string> = {}) =>
      api.fetch(
        new Request(`https://api.example.test${path}`, {
          method: 'POST',
          headers: { authorization, 'content-type': 'application/json', ...headers },
          body
        })
      )

    const refused = [
      await post(`/notes/1?y=${secret}`, '{}'),
      await post('/notes/1', `{"note":"${secret}"}`),
      await post('/notes/1', `{"${secret.replace('s', '\\u0073')}":1}`),
      await post('/notes/1?x=1', '{}', { 'x-note': secret })
    ]

    expect(refused.map(response => response.status)).toEqual([400, 400, 400, 400])
    expect(api.ledger.entries().map(entry => entry.notEmulated)).toEqual([
      'the query repeats the credential',
      'the request body repeats the credential',
      'the request body repeats the credential',
      'a recorded request header repeats the credential'
    ])
    expect(api.ledger.entries()[3]?.headers).toEqual({ 'x-note': '<redacted>' })
    expect(api.snapshot()).toEqual({ writes: 0 })

    const texts = await Promise.all(refused.map(response => response.text()))

    expect([...texts, JSON.stringify(api.ledger.entries())].join('\n')).not.toContain(secret)

    // A missing bearer is a recognised request refused with the route's ledger entry.
    const missing = await api.fetch(get('/files/a'))

    expect(missing.status).toBe(400)
    expect(api.ledger.entries().at(-1)).toMatchObject({
      path: '/files/a',
      route: '/files/{path+}',
      notEmulated: expect.stringContaining('Authorization: Bearer')
    })

    const answered = await api.fetch(get('/files/a/b', { authorization }))

    expect(await answered.text()).toBe('a/b')
  })
})

describe('fail-closed mode: plan-time reasons and recorded headers', () => {
  it('scrubs a plan-time reason that echoes token-carrying input', async () => {
    const api = await build([echoPlan], true)
    const secret = 'synthetic-wrapper-secret'

    // Neither half repeats the bearer, so the request reaches the plan, which joins them.
    const refused = await api.fetch(
      new Request('https://api.example.test/echo/1', {
        method: 'POST',
        headers: { authorization: `Bearer ${secret}`, 'content-type': 'application/json' },
        body: JSON.stringify({ a: 'synthetic-wrapper', b: '-secret' })
      })
    )

    const text = await refused.text()

    expect(refused.status).toBe(400)
    expect(api.ledger.entries()[0]?.notEmulated).toBe('the plan saw <redacted>')

    const control = await Promise.all(
      ['ledger', 'state', 'coverage', 'faults'].map(route =>
        api.fetch(get(`/_emulate/${route}`)).then(response => response.text())
      )
    )

    expect([text, JSON.stringify(api.ledger.entries()), ...control].join('\n')).not.toContain(
      secret
    )
  })

  it('records a JSON-looking header redacted even when it is declared plain', async () => {
    const value = '{"nested":{"access_token":"synthetic-other-secret"}}'
    const failClosed = await build([echo], true)
    const legacy = await build([echo], false)

    for (const api of [failClosed, legacy]) {
      await api.fetch(
        get('/files/a', { authorization: 'Bearer synthetic-wrapper-secret', 'x-note': value })
      )
    }

    expect(failClosed.ledger.entries()[0]?.headers).toEqual({
      'x-note': '{"nested":{"access_token":"<redacted>"}}'
    })
    // Without fail-closed mode a header declared plain is recorded as sent (the earlier
    // behaviour, which Dropbox and Notion keep).
    expect(legacy.ledger.entries()[0]?.headers).toEqual({ 'x-note': value })
  })
})

describe('without fail-closed mode', () => {
  it('keeps the earlier behaviour: any bearer, unknown routes ledgered as sent', async () => {
    const api = await build([echo, write], false)

    expect((await api.fetch(get('/files/a', { authorization: 'Bearer x' }))).status).toBe(200)
    expect((await api.fetch(get('/nope?q=1', { authorization: 'Bearer x' }))).status).toBe(400)
    expect(api.ledger.entries().at(-1)).toMatchObject({
      path: '/nope',
      query: { q: '1' },
      notEmulated: 'no emulated route for this method and path'
    })
  })
})
