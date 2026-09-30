/**
 * Todoist conformance cases for `@yolk-sdk/conformance/runner` and the wire fixtures that back
 * their replay (`@yolk-sdk/conformance/replay`).
 *
 * Every case runs the real connector actions over the connector ports. The current fixtures are
 * synthetic placeholders (`evidence: 'unverified'`) shaped like the Todoist API v1 wire.
 * `pnpm conformance:todoist --live --owner-approved --account <label> --record` stages verified
 * recordings from a practice account in a gitignored directory; a person scrubs them and promotes
 * them here, updating the tests together with them (fixture ids, `evidence`, and `account`
 * change).
 *
 * @experimental
 */
import type { WireFixture } from '@yolk-sdk/conformance/fixture'
import { todoistDueDatesFixture } from './due-dates.ts'
import { todoistNotFoundEnvelopeFixture } from './not-found-envelope.ts'
import { todoistProjectDeleteFixture } from './project-delete.ts'
import { todoistProjectParentIdFixture } from './project-parent-id.ts'
import { todoistTaskLabelsFixture } from './task-labels.ts'
import { todoistTaskLifecycleFixture } from './task-lifecycle.ts'
import { todoistTasksPagingFixture } from './tasks-paging.ts'

export {
  TodoistConformanceActionFailed,
  TodoistConformanceCleanupRefused,
  TodoistConformanceConfig,
  TodoistConformanceRestoreFailed,
  TodoistConformanceSeeds,
  findTodoistConformanceLeftovers,
  todoistConformanceCases,
  todoistConformanceCredentialRef,
  todoistConformanceIntegration,
  todoistConformanceMarker,
  todoistConformanceRunProjectPrefix,
  todoistDueDatesCase,
  todoistNotFoundEnvelopeCase,
  todoistProjectDeleteCase,
  todoistProjectParentIdCase,
  todoistTaskLabelsCase,
  todoistTaskLifecycleCase,
  todoistTasksPagingCase,
  type TodoistConformanceCase,
  type TodoistConformanceError,
  type TodoistConformanceRequirements,
  type TodoistConformanceSeedKey,
  type TodoistOwnedProject
} from './cases.ts'

export { todoistConformanceFixtureSeeds } from './seeds.ts'

export {
  todoistDueDatesFixture,
  todoistNotFoundEnvelopeFixture,
  todoistProjectDeleteFixture,
  todoistProjectParentIdFixture,
  todoistTaskLabelsFixture,
  todoistTaskLifecycleFixture,
  todoistTasksPagingFixture
}

/** Every Todoist wire fixture, in case order, for replaying the whole suite at once. */
export const todoistConformanceFixtures: ReadonlyArray<WireFixture> = [
  todoistTasksPagingFixture,
  todoistNotFoundEnvelopeFixture,
  todoistTaskLabelsFixture,
  todoistTaskLifecycleFixture,
  todoistDueDatesFixture,
  todoistProjectParentIdFixture,
  todoistProjectDeleteFixture
]
