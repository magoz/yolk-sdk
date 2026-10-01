/**
 * Emulator evidence check (`pnpm packages:evidence`, part of `pnpm packages:check`).
 *
 * Validates every emulator route evidence manifest against the conformance case registries:
 *
 * - FAIL: a route cites an unknown case id.
 * - FAIL: a manifest lists the same method + path twice.
 * - FAIL: a connector route with `write: true` has evidence other than `verified`, unless a
 *   pending entry in `scripts/emulator-evidence-pending.json` names it and has not expired.
 * - WARN (pending): an unverified connector write route listed in the pending file, until its
 *   `expires` date (inclusive, UTC). After that date it FAILS again.
 * - FAIL: a pending entry expired, or the pending file is malformed.
 * - FAIL: a pending entry expires more than 60 days after today (keep allowances short).
 * - WARN: a pending entry is stale (its route is now verified, or it matches no route).
 * - FAIL: a verified connector write route has a missing, unreadable, or future `observedAt`.
 * - FAIL: a verified connector write route cites no case ids.
 * - FAIL: a verified route cites case ids, but no cited case is backed by a `verified` fixture
 *   (only checked when fixture evidence is supplied; the CLI loads the Gateway, OpenAI chat,
 *   Codex Responses, Anthropic Messages, Grok Responses, OpenCode Go, subscription-usage (Claude,
 *   Codex, Grok), Fortnox, Microsoft, Dropbox, Notion, Todoist, Telegram, GitHub, Google,
 *   LinkedIn search, MCP, email port, and R2 port fixtures).
 * - WARN: a route's evidence is `unverified` (fetch-handler emulators tag their responses
 *   `x-emulator-evidence: unverified`; the email and R2 port emulators tag their ledger entries).
 * - WARN: `observedAt` is more than 30 days old; on other routes also when it is unreadable, in
 *   the future, or missing on verified evidence.
 * - WARN: any other route cites no case ids.
 *
 * Prints a compact report (pending entries first) and exits 1 on any failure. No network I/O.
 *
 * The CLI checks against today's date. `--now YYYY-MM-DD` replaces it and exists for tests only
 * (proving the exit status before and after the pending expiry); never use it to pass the check.
 */
import { readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'
import { Predicate, Result } from 'effect'
import * as Schema from 'effect/Schema'
import {
  conformanceFixtureEvidence as fixtureEvidenceOf,
  type PortFixture,
  type WireFixture
} from '../packages/conformance/src/fixture.ts'
import { anthropicConformanceCases } from '../packages/agent/src/providers/anthropic/conformance/cases.ts'
import { anthropicClaudeUsageConformanceCases } from '../packages/agent/src/providers/anthropic/conformance/claude-usage-cases.ts'
import {
  anthropicClaudeUsageConformanceFixtures,
  anthropicConformanceFixtures
} from '../packages/agent/src/providers/anthropic/conformance/index.ts'
import { openAiConformanceCases } from '../packages/agent/src/providers/openai/conformance/cases.ts'
import { openAiCodexConformanceCases } from '../packages/agent/src/providers/openai/conformance/codex-cases.ts'
import { openAiCodexUsageConformanceCases } from '../packages/agent/src/providers/openai/conformance/codex-usage-cases.ts'
import {
  openAiCodexConformanceFixtures,
  openAiCodexUsageConformanceFixtures,
  openAiConformanceFixtures
} from '../packages/agent/src/providers/openai/conformance/index.ts'
import { openCodeGoConformanceCases } from '../packages/agent/src/providers/opencode/conformance/cases.ts'
import { openCodeGoConformanceFixtures } from '../packages/agent/src/providers/opencode/conformance/index.ts'
import { vercelAiGatewayConformanceCases } from '../packages/agent/src/providers/vercel/conformance/cases.ts'
import { vercelAiGatewayConformanceFixtures } from '../packages/agent/src/providers/vercel/conformance/index.ts'
import { xAiGrokConformanceCases } from '../packages/agent/src/providers/xai/conformance/cases.ts'
import {
  xAiGrokConformanceFixtures,
  xAiGrokUsageConformanceFixtures
} from '../packages/agent/src/providers/xai/conformance/index.ts'
import { xAiGrokUsageConformanceCases } from '../packages/agent/src/providers/xai/conformance/usage-cases.ts'
import { dropboxConformanceCases } from '../packages/connectors/src/dropbox/conformance/cases.ts'
import { dropboxConformanceFixtures } from '../packages/connectors/src/dropbox/conformance/index.ts'
import { emailConformanceCases } from '../packages/connectors/src/email/conformance/cases.ts'
import { emailConformanceFixtures } from '../packages/connectors/src/email/conformance/index.ts'
import { fortnoxConformanceCases } from '../packages/connectors/src/fortnox/conformance/cases.ts'
import { fortnoxConformanceFixtures } from '../packages/connectors/src/fortnox/conformance/index.ts'
import { githubConformanceCases } from '../packages/connectors/src/github/conformance/cases.ts'
import { githubConformanceFixtures } from '../packages/connectors/src/github/conformance/index.ts'
import { googleConformanceCases } from '../packages/connectors/src/google/conformance/cases.ts'
import { googleConformanceFixtures } from '../packages/connectors/src/google/conformance/index.ts'
import { linkedInSearchConformanceCases } from '../packages/connectors/src/linkedin-search/conformance/cases.ts'
import { linkedInSearchConformanceFixtures } from '../packages/connectors/src/linkedin-search/conformance/index.ts'
import { microsoftConformanceCases } from '../packages/connectors/src/microsoft/conformance/cases.ts'
import { microsoftConformanceFixtures } from '../packages/connectors/src/microsoft/conformance/index.ts'
import { notionConformanceCases } from '../packages/connectors/src/notion/conformance/cases.ts'
import { notionConformanceFixtures } from '../packages/connectors/src/notion/conformance/index.ts'
import { r2ConformanceCases } from '../packages/connectors/src/r2-storage/conformance/cases.ts'
import { r2ConformanceFixtures } from '../packages/connectors/src/r2-storage/conformance/index.ts'
import { telegramConformanceCases } from '../packages/connectors/src/telegram/conformance/cases.ts'
import { telegramConformanceFixtures } from '../packages/connectors/src/telegram/conformance/index.ts'
import { todoistConformanceCases } from '../packages/connectors/src/todoist/conformance/cases.ts'
import { todoistConformanceFixtures } from '../packages/connectors/src/todoist/conformance/index.ts'
import { mcpConformanceCases } from '../packages/mcp/src/conformance/cases.ts'
import { mcpConformanceFixtures } from '../packages/mcp/src/conformance/index.ts'
import {
  anthropicEmulatorRoutes,
  anthropicSubscriptionUsageEmulatorRoutes
} from '../packages/emulators/src/anthropic.ts'
import {
  codexEmulatorRoutes,
  codexSubscriptionUsageEmulatorRoutes
} from '../packages/emulators/src/codex.ts'
import { dropboxEmulatorRoutes } from '../packages/emulators/src/dropbox.ts'
import { emailEmulatorRoutes } from '../packages/emulators/src/email.ts'
import { fortnoxEmulatorRoutes } from '../packages/emulators/src/fortnox.ts'
import { gatewayEmulatorRoutes } from '../packages/emulators/src/gateway.ts'
import { githubEmulatorRoutes } from '../packages/emulators/src/github.ts'
import { googleEmulatorRoutes } from '../packages/emulators/src/google.ts'
import { linkedInSearchEmulatorRoutes } from '../packages/emulators/src/linkedin-search.ts'
import { mcpEmulatorRoutes } from '../packages/emulators/src/mcp.ts'
import { microsoftEmulatorRoutes } from '../packages/emulators/src/microsoft.ts'
import { notionEmulatorRoutes } from '../packages/emulators/src/notion.ts'
import { openAiEmulatorRoutes } from '../packages/emulators/src/openai.ts'
import { openCodeGoEmulatorRoutes } from '../packages/emulators/src/opencode.ts'
import { r2EmulatorRoutes } from '../packages/emulators/src/r2.ts'
import { telegramEmulatorRoutes } from '../packages/emulators/src/telegram.ts'
import { todoistEmulatorRoutes } from '../packages/emulators/src/todoist.ts'
import {
  xAiGrokEmulatorRoutes,
  xAiGrokSubscriptionUsageEmulatorRoutes
} from '../packages/emulators/src/xai.ts'
import type {
  EmulatorEvidence,
  EmulatorRouteEvidence
} from '../packages/emulators/src/route-evidence.ts'

export type EvidenceManifest = {
  readonly name: string
  readonly routes: ReadonlyArray<EmulatorRouteEvidence>
}

export type EvidenceFindingKind =
  | 'unknown-case-id'
  | 'duplicate-route'
  | 'unverified-write'
  | 'pending-write'
  | 'pending-expired'
  | 'pending-too-long'
  | 'stale-pending'
  | 'invalid-pending'
  | 'unverified'
  | 'stale'
  | 'missing-observed-at'
  | 'unreadable-observed-at'
  | 'future-observed-at'
  | 'unbacked-verified'
  | 'no-case-ids'

/**
 * A time-bounded allowance for one unverified connector write route (an entry of
 * `scripts/emulator-evidence-pending.json`). It downgrades the route's failure to a warning until
 * `expires` (a `YYYY-MM-DD` UTC date, inclusive); after that the route fails again.
 */
export type PendingEvidenceEntry = {
  readonly manifest: string
  readonly method: string
  readonly path: string
  readonly reason: string
  readonly expires: string
}

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
  /** Latest allowed pending expiry, in days after `now` (default 60). */
  readonly maxPendingDays?: number
  /**
   * Optional fixture cross-check: the evidence of every fixture backing each case id. When
   * supplied, a verified route that cites case ids fails unless at least one cited case has a
   * `verified` fixture.
   */
  readonly fixtureEvidence?: ReadonlyMap<string, ReadonlyArray<EmulatorEvidence>>
  /** Time-bounded allowances for unverified connector write routes. */
  readonly pending?: ReadonlyArray<PendingEvidenceEntry>
  /** Problems found while reading the pending file; each one fails the check. */
  readonly pendingProblems?: ReadonlyArray<string>
}

/** Every emulator manifest the repo ships. Add new emulators here. */
export const emulatorManifests: ReadonlyArray<EvidenceManifest> = [
  { name: 'gateway', routes: gatewayEmulatorRoutes },
  { name: 'openai', routes: openAiEmulatorRoutes },
  { name: 'anthropic', routes: anthropicEmulatorRoutes },
  { name: 'codex', routes: codexEmulatorRoutes },
  { name: 'xai', routes: xAiGrokEmulatorRoutes },
  { name: 'anthropic-usage', routes: anthropicSubscriptionUsageEmulatorRoutes },
  { name: 'codex-usage', routes: codexSubscriptionUsageEmulatorRoutes },
  { name: 'xai-usage', routes: xAiGrokSubscriptionUsageEmulatorRoutes },
  { name: 'opencode', routes: openCodeGoEmulatorRoutes },
  { name: 'email', routes: emailEmulatorRoutes },
  { name: 'r2', routes: r2EmulatorRoutes },
  { name: 'fortnox', routes: fortnoxEmulatorRoutes },
  { name: 'microsoft', routes: microsoftEmulatorRoutes },
  { name: 'dropbox', routes: dropboxEmulatorRoutes },
  { name: 'notion', routes: notionEmulatorRoutes },
  { name: 'todoist', routes: todoistEmulatorRoutes },
  { name: 'telegram', routes: telegramEmulatorRoutes },
  { name: 'github', routes: githubEmulatorRoutes },
  { name: 'google', routes: googleEmulatorRoutes },
  { name: 'linkedin-search', routes: linkedInSearchEmulatorRoutes },
  { name: 'mcp', routes: mcpEmulatorRoutes }
]

/** The repo's pending-evidence allowlist. */
export const pendingEvidenceFile = join(
  dirname(fileURLToPath(import.meta.url)),
  'emulator-evidence-pending.json'
)

/** Repo-relative name used in report lines. */
const pendingFileLabel = 'scripts/emulator-evidence-pending.json'

export type PendingEvidence = {
  readonly entries: ReadonlyArray<PendingEvidenceEntry>
  readonly problems: ReadonlyArray<string>
}

const NonBlank = Schema.Trimmed.check(Schema.isNonEmpty())

const PendingEntrySchema = Schema.Struct({
  manifest: NonBlank,
  method: NonBlank,
  path: NonBlank,
  reason: NonBlank,
  expires: NonBlank
})

// Other top-level keys (such as a `note`) are allowed; each entry is decoded strictly on its own.
const PendingFileSchema = Schema.Struct({ entries: Schema.Array(Schema.Unknown) })

const decodePendingFile = Schema.decodeUnknownResult(PendingFileSchema)

const decodePendingEntry = Schema.decodeUnknownResult(PendingEntrySchema, {
  onExcessProperty: 'error'
})

/**
 * Validate the parsed pending file: `{ "entries": [{ manifest, method, path, reason, expires }] }`
 * (other top-level keys, such as a note, are allowed). Every field is a non-blank string without
 * surrounding whitespace, `expires` is a valid `YYYY-MM-DD` date, entries have no other keys, and
 * no route is listed twice.
 */
export const parsePendingEvidence = (value: unknown): PendingEvidence => {
  const file = decodePendingFile(value)

  if (Result.isFailure(file)) {
    return { entries: [], problems: ['the pending file must be an object with an "entries" array'] }
  }

  const entries: Array<PendingEvidenceEntry> = []
  const problems: Array<string> = []
  const seen = new Set<string>()

  file.success.entries.forEach((raw, index) => {
    const decoded = decodePendingEntry(raw)

    if (Result.isFailure(decoded)) {
      problems.push(
        `entry ${index} is invalid: ${new Schema.SchemaError(decoded.failure.issue).message}`
      )

      return
    }

    const entry = decoded.success

    if (evidenceAgeDays(entry.expires, new Date(0)) === undefined) {
      problems.push(`entry ${index} expires ${entry.expires} is not a YYYY-MM-DD date`)

      return
    }

    const label = `${entry.manifest} ${routeLabel(entry)}`

    if (seen.has(label)) {
      problems.push(`entry ${index} lists ${label} twice`)

      return
    }

    seen.add(label)
    entries.push(entry)
  })

  return { entries, problems }
}

/** Read and validate the pending file; a missing file means no pending entries. */
export const loadPendingEvidence = (file: string = pendingEvidenceFile): PendingEvidence => {
  let text: string

  try {
    text = readFileSync(file, 'utf8')
  } catch {
    return { entries: [], problems: [] }
  }

  try {
    return parsePendingEvidence(JSON.parse(text))
  } catch {
    return { entries: [], problems: ['the pending file is not valid JSON'] }
  }
}

/** Every conformance case id the manifests may cite. */
export const knownConformanceCaseIds: ReadonlySet<string> = new Set([
  ...vercelAiGatewayConformanceCases.map(testCase => testCase.id),
  ...openAiConformanceCases.map(testCase => testCase.id),
  ...anthropicConformanceCases.map(testCase => testCase.id),
  ...openAiCodexConformanceCases.map(testCase => testCase.id),
  ...xAiGrokConformanceCases.map(testCase => testCase.id),
  ...anthropicClaudeUsageConformanceCases.map(testCase => testCase.id),
  ...openAiCodexUsageConformanceCases.map(testCase => testCase.id),
  ...xAiGrokUsageConformanceCases.map(testCase => testCase.id),
  ...openCodeGoConformanceCases.map(testCase => testCase.id),
  ...fortnoxConformanceCases.map(testCase => testCase.id),
  ...microsoftConformanceCases.map(testCase => testCase.id),
  ...dropboxConformanceCases.map(testCase => testCase.id),
  ...notionConformanceCases.map(testCase => testCase.id),
  ...todoistConformanceCases.map(testCase => testCase.id),
  ...telegramConformanceCases.map(testCase => testCase.id),
  ...githubConformanceCases.map(testCase => testCase.id),
  ...googleConformanceCases.map(testCase => testCase.id),
  ...linkedInSearchConformanceCases.map(testCase => testCase.id),
  ...mcpConformanceCases.map(testCase => testCase.id),
  ...emailConformanceCases.map(testCase => testCase.id),
  ...r2ConformanceCases.map(testCase => testCase.id)
])

/** Group fixture evidence by the case id each fixture backs. */
export const fixtureEvidenceByCase = (
  fixtures: ReadonlyArray<Pick<WireFixture, 'caseId' | 'evidence'>>
): ReadonlyMap<string, ReadonlyArray<EmulatorEvidence>> => {
  const byCase = new Map<string, Array<EmulatorEvidence>>()

  for (const fixture of fixtures) {
    const evidence = byCase.get(fixture.caseId) ?? []

    evidence.push(fixture.evidence)
    byCase.set(fixture.caseId, evidence)
  }

  return byCase
}

/**
 * `{ caseId, evidence }` for every port fixture a case cites (port fixtures carry no `caseId`; an
 * observed one is `verified`).
 */
export const portFixtureEvidence = (
  cases: ReadonlyArray<{ readonly id: string; readonly fixtures: ReadonlyArray<string> }>,
  fixtures: ReadonlyArray<PortFixture>
): ReadonlyArray<Pick<WireFixture, 'caseId' | 'evidence'>> =>
  cases.flatMap(testCase =>
    testCase.fixtures.flatMap(fixtureId =>
      fixtures.flatMap(fixture =>
        fixture.id === fixtureId
          ? [{ caseId: testCase.id, evidence: fixtureEvidenceOf(fixture).evidence }]
          : []
      )
    )
  )

/**
 * Evidence of every committed Gateway, OpenAI chat, Codex Responses, Anthropic Messages, Grok
 * Responses, OpenCode Go, subscription-usage (Claude, Codex, Grok), Fortnox, Microsoft, Dropbox,
 * Notion, Todoist, Telegram, GitHub, Google, LinkedIn search, MCP, email port, and R2 port
 * fixture, by case id.
 */
export const repoFixtureEvidenceByCase: ReadonlyMap<
  string,
  ReadonlyArray<EmulatorEvidence>
> = fixtureEvidenceByCase([
  ...vercelAiGatewayConformanceFixtures,
  ...openAiConformanceFixtures,
  ...anthropicConformanceFixtures,
  ...openAiCodexConformanceFixtures,
  ...xAiGrokConformanceFixtures,
  ...anthropicClaudeUsageConformanceFixtures,
  ...openAiCodexUsageConformanceFixtures,
  ...xAiGrokUsageConformanceFixtures,
  ...openCodeGoConformanceFixtures,
  ...fortnoxConformanceFixtures,
  ...microsoftConformanceFixtures,
  ...dropboxConformanceFixtures,
  ...notionConformanceFixtures,
  ...todoistConformanceFixtures,
  ...telegramConformanceFixtures,
  ...githubConformanceFixtures,
  ...googleConformanceFixtures,
  ...linkedInSearchConformanceFixtures,
  ...mcpConformanceFixtures,
  ...portFixtureEvidence(emailConformanceCases, emailConformanceFixtures),
  ...portFixtureEvidence(r2ConformanceCases, r2ConformanceFixtures)
])

const dayMs = 24 * 60 * 60 * 1000

/** Pending allowances are short-lived: an expiry more than this many days away fails. */
export const defaultMaxPendingDays = 60

const calendarDatePattern = /^\d{4}-\d{2}-\d{2}$/

/**
 * Whole UTC days since a `YYYY-MM-DD` date (negative in the future); `undefined` when unreadable,
 * including dates that do not exist such as `2026-02-30`.
 */
export const evidenceAgeDays = (observedAt: string, now: Date): number | undefined => {
  if (!calendarDatePattern.test(observedAt)) {
    return undefined
  }

  const observed = Date.parse(`${observedAt}T00:00:00.000Z`)

  // Reject dates JavaScript rolls over (2026-02-30 parses as 2026-03-02).
  if (Number.isNaN(observed) || new Date(observed).toISOString().slice(0, 10) !== observedAt) {
    return undefined
  }

  const today = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate())

  return Math.floor((today - observed) / dayMs)
}

const routeLabel = (route: Pick<EmulatorRouteEvidence, 'method' | 'path'>) =>
  `${route.method.toUpperCase()} ${route.path}`

const pendingFor = (
  manifest: string,
  route: EmulatorRouteEvidence,
  pending: ReadonlyArray<PendingEvidenceEntry>
): PendingEvidenceEntry | undefined =>
  pending.find(entry => entry.manifest === manifest && routeLabel(entry) === routeLabel(route))

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

  const connectorWrite = route.kind === 'connector' && route.write

  // A verified connector write route must be backed by at least one conformance case.
  if (route.caseIds.length === 0) {
    if (connectorWrite && route.evidence === 'verified') {
      finding('fail', 'no-case-ids', 'verified connector write route cites no conformance case ids')
    } else {
      finding('warn', 'no-case-ids', 'cites no conformance case ids')
    }
  }

  if (connectorWrite && route.evidence !== 'verified') {
    const pending = pendingFor(manifest, route, input.pending ?? [])
    // Days past `expires` (0 on the expiry day itself, which is still allowed).
    const overdue = pending === undefined ? undefined : evidenceAgeDays(pending.expires, input.now)

    if (pending === undefined || overdue === undefined) {
      finding('fail', 'unverified-write', `connector write route has ${route.evidence} evidence`)
    } else if (-overdue > (input.maxPendingDays ?? defaultMaxPendingDays)) {
      finding(
        'fail',
        'pending-too-long',
        `connector write route has ${route.evidence} evidence; its ${pendingFileLabel} entry expires ${pending.expires}, more than ${input.maxPendingDays ?? defaultMaxPendingDays} days away`
      )
    } else if (overdue > 0) {
      finding(
        'fail',
        'pending-expired',
        `connector write route has ${route.evidence} evidence; its ${pendingFileLabel} entry expired on ${pending.expires}`
      )
    } else {
      finding(
        'warn',
        'pending-write',
        `PENDING until ${pending.expires} (${-overdue} day(s) left): connector write route has ${route.evidence} evidence; ${pending.reason}`
      )
    }
  }

  if (route.evidence === 'unverified') {
    finding('warn', 'unverified', `unverified evidence (${route.caseIds.length} case(s))`)
  }

  if (
    route.evidence === 'verified' &&
    input.fixtureEvidence !== undefined &&
    route.caseIds.length > 0
  ) {
    const fixtureEvidence = input.fixtureEvidence

    const backed = route.caseIds.some(caseId =>
      (fixtureEvidence.get(caseId) ?? []).includes('verified')
    )

    if (!backed) {
      finding(
        'fail',
        'unbacked-verified',
        'verified evidence, but no cited case has a verified fixture'
      )
    }
  }

  // A verified connector write route must carry a readable observation date that is not in the
  // future; other routes only warn.
  const observedAtSeverity = connectorWrite && route.evidence === 'verified' ? 'fail' : 'warn'

  if (route.observedAt === undefined) {
    if (route.evidence === 'verified') {
      finding(observedAtSeverity, 'missing-observed-at', 'verified evidence has no observedAt')
    }

    return findings
  }

  const age = evidenceAgeDays(route.observedAt, input.now)

  if (age === undefined) {
    finding(
      observedAtSeverity,
      'unreadable-observed-at',
      `observedAt ${route.observedAt} is unreadable`
    )
  } else if (age < 0) {
    finding(
      observedAtSeverity,
      'future-observed-at',
      `observedAt ${route.observedAt} is in the future`
    )
  } else if (age > maxAgeDays) {
    finding(
      'warn',
      'stale',
      `observedAt ${route.observedAt} is ${age} days old (max ${maxAgeDays})`
    )
  }

  return findings
}

/** Pending entries that no longer do anything: the route is verified, not a write, or gone. */
const stalePendingFindings = (input: EvidenceCheckInput): ReadonlyArray<EvidenceFinding> =>
  (input.pending ?? []).flatMap(entry => {
    const route = input.manifests
      .find(manifest => manifest.name === entry.manifest)
      ?.routes.find(candidate => routeLabel(candidate) === routeLabel(entry))

    const detail =
      route === undefined
        ? `${pendingFileLabel} entry matches no emulator route; remove it`
        : route.evidence === 'verified'
          ? `route is now verified; remove its stale ${pendingFileLabel} entry`
          : route.kind !== 'connector' || !route.write
            ? `route is not a connector write route; remove its stale ${pendingFileLabel} entry`
            : undefined

    return detail === undefined
      ? []
      : [
          {
            severity: 'warn' as const,
            kind: 'stale-pending' as const,
            manifest: entry.manifest,
            route: routeLabel(entry),
            detail
          }
        ]
  })

/** Pure check over manifests, known case ids, and pending entries. */
export const checkEmulatorEvidence = (input: EvidenceCheckInput): EvidenceReport => {
  const findings: Array<EvidenceFinding> = (input.pendingProblems ?? []).map(problem => ({
    severity: 'fail',
    kind: 'invalid-pending',
    manifest: 'pending',
    route: pendingFileLabel,
    detail: problem
  }))

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

  findings.push(...stalePendingFindings(input))

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

const findingLine = (finding: EvidenceFinding) =>
  `${finding.severity === 'fail' ? 'FAIL' : 'WARN'}  ${finding.manifest}  ${finding.route}  ${finding.detail}`

/**
 * Compact plain-text report: a summary line, a prominent PENDING block (allowlisted unverified
 * write routes), one line per other finding, and a totals line.
 */
export const formatEvidenceReport = (report: EvidenceReport): string => {
  const failures = report.findings.filter(finding => finding.severity === 'fail').length
  const warnings = report.findings.length - failures
  const pending = report.findings.filter(finding => finding.kind === 'pending-write')
  const others = report.findings.filter(finding => finding.kind !== 'pending-write')

  const pendingBlock =
    pending.length === 0
      ? []
      : [
          `PENDING: ${pending.length} unverified connector write route(s) allowed by ${pendingFileLabel}; each FAILS after its expiry date. Verify them with an owner-approved live run.`,
          ...pending.map(findingLine)
        ]

  return [
    `Emulator evidence: ${report.routes} route(s) in ${report.manifests} manifest(s); ${report.verified} verified, ${report.unverified} unverified`,
    ...pendingBlock,
    ...others.map(findingLine),
    `${failures} failure(s), ${warnings} warning(s)${pending.length === 0 ? '' : ` (${pending.length} pending)`}`
  ].join('\n')
}

const invokedAsCli = (): boolean => {
  const invoked = process.argv[1]

  return invoked !== undefined && resolve(invoked) === fileURLToPath(import.meta.url)
}

/**
 * The CLI's clock: today, unless the test-only `--now YYYY-MM-DD` flag replaces it (noon UTC of
 * that date). A string is a usage error.
 */
export const cliNow = (args: ReadonlyArray<string>, today: Date): Date | string => {
  if (args.length === 0) {
    return today
  }

  const [flag, value, ...rest] = args

  if (
    flag !== '--now' ||
    value === undefined ||
    rest.length > 0 ||
    evidenceAgeDays(value, today) === undefined
  ) {
    return 'usage: check-emulator-evidence [--now YYYY-MM-DD]  (--now is for tests only)'
  }

  return new Date(`${value}T12:00:00.000Z`)
}

if (invokedAsCli()) {
  const now = cliNow(process.argv.slice(2), new Date())

  if (Predicate.isString(now)) {
    console.error(now)
    process.exitCode = 1
  } else {
    const pending = loadPendingEvidence()

    const report = checkEmulatorEvidence({
      manifests: emulatorManifests,
      caseIds: knownConformanceCaseIds,
      now,
      fixtureEvidence: repoFixtureEvidenceByCase,
      pending: pending.entries,
      pendingProblems: pending.problems
    })

    const text = formatEvidenceReport(report)

    if (evidenceReportFailed(report)) {
      console.error(text)
      process.exitCode = 1
    } else {
      console.log(text)
    }
  }
}
