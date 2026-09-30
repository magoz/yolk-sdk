import type * as Schema from 'effect/Schema'
import type { WireFixture } from '@yolk-sdk/conformance/fixture'

const base = 'https://api.todoist.com/api/v1'

const workProjectId = '6XSyntheticWork0'

const projectId = '6XSynParentProj1'

const projectName = 'yolk-conformance-run-synthetic-parent'

const json = (status: number, body: Schema.Json) => ({
  status,
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(body)
})

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

/**
 * The case-owned project create under the work project, its read-back, then the restore: the
 * project delete by id and a not-found lookup.
 *
 * Synthetic placeholder (`evidence: 'unverified'`) until a live recording replaces it.
 * `pnpm conformance:todoist --live --owner-approved --account <label> --record` stages a
 * replacement in a gitignored directory; see the script header for the manual scrub-and-promote
 * step.
 */
export const todoistProjectParentIdFixture: WireFixture = {
  id: 'todoist.projects.parent-id.synthetic',
  caseId: 'todoist.projects.parent-id',
  evidence: 'unverified',
  recordedAt: '2026-09-30',
  account: 'synthetic',
  endpoint: base,
  note: 'Create a case-owned project under the work project, read it back with its parent_id, then delete it and confirm it is gone. Synthetic placeholder shaped like the Todoist API v1 wire; not recorded from a live service.',
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
      request: { method: 'GET', url: `${base}/projects/${projectId}` },
      response: json(200, project)
    },
    {
      request: { method: 'DELETE', url: `${base}/projects/${projectId}` },
      response: { status: 204, headers: {}, body: '' }
    },
    {
      request: { method: 'GET', url: `${base}/projects/${projectId}` },
      response: json(404, {
        error: 'Project not found',
        error_code: 478,
        error_extra: { event_id: '00000000000000000000000000000004' },
        error_tag: 'NOT_FOUND',
        http_code: 404
      })
    }
  ]
}
