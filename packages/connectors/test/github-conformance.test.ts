import { describe, expect, it } from '@effect/vitest'
import { Cause, Deferred, Effect, Exit, Fiber, Layer, Option, Ref } from 'effect'
import * as Schema from 'effect/Schema'
import { TestClock } from 'effect/testing'
import { HttpClient, HttpClientError, type HttpClientRequest } from 'effect/unstable/http'
import { defineConformanceCase, type ConformanceCase } from '@yolk-sdk/conformance/case'
import {
  decodeWireFixture,
  isWireBase64BodyResponse,
  isWireStreamResponse,
  scanFixtureForSecrets,
  type WireExchange,
  type WireFixture,
  type WireResponse
} from '@yolk-sdk/conformance/fixture'
import {
  makeReplayHttpClient,
  ReplayHttpClient,
  type ReplayLedgerApi,
  type ReplayLedgerEntry
} from '@yolk-sdk/conformance/replay'
import {
  conformanceReportFailed,
  formatConformanceReport,
  runConformance,
  type ConformanceTarget
} from '@yolk-sdk/conformance/runner'
import { BearerTokenCredential } from '@yolk-sdk/connectors'
import {
  ConformanceCleanupReporter,
  connectorHttpClientsFromEffectHttpClientLayer,
  staticCredentialResolverLayer
} from '@yolk-sdk/connectors/conformance'
import { GithubConnector } from '@yolk-sdk/connectors/github'
import {
  GithubConformanceConfig,
  GithubConformanceSeeds as GithubConformanceSeedsSchema,
  findGithubConformanceLeftovers,
  githubCommentLifecycleCase,
  githubCommentLifecycleFixture,
  githubConformanceCases,
  githubConformanceFixtureSeeds,
  githubConformanceFixtures,
  githubFileContentsFixture,
  githubIssueLabelsCase,
  githubIssueLabelsFixture,
  githubIssueLifecycleCase,
  githubIssueLifecycleFixture,
  githubLabelsPagingCase,
  githubLabelsPagingFixture,
  githubNotFoundEnvelopeFixture,
  githubValidationEnvelopeFixture,
  type GithubConformanceCase,
  type GithubConformanceSeeds
} from '@yolk-sdk/connectors/github/conformance'

const now = new Date('2026-09-30T12:00:00.000Z')

const atTestNow = TestClock.setTime(now.getTime())

const syntheticToken = 'synthetic-github-token-0001'

const credentialLayer = staticCredentialResolverLayer(
  BearerTokenCredential.make({ token: syntheticToken })
)

const portsOver = (
  httpLayer: Layer.Layer<HttpClient.HttpClient>,
  seeds: GithubConformanceSeeds = githubConformanceFixtureSeeds
) =>
  Layer.mergeAll(
    connectorHttpClientsFromEffectHttpClientLayer.pipe(Layer.provide(httpLayer)),
    credentialLayer,
    Layer.succeed(GithubConformanceConfig, seeds)
  )

const fixturesFor = (
  testCase: Pick<ConformanceCase<unknown, unknown>, 'fixtures'>,
  fixtures: ReadonlyArray<WireFixture> = githubConformanceFixtures
) => fixtures.filter(fixture => testCase.fixtures.includes(fixture.id))

const replayLayerOver =
  (fixtures: ReadonlyArray<WireFixture> = githubConformanceFixtures) =>
  (testCase: GithubConformanceCase) =>
    portsOver(ReplayHttpClient.layer(fixturesFor(testCase, fixtures)))

/** Replay layer that also hands its ledger to the test, keyed by case id. */
const ledgerCaseLayer =
  (
    ledgers: Ref.Ref<Map<string, ReplayLedgerApi>>,
    fixtures: ReadonlyArray<WireFixture> = githubConformanceFixtures,
    seeds: GithubConformanceSeeds = githubConformanceFixtureSeeds
  ) =>
  (testCase: GithubConformanceCase) =>
    portsOver(
      Layer.unwrap(
        makeReplayHttpClient(fixturesFor(testCase, fixtures)).pipe(
          Effect.tap(({ ledger }) =>
            Ref.update(ledgers, current => new Map(current).set(testCase.id, ledger))
          ),
          Effect.map(({ client }) => Layer.succeed(HttpClient.HttpClient, client))
        )
      ),
      seeds
    )

const ledgerOf = (ledgers: Ref.Ref<Map<string, ReplayLedgerApi>>, caseId: string) =>
  Effect.gen(function* () {
    const ledger = (yield* Ref.get(ledgers)).get(caseId)

    if (ledger === undefined) {
      return expect.fail(`no ledger for ${caseId}`)
    }

    return { entries: yield* ledger.entries, remaining: yield* ledger.remaining }
  })

const apiBase = 'https://api.github.com/'

const repoBase = `${apiBase}repos/yolk-synthetic/conformance-practice/`

/** `METHOD route exchangeIndex` per ledger entry (route relative to the repository, no query). */
const exchangeIndices = (entries: ReadonlyArray<ReplayLedgerEntry>) =>
  entries.map(entry =>
    entry.match.outcome === 'matched'
      ? `${entry.method} ${entry.url.slice(repoBase.length).split('?', 1)[0]} ${entry.match.exchangeIndex}`
      : `unmatched ${entry.method} ${entry.url}`
  )

const synthetic = (id: string) => `${id}.synthetic`

const caseIds = [
  ['github.labels.list-link-paging', 'read'],
  ['github.errors.not-found-envelope', 'read'],
  ['github.errors.validation-envelope', 'read'],
  ['github.contents.base64-file', 'read'],
  ['github.comments.create-delete', 'write-reversible'],
  ['github.labels.add-remove', 'write-reversible'],
  ['github.issues.lifecycle-close', 'write-irreversible']
] as const

const lifecycleId = 'github.issues.lifecycle-close'

/** Replay may run every case, the write-irreversible one included. */
const everyCase: ConformanceTarget = { kind: 'replay' }

function textBody(response: WireResponse): string {
  if (isWireStreamResponse(response) || isWireBase64BodyResponse(response)) {
    return expect.fail('expected a text body')
  }

  return response.body
}

describe('GitHub conformance cases', () => {
  it('declare their safety, stay unverified, and are backed by one fixture each', () => {
    expect(githubConformanceCases.map(testCase => [testCase.id, testCase.safety])).toEqual(
      caseIds.map(([id, safety]) => [id, safety])
    )
    expect(githubConformanceFixtures.map(fixture => fixture.caseId)).toEqual(
      githubConformanceCases.map(testCase => testCase.id)
    )

    for (const testCase of githubConformanceCases) {
      expect(testCase.observed).toBeUndefined()
      expect(testCase.fixtures).toEqual([synthetic(testCase.id)])
    }
  })

  it('cite only real connector actions', () => {
    const actionIds = new Set(GithubConnector.actions.map(action => action.id))

    for (const testCase of githubConformanceCases) {
      const cited = [...`${testCase.docs} ${testCase.wire}`.matchAll(/`(github\.[a-z_]+)`/g)].map(
        match => match[1]
      )

      expect(cited.length).toBeGreaterThan(0)
      expect(cited.filter(id => id === undefined || !actionIds.has(id))).toEqual([])
    }
  })

  it('mark every guessed sub-claim unverified in wire', () => {
    expect(
      githubConformanceCases.flatMap(testCase =>
        [...testCase.wire.matchAll(/\bunverified: /g)].map(() => testCase.id)
      )
    ).toEqual([
      'github.errors.not-found-envelope',
      'github.errors.validation-envelope',
      'github.contents.base64-file',
      'github.comments.create-delete',
      'github.comments.create-delete',
      'github.labels.add-remove'
    ])
  })

  it.effect('ship synthetic fixtures that decode and pass the secret scan', () =>
    Effect.gen(function* () {
      for (const fixture of githubConformanceFixtures) {
        expect(yield* decodeWireFixture(fixture)).toEqual(fixture)
        expect(scanFixtureForSecrets(fixture)).toEqual([])
        expect(fixture).toMatchObject({ evidence: 'unverified', account: 'synthetic' })

        for (const { request, response } of fixture.exchanges) {
          expect(Object.keys(request.headers ?? {})).not.toContain('authorization')
          expect(request.headers).toMatchObject({ 'x-github-api-version': '2026-03-10' })
          expect(request.url.startsWith(apiBase)).toBe(true)

          if (response.status >= 400) {
            // GitHub errors: JSON with a string `message` and `documentation_url`.
            expect(JSON.parse(textBody(response))).toMatchObject({
              message: expect.any(String),
              documentation_url: expect.any(String)
            })
          }
        }
      }
    })
  )

  it.effect('all pass on replay with unverified warnings', () =>
    Effect.gen(function* () {
      yield* atTestNow

      const report = yield* runConformance(githubConformanceCases, {
        target: everyCase,
        now,
        fixtures: githubConformanceFixtures,
        layer: replayLayerOver()
      })

      expect(report.summary, formatConformanceReport(report)).toEqual({
        passed: 7,
        failed: 0,
        skipped: 0
      })
      expect(conformanceReportFailed(report)).toBe(false)

      for (const result of report.results) {
        expect(result.warnings).toEqual([
          { kind: 'unverified-case' },
          { kind: 'unverified-fixture', fixtureId: synthetic(result.id) }
        ])
      }
    })
  )

  it.effect('consume every recorded exchange in order and send the recorded requests', () =>
    Effect.gen(function* () {
      yield* atTestNow

      const ledgers = yield* Ref.make(new Map<string, ReplayLedgerApi>())

      const report = yield* runConformance(githubConformanceCases, {
        target: everyCase,
        now,
        layer: ledgerCaseLayer(ledgers)
      })

      expect(report.summary.passed).toBe(7)

      for (const testCase of githubConformanceCases) {
        const { entries, remaining } = yield* ledgerOf(ledgers, testCase.id)
        const [fixture] = fixturesFor(testCase)

        if (fixture === undefined) {
          return expect.fail(`no fixture for ${testCase.id}`)
        }

        expect(remaining).toEqual([])
        expect(entries).toHaveLength(fixture.exchanges.length)

        entries.forEach((entry, index) => {
          const exchange: WireExchange | undefined = fixture.exchanges[index]

          expect(entry.match).toEqual({
            outcome: 'matched',
            fixtureId: fixture.id,
            exchangeIndex: index
          })
          expect(entry.bodyJson ?? entry.bodyText).toEqual(exchange?.request.body)
          expect(entry.headers).toMatchObject(exchange?.request.headers ?? {})
          // The token travels in the Authorization header only, and the ledger redacts it.
          expect(entry.headers.authorization).toBe('<redacted>')
          expect(JSON.stringify(entry)).not.toContain(syntheticToken)
        })
      }
    })
  )
})

describe('GitHub conformance safety on a live target', () => {
  // A replay layer under a `live` target proves the policy without any network.
  const statuses = (target: ConformanceTarget) =>
    atTestNow.pipe(
      Effect.andThen(
        runConformance(githubConformanceCases, { target, now, layer: replayLayerOver() })
      ),
      Effect.map(report =>
        report.results.map(result => [result.id, result.status, result.skipReason ?? null])
      )
    )

  it.effect('runs only the read cases by default', () =>
    Effect.gen(function* () {
      expect(yield* statuses({ kind: 'live', account: 'synthetic' })).toEqual(
        caseIds.map(([id, safety]) =>
          safety === 'read'
            ? [id, 'passed', null]
            : [
                id,
                'skipped',
                safety === 'write-irreversible' ? 'manual-only' : 'writes-not-allowed'
              ]
        )
      )
    })
  )

  it.effect('never runs the issue lifecycle under reversible writes', () =>
    Effect.gen(function* () {
      const results = yield* statuses({
        kind: 'live',
        account: 'synthetic',
        allowWrites: 'reversible'
      })

      expect(results.map(([id, status]) => [id, status])).toEqual(
        caseIds.map(([id]) => [id, id === lifecycleId ? 'skipped' : 'passed'])
      )
    })
  )

  it.effect('runs the issue lifecycle only when named by its exact id', () =>
    Effect.gen(function* () {
      const results = yield* statuses({
        kind: 'live',
        account: 'synthetic',
        allowIrreversible: [lifecycleId]
      })

      expect(results.find(([id]) => id === lifecycleId)).toEqual([lifecycleId, 'passed', null])
    })
  )
})

// Drills: replay a fixture that contradicts a claim, or drop it, and check that exactly that case
// fails (and, for write cases, still undoes what it created).

/** Replace exchange `index`'s response, keeping the fixture id so the case still selects it. */
const replaceResponse = (
  fixture: WireFixture,
  index: number,
  response: (original: WireResponse) => WireResponse
): WireFixture => {
  const swap = (exchange: WireExchange, position: number): WireExchange =>
    position === index ? { ...exchange, response: response(exchange.response) } : exchange

  const [first, ...rest] = fixture.exchanges

  return {
    ...fixture,
    exchanges: [swap(first, 0), ...rest.map((exchange, offset) => swap(exchange, offset + 1))]
  }
}

/** A copy of `fixture` (same id) without the exchanges at `indices`. */
const withoutExchanges = (fixture: WireFixture, indices: ReadonlyArray<number>): WireFixture => {
  const [first, ...rest] = fixture.exchanges.filter((_, index) => !indices.includes(index))

  return first === undefined
    ? expect.fail(`no exchanges left in ${fixture.id}`)
    : { ...fixture, exchanges: [first, ...rest] }
}

/** Replace the first occurrence of `from` in a text body, failing if it is not there. */
const replaceInBody =
  (from: string, to: string) =>
  (response: WireResponse): WireResponse => {
    const body = textBody(response)

    expect(body).toContain(from)

    return { status: response.status, headers: response.headers, body: body.replace(from, to) }
  }

const withStatus =
  (status: number, body: string) =>
  (response: WireResponse): WireResponse => ({ status, headers: response.headers, body })

const withHeaders =
  (headers: Readonly<Record<string, string>>) =>
  (response: WireResponse): WireResponse => ({ ...response, headers })

const exchangeAt = (fixture: WireFixture, index: number): WireExchange =>
  fixture.exchanges[index] ?? expect.fail(`no exchange ${index} in ${fixture.id}`)

const serverError =
  '{"message":"Server Error","documentation_url":"https://docs.github.com/rest","status":"500"}'

const mismatch = (message: string) => ({ kind: 'failure', tag: 'ConformanceMismatch', message })

/** Run the whole suite on replay with `fixtures`; return the failed case ids and failures. */
const suiteFailures = (fixtures: ReadonlyArray<WireFixture>) =>
  Effect.gen(function* () {
    yield* atTestNow

    const report = yield* runConformance(githubConformanceCases, {
      target: everyCase,
      now,
      layer: replayLayerOver(fixtures)
    })

    return report.results
      .filter(result => result.status === 'failed')
      .map(result => ({ id: result.id, failure: result.failure }))
  })

const withReplaced = (tampered: WireFixture) =>
  githubConformanceFixtures.map(fixture => (fixture.id === tampered.id ? tampered : fixture))

const contentsBody = JSON.parse(textBody(exchangeAt(githubFileContentsFixture, 0).response))

const jsonText = (value: unknown) => JSON.stringify(value)

type ReportedFailure = { readonly kind: string; readonly tag: string; readonly message: string }

/** One tamper per case: the fixture edit and the failure the case reports. */
const tampers: ReadonlyArray<{
  readonly fixture: WireFixture
  readonly message?: string
  readonly failure?: ReportedFailure
}> = [
  {
    // The first page answers no Link header while page 2 still holds labels.
    fixture: replaceResponse(
      githubLabelsPagingFixture,
      0,
      withHeaders({ 'content-type': 'application/json; charset=utf-8' })
    ),
    message: 'expected page 2, after a page whose Link lists no rel="next", to answer no labels'
  },
  {
    fixture: replaceResponse(
      githubNotFoundEnvelopeFixture,
      0,
      withStatus(
        422,
        '{"message":"Validation Failed","documentation_url":"https://docs.github.com/rest","status":"422"}'
      )
    ),
    message: 'expected an unused issue number to map to github_not_found'
  },
  {
    // Error entries in a shape the connector cannot read: no string resource/field/code/message.
    fixture: replaceResponse(
      githubValidationEnvelopeFixture,
      0,
      withStatus(
        422,
        '{"message":"Validation Failed","errors":[{"value":256}],"documentation_url":"https://docs.github.com/v3/search/","status":"422"}'
      )
    ),
    message: 'expected errors entries in a shape the connector reads (underlying.errors non-empty)'
  },
  {
    fixture: replaceResponse(githubFileContentsFixture, 0, response => ({
      status: response.status,
      headers: response.headers,
      body: jsonText({ ...contentsBody, size: Number(contentsBody.size) - 3 })
    })),
    message: 'expected size to equal the UTF-8 byte length of the decoded content'
  },
  {
    // A deleted comment deleted again answers 204 instead of not found.
    fixture: replaceResponse(githubCommentLifecycleFixture, 4, () => ({
      status: 204,
      headers: {},
      body: ''
    })),
    message: 'expected deleting the deleted comment again to answer github_not_found'
  },
  {
    fixture: replaceResponse(
      githubIssueLabelsFixture,
      6,
      () => exchangeAt(githubIssueLabelsFixture, 4).response
    ),
    message: 'expected removing the removed label again to answer github_not_found'
  },
  {
    // The rename is ignored; the restore still closes the issue (as not_planned).
    fixture: replaceResponse(
      githubIssueLifecycleFixture,
      2,
      () => exchangeAt(githubIssueLifecycleFixture, 1).response
    ),
    message: 'expected update_issue to answer the same issue with the new title'
  }
]

describe('GitHub conformance drills (one per case)', () => {
  it('cover every case with a tamper', () => {
    expect(tampers.map(tamper => tamper.fixture.caseId)).toEqual(caseIds.map(([id]) => id))
  })

  for (const { fixture, message, failure } of tampers) {
    it.effect(`a tampered fixture fails exactly ${fixture.caseId}`, () =>
      Effect.gen(function* () {
        expect(yield* suiteFailures(withReplaced(fixture))).toEqual([
          {
            id: fixture.caseId,
            failure: failure ?? mismatch(message ?? expect.fail('tamper without an outcome'))
          }
        ])
      })
    )
  }

  for (const [label, tampered, message] of [
    [
      'a repeated label on a later page',
      replaceResponse(
        githubLabelsPagingFixture,
        1,
        replaceInBody('"name":"enhancement"', '"name":"bug"')
      ),
      'expected a later page to repeat no label from an earlier page'
    ],
    [
      'the same label twice on one page',
      replaceResponse(
        githubLabelsPagingFixture,
        1,
        replaceInBody('"name":"question"', '"name":"enhancement"')
      ),
      'expected every page to list each label once'
    ],
    [
      'a Link rel="next" dropped from the middle page',
      replaceResponse(
        githubLabelsPagingFixture,
        1,
        withHeaders({ 'content-type': 'application/json; charset=utf-8' })
      ),
      'expected page 3, after a page whose Link lists no rel="next", to answer no labels'
    ],
    [
      'a not-found body without documentation_url',
      replaceResponse(
        githubNotFoundEnvelopeFixture,
        0,
        withStatus(404, '{"message":"Not Found","status":"404"}')
      ),
      'expected the not-found body to be JSON with a non-empty message and a documentation_url'
    ],
    [
      'a validation body without errors',
      replaceResponse(
        githubValidationEnvelopeFixture,
        0,
        withStatus(422, '{"message":"Validation Failed","documentation_url":"https://x.test"}')
      ),
      'expected the validation body to be JSON with a message and a non-empty errors array'
    ],
    [
      'unfolded base64 content',
      replaceResponse(githubFileContentsFixture, 0, response => ({
        status: response.status,
        headers: response.headers,
        body: jsonText({
          ...contentsBody,
          content: String(contentsBody.content).replaceAll('\n', '')
        })
      })),
      'expected the base64 content to be broken into lines'
    ]
  ] as const) {
    it.effect(`${label} fails exactly its case`, () =>
      Effect.gen(function* () {
        expect(yield* suiteFailures(withReplaced(tampered))).toEqual([
          { id: tampered.caseId, failure: mismatch(message) }
        ])
      })
    )
  }

  it.effect('a not-found body that also carries errors details still passes', () =>
    Effect.gen(function* () {
      // The connector reads errors details when present: the case pins neither them nor the rest.
      const withErrors = replaceResponse(
        githubNotFoundEnvelopeFixture,
        0,
        withStatus(
          404,
          '{"message":"Not Found","errors":[{"resource":"Issue","code":"missing"}],"documentation_url":"https://docs.github.com/rest/issues/issues#get-an-issue","status":"404"}'
        )
      )

      expect(yield* suiteFailures(withReplaced(withErrors))).toEqual([])
    })
  )

  for (const [caseId] of caseIds) {
    it.effect(`a dropped fixture fails exactly ${caseId}`, () =>
      Effect.gen(function* () {
        const failures = yield* suiteFailures(
          githubConformanceFixtures.filter(fixture => fixture.caseId !== caseId)
        )

        expect(failures.map(failure => failure.id)).toEqual([caseId])
      })
    )
  }
})

const drill = (
  testCase: GithubConformanceCase,
  fixture: WireFixture,
  seeds: GithubConformanceSeeds = githubConformanceFixtureSeeds
) =>
  Effect.gen(function* () {
    yield* atTestNow

    const ledgers = yield* Ref.make(new Map<string, ReplayLedgerApi>())

    const report = yield* runConformance([testCase], {
      target: everyCase,
      now,
      layer: ledgerCaseLayer(ledgers, [fixture], seeds)
    })

    return {
      passed: !conformanceReportFailed(report),
      failure: report.results[0]?.failure,
      ...(yield* ledgerOf(ledgers, testCase.id))
    }
  })

const writeCalls = (entries: ReadonlyArray<ReplayLedgerEntry>) =>
  entries.flatMap(entry =>
    entry.method === 'GET' ? [] : [`${entry.method} ${entry.url.slice(repoBase.length)}`]
  )

const commentRestoreFailing = (fixture: WireFixture) =>
  replaceResponse(fixture, 2, withStatus(500, serverError))

/** The comment case with its first listing missing the new comment: a claim failure. */
const commentUnlisted = replaceResponse(
  githubCommentLifecycleFixture,
  1,
  replaceInBody(textBody(exchangeAt(githubCommentLifecycleFixture, 1).response), '[]')
)

const commentRecovery = 'delete comment 9000000001 on issue #1 by hand if it still exists'

describe('GitHub conformance restore', () => {
  it.effect('still deletes the comment, by id, when a claim fails mid-flow', () =>
    Effect.gen(function* () {
      const { failure, entries, remaining } = yield* drill(
        githubCommentLifecycleCase,
        commentUnlisted
      )

      expect(failure).toEqual(
        mismatch("expected list_issue_comments since the comment's created_at to list it")
      )
      expect(exchangeIndices(entries)).toEqual([
        'POST issues/1/comments 0',
        'GET issues/1/comments 1',
        'DELETE issues/comments/9000000001 2',
        'GET issues/1/comments 3'
      ])
      expect(remaining).toEqual([{ fixtureId: githubCommentLifecycleFixture.id, exchangeIndex: 4 }])
    })
  )

  it.effect('reports a failed restore, naming the comment, instead of swallowing it', () =>
    Effect.gen(function* () {
      const { failure } = yield* drill(
        githubCommentLifecycleCase,
        commentRestoreFailing(commentUnlisted)
      )

      expect(failure?.tag).toBe('GithubConformanceRestoreFailed')
      expect(failure?.message).toBe(
        `github.comments.create-delete: restore failed; ${commentRecovery}. Restore error: github.delete_issue_comment github_request_failed 500. Claim failed first: expected list_issue_comments since the comment's created_...`
      )
    })
  )

  it.effect('accepts a not-found answer to the restore delete, then still verifies', () =>
    Effect.gen(function* () {
      const gone = replaceResponse(
        commentUnlisted,
        2,
        () => exchangeAt(githubCommentLifecycleFixture, 4).response
      )

      const { failure, entries } = yield* drill(githubCommentLifecycleCase, gone)

      expect(failure?.tag).toBe('ConformanceMismatch')
      expect(exchangeIndices(entries).slice(-2)).toEqual([
        'DELETE issues/comments/9000000001 2',
        'GET issues/1/comments 3'
      ])
    })
  )

  it.effect('fails the restore when the comment is still listed after deleting it', () =>
    Effect.gen(function* () {
      const stillThere = replaceResponse(
        commentUnlisted,
        3,
        () => exchangeAt(githubCommentLifecycleFixture, 1).response
      )

      const { failure } = yield* drill(githubCommentLifecycleCase, stillThere)

      expect(failure?.tag).toBe('GithubConformanceRestoreFailed')
      expect(failure?.message).toContain(
        `restore failed; ${commentRecovery}. Restore error: expected list_issue_comments to omit the case comment aft...`
      )
    })
  )

  it.effect('removes the label again when a claim fails after adding it', () =>
    Effect.gen(function* () {
      const unlisted = replaceResponse(
        githubIssueLabelsFixture,
        3,
        () => exchangeAt(githubIssueLabelsFixture, 0).response
      )

      const { failure, entries, remaining } = yield* drill(githubIssueLabelsCase, unlisted)

      expect(failure).toEqual(mismatch('expected get_issue to list the added label'))
      expect(exchangeIndices(entries)).toEqual([
        'GET issues/1 0',
        'GET labels 1',
        'POST issues/1/labels 2',
        'GET issues/1 3',
        'DELETE issues/1/labels/synthetic-conformance 4',
        'GET issues/1 5'
      ])
      expect(remaining).toEqual([{ fixtureId: githubIssueLabelsFixture.id, exchangeIndex: 6 }])
    })
  )

  it.effect('closes the issue as not_planned when a lifecycle claim fails', () =>
    Effect.gen(function* () {
      const [lifecycleTamper] = tampers.slice(-1)

      const { failure, entries, remaining } = yield* drill(
        githubIssueLifecycleCase,
        lifecycleTamper?.fixture ?? expect.fail('missing lifecycle tamper')
      )

      expect(failure).toEqual(
        mismatch('expected update_issue to answer the same issue with the new title')
      )
      expect(exchangeIndices(entries)).toEqual([
        'POST issues 0',
        'GET issues/42 1',
        'PATCH issues/42 2',
        'PATCH issues/42 3',
        'GET issues/42 4'
      ])
      expect(entries[3]?.bodyJson).toEqual({ state: 'closed', state_reason: 'not_planned' })
      expect(remaining).toEqual([])
    })
  )

  it.effect('reports a failed close, naming the issue number', () =>
    Effect.gen(function* () {
      const [lifecycleTamper] = tampers.slice(-1)

      const { failure } = yield* drill(
        githubIssueLifecycleCase,
        replaceResponse(
          lifecycleTamper?.fixture ?? expect.fail('missing lifecycle tamper'),
          3,
          withStatus(500, serverError)
        )
      )

      expect(failure?.tag).toBe('GithubConformanceRestoreFailed')
      expect(failure?.message).toContain(
        'github.issues.lifecycle-close: restore failed; close issue #42 by hand if it is still open. Restore error: github.update_issue github_request_failed 500.'
      )
    })
  )

  for (const [seed, testCase] of [
    ['owner', githubLabelsPagingCase],
    ['repo', githubLabelsPagingCase],
    ['workIssueNumber', githubCommentLifecycleCase],
    ['labelName', githubIssueLabelsCase],
    ['runId', githubIssueLifecycleCase]
  ] as const) {
    it.effect(`fails with a precondition before any request without ${seed}`, () =>
      Effect.gen(function* () {
        const { [seed]: _dropped, ...seeds } = githubConformanceFixtureSeeds

        const { failure, entries } = yield* drill(
          testCase,
          fixturesFor(testCase)[0] ?? expect.fail('no fixture'),
          seeds
        )

        expect(failure).toEqual(
          mismatch(`precondition: GithubConformanceConfig.${seed} is not configured`)
        )
        expect(entries).toEqual([])
      })
    )
  }

  it.effect('refuses to add a label that is already on the work issue', () =>
    Effect.gen(function* () {
      const alreadyThere = replaceResponse(
        githubIssueLabelsFixture,
        0,
        () => exchangeAt(githubIssueLabelsFixture, 3).response
      )

      const { failure, entries } = yield* drill(githubIssueLabelsCase, alreadyThere)

      expect(failure).toEqual(
        mismatch(
          'precondition: labelName is already on workIssueNumber (a leftover or a concurrent run); remove it by hand first'
        )
      )
      expect(writeCalls(entries)).toEqual([])
    })
  )

  it.effect('refuses to add a label the repository does not have (it would be created)', () =>
    Effect.gen(function* () {
      const missing = replaceResponse(
        githubIssueLabelsFixture,
        1,
        replaceInBody('"name":"synthetic-conformance"', '"name":"other-label"')
      )

      const { failure, entries } = yield* drill(githubIssueLabelsCase, missing)

      expect(failure).toEqual(
        mismatch(
          'precondition: labelName must be an existing repository label (adding a missing label creates it, which the connector cannot undo)'
        )
      )
      expect(writeCalls(entries)).toEqual([])
    })
  )

  it.effect('reports a transport failure of a read without a status', () =>
    Effect.gen(function* () {
      const dropping = HttpClient.make(request => Effect.fail(connectionReset(request)))

      const report = yield* runConformance([githubLabelsPagingCase], {
        target: everyCase,
        now,
        layer: () => portsOver(Layer.succeed(HttpClient.HttpClient, dropping))
      })

      expect(report.results[0]?.failure).toEqual({
        kind: 'failure',
        tag: 'ConnectorError',
        message: 'GitHub GET request failed before a response'
      })
    })
  )
})

const connectionReset = (request: HttpClientRequest.HttpClientRequest) =>
  new HttpClientError.HttpClientError({
    reason: new HttpClientError.TransportError({ request, description: 'connection reset' })
  })

// Ownership drills: definitive rejections undo nothing, ambiguous writes are reported with the
// exact item, and cleanup never leaves the run namespace.

const commentBody =
  'yolk-conformance run-synthetic comment: synthetic conformance comment, safe to delete'

const commentUnknown = `delete the comment "${commentBody}" on issue #1 by hand if it exists`

const issueTitle =
  'yolk-conformance run-synthetic lifecycle: synthetic conformance issue, safe to ignore'

const onlyCreate = (fixture: WireFixture, index = 0) =>
  withoutExchanges(
    fixture,
    fixture.exchanges.flatMap((_, position) => (position === index ? [] : [position]))
  )

describe('GitHub conformance write ownership', () => {
  it.effect('undoes nothing after a definitive comment create rejection', () =>
    Effect.gen(function* () {
      const rejected = onlyCreate(
        replaceResponse(
          githubCommentLifecycleFixture,
          0,
          withStatus(
            403,
            '{"message":"Resource not accessible by integration","documentation_url":"https://docs.github.com/rest","status":"403"}'
          )
        )
      )

      const { failure, entries, remaining } = yield* drill(githubCommentLifecycleCase, rejected)

      expect(failure).toEqual({
        kind: 'failure',
        tag: 'GithubConformanceActionFailed',
        message: 'github.create_issue_comment failed: github_forbidden (HTTP 403)'
      })
      expect(writeCalls(entries)).toEqual(['POST issues/1/comments'])
      expect(remaining).toEqual([])
    })
  )

  for (const [status, body] of [
    [503, serverError],
    [
      408,
      '{"message":"Request Timeout","documentation_url":"https://docs.github.com/rest","status":"408"}'
    ]
  ] as const) {
    it.effect(`reports an ambiguous ${status} comment create with the exact body`, () =>
      Effect.gen(function* () {
        const ambiguous = onlyCreate(
          replaceResponse(githubCommentLifecycleFixture, 0, withStatus(status, body))
        )

        const { failure, entries } = yield* drill(githubCommentLifecycleCase, ambiguous)

        expect(failure).toEqual({
          kind: 'failure',
          tag: 'GithubConformanceActionFailed',
          message: `github.create_issue_comment failed: github_request_failed (HTTP ${status}); write outcome unknown: ${commentUnknown}`
        })
        expect(writeCalls(entries)).toEqual(['POST issues/1/comments'])
      })
    )
  }

  it.effect('reports an issue create that fails in transport as ambiguous', () =>
    Effect.gen(function* () {
      const dropping = HttpClient.make(request => Effect.fail(connectionReset(request)))

      const report = yield* runConformance([githubIssueLifecycleCase], {
        target: everyCase,
        now,
        layer: () => portsOver(Layer.succeed(HttpClient.HttpClient, dropping))
      })

      expect(report.results[0]?.failure).toEqual({
        kind: 'failure',
        tag: 'GithubConformanceActionFailed',
        message: `github.create_issue failed: transport_failed; write outcome unknown: close the issue titled "${issueTitle}" by hand if it exists`
      })
    })
  )

  it.effect('reports an ambiguous label add and removes nothing', () =>
    Effect.gen(function* () {
      const ambiguous = withoutExchanges(
        replaceResponse(githubIssueLabelsFixture, 2, withStatus(502, serverError)),
        [3, 4, 5, 6]
      )

      const { failure, entries } = yield* drill(githubIssueLabelsCase, ambiguous)

      expect(failure).toEqual({
        kind: 'failure',
        tag: 'GithubConformanceActionFailed',
        message:
          'github.add_labels failed: github_request_failed (HTTP 502); write outcome unknown: remove label synthetic-conformance from issue #1 by hand if it is there'
      })
      expect(writeCalls(entries)).toEqual(['POST issues/1/labels'])
    })
  )

  it.effect('refuses to adopt a created comment without the run-scoped body', () =>
    Effect.gen(function* () {
      const foreign = onlyCreate(
        replaceResponse(
          githubCommentLifecycleFixture,
          0,
          replaceInBody(`"body":"${commentBody}"`, '"body":"Someone else comment"')
        )
      )

      const { failure, entries } = yield* drill(githubCommentLifecycleCase, foreign)

      expect(failure).toEqual({
        kind: 'failure',
        tag: 'GithubConformanceCleanupRefused',
        message:
          'github.comments.create-delete: cleanup refused; a write answered comment 9000000001 with another body, outside the run namespace, so nothing was undone there; check it by hand.'
      })
      expect(writeCalls(entries)).toEqual(['POST issues/1/comments'])
    })
  )

  for (const [label, from, to, item] of [
    [
      'another title',
      `"title":"${issueTitle}"`,
      '"title":"Someone else issue"',
      'issue #42 titled "Someone else issue"'
    ],
    ["the work issue's number", '"number":42', '"number":1', `issue #1 titled "${issueTitle}"`]
  ] as const) {
    it.effect(`refuses to adopt a created issue answered with ${label}`, () =>
      Effect.gen(function* () {
        const foreign = onlyCreate(
          replaceResponse(githubIssueLifecycleFixture, 0, replaceInBody(from, to))
        )

        const { failure, entries } = yield* drill(githubIssueLifecycleCase, foreign)

        expect(failure).toEqual({
          kind: 'failure',
          tag: 'GithubConformanceCleanupRefused',
          message: `github.issues.lifecycle-close: cleanup refused; a write answered ${item}, outside the run namespace, so nothing was undone there; check it by hand.`
        })
        expect(writeCalls(entries)).toEqual(['POST issues'])
      })
    )
  }
})

describe('GitHub conformance leftover detection (read-only)', () => {
  const listing = (url: string, body: Schema.Json): WireExchange => ({
    request: { method: 'GET', url },
    response: {
      status: 200,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body)
    }
  })

  const leftoversFixture: WireFixture = {
    id: 'github.leftovers.synthetic',
    caseId: 'github.leftovers',
    evidence: 'unverified',
    recordedAt: '2026-09-30',
    account: 'synthetic',
    endpoint: 'https://api.github.com',
    exchanges: [
      listing(`${repoBase}issues?per_page=100&page=1&state=open`, [
        JSON.parse(textBody(exchangeAt(githubIssueLifecycleFixture, 1).response)),
        JSON.parse(textBody(exchangeAt(githubIssueLabelsFixture, 0).response))
      ]),
      listing(`${repoBase}issues/1/comments?per_page=100&page=1`, [
        JSON.parse(textBody(exchangeAt(githubCommentLifecycleFixture, 0).response)),
        {
          ...JSON.parse(textBody(exchangeAt(githubCommentLifecycleFixture, 0).response)),
          id: 9000000002,
          body: 'A person commented here'
        }
      ]),
      listing(
        `${repoBase}issues/1`,
        JSON.parse(textBody(exchangeAt(githubIssueLabelsFixture, 3).response))
      )
    ]
  }

  it.effect('lists open run issues, run comments, and the seeded label, and nothing else', () =>
    Effect.gen(function* () {
      const { client, ledger } = yield* makeReplayHttpClient([leftoversFixture])

      const found = yield* findGithubConformanceLeftovers.pipe(
        Effect.provide(portsOver(Layer.succeed(HttpClient.HttpClient, client)))
      )

      expect(found).toEqual([
        `open issue #42 "${issueTitle}"`,
        'comment 9000000001 on issue #1',
        'label synthetic-conformance on issue #1'
      ])
      // Read-only: only GET requests were sent.
      expect((yield* ledger.entries).map(entry => entry.method)).toEqual(['GET', 'GET', 'GET'])
    })
  )

  it('requires the run- prefix in every run id and valid repository seeds', () => {
    const decode = Schema.decodeUnknownOption(GithubConformanceSeedsSchema)

    expect(Option.isSome(decode(githubConformanceFixtureSeeds))).toBe(true)
    expect(Option.isNone(decode({ runId: 'mine-0000beef' }))).toBe(true)
    expect(Option.isNone(decode({ owner: '-bad-owner' }))).toBe(true)
    expect(Option.isNone(decode({ repo: '..' }))).toBe(true)
    expect(Option.isNone(decode({ workIssueNumber: '0' }))).toBe(true)
    expect(Option.isNone(decode({ filePath: 'docs/../secret' }))).toBe(true)
    expect(Option.isNone(decode({ labelName: '..' }))).toBe(true)
  })
})

// Interruption drills: a cleanup problem raised while the case is being interrupted still reaches
// the owner through the ConformanceCleanupReporter, with the exact item to check.

const capturingReporter = Effect.gen(function* () {
  const warnings = yield* Ref.make<ReadonlyArray<string>>([])

  return {
    warnings,
    reporter: { warn: (message: string) => Ref.update(warnings, list => [...list, message]) }
  }
})

type HoldMoment = 'during the first listing' | 'during the claim delete' | 'during the create'

/** A comment-case client that holds one request at `moment` until released. */
const holdingComment = (moment: HoldMoment, fixture: WireFixture) =>
  Effect.gen(function* () {
    const sent = yield* Deferred.make<void>()
    const release = yield* Deferred.make<void>()
    const { client, ledger } = yield* makeReplayHttpClient([fixture])
    const seen = yield* Ref.make(0)

    const hold = <A, E, R>(response: Effect.Effect<A, E, R>) =>
      response.pipe(
        Effect.tap(() => Deferred.succeed(sent, undefined)),
        Effect.tap(() => Deferred.await(release))
      )

    const holding = HttpClient.transform(client, (response, request) =>
      Effect.gen(function* () {
        const index = yield* Ref.getAndUpdate(seen, count => count + 1)

        const held =
          (moment === 'during the create' && index === 0) ||
          (moment === 'during the first listing' && index === 1) ||
          (moment === 'during the claim delete' && request.method === 'DELETE' && index === 2)

        return yield* held ? hold(response) : response
      })
    )

    return { sent, release, holding, ledger }
  })

const interruptAfter = <A, E>(
  fiber: Fiber.Fiber<A, E>,
  sent: Deferred.Deferred<void>,
  release: Deferred.Deferred<void>
) =>
  Effect.gen(function* () {
    yield* Deferred.await(sent)

    const interrupting = yield* Effect.forkChild(Fiber.interrupt(fiber))

    yield* Effect.yieldNow
    yield* Deferred.succeed(release, undefined)
    yield* Fiber.join(interrupting)

    return yield* Fiber.await(fiber)
  })

/** The comment fixture whose restore (after an interruption) fails: the restore delete answers 500. */
const restoreDeleteFailing = replaceResponse(
  githubCommentLifecycleFixture,
  2,
  withStatus(500, serverError)
)

describe('GitHub conformance interruption', () => {
  it.effect('finishes a masked in-flight delete, then verifies absence on interruption', () =>
    Effect.gen(function* () {
      const { sent, release, holding, ledger } = yield* holdingComment(
        'during the claim delete',
        githubCommentLifecycleFixture
      )

      const fiber = yield* githubCommentLifecycleCase.run.pipe(
        Effect.provide(portsOver(Layer.succeed(HttpClient.HttpClient, holding))),
        Effect.forkChild
      )

      const exit = yield* interruptAfter(fiber, sent, release)

      expect(Exit.hasInterrupts(exit)).toBe(true)
      // The delete completed; no further claim ran; the restore deleted again (404) and verified.
      expect(exchangeIndices(yield* ledger.entries)).toEqual([
        'POST issues/1/comments 0',
        'GET issues/1/comments 1',
        'DELETE issues/comments/9000000001 2',
        'DELETE issues/comments/9000000001 4',
        'GET issues/1/comments 3'
      ])
    })
  )

  it.effect('registers a comment create in flight when interrupted, then deletes it by id', () =>
    Effect.gen(function* () {
      const { sent, release, holding, ledger } = yield* holdingComment(
        'during the create',
        withoutExchanges(githubCommentLifecycleFixture, [1, 4])
      )

      const fiber = yield* githubCommentLifecycleCase.run.pipe(
        Effect.provide(portsOver(Layer.succeed(HttpClient.HttpClient, holding))),
        Effect.forkChild
      )

      const exit = yield* interruptAfter(fiber, sent, release)

      expect(Exit.hasInterrupts(exit)).toBe(true)
      expect(exchangeIndices(yield* ledger.entries)).toEqual([
        'POST issues/1/comments 0',
        'DELETE issues/comments/9000000001 1',
        'GET issues/1/comments 2'
      ])
    })
  )

  it.effect('reports a failed restore when interrupted during a claim', () =>
    Effect.gen(function* () {
      const { warnings, reporter } = yield* capturingReporter

      const { sent, release, holding } = yield* holdingComment(
        'during the first listing',
        restoreDeleteFailing
      )

      const fiber = yield* githubCommentLifecycleCase.run.pipe(
        Effect.provide(portsOver(Layer.succeed(HttpClient.HttpClient, holding))),
        Effect.provideService(ConformanceCleanupReporter, reporter),
        Effect.forkChild
      )

      yield* interruptAfter(fiber, sent, release)

      const reported = yield* Ref.get(warnings)

      expect(reported).toHaveLength(1)
      expect(reported[0]).toContain(
        `github.comments.create-delete: restore failed; ${commentRecovery}.`
      )
    })
  )

  it.effect('reports an ambiguous comment create answered while being interrupted', () =>
    Effect.gen(function* () {
      const { warnings, reporter } = yield* capturingReporter

      const { sent, release, holding } = yield* holdingComment(
        'during the create',
        onlyCreate(replaceResponse(githubCommentLifecycleFixture, 0, withStatus(503, serverError)))
      )

      const fiber = yield* githubCommentLifecycleCase.run.pipe(
        Effect.provide(portsOver(Layer.succeed(HttpClient.HttpClient, holding))),
        Effect.provideService(ConformanceCleanupReporter, reporter),
        Effect.forkChild
      )

      yield* interruptAfter(fiber, sent, release)

      expect(yield* Ref.get(warnings)).toEqual([
        `github.create_issue_comment failed: github_request_failed (HTTP 503); write outcome unknown: ${commentUnknown}`
      ])
    })
  )

  it.effect(
    'reports nothing extra when an uninterrupted restore fails (the report carries it)',
    () =>
      Effect.gen(function* () {
        const { warnings, reporter } = yield* capturingReporter
        const { client } = yield* makeReplayHttpClient([commentRestoreFailing(commentUnlisted)])

        const exit = yield* githubCommentLifecycleCase.run.pipe(
          Effect.provide(portsOver(Layer.succeed(HttpClient.HttpClient, client))),
          Effect.provideService(ConformanceCleanupReporter, reporter),
          Effect.exit
        )

        expect(Exit.isFailure(exit)).toBe(true)
        expect(yield* Ref.get(warnings)).toEqual([])
      })
  )
})

// Run-level interruption drills: runConformance over [the comment case, a sentinel]. Interrupting
// the comment case must stop the run: the sentinel never starts, whether the restore fails or
// succeeds.

const sentinelCase = (ran: Ref.Ref<boolean>) =>
  defineConformanceCase({
    id: 'test.sentinel.after-interrupted-case',
    safety: 'read',
    docs: 'Synthetic sentinel: records whether it ran.',
    wire: 'Runs only if the run was not stopped.',
    fixtures: [],
    run: Ref.set(ran, true)
  })

describe('GitHub conformance run interruption', () => {
  it.effect('stops the whole run when interrupted with a failing restore', () =>
    Effect.gen(function* () {
      const sentinelRan = yield* Ref.make(false)
      const { warnings, reporter } = yield* capturingReporter

      const { sent, release, holding } = yield* holdingComment(
        'during the first listing',
        restoreDeleteFailing
      )

      const fiber = yield* runConformance([githubCommentLifecycleCase, sentinelCase(sentinelRan)], {
        target: everyCase,
        now,
        layer: () => portsOver(Layer.succeed(HttpClient.HttpClient, holding))
      }).pipe(Effect.provideService(ConformanceCleanupReporter, reporter), Effect.forkChild)

      const exit = yield* interruptAfter(fiber, sent, release)

      expect(yield* Ref.get(sentinelRan)).toBe(false)

      // Same shape as the Todoist drill: the run ends with the case's own RestoreFailed and no
      // Interrupt in the cause, produces no report, and resumes no case.
      if (Exit.isSuccess(exit)) {
        return expect.fail('expected the interrupted run to fail')
      }

      expect(Cause.hasInterrupts(exit.cause)).toBe(false)
      expect(Cause.squash(exit.cause)).toMatchObject({ _tag: 'GithubConformanceRestoreFailed' })

      const reported = yield* Ref.get(warnings)

      expect(reported).toHaveLength(1)
      expect(reported[0]).toContain(commentRecovery)
    })
  )

  it.effect(
    'ends interrupt-only, without a report or a later case, when the cleanup succeeds',
    () =>
      Effect.gen(function* () {
        const sentinelRan = yield* Ref.make(false)
        const { warnings, reporter } = yield* capturingReporter

        const { sent, release, holding } = yield* holdingComment(
          'during the first listing',
          withoutExchanges(githubCommentLifecycleFixture, [4])
        )

        const fiber = yield* runConformance(
          [githubCommentLifecycleCase, sentinelCase(sentinelRan)],
          {
            target: everyCase,
            now,
            layer: () => portsOver(Layer.succeed(HttpClient.HttpClient, holding))
          }
        ).pipe(Effect.provideService(ConformanceCleanupReporter, reporter), Effect.forkChild)

        const exit = yield* interruptAfter(fiber, sent, release)

        expect(yield* Ref.get(sentinelRan)).toBe(false)

        if (Exit.isSuccess(exit)) {
          return expect.fail('expected the interrupted run to be interrupted')
        }

        expect(Cause.hasInterruptsOnly(exit.cause)).toBe(true)
        expect(yield* Ref.get(warnings)).toEqual([])
      })
  )
})
