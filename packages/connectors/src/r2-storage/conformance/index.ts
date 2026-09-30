/**
 * Cloudflare R2 conformance cases for `@yolk-sdk/conformance/runner`, the `PortFixture`s that back
 * their replay, and the plain-JSON backend bridge to the host R2 ports.
 *
 * The connector never talks to R2 itself: the cases run the real `r2_storage.upload_url` action
 * over the host `R2Presigner` and the host-only `getR2Object` / `createR2Object` /
 * `updateR2Object` over the host `R2ObjectClient`. `r2PortsLayerFromBackend` turns any plain-JSON
 * backend into both ports: `makeR2ReplayBackend` over these fixtures, or a structural fake. Live
 * verification needs a host implementation of both ports connected to a practice bucket (the
 * connectors package ships no SigV4 signer or S3 client); no live runner ships here.
 *
 * The current fixtures are synthetic placeholders (no `observed`, so `unverified`). Presigned URLs
 * in them carry only `r2ConformanceSyntheticSignature` and `r2ConformanceSyntheticCredential`,
 * the exact SigV4 entries of the shared, frozen `syntheticPortCredentialParams`. Run both `scanPortFixtureForSecrets` and
 * `findR2PortFixtureSecrets` (escaped and percent-encoded parameters, exact placeholders) on every
 * fixture; `scrubR2PortFixture` rewrites a fixture recorded from a live host, except escaped URLs,
 * before a person promotes it.
 *
 * @experimental
 */
import type { PortFixture } from '@yolk-sdk/conformance/fixture'
import { r2CreateIfAbsentFixtures } from './create-if-absent.ts'
import { r2GetExpectedEtagFixtures } from './get-expected-etag.ts'
import { r2GetMaxBytesFixtures } from './get-max-bytes.ts'
import { r2GetMissingFixtures } from './get-missing.ts'
import { r2PresignUploadUrlFixtures } from './presign-upload-url.ts'
import { r2UpdateIfMatchFixtures } from './update-if-match.ts'

export {
  R2ConformanceActionFailed,
  R2ConformanceConfig,
  R2ConformanceSeeds,
  r2ConformanceCases,
  r2ConformanceCredentialRefs,
  r2ConformanceIntegration,
  r2ConformanceMarker,
  r2ConformancePublicUrl,
  r2CreateIfAbsentCase,
  r2GetExpectedEtagCase,
  r2GetMaxBytesCase,
  r2GetMissingCase,
  r2PresignUploadUrlCase,
  r2UpdateIfMatchCase,
  type R2ConformanceCase,
  type R2ConformanceError,
  type R2ConformanceRequirements,
  type R2ConformanceSeedKey,
  type R2ObservedCall
} from './cases.ts'

export {
  findR2PortFixtureSecrets,
  makeR2ReplayBackend,
  r2BytesToBase64,
  r2ConformanceSyntheticAccessKeyId,
  r2ConformanceSyntheticCredential,
  r2ConformanceSyntheticSignature,
  r2GetRequestJson,
  r2ObjectClientPortName,
  r2PortsFromBackend,
  r2PortsLayerFromBackend,
  r2PresignRequestJson,
  r2PresignerPortName,
  r2PutRequestJson,
  scrubR2PortFixture,
  scrubR2PresignedUrl,
  type R2Backend,
  type R2BackendReply,
  type R2Ports,
  type R2Replay,
  type R2ReplayLedgerEntry
} from './backend.ts'

export { r2ConformanceFixtureSeeds } from './seeds.ts'

export {
  r2CreateIfAbsentFixtures,
  r2GetExpectedEtagFixtures,
  r2GetMaxBytesFixtures,
  r2GetMissingFixtures,
  r2PresignUploadUrlFixtures,
  r2UpdateIfMatchFixtures
}

/** Every R2 `PortFixture`, in case order, for replaying the whole suite at once. */
export const r2ConformanceFixtures: ReadonlyArray<PortFixture> = [
  ...r2PresignUploadUrlFixtures,
  ...r2GetMaxBytesFixtures,
  ...r2GetExpectedEtagFixtures,
  ...r2GetMissingFixtures,
  ...r2CreateIfAbsentFixtures,
  ...r2UpdateIfMatchFixtures
]
