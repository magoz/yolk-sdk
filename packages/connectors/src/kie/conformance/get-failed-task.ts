import type { WireFixture } from '@yolk-sdk/conformance/fixture'

/**
 * `kie.get_task` of the seeded failed task: one GET `recordInfo`, answered HTTP 200 with envelope
 * `code` 200 and a `fail` record carrying `failCode` and `failMsg` and no `resultJson`.
 *
 * Synthetic placeholder (`evidence: 'unverified'`) until a live recording replaces it.
 * `pnpm conformance:kie --live --owner-approved --account <label> --record` stages a replacement
 * in a gitignored directory; promoting it replaces each 2xx body wholesale with a minimal
 * synthetic body (see the script header).
 */
export const kieGetFailedTaskFixture: WireFixture = {
  id: 'kie.tasks.get-failed.synthetic',
  caseId: 'kie.tasks.get-failed',
  evidence: 'unverified',
  recordedAt: '2026-11-20',
  account: 'synthetic',
  endpoint: 'https://api.kie.ai',
  note: 'recordInfo of a failed task, answered code 200 with state fail, a failCode and failMsg, and no resultJson. Synthetic placeholder shaped like the Kie Market API wire; not recorded from a live service.',
  exchanges: [
    {
      request: {
        method: 'GET',
        url: 'https://api.kie.ai/api/v1/jobs/recordInfo?taskId=yolk_synthetic_task_failed_0001',
        headers: { accept: 'application/json' }
      },
      response: {
        status: 200,
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          code: 200,
          msg: 'success',
          data: {
            taskId: 'yolk_synthetic_task_failed_0001',
            model: 'gpt-image-2-text-to-image',
            state: 'fail',
            resultJson: null,
            failCode: '500',
            failMsg: 'synthetic generation failure',
            costTime: null,
            completeTime: 1790000020000,
            createTime: 1790000000000,
            updateTime: 1790000020000
          }
        })
      }
    }
  ]
}
