/**
 * Workflow functions by id. The directive transform (`./vite.ts`) registers every
 * `'use workflow'` function under `<module path>#<name>` when its module loads; `start` looks the
 * id up by function, the run object looks the function up by id.
 */

import { Predicate } from 'effect'

/** A `'use workflow'` function as compiled code registers it. */
export type WorkflowFunction = (...args: ReadonlyArray<never>) => Promise<unknown>

/** How a run invokes a workflow: with its decoded arguments, whatever they are. */
export type InvocableWorkflow = (...args: ReadonlyArray<unknown>) => unknown

// Every JavaScript function can be called with any arguments; a run passes the ones it was started
// with, decoded from devalue text.
const isInvocable = (value: object): value is InvocableWorkflow => Predicate.isFunction(value)

const byId = new Map<string, InvocableWorkflow>()

const ids = new WeakMap<object, string>()

const loaders = new Map<string, () => Promise<unknown>>()

/**
 * Loads workflow modules on demand, by module path (the part of an id before `#`). A Worker
 * registers its workflow modules here instead of importing them at startup, which would evaluate
 * the whole runtime in the global scope (Workers cap its CPU time).
 */
export const registerWorkflowModules = (
  modules: Readonly<Record<string, () => Promise<unknown>>>
): void => {
  for (const [path, load] of Object.entries(modules)) loaders.set(path, load)
}

export const registerWorkflow = (workflow: WorkflowFunction, id: string): void => {
  if (!isInvocable(workflow)) throw new TypeError(`Workflow ${id} is not a function`)

  byId.set(id, workflow)
  ids.set(workflow, id)
}

export const workflowById = async (id: string): Promise<InvocableWorkflow | undefined> => {
  const registered = byId.get(id)

  if (registered !== undefined) return registered

  const load = loaders.get(id.split('#')[0] ?? id)

  if (load !== undefined) await load()

  return byId.get(id)
}

export const workflowIdOf = (workflow: object): string | undefined => ids.get(workflow)
