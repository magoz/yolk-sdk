/**
 * Dropbox conformance runner for a practice Dropbox account (`pnpm conformance:dropbox`).
 *
 * Default: DRY RUN. Prints every case id, its safety, and whether it would run under the chosen
 * flags, then exits without any network call or credential read.
 *
 * `--live --owner-approved --account <label>`: runs the cases against the real Dropbox API with a
 * `FetchHttpClient`, through the real connector actions and the host-only upload helpers. Refused
 * whenever `CI` is non-empty and without `--owner-approved`. Requires `DROPBOX_ACCESS_TOKEN`
 * (environment only, never a flag; a token for the practice account with `files.metadata.read` and
 * `files.content.write`) and the seed paths of every case that will run (flags or environment, see
 * the usage text). Read cases always run; `--allow-writes reversible` adds the write-reversible
 * cases, which work inside their own `yolk-conformance-<runId>-*` folder under `--work-folder`. The
 * runner generates a fresh random `runId` for every invocation (it is never a flag), so concurrent
 * runs never share a folder; a definitive create rejection deletes nothing, and an ambiguous create
 * is reported with the exact path to check by hand. There are no write-irreversible Dropbox cases.
 *
 * `--record` (with `--live`) stages verified recordings all or nothing in a new run directory
 * under the gitignored `.conformance-recordings/dropbox/`; the recorder keeps `dropbox-api-arg` so
 * upload recordings show their mode. Promotion is manual: scrub the staged files of practice-account
 * data (file and folder names, paths, ids, revs, content hashes), copy them into
 * `packages/connectors/src/dropbox/conformance/`, run `pnpm format:fix`, and update
 * `packages/connectors/test/dropbox-conformance.test.ts` and
 * `scripts/test/run-dropbox-conformance.test.ts` in the same change. See
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
  DropboxConformanceConfig,
  DropboxConformanceSeeds,
  dropboxConformanceCases,
  dropboxConformanceFixtureSeeds,
  type DropboxConformanceError,
  type DropboxConformanceRequirements,
  type DropboxConformanceSeedKey
} from '../packages/connectors/src/dropbox/conformance/index.ts'
import { dropboxApiBaseUrl } from '../packages/connectors/src/dropbox/index.ts'
import {
  recordingsRootFor,
  runConnectorConformanceCli,
  type CaseSpec,
  type ConnectorConformanceRunner,
  type SeedSource
} from './connector-conformance-internal.ts'

/** Where each seed path comes from. Flags win over environment variables. */
export const dropboxSeedSources: ReadonlyArray<SeedSource<DropboxConformanceSeedKey>> = [
  {
    key: 'pagingFolderPath',
    flag: '--paging-folder',
    env: 'DROPBOX_CONFORMANCE_PAGING_FOLDER',
    description: 'folder holding more than two entries'
  },
  {
    key: 'mixedCasePath',
    flag: '--mixed-case-path',
    env: 'DROPBOX_CONFORMANCE_MIXED_CASE_PATH',
    description: 'existing entry with upper-case letters in its last component'
  },
  {
    key: 'searchQuery',
    flag: '--search-query',
    env: 'DROPBOX_CONFORMANCE_SEARCH_QUERY',
    description: 'query matching at least two entries by file name'
  },
  {
    key: 'workFolderPath',
    flag: '--work-folder',
    env: 'DROPBOX_CONFORMANCE_WORK_FOLDER',
    description: 'existing folder the cases create their own folders under'
  },
  {
    key: 'copySourcePath',
    flag: '--copy-source',
    env: 'DROPBOX_CONFORMANCE_COPY_SOURCE',
    description: 'small file the copy/move case copies'
  }
]

/** Seeds each case needs, and the fixture module `--record` rewrites for it. */
export const dropboxCaseSpecs: ReadonlyArray<CaseSpec<DropboxConformanceSeedKey>> = [
  {
    caseId: 'dropbox.files.list-folder-cursor-paging',
    seeds: ['pagingFolderPath'],
    optionalSeeds: [],
    fileName: 'list-folder-paging.ts',
    exportName: 'dropboxListFolderPagingFixture',
    doc: 'A `limit: 2` listing of the seeded paging folder, then its `list_folder/continue` pages.'
  },
  {
    caseId: 'dropbox.files.path-lower-lookup',
    seeds: ['mixedCasePath'],
    optionalSeeds: [],
    fileName: 'path-lower-lookup.ts',
    exportName: 'dropboxPathLowerLookupFixture',
    doc: '`get_metadata` of the seeded mixed-case path, then of the same path lower-cased.'
  },
  {
    caseId: 'dropbox.files.search-continue',
    seeds: ['searchQuery'],
    optionalSeeds: [],
    fileName: 'search-continue.ts',
    exportName: 'dropboxSearchContinueFixture',
    doc: 'A `max_results: 1` search, then its `search/continue_v2` page.'
  },
  {
    caseId: 'dropbox.errors.not-found-409-envelope',
    seeds: ['workFolderPath'],
    optionalSeeds: [],
    fileName: 'not-found-envelope.ts',
    exportName: 'dropboxNotFoundEnvelopeFixture',
    doc: '`get_metadata` of an absent child of the work folder: HTTP 409 `path/not_found`.'
  },
  {
    caseId: 'dropbox.files.create-folder-conflict',
    seeds: ['workFolderPath', 'runId'],
    optionalSeeds: [],
    fileName: 'create-folder-conflict.ts',
    exportName: 'dropboxCreateFolderConflictFixture',
    doc: 'Absence check, folder create, two conflicting creates, then the delete and a not-found lookup.'
  },
  {
    caseId: 'dropbox.files.delete-then-not-found',
    seeds: ['workFolderPath', 'runId'],
    optionalSeeds: [],
    fileName: 'delete-then-not-found.ts',
    exportName: 'dropboxDeleteThenNotFoundFixture',
    doc: 'Absence check, folder create, delete, then lookups without and with `include_deleted`.'
  },
  {
    caseId: 'dropbox.files.copy-move-metadata',
    seeds: ['workFolderPath', 'copySourcePath', 'runId'],
    optionalSeeds: [],
    fileName: 'copy-move-metadata.ts',
    exportName: 'dropboxCopyMoveMetadataFixture',
    doc: 'Source lookup, folder create, `copy_v2`, `move_v2`, then the delete and a not-found lookup.'
  },
  {
    caseId: 'dropbox.files.upload-rev-precondition',
    seeds: ['workFolderPath', 'runId'],
    optionalSeeds: [],
    fileName: 'upload-rev-precondition.ts',
    exportName: 'dropboxUploadRevPreconditionFixture',
    doc: 'Folder create, `add` and rev `update` uploads, two rejected uploads, the file lookup, then the delete and a not-found lookup.'
  }
]

/** A fresh invocation-unique run id (`run-<8 hex>`), so concurrent live runs never share folders. */
export const generateRunId = (): string => `run-${randomBytes(4).toString('hex')}`

/** The live credential: the practice account's bearer token. */
export const liveCredential = (accessToken: string) =>
  BearerTokenCredential.make({ token: accessToken })

const casePorts = (
  httpLayer: Layer.Layer<HttpClient.HttpClient>,
  accessToken: string,
  seeds: DropboxConformanceSeeds
) =>
  Layer.mergeAll(
    connectorHttpClientsFromEffectHttpClientLayer.pipe(Layer.provide(httpLayer)),
    staticCredentialResolverLayer(liveCredential(accessToken)),
    Layer.succeed(DropboxConformanceConfig, seeds)
  )

export const dropboxRunner = {
  provider: 'dropbox',
  displayName: 'Dropbox',
  practiceTarget: 'a practice Dropbox account',
  tokenEnv: 'DROPBOX_ACCESS_TOKEN',
  tokenScopes: 'a token for the practice account with files.metadata.read and files.content.write',
  endpoint: dropboxApiBaseUrl,
  writeNote:
    'work inside their own yolk-conformance-<run id> folder under --work-folder (a fresh random run id per invocation) and delete it again',
  cases: dropboxConformanceCases,
  seedSources: dropboxSeedSources,
  generatedSeeds: { keys: ['runId'], generate: () => ({ runId: generateRunId() }) },
  caseSpecs: dropboxCaseSpecs,
  fixtureSeeds: dropboxConformanceFixtureSeeds,
  seedNoun: 'paths',
  seedsTypeName: 'DropboxConformanceSeeds',
  seedsExportName: 'dropboxConformanceFixtureSeeds',
  configName: 'DropboxConformanceConfig',
  decodeSeeds: Schema.decodeUnknownOption(DropboxConformanceSeeds),
  invalidSeedsMessage:
    'Seed paths must be absolute Dropbox paths (for example /Conformance/Work, no trailing slash), and --search-query a non-empty trimmed value',
  casePorts,
  // Upload recordings keep their mode and path argument (review it: it names practice paths).
  recordedRequestHeaders: ['dropbox-api-arg'],
  nameKeys: /^(?:name|path_lower|path_display|path|from_path|to_path|query|highlight_str)$/,
  textKeys: /^(?:content|text)$/
} satisfies ConnectorConformanceRunner<
  DropboxConformanceSeedKey,
  DropboxConformanceSeeds,
  DropboxConformanceError,
  DropboxConformanceRequirements
>

/** Gitignored root of staged Dropbox recordings. */
export const recordingsRoot = recordingsRootFor(dropboxRunner.provider)

const invokedAsCli = (): boolean => {
  const invoked = process.argv[1]

  return invoked !== undefined && resolve(invoked) === fileURLToPath(import.meta.url)
}

if (invokedAsCli()) {
  runConnectorConformanceCli(dropboxRunner)
}
