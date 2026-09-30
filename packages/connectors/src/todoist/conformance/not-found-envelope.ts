import type { WireFixture } from '@yolk-sdk/conformance/fixture'

/**
 * `todoist.get_task` of a well-formed id that addresses no task: HTTP 404 with the JSON error body.
 *
 * Synthetic placeholder (`evidence: 'unverified'`) until a live recording replaces it.
 * `pnpm conformance:todoist --live --owner-approved --account <label> --record` stages a
 * replacement in a gitignored directory; see the script header for the manual scrub-and-promote
 * step.
 */
export const todoistNotFoundEnvelopeFixture: WireFixture = {
  id: 'todoist.errors.not-found-envelope.synthetic',
  caseId: 'todoist.errors.not-found-envelope',
  evidence: 'unverified',
  recordedAt: '2026-09-30',
  account: 'synthetic',
  endpoint: 'https://api.todoist.com/api/v1',
  note: 'A task lookup for an id that addresses no task, answered 404 with the JSON error body. Synthetic placeholder shaped like the Todoist API v1 wire; not recorded from a live service.',
  exchanges: [
    {
      request: {
        method: 'GET',
        url: 'https://api.todoist.com/api/v1/tasks/6YolkAbsentTask0'
      },
      response: {
        status: 404,
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          error: 'Task not found',
          error_code: 478,
          error_extra: { event_id: '00000000000000000000000000000001' },
          error_tag: 'NOT_FOUND',
          http_code: 404
        })
      }
    }
  ]
}
