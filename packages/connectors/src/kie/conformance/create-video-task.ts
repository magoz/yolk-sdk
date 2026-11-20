import type { WireFixture } from '@yolk-sdk/conformance/fixture'

/**
 * `kie.create_video_task` of the synthetic run-scoped prompt from the seeded first frame, 720p for
 * 5 seconds: one POST `createTask` with the Wan 2.7 image-to-video model, answered HTTP 200 with
 * envelope `code` 200 and the created `taskId`.
 *
 * Synthetic placeholder (`evidence: 'unverified'`) until a live recording replaces it.
 * `pnpm conformance:kie --live --owner-approved --account <label> --record` stages a replacement
 * in a gitignored directory (see the script header).
 */
export const kieCreateVideoTaskFixture: WireFixture = {
  id: 'kie.tasks.create-video-task.synthetic',
  caseId: 'kie.tasks.create-video-task',
  evidence: 'unverified',
  recordedAt: '2026-11-20',
  account: 'synthetic',
  endpoint: 'https://api.kie.ai',
  note: 'One createTask of an image-to-video task from the seeded first frame naming the run id, answered code 200 with the created taskId. Synthetic placeholder shaped like the Kie Market API wire; not recorded from a live service.',
  exchanges: [
    {
      request: {
        method: 'POST',
        url: 'https://api.kie.ai/api/v1/jobs/createTask',
        headers: { accept: 'application/json', 'content-type': 'application/json' },
        body: {
          model: 'wan/2-7-image-to-video',
          input: {
            prompt:
              'yolk-conformance run-synthetic: the still image, unchanged, synthetic conformance test, safe to ignore',
            first_frame_url: 'https://example.com/yolk-synthetic/first-frame.png',
            resolution: '720p',
            duration: 5
          }
        }
      },
      response: {
        status: 200,
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          code: 200,
          msg: 'success',
          data: { taskId: 'yolk_synthetic_task_created_0002' }
        })
      }
    }
  ]
}
