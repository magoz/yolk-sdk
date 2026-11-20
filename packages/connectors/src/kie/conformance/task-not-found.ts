import type { WireFixture } from '@yolk-sdk/conformance/fixture'

/**
 * `kie.get_task` of a synthetic task id no account holds: one GET `recordInfo`, answered HTTP 200
 * with envelope `code` 422 and no `data` (the case checks only that the code is 4xx and not 401 or
 * 402).
 *
 * Synthetic placeholder (`evidence: 'unverified'`) until a live recording replaces it.
 * `pnpm conformance:kie --live --owner-approved --account <label> --record` stages a replacement
 * in a gitignored directory (see the script header).
 */
export const kieTaskNotFoundFixture: WireFixture = {
  id: 'kie.errors.task-not-found.synthetic',
  caseId: 'kie.errors.task-not-found',
  evidence: 'unverified',
  recordedAt: '2026-11-20',
  account: 'synthetic',
  endpoint: 'https://api.kie.ai',
  note: 'recordInfo of an unknown task id, answered HTTP 200 with envelope code 422 and null data. Synthetic placeholder shaped like the Kie Market API wire; not recorded from a live service.',
  exchanges: [
    {
      request: {
        method: 'GET',
        url: 'https://api.kie.ai/api/v1/jobs/recordInfo?taskId=yolk_conformance_absent_task_0000',
        headers: { accept: 'application/json' }
      },
      response: {
        status: 200,
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ code: 422, msg: 'recordInfo is null', data: null })
      }
    }
  ]
}
