import type * as Schema from 'effect/Schema'
import type { WireFixture } from '@yolk-sdk/conformance/fixture'

const base = 'https://api.todoist.com/api/v1'

const json = (body: Schema.Json) => ({
  status: 200,
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(body)
})

/** A project in the shape the other Todoist fixtures answer it. */
const project = (id: string, name: string, childOrder: number) => ({
  id,
  name,
  parent_id: null,
  child_order: childOrder,
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
  created_at: '2026-09-20T10:00:00.000000Z',
  updated_at: '2026-09-20T10:00:00.000000Z'
})

const workProject = project('6XSyntheticWork0', 'Synthetic work project', 1)

const pagingProject = project('6XSyntheticPage0', 'Synthetic paging project', 2)

/**
 * The active project listing as the read-only leftover lookup sends it (`limit=200`, one page),
 * then the same listing one project per page, chained through `next_cursor`.
 *
 * Synthetic placeholder (`evidence: 'unverified'`) until a live recording replaces it. The shapes
 * follow the Todoist API v1 reference for `GET /api/v1/projects` (fetched 2026-11-20: a required
 * `{ results, next_cursor }` page of project objects, `limit` up to 200, `cursor` from the previous
 * page; https://developer.todoist.com/api/v1/#tag/Projects/operation/get_projects_api_v1_projects_get),
 * with the project fields the other Todoist fixtures answer. Two gaps against that reference: the
 * project objects keep only that subset of the documented fields (no `access`, `creator_uid`,
 * `icon`, `order_key`, `role`, ...), and the cursor keeps the other fixtures' synthetic form, not
 * the documented `<part>.<part>` pattern (cursors stay opaque to the connector). A real account
 * also lists its Inbox project; this synthetic account holds only the two seeded projects.
 * `pnpm conformance:todoist --live --owner-approved --account <label> --record` stages a
 * replacement in a gitignored directory; see the script header for the manual scrub-and-promote
 * step.
 */
export const todoistProjectsPagingFixture: WireFixture = {
  id: 'todoist.projects.list-cursor-paging.synthetic',
  caseId: 'todoist.projects.list-cursor-paging',
  evidence: 'unverified',
  recordedAt: '2026-11-20',
  account: 'synthetic',
  endpoint: base,
  note: 'The active project listing on one page (limit=200, as the leftover lookup sends it), then one project per page through next_cursor: the same two seeded projects. Synthetic placeholder shaped from the Todoist API v1 reference (fetched 2026-11-20; GET /api/v1/projects: a { results, next_cursor } page, limit up to 200, cursor from the previous page; https://developer.todoist.com/api/v1/#tag/Projects/operation/get_projects_api_v1_projects_get) and the project shape of the other Todoist fixtures. Not in the reference: the projects keep only the subset of the documented fields the other fixtures use, and the cursor keeps their synthetic form rather than the documented <part>.<part> pattern. Not recorded from a live service.',
  exchanges: [
    {
      request: { method: 'GET', url: `${base}/projects?limit=200` },
      response: json({ results: [workProject, pagingProject], next_cursor: null })
    },
    {
      request: { method: 'GET', url: `${base}/projects?limit=1` },
      response: json({ results: [workProject], next_cursor: 'SyntheticProjectCursor0001' })
    },
    {
      request: {
        method: 'GET',
        url: `${base}/projects?cursor=SyntheticProjectCursor0001&limit=1`
      },
      response: json({ results: [pagingProject], next_cursor: null })
    }
  ]
}
