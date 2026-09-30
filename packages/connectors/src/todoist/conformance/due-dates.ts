import type * as Schema from 'effect/Schema'
import type { WireFixture } from '@yolk-sdk/conformance/fixture'

const base = 'https://api.todoist.com/api/v1'

const workProjectId = '6XSyntheticWork0'

const projectId = '6XSynDueProject1'

const projectName = 'yolk-conformance-run-synthetic-due'

const taskId = '6XSynDueTask0001'

const json = (status: number, body: Schema.Json) => ({
  status,
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(body)
})

const noContent = { status: 204, headers: {}, body: '' }

const task = (due: Schema.Json) => ({
  id: taskId,
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
  added_at: '2026-09-30T12:00:01.000000Z',
  completed_at: null,
  updated_at: '2026-09-30T12:00:01.000000Z',
  due,
  priority: 1,
  child_order: 1,
  content: 'yolk-conformance task: safe to delete',
  description: '',
  note_count: 0,
  day_order: -1,
  is_collapsed: false
})

/**
 * The case-owned project create, a task create with `due_date`, its update with `due_datetime`,
 * then the restore: the project delete by id and a not-found lookup.
 *
 * Synthetic placeholder (`evidence: 'unverified'`) until a live recording replaces it.
 * `pnpm conformance:todoist --live --owner-approved --account <label> --record` stages a
 * replacement in a gitignored directory; see the script header for the manual scrub-and-promote
 * step.
 */
export const todoistDueDatesFixture: WireFixture = {
  id: 'todoist.tasks.due-dates.synthetic',
  caseId: 'todoist.tasks.due-dates',
  evidence: 'unverified',
  recordedAt: '2026-09-30',
  account: 'synthetic',
  endpoint: base,
  note: 'Create a case-owned project and a task in it due on a fixed day, move the due to a fixed instant, then delete the project and confirm it is gone. Synthetic placeholder shaped like the Todoist API v1 wire; not recorded from a live service.',
  exchanges: [
    {
      request: {
        method: 'POST',
        url: `${base}/projects`,
        headers: { 'content-type': 'application/json' },
        body: { name: projectName, parent_id: workProjectId }
      },
      response: json(200, {
        id: projectId,
        name: projectName,
        parent_id: workProjectId,
        child_order: 1,
        color: 'charcoal',
        description: '',
        is_archived: false,
        is_deleted: false,
        is_favorite: false,
        is_frozen: false,
        is_shared: false,
        is_collapsed: false,
        can_assign_tasks: false,
        inbox_project: false,
        view_style: 'list',
        default_order: 0,
        created_at: '2026-09-30T12:00:00.000000Z',
        updated_at: '2026-09-30T12:00:00.000000Z'
      })
    },
    {
      request: {
        method: 'POST',
        url: `${base}/tasks`,
        headers: { 'content-type': 'application/json' },
        body: {
          content: 'yolk-conformance task: safe to delete',
          project_id: projectId,
          due_date: '2030-01-15'
        }
      },
      response: json(
        200,
        task({
          date: '2030-01-15',
          timezone: null,
          string: 'Jan 15 2030',
          lang: 'en',
          is_recurring: false
        })
      )
    },
    {
      request: {
        method: 'POST',
        url: `${base}/tasks/${taskId}`,
        headers: { 'content-type': 'application/json' },
        body: { due_datetime: '2030-01-15T12:00:00Z' }
      },
      response: json(
        200,
        task({
          date: '2030-01-15T12:00:00Z',
          timezone: 'UTC',
          string: 'Jan 15 2030 12:00',
          lang: 'en',
          is_recurring: false
        })
      )
    },
    {
      request: { method: 'DELETE', url: `${base}/projects/${projectId}` },
      response: noContent
    },
    {
      request: { method: 'GET', url: `${base}/projects/${projectId}` },
      response: json(404, {
        error: 'Project not found',
        error_code: 478,
        error_extra: { event_id: '00000000000000000000000000000003' },
        error_tag: 'NOT_FOUND',
        http_code: 404
      })
    }
  ]
}
