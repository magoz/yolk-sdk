import { execFile } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { vercelAiGatewayConformanceFixtures } from '../../packages/agent/src/providers/vercel/conformance/index.ts'
import { fortnoxConformanceFixtures } from '../../packages/connectors/src/fortnox/conformance/index.ts'
import type { EmulatorRouteEvidence } from '../../packages/emulators/src/route-evidence.ts'
import {
  checkEmulatorEvidence,
  conformanceFixtureEvidence,
  emulatorManifests,
  evidenceAgeDays,
  evidenceReportFailed,
  fixtureEvidenceByCase,
  formatEvidenceReport,
  knownConformanceCaseIds,
  type EvidenceManifest
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
  const repoFixtures = [...vercelAiGatewayConformanceFixtures, ...fortnoxConformanceFixtures]

  const hasVerifiedFixture = (caseId: string) =>
    repoFixtures.some(fixture => fixture.caseId === caseId && fixture.evidence === 'verified')

  const repoCrossCheck = (routes: ReadonlyArray<EmulatorRouteEvidence>) =>
    checkEmulatorEvidence({
      manifests: [{ name: 'example', routes }],
      caseIds: knownConformanceCaseIds,
      now,
      fixtureEvidence: conformanceFixtureEvidence
    })

  it('passes a verified route whose cited cases all have verified repo fixtures (Gateway)', () => {
    const gatewayCaseIds = [
      ...new Set(vercelAiGatewayConformanceFixtures.map(fixture => fixture.caseId))
    ]

    const verifiedCaseIds = gatewayCaseIds.filter(hasVerifiedFixture)

    expect(verifiedCaseIds).not.toEqual([])
    expect(verifiedCaseIds).toEqual(gatewayCaseIds)

    for (const caseId of verifiedCaseIds) {
      expect(conformanceFixtureEvidence.get(caseId)).toContain('verified')
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

  it('fails unbacked-verified for a verified route citing only still-unverified repo cases (Fortnox)', () => {
    const unverifiedCaseIds = [
      ...new Set(fortnoxConformanceFixtures.map(fixture => fixture.caseId))
    ].filter(caseId => !hasVerifiedFixture(caseId))

    expect(unverifiedCaseIds).not.toEqual([])

    for (const caseId of unverifiedCaseIds) {
      expect(conformanceFixtureEvidence.get(caseId)).not.toContain('verified')
    }

    const report = repoCrossCheck([
      route({ method: 'GET', caseIds: unverifiedCaseIds, observedAt: '2026-09-29' })
    ])

    expect(report.findings.map(finding => `${finding.severity}:${finding.kind}`)).toEqual([
      'fail:unbacked-verified'
    ])
    expect(evidenceReportFailed(report)).toBe(true)
  })

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

describe('repo emulator manifests', () => {
  it('cite only known case ids and have no failures', () => {
    const report = checkEmulatorEvidence({
      manifests: emulatorManifests,
      caseIds: knownConformanceCaseIds,
      now,
      fixtureEvidence: conformanceFixtureEvidence
    })

    expect(evidenceReportFailed(report)).toBe(false)
    expect(knownConformanceCaseIds.has('vercel-ai-gateway.stream.plain-text')).toBe(true)
    expect(knownConformanceCaseIds.has('fortnox.invoice.list-populated')).toBe(true)
    expect(knownConformanceCaseIds.has('openai.chat.json.plain-text')).toBe(true)
    expect(knownConformanceCaseIds.has('anthropic.messages.stream.max-tokens')).toBe(true)
    expect(knownConformanceCaseIds.has('openai.codex.stream.terminal-event')).toBe(true)
    expect(knownConformanceCaseIds.has('xai.grok.stream.terminal-event')).toBe(true)
    expect(emulatorManifests.map(manifest => manifest.name)).toEqual([
      'gateway',
      'openai',
      'anthropic',
      'codex',
      'xai'
    ])
    // The Gateway route is verified (aligned with the live recordings), backed by verified fixtures.
    expect(emulatorManifests[0]?.routes.map(route => [route.evidence, route.observedAt])).toEqual([
      ['verified', '2026-09-30']
    ])
    expect(
      emulatorManifests[0]?.routes.flatMap(route =>
        route.caseIds.map(caseId => conformanceFixtureEvidence.get(caseId))
      )
    ).toEqual([['verified'], ['verified'], ['verified'], ['verified']])
    expect(report.findings.filter(finding => finding.manifest === 'gateway')).toEqual([])
    expect(conformanceFixtureEvidence.get('openai.chat.stream.plain-text')).toEqual(['unverified'])
    expect(conformanceFixtureEvidence.get('anthropic.messages.stream.plain-text')).toEqual([
      'unverified'
    ])
    expect(conformanceFixtureEvidence.get('openai.codex.stream.plain-text')).toEqual(['unverified'])
    expect(conformanceFixtureEvidence.get('xai.grok.stream.plain-text')).toEqual(['unverified'])
  })

  it('runs as a CLI that prints the report and exits 0', async () => {
    const result = await new Promise<{ failed: boolean; stdout: string }>(resolvePromise => {
      execFile(process.execPath, [tsxCli, checker], { cwd: repoRoot }, (error, stdout) => {
        resolvePromise({ failed: error !== null, stdout: String(stdout) })
      })
    })

    expect(result.failed).toBe(false)
    expect(result.stdout).toContain('Emulator evidence:')
    // Verified now; a stale-evidence warning may appear once the observation is over 30 days old.
    expect(result.stdout).not.toContain(
      'WARN  gateway  POST /v1/chat/completions  unverified evidence'
    )
    expect(result.stdout).toContain('WARN  openai  POST /v1/chat/completions  unverified evidence')
    expect(result.stdout).toContain('WARN  anthropic  POST /v1/messages  unverified evidence')
    expect(result.stdout).toContain(
      'WARN  codex  POST /backend-api/codex/responses  unverified evidence'
    )
    expect(result.stdout).toContain('WARN  xai  POST /v1/responses  unverified evidence')
  }, 120000)
})
