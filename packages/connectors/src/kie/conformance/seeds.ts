import type { KieConformanceSeeds } from './cases.ts'

/**
 * Seeds used by the committed Kie fixtures (synthetic until a scrubbed recording is promoted).
 * Replaying the fixtures needs these exact seeds in `KieConformanceConfig`.
 * `pnpm conformance:kie --live --owner-approved --account <label> --record` stages an updated copy
 * for manual promotion together with the fixtures it records.
 */
export const kieConformanceFixtureSeeds: KieConformanceSeeds = {
  successTaskId: 'yolk_synthetic_task_success_0001',
  failedTaskId: 'yolk_synthetic_task_failed_0001',
  firstFrameUrl: 'https://example.com/yolk-synthetic/first-frame.png',
  runId: 'run-synthetic'
}
