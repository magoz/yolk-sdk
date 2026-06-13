import * as Schema from 'effect/Schema'

const NonEmptyTrimmedString = Schema.Trimmed.pipe(Schema.check(Schema.isNonEmpty()))
const NonNegativeInteger = Schema.Int.pipe(Schema.check(Schema.isGreaterThanOrEqualTo(0)))
const PositiveInteger = Schema.Int.pipe(Schema.check(Schema.isGreaterThan(0)))
const PositiveNumber = Schema.Number.pipe(Schema.check(Schema.isGreaterThan(0)))

export class SandboxCommandInput extends Schema.Class<SandboxCommandInput>(
  'SandboxCommandInput'
)({
  command: Schema.String,
  cwd: Schema.optional(Schema.String),
  stdin: Schema.optional(Schema.String),
  timeoutMs: Schema.optional(PositiveInteger),
  background: Schema.optional(Schema.Boolean)
}) {}

export class SandboxPreviewUrl extends Schema.Class<SandboxPreviewUrl>('SandboxPreviewUrl')({
  port: PositiveInteger,
  url: NonEmptyTrimmedString
}) {}

export class VercelSandboxState extends Schema.TaggedClass<VercelSandboxState>()(
  'Vercel',
  {
    name: NonEmptyTrimmedString,
    createdAtMs: NonNegativeInteger,
    lastUsedAtMs: NonNegativeInteger,
    expiresAtMs: NonNegativeInteger,
    maxExpiresAtMs: NonNegativeInteger
  }
) {}

export const SandboxState = Schema.Union([VercelSandboxState])
export type SandboxState = typeof SandboxState.Type

export class SandboxCommandResult extends Schema.Class<SandboxCommandResult>(
  'SandboxCommandResult'
)({
  exitCode: Schema.NullOr(Schema.Int),
  stdout: Schema.String,
  stderr: Schema.String,
  durationMs: NonNegativeInteger,
  timedOut: Schema.Boolean,
  workspaceReset: Schema.Boolean,
  backgroundId: Schema.optional(NonEmptyTrimmedString),
  previewUrls: Schema.Array(SandboxPreviewUrl),
  state: SandboxState
}) {}

export class DisposableSandboxLifecycle extends Schema.TaggedClass<DisposableSandboxLifecycle>()(
  'Disposable',
  {
    idleTtlMs: PositiveInteger,
    maxLifetimeMs: PositiveInteger
  }
) {}

export class SandboxSnapshotRetention extends Schema.Class<SandboxSnapshotRetention>(
  'SandboxSnapshotRetention'
)({
  count: PositiveInteger,
  expirationMs: Schema.optional(NonNegativeInteger),
  deleteEvicted: Schema.optional(Schema.Boolean)
}) {}

export class PersistentSandboxLifecycle extends Schema.TaggedClass<PersistentSandboxLifecycle>()(
  'Persistent',
  {
    idleTtlMs: PositiveInteger,
    snapshotExpirationMs: Schema.optional(NonNegativeInteger),
    keepLastSnapshots: Schema.optional(SandboxSnapshotRetention)
  }
) {}

export const SandboxLifecycle = Schema.Union([
  DisposableSandboxLifecycle,
  PersistentSandboxLifecycle
])
export type SandboxLifecycle = typeof SandboxLifecycle.Type

export class EmptySandboxInitialSource extends Schema.TaggedClass<EmptySandboxInitialSource>()(
  'Empty',
  {}
) {}

export class SnapshotSandboxInitialSource extends Schema.TaggedClass<SnapshotSandboxInitialSource>()(
  'Snapshot',
  {
    snapshotId: NonEmptyTrimmedString
  }
) {}

export class GitSandboxInitialSource extends Schema.TaggedClass<GitSandboxInitialSource>()(
  'Git',
  {
    url: NonEmptyTrimmedString,
    username: Schema.optional(NonEmptyTrimmedString),
    password: Schema.optional(NonEmptyTrimmedString),
    depth: Schema.optional(PositiveInteger),
    revision: Schema.optional(NonEmptyTrimmedString)
  }
) {}

export class TarballSandboxInitialSource extends Schema.TaggedClass<TarballSandboxInitialSource>()(
  'Tarball',
  {
    url: NonEmptyTrimmedString
  }
) {}

export const SandboxInitialSource = Schema.Union([
  EmptySandboxInitialSource,
  SnapshotSandboxInitialSource,
  GitSandboxInitialSource,
  TarballSandboxInitialSource
])
export type SandboxInitialSource = typeof SandboxInitialSource.Type

export class SandboxResources extends Schema.Class<SandboxResources>('SandboxResources')({
  vcpus: PositiveNumber
}) {}
