/**
 * Kie conformance runner for a practice Kie account (`pnpm conformance:kie`).
 *
 * Default: DRY RUN. Prints every case id, its safety, and whether it would run under the chosen
 * flags, then exits without any network call or credential read.
 *
 * `--live --owner-approved --account <label>`: runs the cases against the real Kie Market API with
 * a `FetchHttpClient`, through the real connector actions. Refused whenever `CI` is non-empty and
 * without `--owner-approved`. Requires `KIE_API_KEY` (environment only, never a flag; refused
 * before any request unless it has 16 to 256 letters, digits, `_`, or `-`, and never printed: every
 * printed line is redacted of it, and `--record` refuses to stage a recording carrying it; the
 * recorder never keeps `authorization`, the only header that carries it) and the seeds of every
 * case that will run (flags or environment, see the usage text). The four read cases always run
 * and spend no credits. There are no write-reversible Kie cases. The two create cases,
 * `kie.tasks.create-image-task` and `kie.tasks.create-video-task`, are write-irreversible: each
 * submits a real task that spends Kie credits and that the connector cannot cancel, so each runs
 * only when named with `--allow-irreversible <its exact id>` (`--allow-writes` never starts one).
 * Their prompts name a fresh random `runId` the runner generates per invocation (never a flag); an
 * ambiguous create is reported with the run id to look for in the Kie task log. There is no
 * leftover lookup: the connector reads no task listing, and nothing is ever cleaned up.
 *
 * `--record` (with `--live`) stages verified recordings all or nothing in a new run directory
 * under the gitignored `.conformance-recordings/kie/`. Promotion is manual: replace each recorded
 * 2xx body wholesale with a minimal synthetic body that keeps only the keys and types the case
 * reads (task ids, result URLs, prompts, and failure messages become synthetic, `example.com`
 * values), replace the seeded task ids and first-frame URL in requests and `seeds.ts` the same
 * way, copy the files into `packages/connectors/src/kie/conformance/`, run `pnpm format:fix`, and
 * update `packages/connectors/test/kie-conformance.test.ts` (whose allowlist refuses any value
 * outside its synthetic vocabulary) and `scripts/test/run-kie-conformance.test.ts` in the same
 * change, together with the Kie emulator (`@yolk-sdk/emulators/kie`: its default seed and error
 * bodies, the routes' `kieEmulatorRoutes` evidence and `observedAt`, and its
 * `scripts/emulator-evidence-pending.json` entry). See `connector-conformance-internal.ts` for the
 * shared gates.
 *
 * Never run live in CI.
 */
import { randomBytes } from 'node:crypto'
import { resolve } from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'
import { Layer } from 'effect'
import * as Schema from 'effect/Schema'
import type { HttpClient } from 'effect/http'
import {
  connectorHttpClientsFromEffectHttpClientLayer,
  staticCredentialResolverLayer
} from '../packages/connectors/src/conformance/index.ts'
import { ApiKeyCredential } from '../packages/connectors/src/credential.ts'
import {
  KieConformanceConfig,
  KieConformanceSeeds,
  kieConformanceCases,
  kieConformanceFixtureSeeds,
  type KieConformanceError,
  type KieConformanceRequirements,
  type KieConformanceSeedKey
} from '../packages/connectors/src/kie/conformance/index.ts'
import { kieApiBaseUrl } from '../packages/connectors/src/kie/index.ts'
import {
  recordingsRootFor,
  runConnectorConformanceCli,
  type CaseSpec,
  type ConnectorConformanceRunner,
  type SeedSource
} from './connector-conformance-internal.ts'

/** Environment variable holding the Kie API key (the runner's access token). */
export const kieApiKeyEnv = 'KIE_API_KEY'

/** Where each seed comes from. Flags win over environment variables. */
export const kieSeedSources: ReadonlyArray<SeedSource<KieConformanceSeedKey>> = [
  {
    key: 'successTaskId',
    flag: '--success-task-id',
    env: 'KIE_CONFORMANCE_SUCCESS_TASK_ID',
    description: 'taskId of a finished GPT Image 2 task of the practice account (state success)'
  },
  {
    key: 'failedTaskId',
    flag: '--failed-task-id',
    env: 'KIE_CONFORMANCE_FAILED_TASK_ID',
    description: 'taskId of a finished task of the practice account whose state is fail'
  },
  {
    key: 'firstFrameUrl',
    flag: '--first-frame-url',
    env: 'KIE_CONFORMANCE_FIRST_FRAME_URL',
    description: 'public https URL of a small still image Kie fetches as the first video frame'
  }
]

/** Seeds each case needs, and the fixture module `--record` rewrites for it. */
export const kieCaseSpecs: ReadonlyArray<CaseSpec<KieConformanceSeedKey>> = [
  {
    caseId: 'kie.tasks.get-success',
    seeds: ['successTaskId'],
    optionalSeeds: [],
    fileName: 'get-success-task.ts',
    exportName: 'kieGetSuccessTaskFixture',
    doc: '`kie.get_task` of the seeded finished task: one GET `recordInfo`, answered with a `success` record.'
  },
  {
    caseId: 'kie.tasks.get-failed',
    seeds: ['failedTaskId'],
    optionalSeeds: [],
    fileName: 'get-failed-task.ts',
    exportName: 'kieGetFailedTaskFixture',
    doc: '`kie.get_task` of the seeded failed task: one GET `recordInfo`, answered with a `fail` record.'
  },
  {
    caseId: 'kie.errors.task-not-found',
    seeds: [],
    optionalSeeds: [],
    fileName: 'task-not-found.ts',
    exportName: 'kieTaskNotFoundFixture',
    doc: '`kie.get_task` of a synthetic task id no account holds.'
  },
  {
    caseId: 'kie.errors.unauthorized',
    seeds: [],
    optionalSeeds: [],
    fileName: 'unauthorized.ts',
    exportName: 'kieUnauthorizedFixture',
    doc: '`kie.get_task` with a synthetic API key Kie does not know.'
  },
  {
    caseId: 'kie.tasks.create-image-task',
    seeds: ['runId'],
    optionalSeeds: [],
    fileName: 'create-image-task.ts',
    exportName: 'kieCreateImageTaskFixture',
    doc: '`kie.create_image_task` of the synthetic run-scoped prompt: one POST `createTask`.'
  },
  {
    caseId: 'kie.tasks.create-video-task',
    seeds: ['firstFrameUrl', 'runId'],
    optionalSeeds: [],
    fileName: 'create-video-task.ts',
    exportName: 'kieCreateVideoTaskFixture',
    doc: '`kie.create_video_task` of the synthetic run-scoped prompt from the seeded first frame: one POST `createTask`.'
  }
]

/** A fresh invocation-unique run id (`run-<8 hex>`), named in the create prompts. */
export const generateRunId = (): string => `run-${randomBytes(4).toString('hex')}`

/** The live credential: the practice account's API key. */
export const liveCredential = (apiKey: string) => ApiKeyCredential.make({ key: apiKey })

const casePorts = (
  httpLayer: Layer.Layer<HttpClient.HttpClient>,
  apiKey: string,
  seeds: KieConformanceSeeds
) =>
  Layer.mergeAll(
    connectorHttpClientsFromEffectHttpClientLayer.pipe(Layer.provide(httpLayer)),
    staticCredentialResolverLayer(liveCredential(apiKey)),
    Layer.succeed(KieConformanceConfig, seeds)
  )

export const kieRunner = {
  provider: 'kie',
  displayName: 'Kie',
  practiceTarget: 'a practice Kie account with a small credit balance',
  tokenEnv: kieApiKeyEnv,
  tokenScopes:
    'a Kie API key (the reads spend no credits; each create case submits a real task that spends credits)',
  tokenFormat: {
    pattern: /^[A-Za-z0-9_-]{16,256}$/,
    description: '16 to 256 letters, digits, _ or -'
  },
  endpoint: kieApiBaseUrl,
  irreversibleNote:
    'The write-irreversible kie.tasks.create-image-task and kie.tasks.create-video-task cases each submit a real task naming a fresh run id that spends Kie credits and that the connector cannot cancel; each runs only with --allow-irreversible <its exact id>',
  cases: kieConformanceCases,
  seedSources: kieSeedSources,
  generatedSeeds: { keys: ['runId'], generate: () => ({ runId: generateRunId() }) },
  caseSpecs: kieCaseSpecs,
  fixtureSeeds: kieConformanceFixtureSeeds,
  seedNoun: 'ids',
  seedsTypeName: 'KieConformanceSeeds',
  seedsExportName: 'kieConformanceFixtureSeeds',
  configName: 'KieConformanceConfig',
  decodeSeeds: Schema.decodeUnknownOption(KieConformanceSeeds),
  invalidSeedsMessage:
    '--success-task-id and --failed-task-id must be Kie task ids (letters, digits, underscores, and hyphens), and --first-frame-url a public https URL without credentials',
  casePorts,
  recordedRequestHeaders: [],
  // No cleanup exists, and there is no leftover lookup: only the Kie task log shows what was made.
  recoveryAdvice:
    'A task a create case submitted stays in the Kie account (the connector cannot cancel it): look in the Kie task log by hand for prompts starting with `yolk-conformance run-` (the run id is printed when the run starts); nothing else is created.',
  nameKeys: /^(?:taskId|first_frame_url|resultJson|resultUrls)$/,
  textKeys: /^(?:prompt|msg|failMsg)$/,
  reviewNotice: {
    heading:
      'REVIEW before promoting (staged files hold practice-account task ids, result URLs, and prompts, and this repository is public):',
    seeds:
      'the seeds name practice-account task ids and a frame URL; replace each with a synthetic value',
    promote:
      'replace each recorded 2xx body wholesale with a minimal synthetic body that keeps only the keys and types the case reads (never scrub field by field)',
    stagedFixture: 'replaced wholesale and promoted by hand',
    stagedSeeds: 'a replaced recording'
  }
} satisfies ConnectorConformanceRunner<
  KieConformanceSeedKey,
  KieConformanceSeeds,
  KieConformanceError,
  KieConformanceRequirements
>

/** Gitignored root of staged Kie recordings. */
export const recordingsRoot = recordingsRootFor(kieRunner.provider)

const invokedAsCli = (): boolean => {
  const invoked = process.argv[1]

  return invoked !== undefined && resolve(invoked) === fileURLToPath(import.meta.url)
}

if (invokedAsCli()) {
  runConnectorConformanceCli(kieRunner)
}
