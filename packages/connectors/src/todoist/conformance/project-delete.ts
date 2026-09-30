import type * as Schema from 'effect/Schema'
import type { WireFixture } from '@yolk-sdk/conformance/fixture'

const base = 'https://api.todoist.com/api/v1'

const workProjectId = '6XSyntheticWork0'

const projectId = '6XSynDeleteProj1'

const projectName = 'yolk-conformance-run-synthetic-delete'

const taskId = '6XSynDeleteTask1'

const json = (status: number, body: Schema.Json) => ({
  status,
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(body)
})

const notFound = (error: string, eventId: string) =>
  json(404, {
    error,
    error_code: 478,
    error_extra: { event_id: eventId },
    error_tag: 'NOT_FOUND',
    http_code: 404
  })

/**
 * The case-owned project create, a task create in it, the project delete, then not-found lookups
 * of the project and of the task that was in it (no restore requests follow: the case proved the
 * project gone).
 *
 * Synthetic placeholder (`evidence: 'unverified'`) until a live recording replaces it.
 * `pnpm conformance:todoist --live --owner-approved --account <label> --record` stages a
 * replacement in a gitignored directory; see the script header for the manual scrub-and-promote
 * step.
 */
export const todoistProjectDeleteFixture: WireFixture = {
  id: 'todoist.projects.delete-then-not-found.synthetic',
  caseId: 'todoist.projects.delete-then-not-found',
  evidence: 'unverified',
  recordedAt: '2026-09-30',
  account: 'synthetic',
  endpoint: base,
  note: 'Create a case-owned project and a task in it, delete the project, then look up the project and the task (both not found). Synthetic placeholder shaped like the Todoist API v1 wire; not recorded from a live service.',
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
        body: { content: 'yolk-conformance task: safe to delete', project_id: projectId }
      },
      response: json(200, {
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
        content: 'yolk-conformance task: safe to delete',
        description: '',
        note_count: 0,
        day_order: -1,
        is_collapsed: false
      })
    },
    {
      request: { method: 'DELETE', url: `${base}/projects/${projectId}` },
      response: { status: 204, headers: {}, body: '' }
    },
    {
      request: { method: 'GET', url: `${base}/projects/${projectId}` },
      response: notFound('Project not found', '00000000000000000000000000000005')
    },
    {
      request: { method: 'GET', url: `${base}/tasks/${taskId}` },
      response: notFound('Task not found', '00000000000000000000000000000006')
    }
  ]
}
