import type { WireFixture } from '@yolk-sdk/conformance/fixture'

const label = (id: string, name: string, order: number) => ({
  id,
  name,
  color: 'charcoal',
  order,
  is_favorite: false
})

/**
 * The seeded labeled task (labels as names), then one page of personal labels.
 *
 * Synthetic placeholder (`evidence: 'unverified'`) until a live recording replaces it.
 * `pnpm conformance:todoist --live --owner-approved --account <label> --record` stages a
 * replacement in a gitignored directory; see the script header for the manual scrub-and-promote
 * step.
 */
export const todoistTaskLabelsFixture: WireFixture = {
  id: 'todoist.labels.task-labels-are-names.synthetic',
  caseId: 'todoist.labels.task-labels-are-names',
  evidence: 'unverified',
  recordedAt: '2026-09-30',
  account: 'synthetic',
  endpoint: 'https://api.todoist.com/api/v1',
  note: 'The seeded task carrying two labels by name, then the personal label list (one page). Synthetic placeholder shaped like the Todoist API v1 wire; not recorded from a live service.',
  exchanges: [
    {
      request: {
        method: 'GET',
        url: 'https://api.todoist.com/api/v1/tasks/6XSyntheticLabel'
      },
      response: {
        status: 200,
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          id: '6XSyntheticLabel',
          user_id: '10000001',
          project_id: '6XSyntheticWork0',
          section_id: null,
          parent_id: null,
          added_by_uid: '10000001',
          assigned_by_uid: null,
          responsible_uid: null,
          labels: ['synthetic-errand', 'synthetic-waiting'],
          deadline: null,
          duration: null,
          checked: false,
          is_deleted: false,
          added_at: '2026-09-20T10:00:00.000000Z',
          completed_at: null,
          updated_at: '2026-09-20T10:00:00.000000Z',
          due: null,
          priority: 1,
          child_order: 1,
          content: 'Synthetic labeled task',
          description: '',
          note_count: 0,
          day_order: -1,
          is_collapsed: false
        })
      }
    },
    {
      request: {
        method: 'GET',
        url: 'https://api.todoist.com/api/v1/labels?limit=200'
      },
      response: {
        status: 200,
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          results: [
            label('2100000001', 'synthetic-errand', 1),
            label('2100000002', 'synthetic-waiting', 2),
            label('2100000003', 'synthetic-someday', 3)
          ],
          next_cursor: null
        })
      }
    }
  ]
}
