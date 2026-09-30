import type * as Schema from 'effect/Schema'
import type { WireFixture } from '@yolk-sdk/conformance/fixture'

const base = 'https://api.todoist.com/api/v1'

const workProjectId = '6XSyntheticWork0'

const projectId = '6XSynLifecycle01'

const projectName = 'yolk-conformance-run-synthetic-lifecycle'

const taskId = '6XSynLifeTask001'

const json = (status: number, body: Schema.Json) => ({
  status,
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(body)
})

const noContent = { status: 204, headers: {}, body: '' }

const project = {
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
}

const task = (content: string) => ({
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
  due: null,
  priority: 1,
  child_order: 1,
  content,
  description: '',
  note_count: 0,
  day_order: -1,
  is_collapsed: false
})

/**
 * The case-owned project create, a task create, read, update, and close, the active task list of
 * the project (now empty), then the restore: the project delete by id and a not-found lookup.
 *
 * Synthetic placeholder (`evidence: 'unverified'`) until a live recording replaces it.
 * `pnpm conformance:todoist --live --owner-approved --account <label> --record` stages a
 * replacement in a gitignored directory; see the script header for the manual scrub-and-promote
 * step.
 */
export const todoistTaskLifecycleFixture: WireFixture = {
  id: 'todoist.tasks.lifecycle-close.synthetic',
  caseId: 'todoist.tasks.lifecycle-close',
  evidence: 'unverified',
  recordedAt: '2026-09-30',
  account: 'synthetic',
  endpoint: base,
  note: 'Create a case-owned project under the work project and a task in it, read, update, and close the task, list the active tasks (the closed one is gone), then delete the project and confirm it is gone. Synthetic placeholder shaped like the Todoist API v1 wire; not recorded from a live service.',
  exchanges: [
    {
      request: {
        method: 'POST',
        url: `${base}/projects`,
        headers: { 'content-type': 'application/json' },
        body: { name: projectName, parent_id: workProjectId }
      },
      response: json(200, project)
    },
    {
      request: {
        method: 'POST',
        url: `${base}/tasks`,
        headers: { 'content-type': 'application/json' },
        body: { content: 'yolk-conformance task: safe to delete', project_id: projectId }
      },
      response: json(200, task('yolk-conformance task: safe to delete'))
    },
    {
      request: { method: 'GET', url: `${base}/tasks/${taskId}` },
      response: json(200, task('yolk-conformance task: safe to delete'))
    },
    {
      request: {
        method: 'POST',
        url: `${base}/tasks/${taskId}`,
        headers: { 'content-type': 'application/json' },
        body: { content: 'yolk-conformance task updated: safe to delete' }
      },
      response: json(200, task('yolk-conformance task updated: safe to delete'))
    },
    {
      request: { method: 'POST', url: `${base}/tasks/${taskId}/close` },
      response: noContent
    },
    {
      request: { method: 'GET', url: `${base}/tasks?project_id=${projectId}` },
      response: json(200, { results: [], next_cursor: null })
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
        error_extra: { event_id: '00000000000000000000000000000002' },
        error_tag: 'NOT_FOUND',
        http_code: 404
      })
    }
  ]
}
