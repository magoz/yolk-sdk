import { execFile } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import type { EmulatorRouteEvidence } from '../../packages/emulators/src/route-evidence.ts'
import {
  checkEmulatorEvidence,
  emulatorManifests,
  evidenceAgeDays,
  evidenceReportFailed,
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

  it('warns on stale, unreadable, or missing observedAt without failing', () => {
    const stale = check([route({ observedAt: '2026-08-30' })])

    expect(stale.findings.map(finding => finding.detail)).toEqual([
      'observedAt 2026-08-30 is 31 days old (max 30)'
    ])
    expect(evidenceReportFailed(stale)).toBe(false)
    expect(kinds([route({ observedAt: '2026-08-31' })])).toEqual([])
    expect(kinds([route({ observedAt: 'yesterday' })])).toEqual(['warn:stale'])
    expect(kinds([route({ observedAt: undefined })])).toEqual(['warn:missing-observed-at'])
    expect(kinds([route({ caseIds: [] })])).toEqual(['warn:no-case-ids'])
  })

  it('computes whole UTC days', () => {
    expect(evidenceAgeDays('2026-09-30', now)).toBe(0)
    expect(evidenceAgeDays('2026-09-01', now)).toBe(29)
    expect(evidenceAgeDays('2026-13-45', now)).toBeUndefined()
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
      now
    })

    expect(evidenceReportFailed(report)).toBe(false)
    expect(knownConformanceCaseIds.has('vercel-ai-gateway.stream.plain-text')).toBe(true)
    expect(knownConformanceCaseIds.has('fortnox.invoice.list-populated')).toBe(true)
  })

  it('runs as a CLI that prints the report and exits 0', async () => {
    const result = await new Promise<{ failed: boolean; stdout: string }>(resolvePromise => {
      execFile(process.execPath, [tsxCli, checker], { cwd: repoRoot }, (error, stdout) => {
        resolvePromise({ failed: error !== null, stdout: String(stdout) })
      })
    })

    expect(result.failed).toBe(false)
    expect(result.stdout).toContain('Emulator evidence:')
    expect(result.stdout).toContain('WARN  gateway  POST /v1/chat/completions  unverified evidence')
  }, 120000)
})
