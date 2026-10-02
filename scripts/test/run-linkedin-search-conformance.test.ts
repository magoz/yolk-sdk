import { execFile } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Effect, Layer, Option, Result } from 'effect'
import * as Schema from 'effect/Schema'
import { HttpClient } from 'effect/unstable/http'
import { describe, expect, it } from 'vitest'
import { ConformanceMismatch, defineConformanceCase } from '../../packages/conformance/src/case.ts'
import type { WireExchange, WireFixture } from '../../packages/conformance/src/fixture.ts'
import type { WireRecorderApi } from '../../packages/conformance/src/record.ts'
import { ReplayHttpClient } from '../../packages/conformance/src/replay.ts'
import { runConformance, type ConformanceReport } from '../../packages/conformance/src/runner.ts'
import {
  LinkedInSearchConformanceSeeds,
  linkedInSearchConformanceCases,
  linkedInSearchConformanceFixtureSeeds,
  linkedInSearchConformanceFixtures,
  linkedInSearchEmailLookupFixture,
  linkedInSearchPeopleResultsFixture,
  linkedInSearchProfileFixture
} from '../../packages/connectors/src/linkedin-search/conformance/index.ts'
import {
  enrichLayerApiKeySlotId,
  exaApiKeySlotId
} from '../../packages/connectors/src/linkedin-search/index.ts'
import {
  dryRunReport,
  inspectRecordingForAccessToken,
  interruptOptionsFor,
  liveInCiMessage,
  liveInputs,
  liveSecrets,
  namedLiveSecrets,
  ownerApprovalRequiredMessage,
  parseRunArgs,
  planRun,
  recordingRunId,
  redactedLiveTokenMarker,
  renderFixtureModule,
  renderSeedsModule,
  runLive,
  stageRecordings,
  textContainsAccessToken,
  tokenEnvs,
  usage,
  type LiveInputs,
  type RecordingWriter
} from '../connector-conformance-internal.ts'
import {
  enrichLayerApiKeyEnv,
  exaApiKeyEnv,
  linkedInSearchCaseSpecs,
  linkedInSearchRunner,
  decodeLiveSeeds,
  linkedInSearchCasePorts,
  liveCredentials,
  recordingsRoot
} from '../run-linkedin-search-conformance.ts'
import { todoistRunner } from '../run-todoist-conformance.ts'

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '../..')

const tsxCli = join(repoRoot, 'node_modules/tsx/dist/cli.mjs')

const runnerScript = join(repoRoot, 'scripts/run-linkedin-search-conformance.ts')

const parse = (argv: ReadonlyArray<string>, env: Record<string, string | undefined> = {}) =>
  parseRunArgs(linkedInSearchRunner, argv, env)

const live = (argv: ReadonlyArray<string> = []) =>
  parse(['--live', '--owner-approved', '--account', 'practice', ...argv])

/**
 * Live seeds must name `linkedin.com` profiles; these slugs are made up for the tests and never
 * requested (no test makes a network call).
 */
const liveProfileUrl = 'https://www.linkedin.com/in/yolk-conformance-synthetic-profile'

const liveAbsentProfileUrl = 'https://www.linkedin.com/in/yolk-conformance-absent-profile-00'

const seedFlags = [
  '--search-query=synthetic conformance engineer',
  `--profile-url=${liveProfileUrl}`,
  `--absent-profile-url=${liveAbsentProfileUrl}`
]

/** Synthetic stand-ins for the live keys (never real keys). */
const liveExaKey = 'synthetic-live-exa-key-0123456789'

const liveEnrichLayerKey = 'enrich-layer-practice-key-abcdefghij'

const keyEnv = { [exaApiKeyEnv]: liveExaKey, [enrichLayerApiKeyEnv]: liveEnrichLayerKey }

describe('run-linkedin-search-conformance arguments', () => {
  it('requires CI to be empty, --owner-approved, and --account with --live', () => {
    expect(() =>
      parse(['--live', '--owner-approved', '--account', 'practice'], { CI: 'false' })
    ).toThrow(liveInCiMessage)
    expect(() => parse(['--live', '--account', 'practice'])).toThrow(ownerApprovalRequiredMessage)
    expect(() => parse(['--live', '--owner-approved'])).toThrow('--live requires --account')
    expect(() => parse(['--record'])).toThrow('--record requires --live')
    expect(live()).toMatchObject({ live: true, ownerApproved: true, account: 'practice' })
  })

  it('reads seeds from flags over env, and never takes a key as a flag', () => {
    expect(
      parse(['--search-query', 'synthetic flag query'], {
        LINKEDIN_SEARCH_CONFORMANCE_QUERY: 'synthetic env query',
        LINKEDIN_SEARCH_CONFORMANCE_PROFILE_URL:
          ' https://linkedin.example.com/in/synthetic-person-01 '
      }).seeds
    ).toEqual({
      searchQuery: 'synthetic flag query',
      profileUrl: 'https://linkedin.example.com/in/synthetic-person-01'
    })

    for (const flag of ['--exa-api-key', '--enrich-layer-api-key', '--api-key', '--token']) {
      expect(() => parse([flag, liveExaKey])).toThrow('Unknown argument (not shown)')
    }
  })

  it('rejects an irreversible flag: every LinkedIn search case is a read', () => {
    expect(() => parse(['--allow-irreversible', 'linkedin-search.search.people-results'])).toThrow(
      'Unknown argument'
    )
    expect(linkedInSearchConformanceCases.every(testCase => testCase.safety === 'read')).toBe(true)
  })

  it('documents both keys as environment-only', () => {
    const text = usage(linkedInSearchRunner)

    expect(text).toContain('--owner-approved, EXA_API_KEY, ENRICH_LAYER_API_KEY, --account')
    expect(text).toContain('EXA_API_KEY is read from the environment only: an Exa API key')
    expect(text).toContain(
      'ENRICH_LAYER_API_KEY is read from the environment only too: an Enrich Layer API key'
    )
    expect(text).toContain('(this runner has none)')
    // Neither provider has a sandbox: the usage never calls the keys practice keys.
    expect(text).toContain('real, paid keys: neither provider has a')
    expect(text).toContain('a profile whose owner consented')
    expect(text).not.toContain('never a real one')
    // The usage promotes by wholesale replacement, never by scrubbing the staged files.
    expect(text).not.toContain('scrub the staged files')
    expect(text).not.toContain('scrubbing and promotion')
    // Runners without a review notice keep the default wording.
    expect(usage(todoistRunner)).toContain('scrub the staged files, copy them into')
    expect(text).toContain(
      'Recordings are never written\nover committed fixtures: replace each recorded 2xx body wholesale with a minimal synthetic body that keeps only the keys and types the case reads (never scrub field by field), copy them into'
    )
    expect(text).not.toContain('--allow-irreversible')
    expect(tokenEnvs(linkedInSearchRunner)).toEqual([exaApiKeyEnv, enrichLayerApiKeyEnv])
  })
})

describe('run-linkedin-search-conformance plan', () => {
  it('knows every case and its fixture module, with its own provider endpoint', () => {
    expect(linkedInSearchCaseSpecs.map(spec => spec.caseId)).toEqual(
      linkedInSearchConformanceCases.map(testCase => testCase.id)
    )

    for (const spec of linkedInSearchCaseSpecs) {
      expect(
        readFileSync(
          join(repoRoot, 'packages/connectors/src/linkedin-search/conformance', spec.fileName),
          'utf8'
        )
      ).toContain(`export const ${spec.exportName}: WireFixture`)

      const fixture = linkedInSearchConformanceFixtures.find(
        candidate => candidate.caseId === spec.caseId
      )

      expect(spec.endpoint).toBe(fixture?.endpoint)
    }
  })

  it('runs every case by default: there is no write case to opt into', () => {
    expect(planRun(linkedInSearchRunner, parse([])).map(entry => entry.skipReason)).toEqual(
      linkedInSearchConformanceCases.map(() => undefined)
    )
  })

  it('prints a dry-run plan that names both keys and the seeds each case needs', () => {
    expect(dryRunReport(linkedInSearchRunner, parse([])).split('\n')).toEqual([
      'DRY RUN: no network request was made and no credential was read. Pass --live --owner-approved --account <label> to run (needs EXA_API_KEY and ENRICH_LAYER_API_KEY).',
      'Plan for a live target: allowWrites=none',
      'RUN   linkedin-search.search.people-results  [read]  needs --search-query',
      'RUN   linkedin-search.search.num-results-limit  [read]  needs --search-query',
      'RUN   linkedin-search.profile.get-profile  [read]  needs --profile-url',
      'RUN   linkedin-search.email.lookup-answer  [read]  needs --profile-url',
      'RUN   linkedin-search.errors.exa-unauthorized  [read]',
      'RUN   linkedin-search.errors.enrich-layer-unauthorized  [read]  needs --profile-url',
      'RUN   linkedin-search.errors.profile-not-found  [read]  needs --absent-profile-url',
      "Use dedicated low-credit Exa and Enrich Layer keys (real, paid: neither has a sandbox) and a consenting profile only, with the repository owner's approval; never in CI."
    ])
  })
})

describe('run-linkedin-search-conformance live refusal (no network)', () => {
  it('refuses without either key, naming the missing one', () => {
    expect(liveInputs(linkedInSearchRunner, live(seedFlags), {})).toEqual({
      refusal: 'EXA_API_KEY is required for --live'
    })
    expect(
      liveInputs(linkedInSearchRunner, live(seedFlags), { [exaApiKeyEnv]: liveExaKey })
    ).toEqual({ refusal: 'ENRICH_LAYER_API_KEY is required for --live' })
    expect(
      liveInputs(linkedInSearchRunner, live(seedFlags), {
        [exaApiKeyEnv]: liveExaKey,
        [enrichLayerApiKeyEnv]: '  '
      })
    ).toEqual({ refusal: 'ENRICH_LAYER_API_KEY is required for --live' })
  })

  it('refuses a key in the wrong format before any request, without printing it', () => {
    for (const [env, refusal] of [
      [
        { ...keyEnv, [exaApiKeyEnv]: 'short-key' },
        'EXA_API_KEY must be 16 to 256 letters, digits, _ or -'
      ],
      [
        { ...keyEnv, [enrichLayerApiKeyEnv]: 'has spaces and/slashes in it' },
        'ENRICH_LAYER_API_KEY must be 16 to 256 letters, digits, _ or -'
      ]
    ] as const) {
      const checked = liveInputs(linkedInSearchRunner, live(seedFlags), env)

      expect(checked).toEqual({ refusal })
    }
  })

  it('refuses missing or invalid seeds for the cases that would run', () => {
    expect(liveInputs(linkedInSearchRunner, live(), keyEnv)).toEqual({
      refusal:
        'Missing seed identities for the cases that would run: --search-query, --profile-url, --absent-profile-url'
    })
    expect(
      liveInputs(
        linkedInSearchRunner,
        live([...seedFlags, '--profile-url=https://linkedin.example.com/company/x']),
        keyEnv
      )
    ).toEqual({ refusal: linkedInSearchRunner.invalidSeedsMessage })
  })

  it('requires linkedin.com profile URLs for a live run (replay stays host-agnostic)', () => {
    for (const flag of [
      '--profile-url=https://linkedin.example.com/in/synthetic-person-01',
      '--absent-profile-url=https://linkedin.example.com/in/synthetic-absent-person-00',
      '--profile-url=https://notlinkedin.com/in/synthetic-person-01'
    ]) {
      expect(liveInputs(linkedInSearchRunner, live([...seedFlags, flag]), keyEnv)).toEqual({
        refusal: linkedInSearchRunner.invalidSeedsMessage
      })
    }

    expect(
      liveInputs(
        linkedInSearchRunner,
        live([...seedFlags, '--profile-url=https://uk.linkedin.com/in/yolk-conformance-synthetic']),
        keyEnv
      )
    ).toHaveProperty('inputs')
    // The case schema accepts the synthetic fixture host for replay; the live check refuses it.
    expect(
      Option.isSome(
        Schema.decodeUnknownOption(LinkedInSearchConformanceSeeds)(
          linkedInSearchConformanceFixtureSeeds
        )
      )
    ).toBe(true)
    expect(Option.isNone(decodeLiveSeeds(linkedInSearchConformanceFixtureSeeds))).toBe(true)
  })

  it('carries both keys, each for its own slot, and guards both', () => {
    const checked = liveInputs(linkedInSearchRunner, live(seedFlags), keyEnv)

    if ('refusal' in checked) {
      return expect.fail(checked.refusal)
    }

    expect(checked.inputs).toEqual({
      account: 'practice',
      accessToken: liveExaKey,
      seeds: {
        searchQuery: 'synthetic conformance engineer',
        profileUrl: liveProfileUrl,
        absentProfileUrl: liveAbsentProfileUrl
      },
      extraTokens: { [enrichLayerApiKeyEnv]: liveEnrichLayerKey }
    })
    expect(namedLiveSecrets(linkedInSearchRunner, checked.inputs)).toEqual([
      { label: 'the live secret EXA_API_KEY', secret: liveExaKey },
      { label: 'the live secret ENRICH_LAYER_API_KEY', secret: liveEnrichLayerKey }
    ])
    expect(liveSecrets(checked.inputs)).toEqual([liveExaKey, liveEnrichLayerKey])
    expect(liveCredentials(liveExaKey, liveEnrichLayerKey)).toMatchObject({
      [exaApiKeySlotId]: { _tag: 'ApiKeyCredential', key: liveExaKey },
      [enrichLayerApiKeySlotId]: { _tag: 'ApiKeyCredential', key: liveEnrichLayerKey }
    })
  })

  it('fails closed without an Enrich Layer key: no request, never an empty bearer key', async () => {
    const profileCase =
      linkedInSearchConformanceCases.find(
        testCase => testCase.id === linkedInSearchProfileFixture.caseId
      ) ?? expect.fail('missing profile case')

    const sent: Array<string> = []

    const report = await Effect.runPromise(
      runConformance([profileCase], {
        target: { kind: 'replay' },
        layer: () =>
          linkedInSearchCasePorts(
            Layer.succeed(
              HttpClient.HttpClient,
              HttpClient.make(request =>
                Effect.sync(() => sent.push(request.url)).pipe(
                  Effect.andThen(Effect.die('no request may be sent'))
                )
              )
            ),
            liveExaKey,
            linkedInSearchConformanceFixtureSeeds,
            {}
          )
      })
    )

    expect(report.results[0]?.failure).toEqual({
      kind: 'failure',
      tag: 'ConnectorError',
      message: 'Missing Enrich Layer credential binding'
    })
    expect(sent).toEqual([])
  })

  it('has no leftover lookup and nothing to clean up', () => {
    expect(linkedInSearchRunner).not.toHaveProperty('leftovers')
    expect(interruptOptionsFor(linkedInSearchRunner)).toEqual({
      recoveryAdvice: linkedInSearchRunner.recoveryAdvice,
      hasCleanups: false
    })
  })
})

const recordInputs: LiveInputs<typeof linkedInSearchConformanceFixtureSeeds> = {
  account: 'practice',
  accessToken: liveExaKey,
  seeds: linkedInSearchConformanceFixtureSeeds,
  extraTokens: { [enrichLayerApiKeyEnv]: liveEnrichLayerKey }
}

const recorderOf = (exchanges: ReadonlyArray<WireExchange>): WireRecorderApi => ({
  drain: Effect.succeed(exchanges)
})

const passedReport = (caseIds: ReadonlyArray<string>): ConformanceReport => ({
  target: { kind: 'live', account: 'practice' },
  startedAt: '2026-10-01T12:00:00.000Z',
  results: caseIds.map(id => ({
    id,
    safety: 'read',
    status: 'passed',
    warnings: [],
    durationMs: 1
  })),
  summary: { passed: caseIds.length, failed: 0, skipped: 0 }
})

const memoryWriter = () => {
  const files = new Map<string, string>()
  const operations: Array<string> = []

  const writer: RecordingWriter = {
    exists: path => [...files.keys()].some(file => file === path || file.startsWith(`${path}/`)),
    mkdir: path => {
      operations.push(`mkdir ${path}`)
    },
    writeFile: (path, contents) => {
      operations.push(`write ${path}`)
      files.set(path, contents)
    },
    rename: (from, to) => {
      operations.push(`rename ${from} -> ${to}`)

      for (const [path, contents] of [...files].filter(([path]) => path.startsWith(`${from}/`))) {
        files.delete(path)
        files.set(to + path.slice(from.length), contents)
      }
    },
    rm: path => {
      operations.push(`rm ${path}`)
    },
    realpath: path => path,
    inspect: path => ({ kind: 'present', realpath: path })
  }

  return { writer, files, operations }
}

const stagingDir = join(
  recordingsRoot,
  recordingRunId(new Date('2026-10-01T12:34:56.789Z'), 'a1b2c3d4')
)

const stageWith = (
  recorders: ReadonlyMap<string, WireRecorderApi>,
  writer: RecordingWriter,
  inputs: LiveInputs<typeof linkedInSearchConformanceFixtureSeeds> = recordInputs
) =>
  Effect.runPromise(
    stageRecordings(linkedInSearchRunner, passedReport([...recorders.keys()]), recorders, inputs, {
      writer,
      stagingDir,
      recordedAt: '2026-10-01'
    }).pipe(Effect.result)
  )

/** `fixture`'s exchanges with the first response body carrying `secret` in a JSON string. */
const echoing = (fixture: WireFixture, secret: string): ReadonlyArray<WireExchange> =>
  fixture.exchanges.map((exchange, index) =>
    index === 0
      ? {
          ...exchange,
          response: {
            status: 200,
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ email: null, message: `echo ${secret}` })
          }
        }
      : exchange
  )

describe('run-linkedin-search-conformance --record staging (offline)', () => {
  it('stages every recording with its own provider endpoint, and lists people data for review', async () => {
    expect(recordingsRoot).toBe(join(repoRoot, '.conformance-recordings', 'linkedin-search'))

    const { writer, files } = memoryWriter()

    const result = await stageWith(
      new Map(
        linkedInSearchConformanceFixtures.map(
          fixture => [fixture.caseId, recorderOf(fixture.exchanges)] as const
        )
      ),
      writer
    )

    if (Result.isFailure(result) || result.success === undefined) {
      return expect.fail(Result.isFailure(result) ? result.failure.message : 'nothing staged')
    }

    expect([...files.keys()].sort()).toEqual(
      [...linkedInSearchCaseSpecs.map(spec => spec.fileName), 'seeds.ts']
        .sort()
        .map(name => join(stagingDir, name))
    )

    const staged = [...files.values()].join('\n')

    expect(staged).not.toContain(liveExaKey)
    expect(staged).not.toContain(liveEnrichLayerKey)
    expect(files.get(join(stagingDir, 'profile.ts'))).toContain(
      '"endpoint": "https://enrichlayer.com/api/v2"'
    )
    expect(files.get(join(stagingDir, 'people-results.ts'))).toContain(
      '"endpoint": "https://api.exa.ai"'
    )

    const checklist = result.success.checklist.join('\n')

    // Every string value is listed, under a heading that says whose data it is.
    expect(result.success.checklist[0]).toBe(
      "REVIEW before promoting (staged files hold real third parties' personal data, and this repository is public):"
    )
    expect(checklist).toContain('every string value: ')
    expect(checklist).toContain('"Synthetic Person 01"')
    expect(checklist).toContain('"Conformance Engineer at Example Synthetic Co"')
    expect(checklist).toContain('"https://linkedin.example.com/in/synthetic-person-01"')
    expect(checklist).toContain('"synthetic-person-01@example.com"')
    expect(checklist).toContain(
      'the seeds name real people (a profile URL, a query); replace each with a synthetic value'
    )
    expect(checklist).toContain(
      'PROMOTE by hand: replace each recorded 2xx body wholesale with a minimal synthetic body that keeps only the keys and types the case reads (never scrub field by field), copy into'
    )
    expect(checklist).not.toContain('practice-account data')
  })

  for (const [label, fixture, secret, env] of [
    ['the Exa key', linkedInSearchPeopleResultsFixture, liveExaKey, exaApiKeyEnv],
    [
      'the Enrich Layer key',
      linkedInSearchEmailLookupFixture,
      liveEnrichLayerKey,
      enrichLayerApiKeyEnv
    ],
    [
      'the Enrich Layer key, base64-encoded',
      linkedInSearchProfileFixture,
      Buffer.from(`xx${liveEnrichLayerKey}`).toString('base64'),
      enrichLayerApiKeyEnv
    ]
  ] as const) {
    it(`writes and prints nothing when a recording echoes ${label}`, async () => {
      const { writer, operations } = memoryWriter()

      const result = await stageWith(
        new Map([[fixture.caseId, recorderOf(echoing(fixture, secret))]]),
        writer
      )

      const failure = Result.isFailure(result) ? result.failure.message : expect.fail('staged')

      expect(failure).toBe(
        `${fixture.caseId}: the recording still contains the live secret ${env}; nothing was written`
      )
      expect(failure).not.toContain(liveEnrichLayerKey)
      expect(operations).toEqual([])
    })
  }

  it('writes and prints nothing when a seed would carry the Enrich Layer key into seeds.ts', async () => {
    const { writer, operations } = memoryWriter()

    const result = await stageWith(
      new Map([
        [
          linkedInSearchPeopleResultsFixture.caseId,
          recorderOf(linkedInSearchPeopleResultsFixture.exchanges)
        ]
      ]),
      writer,
      { ...recordInputs, seeds: { ...recordInputs.seeds, searchQuery: `${liveEnrichLayerKey}` } }
    )

    expect(Result.isFailure(result) ? result.failure.message : '').toBe(
      'The staged files or the review checklist would contain the live secret ENRICH_LAYER_API_KEY; nothing was written'
    )
    expect(operations).toEqual([])
  })

  it('inspects every committed fixture as clean for both keys', () => {
    for (const fixture of linkedInSearchConformanceFixtures) {
      for (const secret of [liveExaKey, liveEnrichLayerKey]) {
        expect(inspectRecordingForAccessToken(fixture.exchanges, secret)).toBe('clean')
      }
    }
  })

  it('renders the committed seeds module exactly', () => {
    const committed = readFileSync(
      join(repoRoot, 'packages/connectors/src/linkedin-search/conformance/seeds.ts'),
      'utf8'
    )

    expect(renderSeedsModule(linkedInSearchRunner, linkedInSearchConformanceFixtureSeeds)).toBe(
      committed
    )
  })

  it('renders a fixture module typed with the conformance fixture type', () => {
    const spec =
      linkedInSearchCaseSpecs.find(entry => entry.caseId === linkedInSearchProfileFixture.caseId) ??
      expect.fail('missing profile spec')

    expect(renderFixtureModule(linkedInSearchRunner, spec, linkedInSearchProfileFixture)).toContain(
      'export const linkedInSearchProfileFixture: WireFixture = {'
    )
  })

  it('heads the staged files with wholesale replacement, never scrubbing', () => {
    const spec =
      linkedInSearchCaseSpecs.find(entry => entry.caseId === linkedInSearchProfileFixture.caseId) ??
      expect.fail('missing profile spec')

    const fixtureModule = renderFixtureModule(
      linkedInSearchRunner,
      spec,
      linkedInSearchProfileFixture
    )

    const seedsModule = renderSeedsModule(
      linkedInSearchRunner,
      linkedInSearchConformanceFixtureSeeds
    )

    expect(fixtureModule).toContain('), replaced wholesale and promoted by hand from')
    expect(seedsModule).toContain('(synthetic until a replaced recording is')

    for (const text of [fixtureModule, seedsModule]) {
      expect(text).not.toContain('scrub')
    }

    // Runners without a review notice keep the default wording.
    expect(renderFixtureModule(todoistRunner, spec, linkedInSearchProfileFixture)).toContain(
      '), scrubbed and promoted by hand from'
    )
    expect(renderSeedsModule(todoistRunner, {})).toContain(
      '(synthetic until a scrubbed recording is'
    )
  })
})

describe('run-linkedin-search-conformance live run wiring', () => {
  const runOver = async (
    runner: typeof linkedInSearchRunner,
    http = ReplayHttpClient.layer([])
  ) => {
    const out: Array<string> = []
    const err: Array<string> = []

    await Effect.runPromise(
      runLive(runner, live(seedFlags), recordInputs, {
        http,
        out: line => {
          out.push(line)
        },
        err: line => {
          err.push(line)
        }
      })
    )

    return [...out, ...err].join('\n')
  }

  it('runs every case live over its replayed fixture and prints a PASS line', async () => {
    // Several cases share POST /search, so each runs over its own fixture.
    for (const testCase of linkedInSearchConformanceCases) {
      const printed = await runOver(
        { ...linkedInSearchRunner, cases: [testCase] },
        ReplayHttpClient.layer(
          linkedInSearchConformanceFixtures.filter(fixture => fixture.caseId === testCase.id)
        )
      )

      expect(printed).toContain(`PASS  ${testCase.id}  [read]`)
    }
  })

  it('prints no trace of either key when every request fails', async () => {
    const printed = await runOver(linkedInSearchRunner)

    expect(printed).toContain('FAIL  linkedin-search.search.people-results')

    for (const secret of [liveExaKey, liveEnrichLayerKey]) {
      expect(textContainsAccessToken(printed, secret)).toBe(false)
    }
  })

  it('redacts both keys from a report line that echoes them', async () => {
    const echo = defineConformanceCase({
      id: 'linkedin-search.synthetic.echo',
      title: 'echoes both keys',
      safety: 'read',
      docs: 'A synthetic case whose failure message echoes both live keys.',
      wire: 'None.',
      fixtures: [],
      run: Effect.fail(
        new ConformanceMismatch({ message: `echo ${liveExaKey} and ${liveEnrichLayerKey}` })
      )
    })

    const printed = await runOver({ ...linkedInSearchRunner, cases: [echo] })

    expect(printed).toContain(`echo ${redactedLiveTokenMarker} and ${redactedLiveTokenMarker}`)
    expect(printed).not.toContain(liveExaKey)
    expect(printed).not.toContain(liveEnrichLayerKey)
  })
})

const runCli = (argv: ReadonlyArray<string>, env: Record<string, string>) =>
  new Promise<{ failed: boolean; stdout: string; stderr: string }>(resolvePromise => {
    execFile(
      process.execPath,
      [tsxCli, runnerScript, ...argv],
      { cwd: repoRoot, env: { ...process.env, ...env } },
      (error, stdout, stderr) => {
        resolvePromise({ failed: error !== null, stdout: String(stdout), stderr: String(stderr) })
      }
    )
  })

describe('run-linkedin-search-conformance CLI', () => {
  it('dry-runs by default without keys', async () => {
    const result = await runCli([], { [exaApiKeyEnv]: '', [enrichLayerApiKeyEnv]: '', CI: '' })

    expect(result.failed).toBe(false)
    expect(result.stdout).toContain('DRY RUN: no network request was made')
    expect(result.stdout).toContain('RUN   linkedin-search.errors.exa-unauthorized  [read]')
  })

  it('refuses --live without --owner-approved, and without the Enrich Layer key', async () => {
    const unapproved = await runCli(['--live', '--account', 'practice', ...seedFlags], {
      ...keyEnv,
      CI: ''
    })

    expect(unapproved.failed).toBe(true)
    expect(unapproved.stderr).toContain(ownerApprovalRequiredMessage)

    const missingKey = await runCli(
      ['--live', '--owner-approved', '--account', 'practice', ...seedFlags],
      { [exaApiKeyEnv]: liveExaKey, [enrichLayerApiKeyEnv]: '', CI: '' }
    )

    expect(missingKey.failed).toBe(true)
    expect(missingKey.stderr).toContain('ENRICH_LAYER_API_KEY is required for --live')
    expect(`${missingKey.stdout}${missingKey.stderr}`).not.toContain(liveExaKey)
  })

  it('refuses --live in CI', async () => {
    const result = await runCli(
      ['--live', '--owner-approved', '--account', 'practice', ...seedFlags],
      { ...keyEnv, CI: '1' }
    )

    expect(result.failed).toBe(true)
    expect(result.stderr).toContain(liveInCiMessage)
  })
})
