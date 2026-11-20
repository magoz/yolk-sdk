import type { WireFixture } from '@yolk-sdk/conformance/fixture'

/**
 * `kie.get_task` of the seeded finished GPT Image 2 task: one GET `recordInfo`, answered HTTP 200
 * with envelope `code` 200 and a `success` record whose `resultJson` lists one result URL. Only the
 * keys the connector decodes are kept (no `param`).
 *
 * Synthetic placeholder (`evidence: 'unverified'`) until a live recording replaces it.
 * `pnpm conformance:kie --live --owner-approved --account <label> --record` stages a replacement
 * in a gitignored directory; promoting it replaces each 2xx body wholesale with a minimal
 * synthetic body (see the script header).
 */
export const kieGetSuccessTaskFixture: WireFixture = {
  id: 'kie.tasks.get-success.synthetic',
  caseId: 'kie.tasks.get-success',
  evidence: 'unverified',
  recordedAt: '2026-11-20',
  account: 'synthetic',
  endpoint: 'https://api.kie.ai',
  note: 'recordInfo of a finished text-to-image task, answered code 200 with state success and one result URL in resultJson. Synthetic placeholder shaped like the Kie Market API wire; not recorded from a live service.',
  exchanges: [
    {
      request: {
        method: 'GET',
        url: 'https://api.kie.ai/api/v1/jobs/recordInfo?taskId=yolk_synthetic_task_success_0001',
        headers: { accept: 'application/json' }
      },
      response: {
        status: 200,
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          code: 200,
          msg: 'success',
          data: {
            taskId: 'yolk_synthetic_task_success_0001',
            model: 'gpt-image-2-text-to-image',
            state: 'success',
            resultJson: JSON.stringify({
              resultUrls: ['https://tempfile.example.com/yolk-synthetic/image-0001.png']
            }),
            failCode: null,
            failMsg: null,
            costTime: 12000,
            completeTime: 1790000012000,
            createTime: 1790000000000,
            updateTime: 1790000012000
          }
        })
      }
    }
  ]
}
