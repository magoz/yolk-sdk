/**
 * The shared `src/stateful-emulator.ts` wrapper's opt-in guarantees, over a fake core (no
 * `@emulators/core`): multi-segment `{name+}` parameters, raw parameter patterns (matched in full,
 * no `g` or `y` flag), the fail-closed mode (constant-text ledger entries for unrecognised
 * requests and Authorization headers, every parameter patterned at build, the bearer guarded as a
 * secret in queries, recorded headers, bodies, a route's decoded body views, and plan-time
 * reasons), the opt-in per-origin bearer digest (`bearerDigest`), and that an emulator without
 * `failClosed` keeps the earlier behaviour (the Dropbox and Notion suites cover it fully).
 */
import { createHash } from 'node:crypto'
import { Predicate, Result } from 'effect'
import { describe, expect, it } from '@effect/vitest'
import type * as Schema from 'effect/Schema'
import {
  DecodedViewRefusal,
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
  secretClosureCaps,
  secretClosureOutcome,
  textClosureOutcome,
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

const build = (
  routes: ReadonlyArray<StatefulRoute<State, undefined>>,
  failClosed: boolean,
  extra: Partial<StatefulEmulatorConfig<State, undefined>> = {}
) => {
  const base: StatefulEmulatorConfig<State, undefined> = {
    ...extra,
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

/** A route answering the digest it sees (or `none`), and whether the bearer reached it. */
const digestEcho = statefulRoute<State, undefined, string>(
  {
    method: 'GET',
    path: '/digest',
    kind: 'connector',
    write: false,
    caseIds: ['synthetic.case'],
    evidence: 'unverified'
  },
  'none',
  request => request.bearerDigest ?? 'none',
  (_state, seen) => () => new Response(seen)
)

/** A real one-way digest: SHA-256 (hex) of the origin, a space, and the bearer. */
const sha256Digest = (bearer: string, origin: string) =>
  createHash('sha256').update(`${origin} ${bearer}`).digest('hex')

describe('fail-closed mode: the opt-in per-origin bearer digest', () => {
  const secret = 'synthetic-wrapper-secret'
  const authorization = `Bearer ${secret}`

  it('refuses to build without fail-closed mode', async () => {
    await expect(build([digestEcho], false, { bearerDigest: sha256Digest })).rejects.toThrow(
      'bearerDigest needs fail-closed mode'
    )
  })

  it('routes see the digest for the arrival origin, never the bearer', async () => {
    const api = await build([digestEcho], true, { bearerDigest: sha256Digest })

    const direct = await api.fetch(get('/digest', { authorization }))

    const rewritten = await api.fetchOn('https://other.example.test')(
      get('/digest', { authorization })
    )

    const texts = [await direct.text(), await rewritten.text()]

    // SHA-256 of `<origin> synthetic-wrapper-secret`, precomputed: one per origin.
    expect(texts).toEqual([
      '0bc47171540cb5c4125257df87cf22e75d70e3cf00d717e79d1931e0d4dc5396',
      'ba9cbba97cefa1e9dded86fd3470f13e6a1f4f9fa4db10bc18746991601c1f9a'
    ])

    const controlReads = await Promise.all(
      ['ledger', 'state', 'coverage', 'faults'].map(route =>
        api
          .fetch(new Request(`https://api.example.test/_emulate/${route}`))
          .then(response => response.text())
      )
    )

    const seen = [
      ...texts,
      JSON.stringify(api.ledger.entries()),
      JSON.stringify(api.snapshot()),
      ...controlReads
    ].join('\n')

    expect(seen).not.toContain(secret)
    expect(seen).not.toContain('wrapper-secret')
  })

  it('without the option, routes see no digest (the earlier behaviour)', async () => {
    const api = await build([digestEcho], true)

    expect(await (await api.fetch(get('/digest', { authorization }))).text()).toBe('none')
  })

  it.each([
    [
      'a digest that throws',
      () => {
        throw new Error(`synthetic digest failure ${secret}`)
      }
    ],
    ['a digest that repeats the bearer', (bearer: string) => `digest-of-${bearer}`],
    // A host callback typed loosely (untyped JavaScript, say) may answer a non-string.
    ['a digest that is no string', (): string => JSON.parse('42')],
    [
      'a digest that repeats the bearer JSON-escaped',
      (bearer: string) => `digest-of-${bearer.replace('s', '\\u0073')}`
    ]
  ] as const)('%s answers the 500 emulator error, no fault used', async (_label, bearerDigest) => {
    const api = await build([digestEcho, write], true, { bearerDigest })

    api.faults.add({ kind: 'status', status: 503, count: 1 })

    const failed = await api.fetch(get('/digest', { authorization }))
    const text = await failed.text()

    expect(failed.status).toBe(500)
    expect(JSON.parse(text)).toEqual({
      error: { type: 'emulator_error', message: 'the emulator could not build the response' }
    })
    expect(api.ledger.entries().at(-1)).toMatchObject({
      path: '/digest',
      status: 500,
      responseError: 'the bearer digest failed'
    })
    expect(api.faults.list()[0]).toMatchObject({ applied: 0, remaining: 1 })
    expect(api.snapshot()).toEqual({ writes: 0 })
    expect([text, JSON.stringify(api.ledger.entries())].join('\n')).not.toContain(secret)

    // A request without a bearer never computes a digest: refused by the shape as before.
    expect((await api.fetch(get('/digest'))).status).toBe(400)
  })
})

/** Base64url of UTF-8 text, as a provider wire format may wrap request content. */
const base64Url = (text: string): string =>
  btoa(String.fromCharCode(...new TextEncoder().encode(text)))
    .replaceAll('+', '-')
    .replaceAll('/', '_')
    .replaceAll('=', '')

/** A tolerant view: the base64url-decoded `raw` of a JSON body, or none. */
const rawView = (body: string): ReadonlyArray<string> => {
  const raw = Result.try(() => {
    const parsed: unknown = JSON.parse(body)

    return Predicate.isObject(parsed) && Predicate.isString(parsed.raw) ? parsed.raw : undefined
  })

  const text = Result.isFailure(raw) ? undefined : raw.success

  if (text === undefined) return []

  const decoded = Result.try(() => atob(text.replaceAll('-', '+').replaceAll('_', '/')))

  return Result.isFailure(decoded) ? [] : [decoded.success]
}

/** A write route whose body carries base64url content (`{ raw }`), with a decoded view. */
const encodedWrite = (
  binding: {
    readonly decodedViews?: (body: string) => ReadonlyArray<string>
    readonly viewRefusalReasons?: ReadonlyArray<string>
  } = {}
) =>
  statefulRoute<State, undefined, string>(
    {
      method: 'POST',
      path: '/encoded/{id}',
      kind: 'connector',
      write: true,
      caseIds: ['synthetic.case'],
      evidence: 'unverified',
      params: { id: /^[0-9]+$/ },
      ...binding
    },
    'json',
    () => 'ok',
    state => () => {
      state.writes += 1

      return new Response('written')
    }
  )

describe('fail-closed mode: decoded views of a route body', () => {
  const secret = 'synthetic-wrapper-secret'

  const post = (api: Awaited<ReturnType<typeof build>>, raw: string) =>
    api.fetch(
      new Request('https://api.example.test/encoded/1', {
        method: 'POST',
        headers: { authorization: `Bearer ${secret}`, 'content-type': 'application/json' },
        body: JSON.stringify({ raw })
      })
    )

  it('checks each decoded view like the raw body, before any fault or write', async () => {
    const api = await build([encodedWrite({ decodedViews: rawView })], true)

    api.faults.add({ kind: 'status', status: 503, count: 1 })

    // The bearer only inside base64url content, also JSON-escaped and percent-encoded there.
    const forms = [
      `Subject: ${secret}`,
      `Subject: ${secret.replace('s', '\\u0073')}`,
      `Subject: ${secret.replace('s', '%73')} (100% done)`
    ]

    for (const form of forms) {
      const response = await post(api, base64Url(form))
      const text = await response.text()

      expect(response.status, form).toBe(400)
      expect(text, form).not.toContain(secret)
    }

    for (const entry of api.ledger.entries()) {
      expect(entry).toEqual({
        seq: expect.any(Number),
        method: 'POST',
        path: '/<unrecognised>',
        route: '/encoded/{id}',
        query: {},
        headers: {},
        status: 400,
        evidence: 'unverified',
        notEmulated: 'the request body repeats the credential'
      })
    }

    expect(api.snapshot()).toEqual({ writes: 0 })
    expect(api.faults.list()[0]).toMatchObject({ applied: 0, remaining: 1 })

    // A view without the bearer, and a body the view cannot decode, reach the route (and the
    // fault, which answers the first of them).
    expect((await post(api, base64Url('Subject: safe'))).status).toBe(503)
    expect((await post(api, '***not base64***')).status).toBe(200)
    expect(api.snapshot()).toEqual({ writes: 1 })
  })

  it('a view that throws refuses the body as uncheckable: a constant entry, no fault, no write', async () => {
    const api = await build(
      [
        encodedWrite({
          decodedViews: () => {
            throw new Error('synthetic view failure')
          }
        })
      ],
      true
    )

    api.faults.add({ kind: 'status', status: 503, count: 1 })

    // With the bearer in the encoded content, and without it: the same constant entry, which never
    // says the body repeats the credential.
    const responses = [
      await post(api, base64Url(`Subject: ${secret}`)),
      await post(api, base64Url('Subject: safe'))
    ]

    const texts = await Promise.all(responses.map(response => response.text()))

    expect(responses.map(response => response.status)).toEqual([400, 400])
    expect(texts).toEqual(
      texts.map(() =>
        JSON.stringify({
          error: {
            type: 'not_emulated',
            message: 'Not emulated: the request body cannot be checked for the credential'
          }
        })
      )
    )

    for (const entry of api.ledger.entries()) {
      expect(entry).toEqual({
        seq: expect.any(Number),
        method: 'POST',
        path: '/<unrecognised>',
        route: '/encoded/{id}',
        query: {},
        headers: {},
        status: 400,
        evidence: 'unverified',
        notEmulated: 'the request body cannot be checked for the credential'
      })
    }

    expect(JSON.stringify(api.ledger.entries())).not.toContain(base64Url('Subject: safe'))
    expect(api.snapshot()).toEqual({ writes: 0 })
    expect(api.faults.list()[0]).toMatchObject({ applied: 0, remaining: 1 })
  })

  describe('declared view-refusal reasons', () => {
    const declared = 'synthetic: the encoded note is not the recorded one'

    /** A view that decodes `{ raw }` and refuses it with `reason`, passing what it decoded. */
    const refusing = (reason: string) => (body: string) => {
      throw new DecodedViewRefusal({ reason, decoded: rawView(body) })
    }

    const entryOf = (reason: string) => ({
      seq: expect.any(Number),
      method: 'POST',
      path: '/<unrecognised>',
      route: '/encoded/{id}',
      query: {},
      headers: {},
      status: 400,
      evidence: 'unverified',
      notEmulated: reason
    })

    const refusedWith = async (
      binding: Parameters<typeof encodedWrite>[0],
      raw: string,
      reason: string
    ) => {
      const api = await build([encodedWrite(binding)], true)

      api.faults.add({ kind: 'status', status: 503, count: 1 })

      const response = await post(api, raw)
      const text = await response.text()

      expect(response.status).toBe(400)
      expect(JSON.parse(text)).toEqual({
        error: { type: 'not_emulated', message: `Not emulated: ${reason}` }
      })
      expect(api.ledger.entries()).toEqual([entryOf(reason)])
      expect(api.snapshot()).toEqual({ writes: 0 })
      expect(api.faults.list()[0]).toMatchObject({ applied: 0, remaining: 1 })

      // Nothing the request carried is echoed or recorded.
      expect([text, JSON.stringify(api.ledger.entries())].join('\n')).not.toContain(raw)

      return text
    }

    it('a declared reason is ledgered in the constant entry', async () => {
      await refusedWith(
        { decodedViews: refusing(declared), viewRefusalReasons: [declared] },
        base64Url('Subject: safe'),
        declared
      )
    })

    it('an undeclared reason falls back to the uncheckable reason (never request text)', async () => {
      const raw = base64Url('Subject: safe')

      // The view tries to answer with text derived from the request.
      const text = await refusedWith(
        {
          decodedViews: body => {
            throw new DecodedViewRefusal({ reason: `echo ${body}`, decoded: [] })
          },
          viewRefusalReasons: [declared]
        },
        raw,
        'the request body cannot be checked for the credential'
      )

      expect(text).not.toContain('echo')
    })

    it('a plain throw falls back to the uncheckable reason, even with declared reasons', async () => {
      await refusedWith(
        {
          decodedViews: () => {
            throw new Error(declared)
          },
          viewRefusalReasons: [declared]
        },
        base64Url('Subject: safe'),
        'the request body cannot be checked for the credential'
      )
    })

    it('a refusal whose cleanly decoded text holds the bearer is a credential repeat', async () => {
      const text = await refusedWith(
        { decodedViews: refusing(declared), viewRefusalReasons: [declared] },
        base64Url(`Subject: ${secret}`),
        'the request body repeats the credential'
      )

      expect(text).not.toContain(secret)
    })

    it('a declared reason that names the bearer is scrubbed (defensively)', async () => {
      const naming = `synthetic: refused near ${secret}`

      const text = await refusedWith(
        { decodedViews: refusing(naming), viewRefusalReasons: [naming] },
        base64Url('Subject: safe'),
        'synthetic: refused near <redacted>'
      )

      expect(text).not.toContain(secret)
    })
  })

  it('a route without decoded views is checked exactly as before (the encoded bearer passes)', async () => {
    const api = await build([encodedWrite()], true)

    expect((await post(api, base64Url(`Subject: ${secret}`))).status).toBe(200)
    expect(api.snapshot()).toEqual({ writes: 1 })
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

  // Needs `depth` percent-decodings to show the secret: its `s` as `%73`, then `%2573`, ...
  const encoded = (depth: number): string =>
    depth === 0 ? secret : secret.replace('s', `%${'25'.repeat(depth - 1)}73`)

  it('textRepeatsSecret is caught at any depth until the cap; the cap refuses', () => {
    expect(secretClosureCaps).toEqual({ rounds: 64, texts: 1024, characters: 8 * 1024 * 1024 })

    // A fixpoint, not a round budget: every depth below the round cap is caught.
    for (const depth of [0, 1, 2, 3, 4, 5, 6, 8, 16, 32, 63, 64]) {
      expect(secretClosureOutcome(encoded(depth), [secret]), String(depth)).toBe('repeats')
    }

    // Past the round cap the closure stops: uncertainty refuses, it never admits.
    expect(secretClosureOutcome(encoded(65), [secret])).toBe('capped')
    expect(textRepeatsSecret(encoded(65), [secret])).toBe(true)
    expect(textRepeatsSecret('%' + '25'.repeat(100) + '41', [secret])).toBe(true)

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

    // A text whose closure converges without the secret is clear.
    expect(secretClosureOutcome('{"k":"synthetic-wrapper"} %2541 \\\\u0041', [secret])).toBe(
      'clear'
    )
    expect(textRepeatsSecret('anything', [])).toBe(false)
  })

  it('textClosureOutcome walks the same closure for any predicate, and secrets use it', () => {
    const bearer = /\bbearer\s+[A-Za-z0-9._~+/=-]{8,}/i
    const matches = (text: string) => bearer.test(text)

    for (const text of [
      'Bearer synthetic-token-0001',
      'Bearer%20synthetic-token-0001',
      encodeURIComponent(encodeURIComponent('Bearer synthetic-token-0001')),
      '"Bearer\\u0020synthetic-token-0001"'
    ]) {
      expect(textClosureOutcome(text, matches), text).toBe('matches')
    }

    expect(textClosureOutcome('no token here %41 \\u0041', matches)).toBe('clear')
    expect(textClosureOutcome('%' + '25'.repeat(100) + '41', () => false)).toBe('capped')

    // The GitHub and Google semantics are unchanged: secrets under four characters are not
    // guarded by the shared helpers (the R2 port emulator guards those at its own call site).
    expect(textRepeatsSecret('fixtures/object.txt', ['txt'])).toBe(false)
    expect(secretClosureOutcome('fixtures/object.txt', ['txt'])).toBe('clear')
    expect(textRepeatsSecret('fixtures/object.text', ['text'])).toBe(true)

    // The secret closure is exactly the text closure with a substring predicate.
    for (const depth of [0, 3, 64, 65]) {
      const viaText = textClosureOutcome(encoded(depth), text => text.includes(secret))

      expect(secretClosureOutcome(encoded(depth), [secret]), String(depth)).toBe(
        viaText === 'matches' ? 'repeats' : viaText
      )
    }
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

  /** 64 KiB of `unit`, repeated. */
  const fill = (unit: string): string =>
    unit.repeat(Math.ceil((64 * 1024) / unit.length)).slice(0, 64 * 1024)

  const timed = <A>(run: () => A): readonly [A, number] => {
    const started = performance.now()
    const result = run()

    return [result, performance.now() - started]
  }

  it('a converging 64 KiB body of nested escapes is checked well under a second', async () => {
    const api = await build([echoPlan], true)

    // Nested escapes of every kind, none of them the bearer: the closure reaches its fixpoint.
    const nested = fill(String.raw`\\\\u0025%2525\"\\u005c%5C\/`)
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

    expect(performance.now() - started).toBeLessThan(1000)
    expect(response.status).toBe(400)
    // Admitted past the credential check: the route's own plan refused it.
    expect(api.ledger.entries().at(-1)?.notEmulated).toContain('the plan saw')

    const [outcome, elapsed] = timed(() => secretClosureOutcome(nested, [secret]))

    expect(outcome).toBe('clear')
    expect(elapsed).toBeLessThan(1000)
  })

  it('a capped 64 KiB body is refused as a credential repeat well under a second', async () => {
    const api = await build([echoPlan], true)

    // One escape that needs ~32000 percent-decodings (round cap), and two independent kinds of
    // deep escapes whose interleavings multiply the distinct texts (text and character caps).
    const deep = `%${'25'.repeat(32_000)}41`
    const interleaved = fill(`%${'25'.repeat(100)}41 ${'\\'.repeat(4096)}q `)

    for (const text of [deep, interleaved]) {
      const [outcome, elapsed] = timed(() => secretClosureOutcome(text, [secret]))

      expect(outcome).toBe('capped')
      expect(elapsed).toBeLessThan(1000)
    }

    const response = await api.fetch(
      new Request('https://api.example.test/echo/1', {
        method: 'POST',
        headers: { authorization: `Bearer ${secret}`, 'content-type': 'application/json' },
        body: JSON.stringify({ a: interleaved, b: '' })
      })
    )

    expect(response.status).toBe(400)
    expect(api.ledger.entries().at(-1)).toMatchObject({
      path: '/<unrecognised>',
      query: {},
      headers: {},
      notEmulated: 'the request body repeats the credential'
    })
  })

  it('recognises only a b64token bearer with a safe first character, not a number', async () => {
    const api = await build([echo], true)

    const refused = [
      // Characters the transforms consume (`\`, `%`, `"`), separators, and `=` before the end.
      String.raw`\nabcdefg`,
      'Gbcd\\efgh',
      'Gbcd%41efgh',
      'Gbcd"efgh',
      'Gbcd efgh',
      'Gbcd,efgh',
      'Gbcd=efgh',
      'Gbcd:efgh',
      'Gbcd!efgh',
      // First characters that complete an escape: hex digits and the JSON escape letters.
      ...['0', '4', '9', 'a', 'b', 'c', 'd', 'e', 'f', 'A', 'B', 'C', 'D', 'E', 'F'].map(
        first => `${first}1abcdfgh`
      ),
      ...['n', 'r', 't', 'u'].map(first => `${first}abcdefgh`),
      // The number alphabet, and non-ASCII.
      '12345678',
      '1.2345678e7',
      '-1.5E+10000',
      '12345678901234567890',
      'synth\u00e9tique-token'
    ]

    for (const value of refused) {
      const response = await api.fetch(get('/files/a', { authorization: `Bearer ${value}` }))

      expect(response.status, value).toBe(400)
      expect(await response.text(), value).not.toContain(value)
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

    // GitHub and Google token forms, the allowed first characters (upper-case `N`, `R`, `T`, `U`
    // included: the JSON escape letters are lower-case only), and trailing `=` padding.
    for (const value of [
      'ghp_SyntheticToken0123456789',
      'github_pat_11SYNTHETIC0_abcdefghijklmnopqrstuvwxyz',
      'gho_SyntheticToken0123456789',
      'ya29.a0Synthetic-Token_value',
      'S3ludGhldGljLXRva2Vu==',
      'Zbc+def/ghi~jkl',
      'Nabcdefg',
      'Rabcdefg',
      'Tabcdefg',
      'Uabcdefg',
      '/abcdefg',
      '_abcdefg',
      '~abcdefg',
      'x1234567'
    ]) {
      expect(isRecognisableBearerValue(value), value).toBe(true)
      expect((await api.fetch(get('/files/a', { authorization: `Bearer ${value}` }))).status).toBe(
        200
      )
    }
  })

  it('a bearer with a safe first character is found beside any stray escape introducer', () => {
    const strays = ['%', '%4', '%7', '\\', '\\u', '\\u00', '\\u006', '%25', '%5C', '%255C']

    for (const bearer of ['Nabcdefg', 'Uabcdefg', '/abcdefg', 'gabcdefg', 'zabcdefg']) {
      const hex = bearer.charCodeAt(0).toString(16).padStart(2, '0')
      const rest = bearer.slice(1)

      // The first character unencoded, percent-encoded once and twice, and JSON-escaped once and
      // twice, each with the rest of the bearer as it is.
      const encodings = [
        bearer,
        `%${hex}${rest}`,
        `%25${hex}${rest}`,
        `\\u00${hex}${rest}`,
        `\\\\u00${hex}${rest}`
      ]

      for (const stray of strays) {
        for (const encoded of encodings) {
          const text = `${stray}${encoded}`

          expect(textRepeatsSecret(text, [bearer]), text).toBe(true)
        }
      }
    }
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
  it('exactQuery with rawNames compares every raw parameter name with its plain name', () => {
    const raw = (query: string): EmulatedRequest => ({ ...request(query), rawQuery: query })
    const plain = 'the_name=https%3A%2F%2Fx.example.test%2Fa'
    const encoded = 'a query parameter name in any but its plain form is not emulated'

    // Values may be encoded; only names are compared raw.
    expect(exactQuery(raw(plain), ['the_name'], [], { rawNames: true })).toEqual({
      the_name: 'https://x.example.test/a'
    })
    expect(exactQuery(raw(''), [], ['the_name'], { rawNames: true })).toEqual({})

    for (const name of ['%74he_name', 'the%5Fname', 'the_nam%65', 'the_name%20', 'the+name']) {
      const query = plain.replace('the_name', name)

      // Without the option the decoded name is accepted (where it decodes to the route's name).
      if (!name.includes('+') && !name.endsWith('%20')) {
        expect(exactQuery(raw(query), ['the_name'])).toEqual({
          the_name: 'https://x.example.test/a'
        })
      }

      expect(reasonOf(exactQuery(raw(query), ['the_name'], [], { rawNames: true })), name).toMatch(
        /not emulated/
      )
    }

    expect(
      reasonOf(
        exactQuery(raw(plain.replace('the_name', '%74he_name')), ['the_name'], [], {
          rawNames: true
        })
      )
    ).toBe(encoded)
    // A request built without its raw query cannot prove its names plain: refused.
    expect(reasonOf(exactQuery(request(plain), ['the_name'], [], { rawNames: true }))).toBe(encoded)
  })

  it('the wrapper hands routes the raw query, never decoded', async () => {
    const seen: Array<string | undefined> = []

    const rawEcho = statefulRoute<State, undefined, string>(
      { ...digestEcho, path: '/raw' },
      'none',
      routed => {
        seen.push(routed.rawQuery)

        return ''
      },
      () => () => new Response('ok')
    )

    const api = await build([rawEcho], true)

    await api.fetch(
      get('/raw?%74he_name=a%20b#fragment', { authorization: 'Bearer synthetic-wrapper-secret' })
    )
    await api.fetch(get('/raw', { authorization: 'Bearer synthetic-wrapper-secret' }))

    expect(seen).toEqual(['%74he_name=a%20b', ''])
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
