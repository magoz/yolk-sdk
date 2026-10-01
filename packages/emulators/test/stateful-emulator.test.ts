/**
 * The shared `src/stateful-emulator.ts` wrapper's opt-in guarantees, over a fake core (no
 * `@emulators/core`): multi-segment `{name+}` parameters, raw parameter patterns, the
 * fail-closed mode (constant-text ledger entries for unrecognised requests and Authorization
 * headers, the bearer guarded as a secret, every parameter patterned at build), and that an
 * emulator without
 * `failClosed` keeps the earlier behaviour (the Dropbox and Notion suites cover it in full).
 */
import { describe, expect, it } from '@effect/vitest'
import {
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

  it('ledgers unrecognised requests and Authorization headers with constant text only', async () => {
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
      'query 1'
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

describe('without fail-closed mode', () => {
  it('keeps the earlier behaviour: any non-empty bearer, unknown routes ledgered as sent', async () => {
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
