import type { WireFixture } from '@yolk-sdk/conformance/fixture'

/**
 * `kie.create_image_task` of the synthetic run-scoped prompt, square at 1K: one POST
 * `createTask` with the GPT Image 2 text-to-image model, answered HTTP 200 with envelope `code`
 * 200 and the created `taskId`.
 *
 * Synthetic placeholder (`evidence: 'unverified'`) until a live recording replaces it.
 * `pnpm conformance:kie --live --owner-approved --account <label> --record` stages a replacement
 * in a gitignored directory (see the script header).
 */
export const kieCreateImageTaskFixture: WireFixture = {
  id: 'kie.tasks.create-image-task.synthetic',
  caseId: 'kie.tasks.create-image-task',
  evidence: 'unverified',
  recordedAt: '2026-11-20',
  account: 'synthetic',
  endpoint: 'https://api.kie.ai',
  note: 'One createTask of a text-to-image task naming the run id, answered code 200 with the created taskId. Synthetic placeholder shaped like the Kie Market API wire; not recorded from a live service.',
  exchanges: [
    {
      request: {
        method: 'POST',
        url: 'https://api.kie.ai/api/v1/jobs/createTask',
        headers: { accept: 'application/json', 'content-type': 'application/json' },
        body: {
          model: 'gpt-image-2-text-to-image',
          input: {
            prompt:
              'yolk-conformance run-synthetic: a plain grey square, synthetic conformance test, safe to ignore',
            aspect_ratio: '1:1',
            resolution: '1K'
          }
        }
      },
      response: {
        status: 200,
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          code: 200,
          msg: 'success',
          data: { taskId: 'yolk_synthetic_task_created_0001' }
        })
      }
    }
  ]
}
