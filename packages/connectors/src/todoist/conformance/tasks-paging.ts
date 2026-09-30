import type { WireFixture } from '@yolk-sdk/conformance/fixture'

const projectId = '6XSyntheticPage0'

const task = (id: string, content: string, order: number) => ({
  id,
  user_id: '10000001',
  project_id: projectId,
  section_id: null,
  parent_id: null,
  added_by_uid: '10000001',
  assigned_by_uid: null,
  responsible_uid: null,
  labels: [],
  deadline: null,
  duration: null,
  checked: false,
  is_deleted: false,
  added_at: '2026-09-20T10:00:00.000000Z',
  completed_at: null,
  updated_at: '2026-09-20T10:00:00.000000Z',
  due: null,
  priority: 1,
  child_order: order,
  content,
  description: '',
  note_count: 0,
  day_order: -1,
  is_collapsed: false
})

/**
 * A `limit=2` task listing of the seeded paging project with a `next_cursor`, then the page that
 * cursor leads to, ending with `next_cursor: null`.
 *
 * Synthetic placeholder (`evidence: 'unverified'`) until a live recording replaces it.
 * `pnpm conformance:todoist --live --owner-approved --account <label> --record` stages a
 * replacement in a gitignored directory; see the script header for the manual scrub-and-promote
 * step.
 */
export const todoistTasksPagingFixture: WireFixture = {
  id: 'todoist.tasks.list-cursor-paging.synthetic',
  caseId: 'todoist.tasks.list-cursor-paging',
  evidence: 'unverified',
  recordedAt: '2026-09-30',
  account: 'synthetic',
  endpoint: 'https://api.todoist.com/api/v1',
  note: 'Two pages of active tasks in the seeded paging project (three tasks, limit 2): the first with a next_cursor, the second reached through it and ending with next_cursor null. Synthetic placeholder shaped like the Todoist API v1 wire; not recorded from a live service.',
  exchanges: [
    {
      request: {
        method: 'GET',
        url: `https://api.todoist.com/api/v1/tasks?project_id=${projectId}&limit=2`
      },
      response: {
        status: 200,
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          results: [
            task('6XSynPagingTask1', 'Synthetic paging task one', 1),
            task('6XSynPagingTask2', 'Synthetic paging task two', 2)
          ],
          next_cursor: 'SyntheticTaskCursor0001'
        })
      }
    },
    {
      request: {
        method: 'GET',
        url: `https://api.todoist.com/api/v1/tasks?project_id=${projectId}&cursor=SyntheticTaskCursor0001&limit=2`
      },
      response: {
        status: 200,
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          results: [task('6XSynPagingTask3', 'Synthetic paging task three', 3)],
          next_cursor: null
        })
      }
    }
  ]
}
