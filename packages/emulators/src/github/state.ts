/**
 * GitHub emulator state: the authenticated user, the practice repository, its labels, issues,
 * comments, and files, the record of deleted comments, the counters, the seed input, the default
 * seed, and the profiles (internal; re-exported by `src/github.ts`).
 *
 * Entity shapes and the default entities follow the synthetic GitHub conformance fixtures, copied
 * as data (the same owner, repository, labels, work issue, file, user, and ids as the fixtures and
 * `githubConformanceFixtureSeeds`), never imported from SDK code. The repository id is the one the
 * paging fixture's `Link` URLs name, and the default branch is the one the contents fixture's URLs
 * name.
 *
 * Issue numbers below `nextIssueNumber` that the state does not hold are implied (the repository
 * reached them, but no fixture shows them): an answer that would render one is not emulated.
 * Numbers at or above it are not reached yet and answer the not-found fixture's 404. Created issue
 * numbers and comment ids come from counters that only advance; the default seed starts them at the
 * fixtures' created values (issue 42, comment 9000000001), and a seed's counters must lie above
 * every seeded number. Created issue `id` and `node_id` values derive from the minted number in the
 * fixtures' form (`3000000000 + number`, `I_kwSynthetic<number>`), and created comment `node_id`
 * values from the minted id (`IC_kwSynthetic<id>`); a seed may not use those minted forms at or
 * above its counters.
 *
 * Comments exist only as created here (no fixture shows a seeded comment). A deleted comment is
 * kept as a record (`deletedComments`): deleting it again answers the comment fixture's 404.
 *
 * @experimental
 */
import { Result } from 'effect'
import * as Schema from 'effect/Schema'

/** A GitHub owner login (the connector's owner pattern). */
export const githubOwnerPattern = /^[A-Za-z0-9](?:[A-Za-z0-9]|-(?=[A-Za-z0-9])){0,38}$/

/** A repository name in plain characters (no `.`/`..`, no `.git` suffix; checked below). */
export const githubRepoPattern = /^[A-Za-z0-9._-]{1,100}$/

/** A label name in plain characters (the conformance seed pattern; never percent-encoded). */
export const githubLabelNamePattern = /^[A-Za-z0-9][A-Za-z0-9._-]{0,49}$/

/** A relative file path whose segments never start with a dot (the conformance seed pattern). */
export const githubFilePathPattern =
  /^[A-Za-z0-9_-][A-Za-z0-9._-]*(?:\/[A-Za-z0-9_-][A-Za-z0-9._-]*)*$/

/** A GitHub timestamp as the fixtures write it: whole seconds, UTC. */
export const githubTimestampPattern = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/

const Timestamp = Schema.String.check(Schema.isPattern(githubTimestampPattern))

const PositiveInt = Schema.Int.check(Schema.isGreaterThanOrEqualTo(1))

/** The largest issue number the emulator addresses (ten digits, the route pattern). */
export const githubMaxIssueNumber = 9_999_999_999

const IssueNumber = PositiveInt.check(Schema.isLessThanOrEqualTo(githubMaxIssueNumber))

const LabelName = Schema.String.check(Schema.isPattern(githubLabelNamePattern))

/** A user as the fixtures render it (`login`, `id`, `type`, `site_admin`). */
export const GithubEmulatorUser = Schema.Struct({
  login: Schema.String.check(Schema.isPattern(githubOwnerPattern)),
  id: PositiveInt,
  type: Schema.String,
  siteAdmin: Schema.Boolean
})

export type GithubEmulatorUser = typeof GithubEmulatorUser.Type

/** The practice repository: its owner and name, its numeric id, and its default branch. */
export const GithubEmulatorRepository = Schema.Struct({
  owner: Schema.String.check(Schema.isPattern(githubOwnerPattern)),
  repo: Schema.String.check(
    Schema.isPattern(githubRepoPattern),
    Schema.makeFilter(
      (repo: string) =>
        (repo !== '.' && repo !== '..' && !repo.endsWith('.git')) ||
        'a repository name is not . or .. and does not end in .git'
    )
  ),
  /** The id the `Link` URLs name (`/repositories/<id>/labels`). */
  id: PositiveInt,
  defaultBranch: Schema.String.check(Schema.isPattern(/^[A-Za-z0-9._-]{1,100}$/))
})

export type GithubEmulatorRepository = typeof GithubEmulatorRepository.Type

/** A repository label. */
export const GithubEmulatorLabel = Schema.Struct({
  id: PositiveInt,
  nodeId: Schema.String,
  name: LabelName,
  /** Six hex digits, as the fixtures write colors. */
  color: Schema.String.check(Schema.isPattern(/^[0-9a-f]{6}$/)),
  default: Schema.Boolean,
  description: Schema.NullOr(Schema.String)
})

export type GithubEmulatorLabel = typeof GithubEmulatorLabel.Type

/** A seeded issue (its labels by name; never a pull request, never locked). */
export const GithubEmulatorSeedIssue = Schema.Struct({
  number: IssueNumber,
  id: PositiveInt,
  nodeId: Schema.String,
  title: Schema.String.check(Schema.isMinLength(1)),
  body: Schema.NullOr(Schema.String),
  state: Schema.Literals(['open', 'closed']),
  stateReason: Schema.NullOr(Schema.String),
  labels: Schema.Array(LabelName),
  user: GithubEmulatorUser,
  authorAssociation: Schema.String,
  createdAt: Timestamp,
  updatedAt: Timestamp,
  closedAt: Schema.NullOr(Timestamp)
})

export type GithubEmulatorSeedIssue = typeof GithubEmulatorSeedIssue.Type

/** A stored issue: a seeded one, or one created through the recorded create flow. */
export const GithubEmulatorIssue = Schema.Struct({
  ...GithubEmulatorSeedIssue.fields,
  /** Created here (only such issues are renamed or closed). */
  createdHere: Schema.Boolean
})

export type GithubEmulatorIssue = typeof GithubEmulatorIssue.Type

/** A comment created here on an issue. */
export const GithubEmulatorComment = Schema.Struct({
  id: PositiveInt,
  issueNumber: IssueNumber,
  body: Schema.String,
  user: GithubEmulatorUser,
  authorAssociation: Schema.String,
  createdAt: Timestamp,
  updatedAt: Timestamp
})

export type GithubEmulatorComment = typeof GithubEmulatorComment.Type

/** A UTF-8 text file in the default branch. */
export const GithubEmulatorFile = Schema.Struct({
  path: Schema.String.check(Schema.isPattern(githubFilePathPattern), Schema.isMaxLength(200)),
  /** The blob sha (40 lower-case hex digits). */
  sha: Schema.String.check(Schema.isPattern(/^[0-9a-f]{40}$/)),
  text: Schema.String
})

export type GithubEmulatorFile = typeof GithubEmulatorFile.Type

const Counters = Schema.Struct({
  /** The number the next created issue takes. */
  nextIssueNumber: IssueNumber,
  /** The id the next created comment takes. */
  nextCommentId: PositiveInt
})

/** The whole emulator state (JSON-compatible; what `snapshot()` returns). */
export const GithubEmulatorStateSchema = Schema.Struct({
  /** The authenticated user: the author of everything created here. */
  viewer: GithubEmulatorUser,
  repository: GithubEmulatorRepository,
  labels: Schema.Array(GithubEmulatorLabel),
  issues: Schema.Array(GithubEmulatorIssue),
  comments: Schema.Array(GithubEmulatorComment),
  /** Ids of comments deleted here (a second delete answers the recorded 404). */
  deletedComments: Schema.Array(PositiveInt),
  files: Schema.Array(GithubEmulatorFile),
  counters: Counters
})

/**
 * The emulator state. The container is mutable (routes replace whole lists); every entity is
 * replaced, never edited in place.
 */
export type GithubEmulatorState = {
  viewer: GithubEmulatorUser
  repository: GithubEmulatorRepository
  labels: ReadonlyArray<GithubEmulatorLabel>
  issues: ReadonlyArray<GithubEmulatorIssue>
  comments: ReadonlyArray<GithubEmulatorComment>
  deletedComments: ReadonlyArray<number>
  files: ReadonlyArray<GithubEmulatorFile>
  counters: typeof Counters.Type
}

/** Account-variance profiles for the default seed. */
export const GithubEmulatorProfile = Schema.Literals(['default', 'empty'])

export type GithubEmulatorProfile = typeof GithubEmulatorProfile.Type

/**
 * A typed seed. Start from `profile` (default `'default'`, the fixture entities); every other key,
 * when given, replaces that part of the profile. Counters default to the profile's, raised above
 * the highest seeded issue number; a counter given at or below a seeded value is invalid.
 */
export const GithubEmulatorSeed = Schema.Struct({
  profile: Schema.optionalKey(GithubEmulatorProfile),
  viewer: Schema.optionalKey(GithubEmulatorUser),
  repository: Schema.optionalKey(GithubEmulatorRepository),
  labels: Schema.optionalKey(Schema.Array(GithubEmulatorLabel)),
  issues: Schema.optionalKey(Schema.Array(GithubEmulatorSeedIssue)),
  files: Schema.optionalKey(Schema.Array(GithubEmulatorFile)),
  nextIssueNumber: Schema.optionalKey(IssueNumber),
  nextCommentId: Schema.optionalKey(PositiveInt)
})

export type GithubEmulatorSeed = typeof GithubEmulatorSeed.Type

const strict = { onExcessProperty: 'error' } as const

const decodeSeedInput = Schema.decodeUnknownResult(GithubEmulatorSeed, strict)

const decodeStateInput = Schema.decodeUnknownResult(GithubEmulatorStateSchema, strict)

const issueMessage = (issue: Schema.SchemaError['issue']): string =>
  new Schema.SchemaError(issue).message

/** Minted issue `id` values: `3000000000 + number`, as the fixtures write them. */
export const mintedIssueIdBase = 3_000_000_000

export const mintedIssueNodeId = (number: number): string => `I_kwSynthetic${number}`

export const mintedCommentNodeId = (id: number): string => `IC_kwSynthetic${id}`

// Default entities, copied from the fixtures: the user, the practice repository (the paging
// fixture's repository id, the contents fixture's branch), the five labels of the paging fixture,
// the work issue of the label fixture, and the text file of the contents fixture.

const seededAt = '2026-09-30T12:00:00Z'

const defaultViewer: GithubEmulatorUser = {
  login: 'yolk-synthetic-bot',
  id: 1000001,
  type: 'User',
  siteAdmin: false
}

const defaultRepository: GithubEmulatorRepository = {
  owner: 'yolk-synthetic',
  repo: 'conformance-practice',
  id: 100000001,
  defaultBranch: 'main'
}

const label = (id: number, name: string, color: string): GithubEmulatorLabel => ({
  id,
  nodeId: `LA_kwSynthetic${id}`,
  name,
  color,
  default: false,
  description: `Synthetic ${name} label`
})

const defaultLabels: ReadonlyArray<GithubEmulatorLabel> = [
  label(700000001, 'bug', 'd73a4a'),
  label(700000002, 'documentation', '0075ca'),
  label(700000003, 'enhancement', 'a2eeef'),
  label(700000004, 'question', 'd876e3'),
  label(700000005, 'synthetic-conformance', 'ededed')
]

const workIssue: GithubEmulatorSeedIssue = {
  number: 1,
  id: mintedIssueIdBase + 1,
  nodeId: mintedIssueNodeId(1),
  title: 'Synthetic work issue for conformance runs',
  body: 'Synthetic work issue: conformance cases add and remove a label and a comment here.',
  state: 'open',
  stateReason: null,
  labels: ['bug'],
  user: defaultViewer,
  authorAssociation: 'OWNER',
  createdAt: seededAt,
  updatedAt: seededAt,
  closedAt: null
}

const notesFile: GithubEmulatorFile = {
  path: 'docs/synthetic-notes.txt',
  sha: '5f1c0ffee5f1c0ffee5f1c0ffee5f1c0ffee0001',
  text: 'Synthetic conformance notes for the practice repository: café, naïve, façade.\nSecond synthetic line.\n'
}

type ProfileParts = {
  readonly viewer: GithubEmulatorUser
  readonly repository: GithubEmulatorRepository
  readonly labels: ReadonlyArray<GithubEmulatorLabel>
  readonly issues: ReadonlyArray<GithubEmulatorSeedIssue>
  readonly files: ReadonlyArray<GithubEmulatorFile>
  readonly counters: typeof Counters.Type
}

const profileParts = (profile: GithubEmulatorProfile): ProfileParts =>
  profile === 'default'
    ? {
        viewer: defaultViewer,
        repository: defaultRepository,
        labels: defaultLabels,
        issues: [workIssue],
        files: [notesFile],
        // The lifecycle fixture's created issue and the comment fixture's created comment.
        counters: { nextIssueNumber: 42, nextCommentId: 9000000001 }
      }
    : {
        viewer: defaultViewer,
        repository: defaultRepository,
        labels: [],
        issues: [],
        files: [],
        counters: { nextIssueNumber: 1, nextCommentId: 1 }
      }

const duplicate = <A>(values: ReadonlyArray<A>): A | undefined =>
  values.find((value, index) => values.indexOf(value) !== index)

/** Integrity problems a decoded seed can still have (duplicates, dangling or minted values). */
const seedProblem = (parts: ProfileParts): string | undefined => {
  const duplicates: ReadonlyArray<readonly [string, unknown]> = [
    ['label name', duplicate(parts.labels.map(entry => entry.name))],
    ['label id', duplicate(parts.labels.map(entry => entry.id))],
    ['issue number', duplicate(parts.issues.map(issue => issue.number))],
    ['issue id', duplicate(parts.issues.map(issue => issue.id))],
    ['issue node id', duplicate(parts.issues.map(issue => issue.nodeId))],
    ['file path', duplicate(parts.files.map(file => file.path))]
  ]

  for (const [kind, value] of duplicates) {
    if (value !== undefined) return `duplicate ${kind} ${String(value)}`
  }

  const labelNames = new Set(parts.labels.map(entry => entry.name))

  for (const issue of parts.issues) {
    const missing = issue.labels.find(name => !labelNames.has(name))

    if (missing !== undefined) return `issue ${issue.number} names missing label ${missing}`

    if (duplicate(issue.labels) !== undefined) return `issue ${issue.number} repeats a label`

    if (issue.number >= parts.counters.nextIssueNumber) {
      return `nextIssueNumber must lie above seeded issue ${issue.number}`
    }

    // Minted ids never collide with seeded ones.
    const mintedNumber = /^I_kwSynthetic(\d+)$/.exec(issue.nodeId)?.[1]

    if (
      issue.id >= mintedIssueIdBase + parts.counters.nextIssueNumber ||
      (mintedNumber !== undefined && Number(mintedNumber) >= parts.counters.nextIssueNumber)
    ) {
      return `issue ${issue.number} uses an id in the minted form at or above nextIssueNumber`
    }
  }

  const prefix = parts.files.find(file =>
    parts.files.some(other => other.path.startsWith(`${file.path}/`))
  )

  return prefix === undefined ? undefined : `file ${prefix.path} is also a folder`
}

/** Build the emulator state for a decoded seed; a string is an integrity problem. */
const stateFromSeed = (seed: GithubEmulatorSeed): GithubEmulatorState | string => {
  const profile = profileParts(seed.profile ?? 'default')
  const issues = seed.issues ?? profile.issues
  const highest = Math.max(0, ...issues.map(issue => issue.number))

  const parts: ProfileParts = {
    viewer: seed.viewer ?? profile.viewer,
    repository: seed.repository ?? profile.repository,
    labels: seed.labels ?? profile.labels,
    issues,
    files: seed.files ?? profile.files,
    counters: {
      // Raised above the seeded numbers unless the seed names the counter itself (then checked).
      nextIssueNumber:
        seed.nextIssueNumber ?? Math.max(profile.counters.nextIssueNumber, highest + 1),
      nextCommentId: seed.nextCommentId ?? profile.counters.nextCommentId
    }
  }

  const problem = seedProblem(parts)

  return (
    problem ?? {
      viewer: parts.viewer,
      repository: parts.repository,
      labels: parts.labels,
      issues: parts.issues.map(issue => ({ ...issue, createdHere: false })),
      comments: [],
      deletedComments: [],
      files: parts.files,
      counters: parts.counters
    }
  )
}

/** Decode and build a seed; a string is the reason it is invalid. */
export const buildSeedState = (input: unknown): GithubEmulatorState | string => {
  const decoded = decodeSeedInput(input)

  return Result.isFailure(decoded)
    ? issueMessage(decoded.failure.issue)
    : stateFromSeed(decoded.success)
}

/** Decode a full state (a restored snapshot); a string is the reason it is invalid. */
export const decodeState = (input: unknown): GithubEmulatorState | string => {
  const decoded = decodeStateInput(input)

  return Result.isFailure(decoded) ? issueMessage(decoded.failure.issue) : { ...decoded.success }
}
