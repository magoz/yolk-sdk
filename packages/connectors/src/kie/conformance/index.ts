/**
 * Kie conformance cases for `@yolk-sdk/conformance/runner` and the wire fixtures that back their
 * replay (`@yolk-sdk/conformance/replay`).
 *
 * Every case runs the real connector actions (`kie.get_task`, `kie.create_image_task`,
 * `kie.create_video_task`) over the connector ports. The four reads need no write; the two create
 * cases are `write-irreversible` (every task spends credits and cannot be cancelled through the
 * connector) and run only when named by their exact ids. The current fixtures are synthetic
 * placeholders (`evidence: 'unverified'`) shaped like the Kie Market API wire; every task id, URL,
 * and prompt in them is synthetic (`example.com`), and they carry no API key.
 * `pnpm conformance:kie --live --owner-approved --account <label> --record` stages verified
 * recordings from a practice account in a gitignored directory; a person replaces each recorded
 * 2xx body wholesale with a minimal synthetic body and promotes them here, updating the tests
 * together with them (fixture ids, `evidence`, and `account` change).
 *
 * @experimental
 */
import type { WireFixture } from '@yolk-sdk/conformance/fixture'
import { kieCreateImageTaskFixture } from './create-image-task.ts'
import { kieCreateVideoTaskFixture } from './create-video-task.ts'
import { kieGetFailedTaskFixture } from './get-failed-task.ts'
import { kieGetSuccessTaskFixture } from './get-success-task.ts'
import { kieTaskNotFoundFixture } from './task-not-found.ts'
import { kieUnauthorizedFixture } from './unauthorized.ts'

export {
  KieConformanceActionFailed,
  KieConformanceConfig,
  KieConformanceSeeds,
  kieConformanceAbsentTaskId,
  kieConformanceCases,
  kieConformanceCredentialRef,
  kieConformanceImagePrompt,
  kieConformanceIntegration,
  kieConformanceInvalidApiKey,
  kieConformanceMarker,
  kieConformanceVideoPrompt,
  kieCreateImageTaskCase,
  kieCreateVideoTaskCase,
  kieGetFailedTaskCase,
  kieGetSuccessTaskCase,
  kieTaskNotFoundCase,
  kieUnauthorizedCase,
  type KieConformanceCase,
  type KieConformanceError,
  type KieConformanceRequirements,
  type KieConformanceSeedKey
} from './cases.ts'

export { kieConformanceFixtureSeeds } from './seeds.ts'

export {
  kieCreateImageTaskFixture,
  kieCreateVideoTaskFixture,
  kieGetFailedTaskFixture,
  kieGetSuccessTaskFixture,
  kieTaskNotFoundFixture,
  kieUnauthorizedFixture
}

/** Every Kie wire fixture, in case order, for replaying the whole suite at once. */
export const kieConformanceFixtures: ReadonlyArray<WireFixture> = [
  kieGetSuccessTaskFixture,
  kieGetFailedTaskFixture,
  kieTaskNotFoundFixture,
  kieUnauthorizedFixture,
  kieCreateImageTaskFixture,
  kieCreateVideoTaskFixture
]
