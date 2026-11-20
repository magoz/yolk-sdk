import type { WireFixture } from '@yolk-sdk/conformance/fixture'

/**
 * `kie.get_task` with a synthetic API key Kie does not know: one GET `recordInfo`, answered HTTP
 * 401 with envelope `code` 401 (the case checks only the code; the authorization header is never
 * recorded).
 *
 * Synthetic placeholder (`evidence: 'unverified'`) until a live recording replaces it.
 * `pnpm conformance:kie --live --owner-approved --account <label> --record` stages a replacement
 * in a gitignored directory (see the script header).
 */
export const kieUnauthorizedFixture: WireFixture = {
  id: 'kie.errors.unauthorized.synthetic',
  caseId: 'kie.errors.unauthorized',
  evidence: 'unverified',
  recordedAt: '2026-11-20',
  account: 'synthetic',
  endpoint: 'https://api.kie.ai',
  note: 'recordInfo with an API key Kie does not know, answered HTTP 401 with envelope code 401. Synthetic placeholder shaped like the Kie Market API wire; not recorded from a live service.',
  exchanges: [
    {
      request: {
        method: 'GET',
        url: 'https://api.kie.ai/api/v1/jobs/recordInfo?taskId=yolk_conformance_absent_task_0000',
        headers: { accept: 'application/json' }
      },
      response: {
        status: 401,
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ code: 401, msg: 'Unauthorized', data: null })
      }
    }
  ]
}
