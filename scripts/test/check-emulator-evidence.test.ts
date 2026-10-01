import { execFile } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { vercelAiGatewayConformanceFixtures } from '../../packages/agent/src/providers/vercel/conformance/index.ts'
import { dropboxConformanceFixtures } from '../../packages/connectors/src/dropbox/conformance/index.ts'
import { fortnoxConformanceFixtures } from '../../packages/connectors/src/fortnox/conformance/index.ts'
import { googleConformanceFixtures } from '../../packages/connectors/src/google/conformance/index.ts'
import { linkedInSearchConformanceFixtures } from '../../packages/connectors/src/linkedin-search/conformance/index.ts'
import { emailConformanceCases } from '../../packages/connectors/src/email/conformance/cases.ts'
import { r2ConformanceCases } from '../../packages/connectors/src/r2-storage/conformance/cases.ts'
import { microsoftConformanceFixtures } from '../../packages/connectors/src/microsoft/conformance/index.ts'
import { notionConformanceFixtures } from '../../packages/connectors/src/notion/conformance/index.ts'
import { githubConformanceFixtures } from '../../packages/connectors/src/github/conformance/index.ts'
import { telegramConformanceFixtures } from '../../packages/connectors/src/telegram/conformance/index.ts'
import { todoistConformanceFixtures } from '../../packages/connectors/src/todoist/conformance/index.ts'
import { mcpConformanceFixtures } from '../../packages/mcp/src/conformance/index.ts'
import { dropboxEmulatorRoutes } from '../../packages/emulators/src/dropbox.ts'
import { emailEmulatorRoutes } from '../../packages/emulators/src/email.ts'
import { r2EmulatorRoutes } from '../../packages/emulators/src/r2.ts'
import { fortnoxEmulatorRoutes } from '../../packages/emulators/src/fortnox.ts'
import { googleEmulatorRoutes } from '../../packages/emulators/src/google.ts'
import { linkedInSearchEmulatorRoutes } from '../../packages/emulators/src/linkedin-search.ts'
import { mcpEmulatorRoutes } from '../../packages/emulators/src/mcp.ts'
import { microsoftEmulatorRoutes } from '../../packages/emulators/src/microsoft.ts'
import { notionEmulatorRoutes } from '../../packages/emulators/src/notion.ts'
import { githubEmulatorRoutes } from '../../packages/emulators/src/github.ts'
import { telegramEmulatorRoutes } from '../../packages/emulators/src/telegram.ts'
import { todoistEmulatorRoutes } from '../../packages/emulators/src/todoist.ts'
import type { EmulatorRouteEvidence } from '../../packages/emulators/src/route-evidence.ts'
import {
  checkEmulatorEvidence,
  cliNow,
  repoFixtureEvidenceByCase,
  defaultMaxPendingDays,
  emulatorManifests,
  evidenceAgeDays,
  evidenceReportFailed,
  fixtureEvidenceByCase,
  formatEvidenceReport,
  knownConformanceCaseIds,
  loadPendingEvidence,
  parsePendingEvidence,
  type EvidenceManifest,
  type PendingEvidenceEntry
} from '../check-emulator-evidence.ts'

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '../..')

const tsxCli = join(repoRoot, 'node_modules/tsx/dist/cli.mjs')

const checker = join(repoRoot, 'scripts/check-emulator-evidence.ts')

const now = new Date('2026-09-30T12:00:00.000Z')

const caseIds: ReadonlySet<string> = new Set(['example.read.list', 'example.write.create'])

const route = (overrides: Partial<EmulatorRouteEvidence> = {}): EmulatorRouteEvidence => ({
  method: 'GET',
  path: '/v1/items',
  kind: 'connector',
  write: false,
  caseIds: ['example.read.list'],
  evidence: 'verified',
  observedAt: '2026-09-20',
  ...overrides
})

const check = (routes: ReadonlyArray<EmulatorRouteEvidence>) =>
  checkEmulatorEvidence({ manifests: [{ name: 'example', routes }], caseIds, now })

const kinds = (routes: ReadonlyArray<EmulatorRouteEvidence>) =>
  check(routes).findings.map(finding => `${finding.severity}:${finding.kind}`)

describe('checkEmulatorEvidence', () => {
  it('passes fresh verified routes with known case ids and no findings', () => {
    const report = check([
      route(),
      route({ method: 'POST', write: true, caseIds: ['example.write.create'] })
    ])

    expect(report.findings).toEqual([])
    expect(evidenceReportFailed(report)).toBe(false)
    expect(report).toMatchObject({ manifests: 1, routes: 2, verified: 2, unverified: 0 })
  })

  it('fails a route that cites an unknown case id', () => {
    const report = check([route({ caseIds: ['example.read.list', 'example.missing.case'] })])

    expect(report.findings).toEqual([
      {
        severity: 'fail',
        kind: 'unknown-case-id',
        manifest: 'example',
        route: 'GET /v1/items',
        detail: 'cites unknown case id example.missing.case'
      }
    ])
    expect(evidenceReportFailed(report)).toBe(true)
  })

  it('fails duplicate method + path routes within one manifest only', () => {
    expect(kinds([route(), route({ method: 'get' })])).toEqual(['fail:duplicate-route'])

    const acrossManifests = checkEmulatorEvidence({
      manifests: [
        { name: 'one', routes: [route()] },
        { name: 'two', routes: [route()] }
      ],
      caseIds,
      now
    })

    expect(acrossManifests.findings).toEqual([])
  })

  it('fails connector write routes without verified evidence, and warns for other unverified routes', () => {
    expect(kinds([route({ write: true, evidence: 'unverified', observedAt: undefined })])).toEqual([
      'fail:unverified-write',
      'warn:unverified'
    ])
    expect(
      kinds([
        route({ kind: 'provider', write: true, evidence: 'unverified', observedAt: undefined })
      ])
    ).toEqual(['warn:unverified'])
    expect(kinds([route({ evidence: 'unverified', observedAt: undefined })])).toEqual([
      'warn:unverified'
    ])
  })

  it('warns on stale, unreadable, future, or missing observedAt on routes that are not connector writes', () => {
    const stale = check([route({ observedAt: '2026-08-30' })])

    expect(stale.findings.map(finding => finding.detail)).toEqual([
      'observedAt 2026-08-30 is 31 days old (max 30)'
    ])
    expect(evidenceReportFailed(stale)).toBe(false)
    expect(kinds([route({ observedAt: '2026-08-31' })])).toEqual([])
    expect(kinds([route({ observedAt: 'yesterday' })])).toEqual(['warn:unreadable-observed-at'])
    expect(kinds([route({ observedAt: '2026-10-01' })])).toEqual(['warn:future-observed-at'])
    expect(kinds([route({ observedAt: undefined })])).toEqual(['warn:missing-observed-at'])
    expect(kinds([route({ caseIds: [] })])).toEqual(['warn:no-case-ids'])
  })

  it('fails a verified connector write route whose observedAt is missing, unreadable, or in the future', () => {
    const write = (observedAt: string | undefined) =>
      route({ method: 'POST', write: true, caseIds: ['example.write.create'], observedAt })

    expect(kinds([write(undefined)])).toEqual(['fail:missing-observed-at'])
    expect(kinds([write('yesterday')])).toEqual(['fail:unreadable-observed-at'])
    expect(kinds([write('2026-02-30')])).toEqual(['fail:unreadable-observed-at'])
    expect(kinds([write('2026-10-01')])).toEqual(['fail:future-observed-at'])
    expect(evidenceReportFailed(check([write('2026-10-01')]))).toBe(true)
    expect(kinds([write('2026-09-30')])).toEqual([])
    // Stale is still only a warning.
    expect(kinds([write('2026-08-01')])).toEqual(['warn:stale'])
  })

  it('fails a verified connector write route that cites no case ids; warns for other routes', () => {
    const writeReport = check([
      route({ method: 'POST', write: true, caseIds: [], observedAt: '2026-09-29' })
    ])

    expect(writeReport.findings.map(finding => `${finding.severity}:${finding.kind}`)).toEqual([
      'fail:no-case-ids'
    ])
    expect(evidenceReportFailed(writeReport)).toBe(true)

    const readReport = check([
      route({ method: 'GET', write: false, caseIds: [], observedAt: '2026-09-29' })
    ])

    expect(readReport.findings.map(finding => `${finding.severity}:${finding.kind}`)).toEqual([
      'warn:no-case-ids'
    ])
    expect(evidenceReportFailed(readReport)).toBe(false)
  })

  it('fails a verified route when no cited case has a verified fixture (optional cross-check)', () => {
    const writeRoute = route({
      method: 'POST',
      write: true,
      caseIds: ['example.read.list', 'example.write.create'],
      observedAt: '2026-09-29'
    })

    const crossCheck = (fixtureEvidence: ReturnType<typeof fixtureEvidenceByCase>) =>
      checkEmulatorEvidence({
        manifests: [{ name: 'example', routes: [writeRoute] }],
        caseIds,
        now,
        fixtureEvidence
      }).findings.map(finding => `${finding.severity}:${finding.kind}`)

    const allUnverified = fixtureEvidenceByCase([
      { caseId: 'example.read.list', evidence: 'unverified' },
      { caseId: 'example.write.create', evidence: 'unverified' },
      { caseId: 'example.write.create', evidence: 'unverified' }
    ])

    expect(crossCheck(allUnverified)).toEqual(['fail:unbacked-verified'])
    expect(crossCheck(new Map())).toEqual(['fail:unbacked-verified'])

    const oneVerified = fixtureEvidenceByCase([
      { caseId: 'example.read.list', evidence: 'unverified' },
      { caseId: 'example.write.create', evidence: 'unverified' },
      { caseId: 'example.write.create', evidence: 'verified' }
    ])

    expect(crossCheck(oneVerified)).toEqual([])
    // Without the hook, only the route's own label is checked.
    expect(kinds([writeRoute])).toEqual([])
  })

  // Repo cross-checks derive every expectation from the committed fixture data: which cases are
  // backed by a verified fixture, and which only by unverified ones.
  const repoFixtures = [
    ...vercelAiGatewayConformanceFixtures,
    ...fortnoxConformanceFixtures,
    ...microsoftConformanceFixtures,
    ...dropboxConformanceFixtures,
    ...notionConformanceFixtures,
    ...todoistConformanceFixtures,
    ...telegramConformanceFixtures,
    ...githubConformanceFixtures,
    ...googleConformanceFixtures,
    ...linkedInSearchConformanceFixtures,
    ...mcpConformanceFixtures
  ]

  const hasVerifiedFixture = (caseId: string) =>
    repoFixtures.some(fixture => fixture.caseId === caseId && fixture.evidence === 'verified')

  const repoCrossCheck = (routes: ReadonlyArray<EmulatorRouteEvidence>) =>
    checkEmulatorEvidence({
      manifests: [{ name: 'example', routes }],
      caseIds: knownConformanceCaseIds,
      now,
      fixtureEvidence: repoFixtureEvidenceByCase
    })

  it('passes a verified route whose cited cases all have verified repo fixtures (Gateway)', () => {
    const gatewayCaseIds = [
      ...new Set(vercelAiGatewayConformanceFixtures.map(fixture => fixture.caseId))
    ]

    const verifiedCaseIds = gatewayCaseIds.filter(hasVerifiedFixture)

    expect(verifiedCaseIds).not.toEqual([])
    expect(verifiedCaseIds).toEqual(gatewayCaseIds)

    for (const caseId of verifiedCaseIds) {
      expect(repoFixtureEvidenceByCase.get(caseId)).toContain('verified')
    }

    const recordedAt = vercelAiGatewayConformanceFixtures
      .filter(fixture => fixture.evidence === 'verified')
      .map(fixture => fixture.recordedAt)
      .sort()
      .at(0)

    const report = repoCrossCheck([
      route({
        method: 'POST',
        path: '/v1/chat/completions',
        kind: 'provider',
        caseIds: verifiedCaseIds,
        observedAt: recordedAt
      })
    ])

    expect(report.findings).toEqual([])
    expect(evidenceReportFailed(report)).toBe(false)
  })

  it.each([
    ['Fortnox', fortnoxConformanceFixtures],
    ['Microsoft', microsoftConformanceFixtures],
    ['Dropbox', dropboxConformanceFixtures],
    ['Notion', notionConformanceFixtures],
    ['Todoist', todoistConformanceFixtures],
    ['Telegram', telegramConformanceFixtures],
    ['GitHub', githubConformanceFixtures],
    ['Google', googleConformanceFixtures],
    ['LinkedIn search', linkedInSearchConformanceFixtures],
    ['MCP', mcpConformanceFixtures]
  ])(
    'fails unbacked-verified for a verified route citing only still-unverified repo cases (%s)',
    (_name, fixtures) => {
      const unverifiedCaseIds = [...new Set(fixtures.map(fixture => fixture.caseId))].filter(
        caseId => !hasVerifiedFixture(caseId)
      )

      expect(unverifiedCaseIds).not.toEqual([])

      for (const caseId of unverifiedCaseIds) {
        expect(repoFixtureEvidenceByCase.get(caseId)).not.toContain('verified')
      }

      const report = repoCrossCheck([
        route({ method: 'GET', caseIds: unverifiedCaseIds, observedAt: '2026-09-29' })
      ])

      expect(report.findings.map(finding => `${finding.severity}:${finding.kind}`)).toEqual([
        'fail:unbacked-verified'
      ])
      expect(evidenceReportFailed(report)).toBe(true)
    }
  )

  it('computes whole UTC days', () => {
    expect(evidenceAgeDays('2026-09-30', now)).toBe(0)
    expect(evidenceAgeDays('2026-09-01', now)).toBe(29)
    expect(evidenceAgeDays('2026-10-02', now)).toBe(-2)
    expect(evidenceAgeDays('2026-13-45', now)).toBeUndefined()
    expect(evidenceAgeDays('2026-02-30', now)).toBeUndefined()
  })

  it('formats a compact report', () => {
    const manifests: ReadonlyArray<EvidenceManifest> = [
      {
        name: 'example',
        routes: [
          route({ evidence: 'unverified', observedAt: undefined }),
          route({ caseIds: ['nope.case'], method: 'PUT' })
        ]
      }
    ]

    expect(formatEvidenceReport(checkEmulatorEvidence({ manifests, caseIds, now }))).toBe(
      [
        'Emulator evidence: 2 route(s) in 1 manifest(s); 1 verified, 1 unverified',
        'WARN  example  GET /v1/items  unverified evidence (1 case(s))',
        'FAIL  example  PUT /v1/items  cites unknown case id nope.case',
        '1 failure(s), 1 warning(s)'
      ].join('\n')
    )
  })
})

const unverifiedWrite = route({
  method: 'PUT',
  path: '/v1/items/{id}',
  write: true,
  caseIds: ['example.write.create'],
  evidence: 'unverified',
  observedAt: undefined
})

const pendingEntry = (overrides: Partial<PendingEvidenceEntry> = {}): PendingEvidenceEntry => ({
  manifest: 'example',
  method: 'PUT',
  path: '/v1/items/{id}',
  reason: 'awaiting the live run',
  expires: '2026-10-31',
  ...overrides
})

const checkPending = (
  routes: ReadonlyArray<EmulatorRouteEvidence>,
  pending: ReadonlyArray<PendingEvidenceEntry>,
  at: Date = now
) => checkEmulatorEvidence({ manifests: [{ name: 'example', routes }], caseIds, now: at, pending })

const findingKinds = (report: ReturnType<typeof checkEmulatorEvidence>) =>
  report.findings.map(finding => `${finding.severity}:${finding.kind}`)

describe('pending evidence allowlist', () => {
  it('downgrades a listed unverified write route to a pending warning until it expires', () => {
    const report = checkPending([unverifiedWrite], [pendingEntry()])

    expect(findingKinds(report)).toEqual(['warn:pending-write', 'warn:unverified'])
    expect(report.findings[0]?.detail).toBe(
      'PENDING until 2026-10-31 (31 day(s) left): connector write route has unverified evidence; awaiting the live run'
    )
    expect(evidenceReportFailed(report)).toBe(false)

    // The expiry day itself is still allowed.
    const lastDay = checkPending(
      [unverifiedWrite],
      [pendingEntry()],
      new Date('2026-10-31T23:59:59Z')
    )

    expect(evidenceReportFailed(lastDay)).toBe(false)
  })

  it(`fails an entry whose expiry is more than ${defaultMaxPendingDays} days away`, () => {
    // 2026-09-30 + 60 days = 2026-11-29 (still allowed); one day later fails.
    expect(
      evidenceReportFailed(
        checkPending([unverifiedWrite], [pendingEntry({ expires: '2026-11-29' })])
      )
    ).toBe(false)

    const report = checkPending([unverifiedWrite], [pendingEntry({ expires: '2026-11-30' })])

    expect(findingKinds(report)).toEqual(['fail:pending-too-long', 'warn:unverified'])
    expect(report.findings[0]?.detail).toContain('expires 2026-11-30, more than 60 days away')
    expect(evidenceReportFailed(report)).toBe(true)
  })

  it('fails a listed route after its expiry date', () => {
    const report = checkPending(
      [unverifiedWrite],
      [pendingEntry()],
      new Date('2026-11-01T00:00:00.000Z')
    )

    expect(findingKinds(report)).toEqual(['fail:pending-expired', 'warn:unverified'])
    expect(report.findings[0]?.detail).toContain('expired on 2026-10-31')
    expect(evidenceReportFailed(report)).toBe(true)
  })

  it('still fails unlisted unverified write routes (other manifest, method, or path)', () => {
    for (const entry of [
      pendingEntry({ manifest: 'other' }),
      pendingEntry({ method: 'POST' }),
      pendingEntry({ path: '/v1/items' })
    ]) {
      const report = checkPending([unverifiedWrite], [entry])

      expect(findingKinds(report)).toEqual([
        'fail:unverified-write',
        'warn:unverified',
        'warn:stale-pending'
      ])
      expect(evidenceReportFailed(report)).toBe(true)
    }
  })

  it('warns that an entry is stale once its route is verified', () => {
    const report = checkPending(
      [{ ...unverifiedWrite, evidence: 'verified', observedAt: '2026-09-29' }],
      [pendingEntry()]
    )

    expect(report.findings).toEqual([
      {
        severity: 'warn',
        kind: 'stale-pending',
        manifest: 'example',
        route: 'PUT /v1/items/{id}',
        detail:
          'route is now verified; remove its stale scripts/emulator-evidence-pending.json entry'
      }
    ])
    expect(evidenceReportFailed(report)).toBe(false)
  })

  it('validates the pending file shape and fails on problems', () => {
    expect(parsePendingEvidence({ note: 'x', entries: [pendingEntry()] })).toEqual({
      entries: [pendingEntry()],
      problems: []
    })
    expect(parsePendingEvidence([]).problems).toEqual([
      'the pending file must be an object with an "entries" array'
    ])

    const problems = parsePendingEvidence({
      entries: [
        pendingEntry({ expires: '2026-02-30' }),
        pendingEntry({ reason: ' ' }),
        { ...pendingEntry(), owner: 'someone' },
        'nope',
        pendingEntry(),
        pendingEntry({ method: 'put' })
      ]
    }).problems

    expect(problems).toHaveLength(5)
    expect(problems[0]).toBe('entry 0 expires 2026-02-30 is not a YYYY-MM-DD date')

    for (const [index, problem] of problems.slice(1, 4).entries()) {
      expect(problem.startsWith(`entry ${index + 1} is invalid: `), problem).toBe(true)
    }

    expect(problems[2]).toContain('owner')
    expect(problems[4]).toBe('entry 5 lists example PUT /v1/items/{id} twice')

    const report = checkEmulatorEvidence({
      manifests: [],
      caseIds,
      now,
      pendingProblems: ['entry 0 is not an object']
    })

    expect(findingKinds(report)).toEqual(['fail:invalid-pending'])
  })

  it('reports pending routes first and counts them', () => {
    const text = formatEvidenceReport(
      checkPending([route(), unverifiedWrite], [pendingEntry()])
    ).split('\n')

    expect(text[1]).toBe(
      'PENDING: 1 unverified connector write route(s) allowed by scripts/emulator-evidence-pending.json; each FAILS after its expiry date. Verify them with an owner-approved live run.'
    )
    expect(text[2]).toMatch(
      /^WARN {2}example {2}PUT \/v1\/items\/\{id\} {2}PENDING until 2026-10-31/
    )
    expect(text.at(-1)).toBe('0 failure(s), 2 warning(s) (1 pending)')
  })
})

describe('repo emulator manifests', () => {
  const repoPending = loadPendingEvidence()

  const emailWriteRoutes = emailEmulatorRoutes
    .filter(emailRoute => emailRoute.write)
    .map(emailRoute => `${emailRoute.method} ${emailRoute.path}`)

  const r2WriteRoutes = r2EmulatorRoutes
    .filter(r2Route => r2Route.write)
    .map(r2Route => `${r2Route.method} ${r2Route.path}`)

  const fortnoxWriteRoutes = fortnoxEmulatorRoutes
    .filter(fortnoxRoute => fortnoxRoute.write)
    .map(fortnoxRoute => `${fortnoxRoute.method} ${fortnoxRoute.path}`)

  const microsoftWriteRoutes = microsoftEmulatorRoutes
    .filter(microsoftRoute => microsoftRoute.write)
    .map(microsoftRoute => `${microsoftRoute.method} ${microsoftRoute.path}`)

  const dropboxWriteRoutes = dropboxEmulatorRoutes
    .filter(dropboxRoute => dropboxRoute.write)
    .map(dropboxRoute => `${dropboxRoute.method} ${dropboxRoute.path}`)

  const notionWriteRoutes = notionEmulatorRoutes
    .filter(notionRoute => notionRoute.write)
    .map(notionRoute => `${notionRoute.method} ${notionRoute.path}`)

  const todoistWriteRoutes = todoistEmulatorRoutes
    .filter(todoistRoute => todoistRoute.write)
    .map(todoistRoute => `${todoistRoute.method} ${todoistRoute.path}`)

  const telegramWriteRoutes = telegramEmulatorRoutes
    .filter(telegramRoute => telegramRoute.write)
    .map(telegramRoute => `${telegramRoute.method} ${telegramRoute.path}`)

  const githubWriteRoutes = githubEmulatorRoutes
    .filter(githubRoute => githubRoute.write)
    .map(githubRoute => `${githubRoute.method} ${githubRoute.path}`)

  const googleWriteRoutes = googleEmulatorRoutes
    .filter(googleRoute => googleRoute.write)
    .map(googleRoute => `${googleRoute.method} ${googleRoute.path}`)

  const failedRoutes = (report: ReturnType<typeof repoCheck>, manifest: string) =>
    report.findings
      .filter(finding => finding.severity === 'fail' && finding.manifest === manifest)
      .map(finding => finding.route)

  const repoCheck = (
    at: Date,
    pending: ReadonlyArray<PendingEvidenceEntry> = repoPending.entries
  ) =>
    checkEmulatorEvidence({
      manifests: emulatorManifests,
      caseIds: knownConformanceCaseIds,
      now: at,
      fixtureEvidence: repoFixtureEvidenceByCase,
      pending,
      pendingProblems: repoPending.problems
    })

  it('cite only known case ids and have no failures while the pending file holds', () => {
    const report = repoCheck(now)

    expect(repoPending.problems).toEqual([])
    expect(evidenceReportFailed(report)).toBe(false)
    expect(knownConformanceCaseIds.has('vercel-ai-gateway.stream.plain-text')).toBe(true)
    expect(knownConformanceCaseIds.has('fortnox.invoice.list-populated')).toBe(true)
    expect(knownConformanceCaseIds.has('openai.chat.json.plain-text')).toBe(true)
    expect(knownConformanceCaseIds.has('anthropic.messages.stream.max-tokens')).toBe(true)
    expect(knownConformanceCaseIds.has('openai.codex.stream.terminal-event')).toBe(true)
    expect(knownConformanceCaseIds.has('xai.grok.stream.terminal-event')).toBe(true)
    expect(knownConformanceCaseIds.has('anthropic.claude.usage.snapshot')).toBe(true)
    expect(knownConformanceCaseIds.has('openai.codex.usage.snapshot')).toBe(true)
    expect(knownConformanceCaseIds.has('xai.grok.usage.snapshot')).toBe(true)
    expect(knownConformanceCaseIds.has('opencode.go.responses.stream.commentary-replay')).toBe(true)
    expect(knownConformanceCaseIds.has('opencode.go.usage.snapshot')).toBe(true)
    expect(knownConformanceCaseIds.has('microsoft.onedrive.copy-accepted-monitor')).toBe(true)
    expect(knownConformanceCaseIds.has('dropbox.files.upload-rev-precondition')).toBe(true)
    expect(knownConformanceCaseIds.has('notion.pages.archive-in-trash')).toBe(true)
    expect(knownConformanceCaseIds.has('todoist.tasks.list-cursor-paging')).toBe(true)
    expect(knownConformanceCaseIds.has('telegram.messages.send-message')).toBe(true)
    expect(knownConformanceCaseIds.has('github.issues.lifecycle-close')).toBe(true)
    expect(knownConformanceCaseIds.has('google.gmail.send-practice-address')).toBe(true)
    expect(knownConformanceCaseIds.has('linkedin-search.errors.profile-not-found')).toBe(true)
    expect(knownConformanceCaseIds.has('mcp.auth.rejected')).toBe(true)
    expect(emulatorManifests.map(manifest => manifest.name)).toEqual([
      'gateway',
      'openai',
      'anthropic',
      'codex',
      'xai',
      'anthropic-usage',
      'codex-usage',
      'xai-usage',
      'opencode',
      'email',
      'r2',
      'fortnox',
      'microsoft',
      'dropbox',
      'notion',
      'todoist',
      'telegram',
      'github',
      'google',
      'linkedin-search',
      'mcp'
    ])
    // The Gateway route is verified (aligned with the live recordings), backed by verified fixtures.
    expect(emulatorManifests[0]?.routes.map(route => [route.evidence, route.observedAt])).toEqual([
      ['verified', '2026-09-30']
    ])
    expect(
      emulatorManifests[0]?.routes.flatMap(route =>
        route.caseIds.map(caseId => repoFixtureEvidenceByCase.get(caseId))
      )
    ).toEqual([['verified'], ['verified'], ['verified'], ['verified']])
    expect(report.findings.filter(finding => finding.manifest === 'gateway')).toEqual([])
    expect(repoFixtureEvidenceByCase.get('openai.chat.stream.plain-text')).toEqual(['unverified'])
    expect(repoFixtureEvidenceByCase.get('anthropic.messages.stream.plain-text')).toEqual([
      'unverified'
    ])
    expect(repoFixtureEvidenceByCase.get('openai.codex.stream.plain-text')).toEqual(['unverified'])
    expect(repoFixtureEvidenceByCase.get('xai.grok.stream.plain-text')).toEqual(['unverified'])
    expect(repoFixtureEvidenceByCase.get('microsoft.calendar.cancel-semantics')).toEqual([
      'unverified'
    ])

    // Every new route (usage, OpenCode Go, Dropbox, Notion, Google, LinkedIn search) is unverified
    // and backed by unverified fixtures.
    for (const name of [
      'anthropic-usage',
      'codex-usage',
      'xai-usage',
      'opencode',
      'dropbox',
      'notion',
      'google',
      'linkedin-search'
    ]) {
      const routes = emulatorManifests.find(manifest => manifest.name === name)?.routes ?? []

      expect(routes.length, name).toBeGreaterThan(0)

      for (const route of routes) {
        expect(route.evidence, `${name} ${route.path}`).toBe('unverified')
        expect(
          route.caseIds.map(caseId => repoFixtureEvidenceByCase.get(caseId)),
          `${name} ${route.path}`
        ).toEqual(route.caseIds.map(() => ['unverified']))
      }
    }

    // Each MCP case has a modern and a legacy fixture, both unverified.
    expect(mcpEmulatorRoutes.length).toBeGreaterThan(0)

    for (const route of mcpEmulatorRoutes) {
      expect(route.evidence, route.path).toBe('unverified')

      for (const caseId of route.caseIds) {
        expect(repoFixtureEvidenceByCase.get(caseId), `${route.path} ${caseId}`).toEqual(
          mcpConformanceFixtures
            .filter(fixture => fixture.caseId === caseId)
            .map(() => 'unverified')
        )
      }
    }

    for (const route of r2EmulatorRoutes) {
      expect(route.evidence, route.path).toBe('unverified')
    }

    for (const testCase of [...emailConformanceCases, ...r2ConformanceCases]) {
      expect(knownConformanceCaseIds.has(testCase.id)).toBe(true)
      // Synthetic port fixtures: unverified, derived through the cases that cite them.
      expect(repoFixtureEvidenceByCase.get(testCase.id)).toEqual(
        testCase.fixtures.map(() => 'unverified')
      )
    }

    expect(
      report.findings
        .filter(finding => finding.kind === 'pending-write')
        .map(finding => finding.route)
    ).toEqual([
      ...emailWriteRoutes,
      ...r2WriteRoutes,
      ...fortnoxWriteRoutes,
      ...microsoftWriteRoutes,
      ...dropboxWriteRoutes,
      ...notionWriteRoutes,
      ...todoistWriteRoutes,
      ...telegramWriteRoutes,
      ...githubWriteRoutes,
      ...googleWriteRoutes
    ])
    expect(r2WriteRoutes).toEqual(['PORT R2ObjectClient.put'])
    expect(fortnoxWriteRoutes).toEqual([
      'PUT /3/customers/{CustomerNumber}',
      'POST /3/invoices',
      'PUT /3/invoices/{DocumentNumber}',
      'GET /3/invoices/{DocumentNumber}/email'
    ])
    expect(microsoftWriteRoutes).toEqual([
      'POST /v1.0/users/{userId}/calendars/{calendarId}/events',
      'PATCH /v1.0/users/{userId}/events/{eventId}',
      'DELETE /v1.0/users/{userId}/events/{eventId}',
      'POST /v1.0/users/{userId}/events/{eventId}/cancel',
      'POST /v1.0/users/{userId}/messages',
      'PATCH /v1.0/users/{userId}/messages/{messageId}',
      'POST /v1.0/users/{userId}/messages/{messageId}/move',
      'POST /v1.0/$batch',
      'POST /v1.0/drives/{driveId}/items/{itemId}/children',
      'DELETE /v1.0/drives/{driveId}/items/{itemId}',
      'POST /v1.0/drives/{driveId}/items/{itemId}/copy'
    ])
    expect(dropboxWriteRoutes).toEqual([
      'POST /2/files/create_folder_v2',
      'POST /2/files/delete_v2',
      'POST /2/files/copy_v2',
      'POST /2/files/move_v2',
      'POST /2/files/upload'
    ])
    expect(notionWriteRoutes).toEqual(['POST /v1/pages', 'PATCH /v1/pages/{pageId}'])
    expect(todoistWriteRoutes).toEqual([
      'POST /api/v1/tasks',
      'POST /api/v1/tasks/{taskId}',
      'POST /api/v1/tasks/{taskId}/close',
      'POST /api/v1/projects',
      'DELETE /api/v1/projects/{projectId}'
    ])
    expect(telegramWriteRoutes).toEqual(['POST /bot{token}/sendMessage'])
    expect(githubWriteRoutes).toEqual([
      'POST /repos/{owner}/{repo}/issues/{issueNumber}/comments',
      'DELETE /repos/{owner}/{repo}/issues/comments/{commentId}',
      'POST /repos/{owner}/{repo}/issues/{issueNumber}/labels',
      'DELETE /repos/{owner}/{repo}/issues/{issueNumber}/labels/{name}',
      'POST /repos/{owner}/{repo}/issues',
      'PATCH /repos/{owner}/{repo}/issues/{issueNumber}'
    ])
    expect(googleWriteRoutes).toEqual([
      'POST /gmail/v1/users/me/messages/{messageId}/modify',
      'POST /gmail/v1/users/me/messages/{messageId}/trash',
      'POST /gmail/v1/users/me/messages/{messageId}/untrash',
      'POST /gmail/v1/users/me/labels',
      'DELETE /gmail/v1/users/me/labels/{labelId}',
      'POST /gmail/v1/users/me/drafts',
      'PUT /gmail/v1/users/me/drafts/{draftId}',
      'DELETE /gmail/v1/users/me/drafts/{draftId}',
      'POST /upload/gmail/v1/users/me/messages/send',
      'POST /calendar/v3/calendars/{calendarId}/events',
      'PATCH /calendar/v3/calendars/{calendarId}/events/{eventId}',
      'DELETE /calendar/v3/calendars/{calendarId}/events/{eventId}',
      'POST /drive/v3/files',
      'PATCH /drive/v3/files/{fileId}',
      'DELETE /drive/v3/files/{fileId}'
    ])
    // Fixture-only: every Todoist, Telegram, GitHub, Google, LinkedIn search, and MCP route cites a
    // case (no uncited route). Every LinkedIn search and MCP row is a read: no pending entry.
    expect(linkedInSearchEmulatorRoutes.filter(route => route.write)).toEqual([])
    expect(repoPending.entries.filter(entry => entry.manifest === 'linkedin-search')).toEqual([])
    expect(mcpEmulatorRoutes.filter(route => route.write)).toEqual([])
    expect(repoPending.entries.filter(entry => entry.manifest === 'mcp')).toEqual([])
    expect(
      report.findings
        .filter(
          finding =>
            (finding.manifest === 'todoist' ||
              finding.manifest === 'telegram' ||
              finding.manifest === 'github' ||
              finding.manifest === 'google' ||
              finding.manifest === 'linkedin-search' ||
              finding.manifest === 'mcp') &&
            finding.kind === 'no-case-ids'
        )
        .map(finding => finding.route)
    ).toEqual([])
  })

  it('ships one pending entry per email write route, at most 60 days out, naming the live run', () => {
    expect(
      repoPending.entries
        .filter(entry => entry.manifest === 'email')
        .map(entry => `${entry.method} ${entry.path}`)
    ).toEqual(emailWriteRoutes)

    for (const entry of repoPending.entries.filter(item => item.manifest === 'email')) {
      // At most 60 days from 2026-09-30.
      expect(entry.expires <= '2026-11-29', entry.path).toBe(true)
      expect(entry.reason).toContain('owner-approved live run against a practice mailbox')
      expect(entry.reason).toContain('tracking #115')
    }
  })

  it('fails the unverified email write routes without the pending file or after it expires', () => {
    for (const report of [repoCheck(now, []), repoCheck(new Date('2026-11-30T00:00:00.000Z'))]) {
      expect(evidenceReportFailed(report)).toBe(true)
      expect(failedRoutes(report, 'email')).toEqual(emailWriteRoutes)
    }
  })

  it('ships one pending entry per R2 write route, at most 60 days out, naming the live run', () => {
    const r2Entries = repoPending.entries.filter(entry => entry.manifest === 'r2')

    expect(r2Entries.map(entry => `${entry.method} ${entry.path}`)).toEqual(r2WriteRoutes)

    for (const entry of r2Entries) {
      // At most 60 days from 2026-09-30.
      expect(entry.expires <= '2026-11-29', entry.path).toBe(true)
      expect(entry.reason).toContain(
        'owner-approved live run of r2.objects.create-if-absent and r2.objects.update-if-match'
      )
      expect(entry.reason).toContain('against a practice bucket')

      // The named ids are exactly the R2 write cases the route cites.
      const writeCaseIds = r2EmulatorRoutes.find(route => route.write)?.caseIds ?? []

      expect(writeCaseIds).toEqual(['r2.objects.create-if-absent', 'r2.objects.update-if-match'])

      for (const caseId of writeCaseIds) {
        expect(entry.reason, caseId).toContain(caseId)
        expect(knownConformanceCaseIds.has(caseId), caseId).toBe(true)
      }

      expect(entry.reason).toContain('tracking #115')
    }
  })

  it('fails the unverified R2 write route without the pending file or after it expires', () => {
    for (const report of [repoCheck(now, []), repoCheck(new Date('2026-11-30T00:00:00.000Z'))]) {
      expect(evidenceReportFailed(report)).toBe(true)
      expect(failedRoutes(report, 'r2')).toEqual(r2WriteRoutes)
    }
  })

  it('ships one pending entry per Fortnox write route, at most 60 days out, naming the live run', () => {
    const fortnoxEntries = repoPending.entries.filter(entry => entry.manifest === 'fortnox')

    expect(fortnoxEntries.map(entry => `${entry.method} ${entry.path}`)).toEqual(fortnoxWriteRoutes)

    for (const entry of fortnoxEntries) {
      // At most 60 days from 2026-09-30.
      expect(entry.expires <= '2026-11-29', entry.path).toBe(true)
      expect(entry.reason).toContain('owner-approved')
      expect(entry.reason).toContain('live run of fortnox.')
    }
  })

  it('fails the unverified Fortnox write routes without the pending file or after it expires', () => {
    const fortnoxExpiry = repoPending.entries
      .filter(entry => entry.manifest === 'fortnox')
      .map(entry => entry.expires)
      .toSorted()
      .at(-1)

    expect(fortnoxExpiry).toBeDefined()

    const dayAfterFortnoxExpiry = new Date(
      Date.parse(`${fortnoxExpiry ?? ''}T00:00:00.000Z`) + 24 * 60 * 60 * 1000
    )

    for (const report of [repoCheck(now, []), repoCheck(dayAfterFortnoxExpiry)]) {
      expect(evidenceReportFailed(report)).toBe(true)
      expect(failedRoutes(report, 'fortnox')).toEqual(fortnoxWriteRoutes)
    }
  })

  it('ships one pending entry per Microsoft write route, at most 60 days out, naming the live run', () => {
    const microsoftEntries = repoPending.entries.filter(entry => entry.manifest === 'microsoft')

    expect(microsoftEntries.map(entry => `${entry.method} ${entry.path}`)).toEqual(
      microsoftWriteRoutes
    )

    for (const entry of microsoftEntries) {
      // At most 60 days from 2026-09-30.
      expect(entry.expires <= '2026-11-29', entry.path).toBe(true)
      expect(entry.reason).toContain('owner-approved')
      expect(entry.reason).toContain('live run of microsoft.')
    }
  })

  it('fails the unverified Microsoft write routes without the pending file or after it expires', () => {
    const microsoftExpiry = repoPending.entries
      .filter(entry => entry.manifest === 'microsoft')
      .map(entry => entry.expires)
      .toSorted()
      .at(-1)

    expect(microsoftExpiry).toBeDefined()

    const dayAfterMicrosoftExpiry = new Date(
      Date.parse(`${microsoftExpiry ?? ''}T00:00:00.000Z`) + 24 * 60 * 60 * 1000
    )

    for (const report of [repoCheck(now, []), repoCheck(dayAfterMicrosoftExpiry)]) {
      expect(evidenceReportFailed(report)).toBe(true)
      expect(failedRoutes(report, 'microsoft')).toEqual(microsoftWriteRoutes)
    }

    // Each allowance is independent (dates from the pending file): the day after the last Fortnox
    // allowance expires, the Fortnox routes fail; on the day after the EARLIER of the two expiries,
    // the other emulator's routes, still within their own allowance, do not.
    const fortnoxExpiry = repoPending.entries
      .filter(entry => entry.manifest === 'fortnox')
      .map(entry => entry.expires)
      .toSorted()
      .at(-1)

    expect(fortnoxExpiry).toBeDefined()

    const dayAfter = (date: string | undefined) =>
      new Date(Date.parse(`${date ?? ''}T00:00:00.000Z`) + 24 * 60 * 60 * 1000)

    expect(failedRoutes(repoCheck(dayAfter(fortnoxExpiry)), 'fortnox')).toEqual(fortnoxWriteRoutes)

    const [earlier, later] =
      (fortnoxExpiry ?? '') < (microsoftExpiry ?? '')
        ? (['fortnox', 'microsoft'] as const)
        : (['microsoft', 'fortnox'] as const)

    const earlierExpiry = earlier === 'fortnox' ? fortnoxExpiry : microsoftExpiry
    const laterExpiry = later === 'fortnox' ? fortnoxExpiry : microsoftExpiry

    if (earlierExpiry !== laterExpiry) {
      expect(failedRoutes(repoCheck(dayAfter(earlierExpiry)), later)).toEqual([])
    }
  })

  it.each([
    ['dropbox', 'Dropbox', () => dropboxWriteRoutes],
    ['notion', 'Notion', () => notionWriteRoutes],
    ['todoist', 'Todoist', () => todoistWriteRoutes],
    ['telegram', 'Telegram', () => telegramWriteRoutes],
    ['github', 'GitHub', () => githubWriteRoutes],
    ['google', 'Google', () => googleWriteRoutes]
  ] as const)(
    'ships one pending entry per %s write route, at most 60 days out, naming the live run',
    (manifest, _label, writeRoutes) => {
      const entries = repoPending.entries.filter(entry => entry.manifest === manifest)

      expect(entries.map(entry => `${entry.method} ${entry.path}`)).toEqual(writeRoutes())

      for (const entry of entries) {
        // At most 60 days from 2026-09-30 (and from 2026-10-01, the day they were added).
        expect(entry.expires <= '2026-11-29', entry.path).toBe(true)
        expect(entry.reason).toContain('owner-approved')
        expect(entry.reason).toContain(`live run of ${manifest}.`)
        expect(entry.reason).toContain('tracking #115')
      }
    }
  )

  it.each([
    ['dropbox', () => dropboxWriteRoutes],
    ['notion', () => notionWriteRoutes],
    ['todoist', () => todoistWriteRoutes],
    ['telegram', () => telegramWriteRoutes],
    ['github', () => githubWriteRoutes],
    ['google', () => googleWriteRoutes]
  ] as const)(
    'fails the unverified %s write routes without the pending file or after it expires',
    (manifest, writeRoutes) => {
      const expiry = repoPending.entries
        .filter(entry => entry.manifest === manifest)
        .map(entry => entry.expires)
        .toSorted()
        .at(-1)

      expect(expiry).toBeDefined()

      const dayAfterExpiry = new Date(
        Date.parse(`${expiry ?? ''}T00:00:00.000Z`) + 24 * 60 * 60 * 1000
      )

      for (const report of [repoCheck(now, []), repoCheck(dayAfterExpiry)]) {
        expect(evidenceReportFailed(report)).toBe(true)
        expect(failedRoutes(report, manifest)).toEqual(writeRoutes())
      }

      // On its last allowed day the routes still pass.
      expect(failedRoutes(repoCheck(new Date(`${expiry ?? ''}T12:00:00.000Z`)), manifest)).toEqual(
        []
      )
    }
  )

  it('the CLI clock is today unless the test-only --now flag sets it', () => {
    const today = new Date('2026-09-30T08:00:00.000Z')

    expect(cliNow([], today)).toBe(today)
    expect(cliNow(['--now', '2026-11-01'], today)).toEqual(new Date('2026-11-01T12:00:00.000Z'))

    for (const args of [['--now'], ['--now', '2026-02-30'], ['--today', '2026-11-01']]) {
      expect(cliNow(args, today), args.join(' ')).toContain('usage:')
    }
  })

  // The CLI runs at explicit dates taken from the pending file, never the wall clock, so this
  // test does not start failing on its own when the entries expire. With no pending entries the
  // result does not depend on the date, so today is used (a fixed date could precede the
  // `observedAt` of freshly verified routes and fail as `future-observed-at`).
  const expiries = repoPending.entries.map(entry => entry.expires).toSorted()
  const earliestExpiry = expiries[0] ?? new Date().toISOString().slice(0, 10)
  const latestExpiry = expiries.at(-1) ?? earliestExpiry

  const dayAfter = (date: string) =>
    new Date(Date.parse(`${date}T00:00:00.000Z`) + 24 * 60 * 60 * 1000).toISOString().slice(0, 10)

  const runCli = (date: string) =>
    new Promise<{ failed: boolean; stdout: string; stderr: string }>(resolvePromise => {
      execFile(
        process.execPath,
        [tsxCli, checker, '--now', date],
        { cwd: repoRoot },
        (error, stdout, stderr) => {
          resolvePromise({ failed: error !== null, stdout: String(stdout), stderr: String(stderr) })
        }
      )
    })

  it('runs as a CLI that prints the report and exits 0 before the pending entries expire', async () => {
    const pendingRoutes = repoCheck(new Date(`${earliestExpiry}T12:00:00.000Z`)).findings.filter(
      finding => finding.kind === 'pending-write'
    ).length

    const result = await runCli(earliestExpiry)

    expect(pendingRoutes).toBe(repoPending.entries.length)
    expect(result.failed).toBe(false)
    expect(result.stdout).toContain('Emulator evidence:')
    // The Gateway route is verified; a stale-evidence warning may appear, never an unverified one.
    expect(result.stdout).not.toContain(
      'WARN  gateway  POST /v1/chat/completions  unverified evidence'
    )
    expect(result.stdout).toContain('WARN  openai  POST /v1/chat/completions  unverified evidence')
    expect(result.stdout).toContain('WARN  anthropic  POST /v1/messages  unverified evidence')
    expect(result.stdout).toContain(
      'WARN  codex  POST /backend-api/codex/responses  unverified evidence'
    )
    expect(result.stdout).toContain('WARN  xai  POST /v1/responses  unverified evidence')
    expect(result.stdout).toContain(
      'WARN  anthropic-usage  GET /api/oauth/usage  unverified evidence'
    )
    expect(result.stdout).toContain(
      'WARN  codex-usage  GET /backend-api/wham/usage  unverified evidence'
    )
    expect(result.stdout).toContain('WARN  xai-usage  GET /v1/billing  unverified evidence')
    expect(result.stdout).toContain('WARN  opencode  GET /zen/go/v1/usage  unverified evidence')
    expect(result.stdout).toContain(
      'WARN  opencode  POST /zen/go/v1/responses  unverified evidence (2 case(s))'
    )
    expect(result.stdout).toContain(
      'WARN  email  PORT EmailClient.createDraft  PENDING until 2026-11-29'
    )
    expect(result.stdout).toContain('WARN  email  PORT EmailClient.getMessage  unverified evidence')
    expect(result.stdout).toContain('WARN  r2  PORT R2ObjectClient.put  PENDING until 2026-11-29')
    expect(result.stdout).toContain('WARN  r2  PORT R2ObjectClient.get  unverified evidence')
    expect(result.stdout).toContain('WARN  fortnox  POST /3/invoices  PENDING until 2026-11-29')
    expect(result.stdout).toContain('WARN  microsoft  POST /v1.0/$batch  PENDING until 2026-11-27')
    expect(result.stdout).toContain('WARN  dropbox  POST /2/files/upload  PENDING until 2026-11-29')
    expect(result.stdout).toContain(
      'WARN  notion  PATCH /v1/pages/{pageId}  PENDING until 2026-11-29'
    )
    expect(result.stdout).toContain(
      'WARN  dropbox  POST /2/files/get_metadata  unverified evidence'
    )
    expect(result.stdout).toContain('WARN  notion  GET /v1/users/me  unverified evidence')
    expect(result.stdout).toContain(
      'WARN  todoist  POST /api/v1/projects  PENDING until 2026-11-29'
    )
    expect(result.stdout).toContain(
      'WARN  telegram  POST /bot{token}/sendMessage  PENDING until 2026-11-29'
    )
    expect(result.stdout).toContain(
      'WARN  github  POST /repos/{owner}/{repo}/issues  PENDING until 2026-11-29'
    )
    expect(result.stdout).toContain(
      'WARN  github  GET /repos/{owner}/{repo}/labels  unverified evidence'
    )
    expect(result.stdout).toContain(
      'WARN  google  POST /upload/gmail/v1/users/me/messages/send  PENDING until 2026-11-29'
    )
    expect(result.stdout).toContain(
      'WARN  google  GET /drive/v3/files/{fileId}  unverified evidence (2 case(s))'
    )
    expect(result.stdout).toContain(
      'WARN  linkedin-search  GET /api/v2/profile  unverified evidence (3 case(s))'
    )
    expect(result.stdout).not.toContain('linkedin-search  POST /search  PENDING')
    expect(result.stdout).toContain(
      'WARN  mcp  RPC https://mcp.example.test/legacy/mcp#tools/call  unverified evidence (3 case(s))'
    )
    expect(result.stdout).not.toMatch(/mcp {2}\S+ \S+ {2}PENDING/)

    // The PENDING count comes from the pending file, not a hard-coded number.
    const pendingLine = result.stdout.split('\n').find(line => line.startsWith('PENDING: '))

    expect(pendingLine === undefined ? 0 : Number(pendingLine.split(' ')[1])).toBe(pendingRoutes)
  }, 120000)

  it.runIf(repoPending.entries.length > 0)(
    'runs as a CLI that exits 1 after the pending entries expire',
    async () => {
      const result = await runCli(dayAfter(latestExpiry))

      expect(result.failed).toBe(true)
      expect(result.stderr).toContain(`expired on ${latestExpiry}`)
    },
    120000
  )
})
