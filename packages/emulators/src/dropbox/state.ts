/**
 * Dropbox emulator state: the typed entries, deleted-entry records, the seed input, the default
 * seed, and the profiles (internal; re-exported by `src/dropbox.ts`).
 *
 * Entry shapes and the default entries follow the synthetic Dropbox conformance fixtures, copied
 * as data (the same paths, ids, revs, sizes, content hashes, and timestamps as the fixtures and
 * `dropboxConformanceFixtureSeeds`), never imported from SDK code. The parent folders the seeded
 * paths need (`/Conformance`, `/Conformance/Paging`, `/Conformance/Search`, `/Conformance/Work`)
 * are `implied`: no fixture shows their metadata, so they hold paths together but any answer that
 * would render one is not emulated.
 *
 * Minted values never repeat seeded ones: the id and rev counters start above the highest seeded
 * id (`id:SyntheticEntryNNNNNNNN`) and rev (`a1b2c3d4e5f6NNNN`) in the minted form.
 *
 * @experimental
 */
import { Predicate, Result } from 'effect'
import * as Schema from 'effect/Schema'

/** A Dropbox revision: lower-case hex, at least nine digits (what the connector accepts). */
const Rev = Schema.String.check(Schema.isPattern(/^[0-9a-f]{9,}$/))

/** A Dropbox file or folder id (`id:` form). */
const EntryId = Schema.String.check(Schema.isPattern(/^id:\S+$/))

/** A Dropbox timestamp as the fixtures write it (`2026-09-20T10:00:00Z`). */
const Timestamp = Schema.String.check(Schema.isPattern(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/))

/** One path component: non-empty, no `/`, not `.` or `..`. */
const EntryName = Schema.String.check(
  Schema.makeFilter(name =>
    name.length > 0 && !name.includes('/') && name !== '.' && name !== '..'
      ? true
      : 'an entry name is one non-empty path component'
  )
)

/** File fields (absent on folders). */
export const DropboxEmulatorFile = Schema.Struct({
  rev: Rev,
  size: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  contentHash: Schema.String,
  clientModified: Timestamp,
  serverModified: Timestamp
})

export type DropboxEmulatorFile = typeof DropboxEmulatorFile.Type

/** A stored file or folder. Its path is its parents' names and its own, in stored casing. */
export const DropboxEmulatorEntry = Schema.Struct({
  id: EntryId,
  /** Parent folder id; `null` in the root folder. */
  parentId: Schema.NullOr(EntryId),
  name: EntryName,
  /** `null` for a folder. */
  file: Schema.NullOr(DropboxEmulatorFile),
  /**
   * `true` for an entry no fixture shows, held only because a seeded path needs it: lookups pass
   * through it, but an answer that would render it is not emulated.
   */
  implied: Schema.Boolean
})

export type DropboxEmulatorEntry = typeof DropboxEmulatorEntry.Type

/**
 * What Dropbox keeps of a deleted entry (`include_deleted` lookups answer it): its name and paths
 * as they were. `delete_v2` records one only for an empty folder, the only delete whose
 * `include_deleted` answer a fixture records.
 */
export const DropboxEmulatorDeleted = Schema.Struct({
  name: EntryName,
  pathLower: Schema.String,
  pathDisplay: Schema.String
})

export type DropboxEmulatorDeleted = typeof DropboxEmulatorDeleted.Type

const Counter = Schema.Int.check(Schema.isGreaterThanOrEqualTo(1))

const Counters = Schema.Struct({
  /** Next number in created entry ids (`id:SyntheticEntry00000001`). */
  nextIdNumber: Counter,
  /** Next number in minted revs (`a1b2c3d4e5f60101`). */
  nextRevNumber: Counter
})

/** The whole emulator state (JSON-compatible; what `snapshot()` returns). */
export const DropboxEmulatorStateSchema = Schema.Struct({
  entries: Schema.Array(DropboxEmulatorEntry),
  deleted: Schema.Array(DropboxEmulatorDeleted),
  counters: Counters
})

/**
 * The emulator state. The container is mutable (routes replace whole lists); every entity is
 * replaced, never edited in place.
 */
export type DropboxEmulatorState = {
  entries: ReadonlyArray<DropboxEmulatorEntry>
  deleted: ReadonlyArray<DropboxEmulatorDeleted>
  counters: typeof Counters.Type
}

/** An absolute path in display casing: `/`-separated non-empty components, no trailing `/`. */
const SeedPath = Schema.String.check(Schema.isPattern(/^(?:\/[^/]+)+$/))

/**
 * A seeded entry, addressed by its display path (its parent folder must be seeded too). File
 * fields default to synthetic values; a folder takes none.
 */
export const DropboxEmulatorEntrySeed = Schema.Struct({
  path: SeedPath,
  id: EntryId,
  kind: Schema.Literals(['file', 'folder']),
  rev: Schema.optionalKey(Rev),
  size: Schema.optionalKey(Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))),
  contentHash: Schema.optionalKey(Schema.String),
  clientModified: Schema.optionalKey(Timestamp),
  serverModified: Schema.optionalKey(Timestamp),
  /** An entry no fixture shows (default `false`); see `DropboxEmulatorEntry.implied`. */
  implied: Schema.optionalKey(Schema.Boolean)
})

export type DropboxEmulatorEntrySeed = typeof DropboxEmulatorEntrySeed.Type

/** Account-variance profiles for the default seed. */
export const DropboxEmulatorProfile = Schema.Literals(['default', 'empty'])

export type DropboxEmulatorProfile = typeof DropboxEmulatorProfile.Type

/**
 * A typed seed. Start from `profile` (default `'default'`, the fixture entries); `entries` and
 * `deleted`, when given, replace that part of the profile.
 */
export const DropboxEmulatorSeed = Schema.Struct({
  profile: Schema.optionalKey(DropboxEmulatorProfile),
  entries: Schema.optionalKey(Schema.Array(DropboxEmulatorEntrySeed)),
  deleted: Schema.optionalKey(Schema.Array(DropboxEmulatorDeleted))
})

export type DropboxEmulatorSeed = typeof DropboxEmulatorSeed.Type

const strict = { onExcessProperty: 'error' } as const

const decodeSeedInput = Schema.decodeUnknownResult(DropboxEmulatorSeed, strict)

const decodeStateInput = Schema.decodeUnknownResult(DropboxEmulatorStateSchema, strict)

const issueMessage = (issue: Schema.SchemaError['issue']): string =>
  new Schema.SchemaError(issue).message

/** A synthetic 64-digit content hash ending in `suffix`, as the fixtures write them. */
export const syntheticContentHash = (suffix: string): string => suffix.padStart(64, '0')

// Default entries. Fixture-derived: every file, the `paging-two` folder, and every path, id, rev,
// size, content hash, and timestamp of them. Implied (never rendered): the `/Conformance`,
// `/Conformance/Paging`, `/Conformance/Search`, and `/Conformance/Work` folders.

const file = (
  path: string,
  id: string,
  revSuffix: string,
  size: number,
  hashSuffix: string,
  clientModified: string,
  serverModified: string = clientModified
): DropboxEmulatorEntrySeed => ({
  path,
  id,
  kind: 'file',
  rev: `a1b2c3d4e5f6${revSuffix}`,
  size,
  contentHash: syntheticContentHash(hashSuffix),
  clientModified,
  serverModified
})

const folder = (path: string, id: string): DropboxEmulatorEntrySeed => ({
  path,
  id,
  kind: 'folder'
})

/** A parent folder no fixture shows. */
const impliedFolder = (path: string, id: string): DropboxEmulatorEntrySeed => ({
  ...folder(path, id),
  implied: true
})

const defaultEntries: ReadonlyArray<DropboxEmulatorEntrySeed> = [
  impliedFolder('/Conformance', 'id:SyntheticConformanceFolder'),
  impliedFolder('/Conformance/Paging', 'id:SyntheticPagingFolder0000'),
  file(
    '/Conformance/Paging/paging-one.txt',
    'id:SyntheticPagingFile0001',
    '0001',
    12,
    '1',
    '2026-09-20T10:00:00Z'
  ),
  folder('/Conformance/Paging/paging-two', 'id:SyntheticPagingFolder0002'),
  file(
    '/Conformance/Paging/paging-three.txt',
    'id:SyntheticPagingFile0003',
    '0003',
    14,
    '3',
    '2026-09-20T10:05:00Z'
  ),
  file(
    '/Conformance/Mixed Case Notes.txt',
    'id:SyntheticMixedCaseFile01',
    '0010',
    20,
    '10',
    '2026-09-20T11:00:00Z'
  ),
  impliedFolder('/Conformance/Search', 'id:SyntheticSearchFolder0000'),
  file(
    '/Conformance/Search/yolk-search-probe-1.txt',
    'id:SyntheticSearchFile0001',
    '0021',
    16,
    '21',
    '2026-09-20T12:00:00Z'
  ),
  file(
    '/Conformance/Search/yolk-search-probe-2.txt',
    'id:SyntheticSearchFile0002',
    '0022',
    16,
    '22',
    '2026-09-20T12:00:00Z'
  ),
  impliedFolder('/Conformance/Work', 'id:SyntheticWorkFolder00000'),
  file(
    '/Conformance/copy-source.txt',
    'id:SyntheticCopySource001',
    '0030',
    42,
    '42',
    '2026-09-20T13:00:00Z',
    '2026-09-29T13:00:00Z'
  )
]

const profileEntries = (
  profile: DropboxEmulatorProfile
): ReadonlyArray<DropboxEmulatorEntrySeed> => (profile === 'default' ? defaultEntries : [])

const defaultTimestamp = '2026-09-20T10:00:00Z'

/** The form of minted ids (`id:SyntheticEntry00000001`) and revs (`a1b2c3d4e5f60101`). */
const mintedIdPattern = /^id:SyntheticEntry(\d+)$/

const mintedRevPattern = /^a1b2c3d4e5f6(\d+)$/

/** The highest number among `values` in a minted form (0 when none is). */
const highestMinted = (values: ReadonlyArray<string>, pattern: RegExp): number =>
  Math.max(0, ...values.map(value => Number(pattern.exec(value)?.[1] ?? 0)))

const duplicate = (values: ReadonlyArray<string>): string | undefined =>
  values.find((value, index) => values.indexOf(value) !== index)

const parentPath = (path: string): string => path.slice(0, path.lastIndexOf('/'))

const lastName = (path: string): string => path.slice(path.lastIndexOf('/') + 1)

/** Build the emulator state for a decoded seed; a string is an integrity problem. */
const stateFromSeed = (seed: DropboxEmulatorSeed): DropboxEmulatorState | string => {
  const seeded = seed.entries ?? profileEntries(seed.profile ?? 'default')

  const duplicates: ReadonlyArray<readonly [string, string | undefined]> = [
    ['entry id', duplicate(seeded.map(entry => entry.id))],
    ['entry path', duplicate(seeded.map(entry => entry.path.toLowerCase()))]
  ]

  for (const [label, value] of duplicates) {
    if (value !== undefined) return `duplicate ${label} ${value}`
  }

  const byPath = new Map(seeded.map(entry => [entry.path.toLowerCase(), entry]))
  const entries: Array<DropboxEmulatorEntry> = []

  for (const entry of seeded) {
    const name = lastName(entry.path)

    if (name === '.' || name === '..') return `entry ${entry.id} has an invalid path`

    const parent = parentPath(entry.path)
    const parentEntry = parent === '' ? undefined : byPath.get(parent.toLowerCase())

    if (parent !== '' && (parentEntry === undefined || parentEntry.kind !== 'folder')) {
      return `entry ${entry.path} needs a seeded parent folder ${parent}`
    }

    const hasFileFields = [
      entry.rev,
      entry.size,
      entry.contentHash,
      entry.clientModified,
      entry.serverModified
    ].some(Predicate.isNotUndefined)

    if (entry.kind === 'folder' && hasFileFields) {
      return `folder ${entry.path} cannot take file fields`
    }

    const clientModified = entry.clientModified ?? defaultTimestamp

    entries.push({
      id: entry.id,
      parentId: parentEntry?.id ?? null,
      name,
      implied: entry.implied ?? false,
      file:
        entry.kind === 'folder'
          ? null
          : {
              rev: entry.rev ?? 'a1b2c3d4e5f60000',
              size: entry.size ?? 0,
              contentHash: entry.contentHash ?? syntheticContentHash('0'),
              clientModified,
              serverModified: entry.serverModified ?? clientModified
            }
    })
  }

  return {
    entries,
    deleted: seed.deleted ?? [],
    counters: {
      nextIdNumber:
        highestMinted(
          entries.map(entry => entry.id),
          mintedIdPattern
        ) + 1,
      nextRevNumber: Math.max(
        101,
        highestMinted(
          entries.flatMap(entry => entry.file?.rev ?? []),
          mintedRevPattern
        ) + 1
      )
    }
  }
}

/** Decode and build a seed; a string is the reason it is invalid. */
export const buildSeedState = (input: unknown): DropboxEmulatorState | string => {
  const decoded = decodeSeedInput(input)

  return Result.isFailure(decoded)
    ? issueMessage(decoded.failure.issue)
    : stateFromSeed(decoded.success)
}

/** Decode a full state (a restored snapshot); a string is the reason it is invalid. */
export const decodeState = (input: unknown): DropboxEmulatorState | string => {
  const decoded = decodeStateInput(input)

  return Result.isFailure(decoded) ? issueMessage(decoded.failure.issue) : { ...decoded.success }
}
