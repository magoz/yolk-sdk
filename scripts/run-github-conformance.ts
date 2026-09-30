/**
 * GitHub conformance runner for a practice GitHub repository (`pnpm conformance:github`).
 *
 * Default: DRY RUN. Prints every case id, its safety, and whether it would run under the chosen
 * flags, then exits without any network call or credential read.
 *
 * `--live --owner-approved --account <label>`: runs the cases against the real GitHub REST API with
 * a `FetchHttpClient`, through the real connector actions. Refused whenever `CI` is non-empty and
 * without `--owner-approved`. Requires `GITHUB_TOKEN` (environment only, never a flag; a token for
 * the practice repository only: a fine-grained token with Issues read/write and Contents read is
 * enough) and the seeds of every case that will run (`--owner`, `--repo`, and the case seeds; flags
 * or environment, see the usage text). A token that is not letters, digits, and underscores is
 * refused before any request (never printed). Read cases always run. `--allow-writes reversible`
 * adds the write-reversible cases: a `yolk-conformance <runId> comment` on `--work-issue`, deleted
 * again by id, and `--label` added to `--work-issue` and removed again (that case refuses to start
 * while the label is already there, so concurrent runs of it are not supported). Both undo their
 * state, but not everything they cause: the comment notifies the work issue's subscribers, and the
 * label add and remove stay on its timeline, so `--work-issue` must be a practice issue nobody else
 * watches. The one
 * write-irreversible case, `github.issues.lifecycle-close`, opens a real issue titled with the run
 * id and closes it; GitHub issues cannot be deleted through the REST API, so the closed issue stays
 * in the repository, and the case runs only when named with
 * `--allow-irreversible github.issues.lifecycle-close` (`--allow-writes` never starts it). The
 * runner generates a fresh random `runId` per invocation (never a flag) and prints it before any
 * case when the lifecycle case will run. A definitive write rejection undoes nothing, and an
 * ambiguous write is reported with the exact item to check by hand. Before any write case, and
 * again after an interrupt-only exit, a read-only lookup warns about open `yolk-conformance run-*`
 * issues, `yolk-conformance run-*` comments on the work issue, and the seeded label on it; nothing
 * is changed automatically.
 *
 * The token travels only in the `Authorization` header, which the recorder never keeps; `--record`
 * still refuses to stage any recording in which the live token survives anywhere (an echo in a body
 * or header; raw, percent-encoded, escaped, or base64-encoded) or that holds a body outside the
 * guard's inspectable allowlist (strict UTF-8 text without NUL characters), and the fixture secret
 * scan refuses credential query parameters (a private repository's contents `download_url` carries a
 * `token` parameter, so use a public practice repository to record the contents case). `--record`
 * keeps the `link` response header (the paging claim reads it) and the `x-github-api-version`
 * request header, and stages verified recordings all or nothing in a new run directory under the
 * gitignored `.conformance-recordings/github/`. Promotion is manual: scrub the staged files of
 * practice-repository data (owner, repository and numeric repository ids in `Link` URLs, logins,
 * issue and comment ids, titles, bodies, label names, file contents, shas, URLs), copy them into
 * `packages/connectors/src/github/conformance/`, run `pnpm format:fix`, and update
 * `packages/connectors/test/github-conformance.test.ts` and
 * `scripts/test/run-github-conformance.test.ts` in the same change. See
 * `connector-conformance-internal.ts` for the shared gates.
 *
 * Never run live in CI.
 */
import { randomBytes } from 'node:crypto'
import { resolve } from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'
import { Layer } from 'effect'
import * as Schema from 'effect/Schema'
import type { HttpClient } from 'effect/unstable/http'
import {
  connectorHttpClientsFromEffectHttpClientLayer,
  staticCredentialResolverLayer
} from '../packages/connectors/src/conformance/index.ts'
import { BearerTokenCredential } from '../packages/connectors/src/credential.ts'
import {
  GithubConformanceConfig,
  GithubConformanceSeeds,
  findGithubConformanceLeftovers,
  githubConformanceCases,
  githubConformanceFixtureSeeds,
  type GithubConformanceError,
  type GithubConformanceRequirements,
  type GithubConformanceSeedKey
} from '../packages/connectors/src/github/conformance/index.ts'
import { githubApiBaseUrl } from '../packages/connectors/src/github/index.ts'
import {
  recordingsRootFor,
  runConnectorConformanceCli,
  type CaseSpec,
  type ConnectorConformanceRunner,
  type SeedSource
} from './connector-conformance-internal.ts'

/** Where each seed comes from. Flags win over environment variables. */
export const githubSeedSources: ReadonlyArray<SeedSource<GithubConformanceSeedKey>> = [
  {
    key: 'owner',
    flag: '--owner',
    env: 'GITHUB_CONFORMANCE_OWNER',
    description: 'owner (user or organization) of the practice repository'
  },
  {
    key: 'repo',
    flag: '--repo',
    env: 'GITHUB_CONFORMANCE_REPO',
    description: 'the practice repository (3 to 20 labels)'
  },
  {
    key: 'workIssueNumber',
    flag: '--work-issue',
    env: 'GITHUB_CONFORMANCE_WORK_ISSUE',
    description:
      'open practice issue nobody else watches (comments notify its subscribers; label changes stay on its timeline)'
  },
  {
    key: 'labelName',
    flag: '--label',
    env: 'GITHUB_CONFORMANCE_LABEL',
    description: 'existing repository label that is not on --work-issue'
  },
  {
    key: 'filePath',
    flag: '--file-path',
    env: 'GITHUB_CONFORMANCE_FILE_PATH',
    description: 'UTF-8 text file (over 45 bytes, a non-ASCII character, under 100,000 characters)'
  }
]

const repoSeeds: ReadonlyArray<GithubConformanceSeedKey> = ['owner', 'repo']

/** Seeds each case needs, and the fixture module `--record` rewrites for it. */
export const githubCaseSpecs: ReadonlyArray<CaseSpec<GithubConformanceSeedKey>> = [
  {
    caseId: 'github.labels.list-link-paging',
    seeds: repoSeeds,
    optionalSeeds: [],
    fileName: 'labels-paging.ts',
    exportName: 'githubLabelsPagingFixture',
    doc: 'The `per_page=2` label pages of the practice repository with their `Link` headers, then the page after the last.'
  },
  {
    caseId: 'github.errors.not-found-envelope',
    seeds: repoSeeds,
    optionalSeeds: [],
    fileName: 'not-found-envelope.ts',
    exportName: 'githubNotFoundEnvelopeFixture',
    doc: '`github.get_issue` of an issue number the practice repository has not reached, with the JSON error body.'
  },
  {
    caseId: 'github.errors.validation-envelope',
    seeds: repoSeeds,
    optionalSeeds: [],
    fileName: 'validation-envelope.ts',
    exportName: 'githubValidationEnvelopeFixture',
    doc: '`github.search_issues` with a query longer than 256 characters, with the validation body.'
  },
  {
    caseId: 'github.contents.base64-file',
    seeds: [...repoSeeds, 'filePath'],
    optionalSeeds: [],
    fileName: 'file-contents.ts',
    exportName: 'githubFileContentsFixture',
    doc: '`github.get_file_contents` of the seeded text file.'
  },
  {
    caseId: 'github.comments.create-delete',
    seeds: [...repoSeeds, 'workIssueNumber', 'runId'],
    optionalSeeds: [],
    fileName: 'comment-lifecycle.ts',
    exportName: 'githubCommentLifecycleFixture',
    doc: 'A run-scoped comment created on the work issue, listed, deleted by id, no longer listed, then deleted again.'
  },
  {
    caseId: 'github.labels.add-remove',
    seeds: [...repoSeeds, 'workIssueNumber', 'labelName'],
    optionalSeeds: [],
    fileName: 'issue-labels.ts',
    exportName: 'githubIssueLabelsFixture',
    doc: 'The seeded label added to the work issue and removed again, with the reads around it.'
  },
  {
    caseId: 'github.issues.lifecycle-close',
    seeds: [...repoSeeds, 'runId'],
    optionalSeeds: [],
    fileName: 'issue-lifecycle.ts',
    exportName: 'githubIssueLifecycleFixture',
    doc: 'A run-scoped issue created, read, renamed, closed as completed, and read back closed.'
  }
]

/** A fresh invocation-unique run id (`run-<8 hex>`), named in every comment and issue title. */
export const generateRunId = (): string => `run-${randomBytes(4).toString('hex')}`

/** The live credential: a bearer token for the practice repository. */
export const liveCredential = (accessToken: string) =>
  BearerTokenCredential.make({ token: accessToken })

const casePorts = (
  httpLayer: Layer.Layer<HttpClient.HttpClient>,
  accessToken: string,
  seeds: GithubConformanceSeeds
) =>
  Layer.mergeAll(
    connectorHttpClientsFromEffectHttpClientLayer.pipe(Layer.provide(httpLayer)),
    staticCredentialResolverLayer(liveCredential(accessToken)),
    Layer.succeed(GithubConformanceConfig, seeds)
  )

export const githubRunner = {
  provider: 'github',
  displayName: 'GitHub',
  practiceTarget: 'a practice GitHub repository',
  tokenEnv: 'GITHUB_TOKEN',
  tokenScopes:
    'a token for the practice repository only (fine-grained: Issues read/write and Contents read)',
  endpoint: githubApiBaseUrl,
  writeNote:
    'post a yolk-conformance <run id> comment on --work-issue and delete it again by id (a fresh random run id per invocation), and add --label to --work-issue and remove it again (refused while the label is already there); the comment notifies the issue subscribers and the label changes stay on its timeline, so use a practice issue nobody else watches',
  irreversibleNote:
    'The write-irreversible github.issues.lifecycle-close case opens a real issue titled with a fresh run id and closes it; GitHub issues cannot be deleted through the REST API, so the closed issue stays in the repository; it runs only with --allow-irreversible github.issues.lifecycle-close',
  cases: githubConformanceCases,
  seedSources: githubSeedSources,
  generatedSeeds: { keys: ['runId'], generate: () => ({ runId: generateRunId() }) },
  caseSpecs: githubCaseSpecs,
  fixtureSeeds: githubConformanceFixtureSeeds,
  seedNoun: 'values',
  seedsTypeName: 'GithubConformanceSeeds',
  seedsExportName: 'githubConformanceFixtureSeeds',
  configName: 'GithubConformanceConfig',
  decodeSeeds: Schema.decodeUnknownOption(GithubConformanceSeeds),
  invalidSeedsMessage:
    '--owner and --repo must be a valid GitHub owner and repository, --work-issue an issue number, --label a plain label name (letters, digits, ., _, -), and --file-path a relative path without dot segments',
  casePorts,
  recordedRequestHeaders: ['x-github-api-version'],
  // The paging claim reads `Link`; without it a recording would not replay.
  recordedResponseHeaders: ['link'],
  // Checked before any request, never printed: every GitHub token format is letters, digits, and
  // underscores (ghp_, gho_, ghu_, ghs_, ghr_, github_pat_, and classic 40-hex tokens).
  tokenFormat: {
    pattern: /^[A-Za-z0-9_]{20,255}$/,
    description:
      'a GitHub token (20 to 255 letters, digits, and underscores, such as ghp_..., github_pat_..., or ghs_...)'
  },
  // Read-only: open run issues, run comments on the work issue, and the seeded label on it.
  leftovers: findGithubConformanceLeftovers,
  leftoverAdvice:
    'close, delete, or remove it by hand after checking that no run is still using it',
  recoveryAdvice:
    "Look in the practice repository by hand: comments starting with `yolk-conformance run-` on --work-issue (delete them), --label on --work-issue (remove it), and open issues titled `yolk-conformance run-` (close them; the run id is printed when the lifecycle case runs). Closed `yolk-conformance run-` issues are the lifecycle case's documented leftover: GitHub issues cannot be deleted through the REST API.",
  nameKeys: /^(?:login|name|title|path|full_name|html_url|download_url)$/,
  textKeys: /^(?:body|content|message|description)$/
} satisfies ConnectorConformanceRunner<
  GithubConformanceSeedKey,
  GithubConformanceSeeds,
  GithubConformanceError,
  GithubConformanceRequirements
>

/** Gitignored root of staged GitHub recordings. */
export const recordingsRoot = recordingsRootFor(githubRunner.provider)

const invokedAsCli = (): boolean => {
  const invoked = process.argv[1]

  return invoked !== undefined && resolve(invoked) === fileURLToPath(import.meta.url)
}

if (invokedAsCli()) {
  runConnectorConformanceCli(githubRunner)
}
