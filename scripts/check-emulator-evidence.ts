/**
 * Emulator evidence check (`pnpm packages:evidence`, part of `pnpm packages:check`).
 *
 * Validates every emulator route evidence manifest against the conformance case registries:
 *
 * - FAIL: a route cites an unknown case id.
 * - FAIL: a manifest lists the same method + path twice.
 * - FAIL: a connector route with `write: true` has evidence other than `verified`.
 * - WARN: a route's evidence is `unverified` (the emulator tags its responses
 *   `x-emulator-evidence: unverified`).
 * - WARN: `observedAt` is more than 30 days old, unreadable, or missing on verified evidence.
 * - WARN: a route cites no case ids.
 *
 * Prints a compact report and exits 1 on any failure. No network I/O.
 */
import { resolve } from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'
import { vercelAiGatewayConformanceCases } from '../packages/agent/src/providers/vercel/conformance/cases.ts'
import { fortnoxConformanceCases } from '../packages/connectors/src/fortnox/conformance/cases.ts'
import { gatewayEmulatorRoutes } from '../packages/emulators/src/gateway.ts'
import type { EmulatorRouteEvidence } from '../packages/emulators/src/route-evidence.ts'

export type EvidenceManifest = {
  readonly name: string
  readonly routes: ReadonlyArray<EmulatorRouteEvidence>
}

export type EvidenceFindingKind =
  | 'unknown-case-id'
  | 'duplicate-route'
  | 'unverified-write'
  | 'unverified'
  | 'stale'
  | 'missing-observed-at'
  | 'no-case-ids'

export type EvidenceFinding = {
  readonly severity: 'fail' | 'warn'
  readonly kind: EvidenceFindingKind
  readonly manifest: string
  readonly route: string
  readonly detail: string
}

export type EvidenceReport = {
  readonly manifests: number
  readonly routes: number
  readonly verified: number
  readonly unverified: number
  readonly findings: ReadonlyArray<EvidenceFinding>
}

export type EvidenceCheckInput = {
  readonly manifests: ReadonlyArray<EvidenceManifest>
  readonly caseIds: ReadonlySet<string>
  readonly now: Date
  readonly maxAgeDays?: number
}

/** Every emulator manifest the repo ships. Add new emulators here. */
export const emulatorManifests: ReadonlyArray<EvidenceManifest> = [
  { name: 'gateway', routes: gatewayEmulatorRoutes }
]

/** Every conformance case id the manifests may cite. */
export const knownConformanceCaseIds: ReadonlySet<string> = new Set([
  ...vercelAiGatewayConformanceCases.map(testCase => testCase.id),
  ...fortnoxConformanceCases.map(testCase => testCase.id)
])

const dayMs = 24 * 60 * 60 * 1000

const calendarDatePattern = /^\d{4}-\d{2}-\d{2}$/

/** Whole UTC days since a `YYYY-MM-DD` date; `undefined` when unreadable. */
export const evidenceAgeDays = (observedAt: string, now: Date): number | undefined => {
  if (!calendarDatePattern.test(observedAt)) {
    return undefined
  }

  const observed = Date.parse(`${observedAt}T00:00:00.000Z`)

  if (Number.isNaN(observed)) {
    return undefined
  }

  const today = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate())

  return Math.floor((today - observed) / dayMs)
}

const routeLabel = (route: EmulatorRouteEvidence) => `${route.method.toUpperCase()} ${route.path}`

const routeFindings = (
  manifest: string,
  route: EmulatorRouteEvidence,
  input: EvidenceCheckInput
): ReadonlyArray<EvidenceFinding> => {
  const findings: Array<EvidenceFinding> = []
  const label = routeLabel(route)
  const maxAgeDays = input.maxAgeDays ?? 30

  const finding = (
    severity: EvidenceFinding['severity'],
    kind: EvidenceFindingKind,
    detail: string
  ) => findings.push({ severity, kind, manifest, route: label, detail })

  for (const caseId of route.caseIds) {
    if (!input.caseIds.has(caseId)) {
      finding('fail', 'unknown-case-id', `cites unknown case id ${caseId}`)
    }
  }

  if (route.caseIds.length === 0) {
    finding('warn', 'no-case-ids', 'cites no conformance case ids')
  }

  if (route.kind === 'connector' && route.write && route.evidence !== 'verified') {
    finding('fail', 'unverified-write', `connector write route has ${route.evidence} evidence`)
  }

  if (route.evidence === 'unverified') {
    finding('warn', 'unverified', `unverified evidence (${route.caseIds.length} case(s))`)
  }

  if (route.observedAt === undefined) {
    if (route.evidence === 'verified') {
      finding('warn', 'missing-observed-at', 'verified evidence has no observedAt')
    }

    return findings
  }

  const age = evidenceAgeDays(route.observedAt, input.now)

  if (age === undefined) {
    finding('warn', 'stale', `observedAt ${route.observedAt} is unreadable`)
  } else if (age > maxAgeDays) {
    finding(
      'warn',
      'stale',
      `observedAt ${route.observedAt} is ${age} days old (max ${maxAgeDays})`
    )
  }

  return findings
}

/** Pure check over manifests and known case ids. */
export const checkEmulatorEvidence = (input: EvidenceCheckInput): EvidenceReport => {
  const findings: Array<EvidenceFinding> = []
  let routes = 0
  let verified = 0

  for (const manifest of input.manifests) {
    const seen = new Set<string>()

    for (const route of manifest.routes) {
      routes += 1

      if (route.evidence === 'verified') {
        verified += 1
      }

      const label = routeLabel(route)

      if (seen.has(label)) {
        findings.push({
          severity: 'fail',
          kind: 'duplicate-route',
          manifest: manifest.name,
          route: label,
          detail: 'route is listed more than once'
        })
      }

      seen.add(label)
      findings.push(...routeFindings(manifest.name, route, input))
    }
  }

  return {
    manifests: input.manifests.length,
    routes,
    verified,
    unverified: routes - verified,
    findings
  }
}

export const evidenceReportFailed = (report: EvidenceReport): boolean =>
  report.findings.some(finding => finding.severity === 'fail')

/** Compact plain-text report: a summary line, one line per finding, and a totals line. */
export const formatEvidenceReport = (report: EvidenceReport): string => {
  const failures = report.findings.filter(finding => finding.severity === 'fail').length
  const warnings = report.findings.length - failures

  return [
    `Emulator evidence: ${report.routes} route(s) in ${report.manifests} manifest(s); ${report.verified} verified, ${report.unverified} unverified`,
    ...report.findings.map(
      finding =>
        `${finding.severity === 'fail' ? 'FAIL' : 'WARN'}  ${finding.manifest}  ${finding.route}  ${finding.detail}`
    ),
    `${failures} failure(s), ${warnings} warning(s)`
  ].join('\n')
}

const invokedAsCli = (): boolean => {
  const invoked = process.argv[1]

  return invoked !== undefined && resolve(invoked) === fileURLToPath(import.meta.url)
}

if (invokedAsCli()) {
  const report = checkEmulatorEvidence({
    manifests: emulatorManifests,
    caseIds: knownConformanceCaseIds,
    now: new Date()
  })

  const text = formatEvidenceReport(report)

  if (evidenceReportFailed(report)) {
    console.error(text)
    process.exitCode = 1
  } else {
    console.log(text)
  }
}
