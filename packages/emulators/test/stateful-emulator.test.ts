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
import type * as Schema from 'effect/Schema'
import {
  exactBodyKeys,
  exactObject,
  exactQuery,
  isNotEmulated,
  makeStatefulEmulator,
  notEmulated,
  routeMatcher,
  statefulRoute,
  type EmulatedRequest,
  type StatefulEmulatorConfig,
  type StatefulRoute
} from '../src/stateful-emulator.ts'
import {
  isRecognisableBearerValue,
  secretClosureRounds,
  textRepeatsSecret,
  tolerantJsonUnescape,
  tolerantPercentDecode
} from '../src/stateful-secrets.ts'

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

  it('tries alternation and lazy quantifiers against the whole parameter', () => {
    const route = (path: string, pattern: RegExp) =>
      statefulRoute<State, undefined, string>(
        { ...echo, path, params: { id: pattern } },
        'none',
        () => '',
        () => () => new Response('')
      )

    const match = routeMatcher([
      route('/alternation/{id}', /[0-9]+|[0-9]+-[a-z]+/),
      route('/lazy/{id}', /[a-z]+?/)
    ])

    // The first alternative alone matches only `12`; the whole value matches the second.
    expect(match('GET', '/alternation/12-ab')?.params).toEqual({ id: '12-ab' })
    expect(match('GET', '/alternation/12')?.params).toEqual({ id: '12' })
    expect(match('GET', '/alternation/12-ab%2F')).toBeUndefined()
    // A lazy quantifier alone matches only `a`; anchored, it takes the whole value.
    expect(match('GET', '/lazy/abc')?.params).toEqual({ id: 'abc' })
    expect(match('GET', '/lazy/abc1')).toBeUndefined()
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

    // Every such request is ledgered with constant text only: nothing request-derived.
    for (const entry of api.ledger.entries()) {
      expect(entry).toEqual({
        seq: expect.any(Number),
        method: 'POST',
        path: '/<unrecognised>',
        route: '/notes/{id}',
        query: {},
        headers: {},
        status: 400,
        evidence: 'unverified',
        notEmulated: expect.stringMatching(/ repeats the credential$/)
      })
    }

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

describe('fail-closed credential guard', () => {
  const secret = 'synthetic-wrapper-secret'

  // Needs `rounds` percent-decodings to show the secret: its `s` as `%73`, then `%2573`, ...
  const encoded = (rounds: number): string => {
    if (rounds === 0) return secret

    let escape = '%73'

    for (let round = 1; round < rounds; round += 1) escape = escape.replace('%', '%25')

    return secret.replace('s', escape)
  }

  it('textRepeatsSecret walks a bounded closure: 4 rounds of decoding, every text checked', () => {
    expect(secretClosureRounds).toBe(4)

    for (const rounds of [0, 1, 2, 3, 4]) {
      expect(textRepeatsSecret(encoded(rounds), [secret]), String(rounds)).toBe(true)
    }

    // A fifth round lies beyond the bound.
    expect(textRepeatsSecret(encoded(5), [secret])).toBe(false)

    // Percent-decoding and JSON compose: an encoded JSON string, a JSON string in a JSON string,
    // object keys, and `\u` escapes.
    const escaped = `"${secret.replace('s', '\\u0073')}"`

    for (const text of [
      encodeURIComponent(escaped),
      JSON.stringify(escaped),
      encodeURIComponent(JSON.stringify(escaped)),
      `{"k":{${escaped}:1}}`,
      `[1,${JSON.stringify(encodeURIComponent(secret))}]`
    ]) {
      expect(textRepeatsSecret(text, [secret]), text).toBe(true)
    }

    expect(textRepeatsSecret('{"k":"synthetic-wrapper"}', [secret])).toBe(false)
    expect(textRepeatsSecret('anything', [])).toBe(false)
  })

  it('the two transforms are total: every malformed sequence is left as it is', () => {
    expect(tolerantPercentDecode('100% %73x %E9 %zz %2 %7e%25')).toBe('100% sx %E9 %zz %2 ~%')
    expect(tolerantPercentDecode('%')).toBe('%')
    expect(
      tolerantJsonUnescape('v=\\u0073 \\u00e9 \\" \\\\ \\/ \\b \\f \\n \\r \\t \\x \\u12 \\')
    ).toBe('v=s \\u00e9 " \\ / \b \f \n \r \t \\x \\u12 \\')
    // One left-to-right pass: an escaped backslash before `u0073` takes another round.
    expect(tolerantJsonUnescape(String.raw`\\u0073`)).toBe(String.raw`\u0073`)

    // So the closure sees an encoded bearer next to a stray `%` or a non-UTF-8 escape, and every
    // string of a JSON text with duplicate keys.
    for (const text of [
      `${secret.replace('s', '%73')} (100% done)`,
      `caf%E9 ${secret.replace('s', '%73')}`,
      String.raw`{"x":"\u0073ynthetic-wrapper-secret","x":"safe"}`,
      String.raw`v=\u0073ynthetic-wrapper-secret`
    ]) {
      expect(textRepeatsSecret(text, [secret]), text).toBe(true)
    }
  })

  it('a 64 KiB body of nested escapes is checked well under a second', async () => {
    const api = await build([echoPlan], true)

    // Nested escapes of every kind, 64 KiB, none of them the bearer.
    const unit = String.raw`\\\\u0025%2525\"\\u005c%5C\/`
    const nested = unit.repeat(Math.ceil((64 * 1024) / unit.length)).slice(0, 64 * 1024)
    const body = JSON.stringify({ a: nested, b: '' })

    expect(body.length).toBeGreaterThan(64 * 1024)

    const send = () =>
      api.fetch(
        new Request('https://api.example.test/echo/1', {
          method: 'POST',
          headers: { authorization: `Bearer ${secret}`, 'content-type': 'application/json' },
          body
        })
      )

    await send()

    const started = performance.now()
    const response = await send()
    const elapsed = performance.now() - started

    expect(response.status).toBe(400)
    expect(elapsed).toBeLessThan(1000)

    const closureStarted = performance.now()

    expect(textRepeatsSecret(nested, [secret])).toBe(false)
    expect(performance.now() - closureStarted).toBeLessThan(1000)
  })

  it('recognises only an RFC 6750 b64token bearer outside the number alphabet', async () => {
    const api = await build([echo], true)

    // Characters the transforms consume (`\`, `%`, `"`), separators, and `=` before the end.
    const refused = [
      String.raw`\nabcdefg`,
      'abcd\\efgh',
      'abcd%41efgh',
      'abcd"efgh',
      'abcd efgh',
      'abcd,efgh',
      'abcd=efgh',
      'abcd:efgh',
      'abcd!efgh'
    ]

    for (const value of refused) {
      const response = await api.fetch(get('/files/a', { authorization: `Bearer ${value}` }))
      const text = await response.text()

      expect(response.status, value).toBe(400)
      expect(text, value).not.toContain(value)
      expect(isRecognisableBearerValue(value), value).toBe(false)
    }

    expect(api.ledger.entries().map(entry => [entry.path, entry.notEmulated])).toEqual(
      refused.map(() => ['/<unrecognised>', 'synthetic: unrecognisable authorization'])
    )

    const control = await Promise.all(
      ['ledger', 'state', 'coverage', 'faults'].map(route =>
        api.fetch(get(`/_emulate/${route}`)).then(response => response.text())
      )
    )

    for (const value of refused) expect(control.join('\n'), value).not.toContain(value)

    // GitHub and Google token forms, and trailing `=` padding, are recognised.
    for (const value of [
      'ghp_SyntheticToken0123456789',
      'github_pat_11SYNTHETIC0_abcdefghijklmnopqrstuvwxyz',
      'gho_SyntheticToken0123456789',
      'ya29.a0Synthetic-Token_value',
      'c3ludGhldGljLXRva2Vu==',
      'abc+def/ghi~jkl'
    ]) {
      expect(isRecognisableBearerValue(value), value).toBe(true)
      expect((await api.fetch(get('/files/a', { authorization: `Bearer ${value}` }))).status).toBe(
        200
      )
    }
  })

  it('recognises only a printable-ASCII bearer outside the number alphabet', async () => {
    const api = await build([echo], true)

    for (const value of [
      '12345678',
      '1.2345678e7',
      '-1.5E+10000',
      '12345678901234567890',
      'synth\u00e9tique-token'
    ]) {
      const response = await api.fetch(get('/files/a', { authorization: `Bearer ${value}` }))

      expect(response.status, value).toBe(400)
      expect(await response.text()).not.toContain(value)
    }

    expect(api.ledger.entries().map(entry => [entry.path, entry.notEmulated])).toEqual(
      Array.from({ length: 5 }, () => [
        '/<unrecognised>',
        'synthetic: unrecognisable authorization'
      ])
    )
    expect(isRecognisableBearerValue('ghp_1234567890')).toBe(true)
    expect(isRecognisableBearerValue('github_pat_11AAAA')).toBe(true)
    expect(isRecognisableBearerValue('gho_0000000000')).toBe(true)
    expect(isRecognisableBearerValue('ya29.a0AfH6SMsynthetic')).toBe(true)
    expect(isRecognisableBearerValue('synth\u00e9tique-token')).toBe(false)

    const answered = await api.fetch(get('/files/a', { authorization: 'Bearer 1234567x' }))

    expect(answered.status).toBe(200)
  })
})

describe('constant-text shape checks (exactBodyKeys, exactQuery)', () => {
  const request = (query: string, json?: Schema.Json): EmulatedRequest => ({
    method: 'POST',
    path: '/x',
    params: {},
    query: new URLSearchParams(query),
    header: () => undefined,
    json,
    bytes: undefined
  })

  const reasonOf = (result: unknown): string => (isNotEmulated(result) ? result.reason : 'admitted')

  // A request key that carries text (here another credential) is never echoed into a reason.
  const foreign = '{"access_token":"synthetic-other-secret"}'

  it('exactBodyKeys answers the object or a constant reason', () => {
    expect(exactBodyKeys({ a: 1 }, 'the body', ['a'])).toEqual({ a: 1 })
    expect(exactBodyKeys({ a: 1, b: 2 }, 'the body', ['a'], ['b'])).toEqual({ a: 1, b: 2 })
    expect(reasonOf(exactBodyKeys({ a: 1, [foreign]: 2 }, 'the body', ['a']))).toBe(
      'the body has a key this route does not take'
    )
    expect(reasonOf(exactBodyKeys({}, 'the body', ['a']))).toBe(
      "the body without 'a' is not emulated"
    )
    expect(reasonOf(exactBodyKeys([foreign], 'the body', ['a']))).toBe(
      'the body must be a JSON object'
    )
  })

  it('exactQuery answers the values or a constant reason', () => {
    expect(exactQuery(request('a=1&b=2'), ['a'], ['b'])).toEqual({ a: '1', b: '2' })
    expect(reasonOf(exactQuery(request(`a=1&${encodeURIComponent(foreign)}=1`), ['a']))).toBe(
      'a query parameter this route does not take is not emulated'
    )
    expect(reasonOf(exactQuery(request('a=1&a=2'), ['a']))).toBe(
      'repeated query parameters are not emulated'
    )
    expect(reasonOf(exactQuery(request(''), ['a']))).toBe(
      'requests without query parameter a are not emulated on this route'
    )
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
