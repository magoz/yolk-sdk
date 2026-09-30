import type { TodoistConformanceSeeds } from './cases.ts'

/**
 * Seed ids used by the committed Todoist fixtures (synthetic until a scrubbed recording is
 * promoted). Replaying the fixtures needs these exact seeds in `TodoistConformanceConfig`.
 * `pnpm conformance:todoist --live --owner-approved --account <label> --record` stages an
 * updated copy for manual promotion together with the fixtures it records.
 */
export const todoistConformanceFixtureSeeds: TodoistConformanceSeeds = {
  pagingProjectId: '6XSyntheticPage0',
  labeledTaskId: '6XSyntheticLabel',
  workProjectId: '6XSyntheticWork0',
  runId: 'run-synthetic'
}
