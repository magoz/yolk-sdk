import * as Schema from 'effect/Schema'
import { Match, Predicate } from 'effect'
import {
  AgentError,
  AgentRetry,
  isSubagentAcceptedToolResult,
  type AgentEvent,
  type SubagentStatus
} from './event.ts'
import { HitlRequest, type ToolCall } from './tool.ts'

/**
 * What a blocked agent needs from a person. `permission`: approval to do something (tool
 * approvals, action-backed interactions). `question`: an answer or typed input. `auth`: a login,
 * token, or credential (reserved; no request produces it yet). Same set as OSC 7501 `kind`.
 */
export const AgentBlockedKind = Schema.Literals(['permission', 'question', 'auth'])

export type AgentBlockedKind = typeof AgentBlockedKind.Type

/** Busy without anything more specific to report (OSC 7501's absent `progress`). */
export class AgentBusy extends Schema.TaggedClass<AgentBusy>()('Busy', {}) {}

/** A model response is streaming. */
export class AgentGenerating extends Schema.TaggedClass<AgentGenerating>()('Generating', {}) {}

export const AgentToolActivityCall = Schema.Struct({
  toolCallId: Schema.String,
  name: Schema.String
})

export type AgentToolActivityCall = typeof AgentToolActivityCall.Type

/** Host tools are executing; same-turn siblings run together, in start order. */
export class AgentRunningTools extends Schema.TaggedClass<AgentRunningTools>()('Tools', {
  calls: Schema.NonEmptyArray(AgentToolActivityCall)
}) {}

export class AgentCompacting extends Schema.TaggedClass<AgentCompacting>()('Compacting', {
  strategy: Schema.String
}) {}

/** Waiting before retrying a failed model call. */
export class AgentRetrying extends Schema.TaggedClass<AgentRetrying>()('Retrying', {
  retry: AgentRetry
}) {}

export const AgentActivity = Schema.Union([
  AgentBusy,
  AgentGenerating,
  AgentRunningTools,
  AgentCompacting,
  AgentRetrying
])

export type AgentActivity = typeof AgentActivity.Type

/** At rest, waiting for the next instruction. Also the status after a person cancels a run. */
export class AgentIdle extends Schema.TaggedClass<AgentIdle>()('Idle', {}) {}

export class AgentWorking extends Schema.TaggedClass<AgentWorking>()('Working', {
  activity: AgentActivity
}) {}

/** Paused until a person settles every request; `kind` summarizes them (see `agentBlockedKind`). */
export class AgentBlocked extends Schema.TaggedClass<AgentBlocked>()('Blocked', {
  kind: AgentBlockedKind,
  requests: Schema.NonEmptyArray(HitlRequest)
}) {}

/** Finished; the result is in the transcript. Whether a person has seen it is host state. */
export class AgentDone extends Schema.TaggedClass<AgentDone>()('Done', {}) {}

/** Failed and stopped. `error` is absent for failures outside the agent stream (transport). */
export class AgentFailed extends Schema.TaggedClass<AgentFailed>()('Failed', {
  message: Schema.String,
  error: Schema.optional(AgentError)
}) {}

/**
 * What an agent run is doing, in the vocabulary of the OSC 7501 Program Status Protocol: idle,
 * working, blocked on a person, done, or failed. Presentation (labels, badges, notifications,
 * seen/unseen) is host policy.
 */
export const AgentStatus = Schema.Union([
  AgentIdle,
  AgentWorking,
  AgentBlocked,
  AgentDone,
  AgentFailed
])

export type AgentStatus = typeof AgentStatus.Type

export const idleAgentStatus: AgentStatus = AgentIdle.make({})

/** Status of one subagent run started by a `subagent` tool call of the parent run. */
export const SubagentStatusEntry = Schema.Struct({
  subagentRunId: Schema.String,
  parentToolCallId: Schema.String,
  subagentType: Schema.String,
  description: Schema.String,
  /** The host accepted it as background work; its status comes from the host from then on. */
  background: Schema.Boolean,
  status: AgentStatus
})

export type SubagentStatusEntry = typeof SubagentStatusEntry.Type

/** A run's own status plus one entry per subagent, in start order. */
export const AgentStatusTree = Schema.Struct({
  root: AgentStatus,
  subagents: Schema.Array(SubagentStatusEntry)
})

export type AgentStatusTree = typeof AgentStatusTree.Type

export const initialAgentStatusTree: AgentStatusTree = { root: idleAgentStatus, subagents: [] }

export const hitlRequestBlockedKind = (request: HitlRequest): AgentBlockedKind =>
  Match.value(request).pipe(
    Match.withReturnType<AgentBlockedKind>(),
    Match.tagsExhaustive({
      ToolApprovalRequest: () => 'permission',
      InteractionRequest: () => 'permission',
      QuestionRequest: () => 'question',
      InputRequest: () => 'question'
    })
  )

const blockedKindRank: Record<AgentBlockedKind, number> = { question: 0, permission: 1, auth: 2 }

/** One kind for a batch of requests: `auth` over `permission` over `question`. */
export const agentBlockedKind = (
  requests: readonly [HitlRequest, ...Array<HitlRequest>]
): AgentBlockedKind =>
  requests
    .map(hitlRequestBlockedKind)
    .reduce((kind, next) => (blockedKindRank[next] > blockedKindRank[kind] ? next : kind))

/** Still running or waiting on a person, as opposed to settled (idle, done, or failed). */
export const isAgentStatusLive = (status: AgentStatus) =>
  Predicate.isTagged(status, 'Working') || Predicate.isTagged(status, 'Blocked')

/** The pending retry while the status is `Working(Retrying)`. */
export const agentStatusRetry = (status: AgentStatus): AgentRetry | undefined =>
  Predicate.isTagged(status, 'Working') && Predicate.isTagged(status.activity, 'Retrying')
    ? status.activity.retry
    : undefined

const busy = AgentWorking.make({ activity: AgentBusy.make({}) })

const generating = AgentWorking.make({ activity: AgentGenerating.make({}) })

const activityOf = (status: AgentStatus) =>
  Predicate.isTagged(status, 'Working') ? status.activity : undefined

const withToolStarted = (status: AgentStatus, call: ToolCall): AgentStatus => {
  const activity = activityOf(status)
  const started = { toolCallId: call.id, name: call.name }

  if (!Predicate.isTagged(activity, 'Tools')) {
    return AgentWorking.make({ activity: AgentRunningTools.make({ calls: [started] }) })
  }

  if (activity.calls.some(running => running.toolCallId === call.id)) {
    return status
  }

  return AgentWorking.make({
    activity: AgentRunningTools.make({ calls: [...activity.calls, started] })
  })
}

const withToolSettled = (status: AgentStatus, call: ToolCall): AgentStatus => {
  const activity = activityOf(status)

  if (!Predicate.isTagged(activity, 'Tools')) {
    return status
  }

  const [first, ...rest] = activity.calls.filter(running => running.toolCallId !== call.id)

  if (first === undefined) {
    return busy
  }

  return rest.length + 1 === activity.calls.length
    ? status
    : AgentWorking.make({ activity: AgentRunningTools.make({ calls: [first, ...rest] }) })
}

const statusFromAgentError = (error: AgentError): AgentStatus =>
  error.code === 'aborted' && (error.abortReason === undefined || error.abortReason === 'user')
    ? idleAgentStatus
    : AgentFailed.make({ message: error.message, error })

/**
 * Applies one event to a run's status. Callers dedupe replayed events by `eventId`. Work events
 * (start, turn, stream, tool, compaction, retry) mean the run is working whatever the previous
 * status was, so a resumed durable stream recovers from `Blocked` even without `AgentStart`.
 */
export const nextAgentStatus = (status: AgentStatus, event: AgentEvent): AgentStatus =>
  Match.value(event).pipe(
    Match.withReturnType<AgentStatus>(),
    Match.tag('AgentStart', 'TurnStart', () => busy),
    Match.tag('LLMStreamStart', () => generating),
    Match.tag('LLMStreamEnd', () =>
      Predicate.isTagged(activityOf(status), 'Generating') ? busy : status
    ),
    Match.tag(
      'LLMTextDelta',
      'LLMReasoningDelta',
      'LLMReasoningReplay',
      'ToolInputStart',
      'ToolInputDelta',
      'ToolInputEnd',
      () => (Predicate.isTagged(activityOf(status), 'Retrying') ? generating : status)
    ),
    Match.tag('ToolExecutionStarted', current => withToolStarted(status, current.call)),
    Match.tag('ToolExecutionAccepted', 'ToolExecutionCompleted', 'ToolExecutionError', current =>
      withToolSettled(status, current.call)
    ),
    Match.tag('CompactionStart', current =>
      AgentWorking.make({ activity: AgentCompacting.make({ strategy: current.strategy }) })
    ),
    Match.tag('CompactionEnd', () =>
      Predicate.isTagged(activityOf(status), 'Compacting') ? busy : status
    ),
    Match.tag('AgentRetry', current =>
      AgentWorking.make({ activity: AgentRetrying.make({ retry: current }) })
    ),
    Match.tag('AgentAwaitingInput', current =>
      AgentBlocked.make({ kind: agentBlockedKind(current.requests), requests: current.requests })
    ),
    Match.tag('AgentEnd', () => AgentDone.make({})),
    Match.tag('AgentError', statusFromAgentError),
    Match.tag(
      'UsageUpdate',
      'TurnEnd',
      'UserMessage',
      'AssistantMessage',
      'ProviderToolResult',
      'ToolApprovalRequested',
      'ToolApprovalGranted',
      'ToolApprovalDenied',
      'QuestionRequested',
      'QuestionAnswered',
      'QuestionCancelled',
      'InputRequested',
      'InputSubmitted',
      'InputCancelled',
      'InteractionRequested',
      'InteractionSubmitted',
      'InteractionCancelled',
      'SubagentStarted',
      'SubagentCompleted',
      () => status
    ),
    Match.exhaustive
  )

export const agentStatusFromEvents = (
  events: ReadonlyArray<AgentEvent>,
  initial: AgentStatus = idleAgentStatus
): AgentStatus => events.reduce(nextAgentStatus, initial)

/**
 * Applies OSC 7501's lifetime rule to a stored status: `Working` and `Blocked` only hold while the
 * run is alive, so they become `Idle` when the host proves it is not (lease cleared, platform run
 * terminal). `Done` and `Failed` survive until the host replaces them.
 */
export const reconcileAgentStatus = (
  status: AgentStatus,
  options: { readonly runActive: boolean }
): AgentStatus => (!options.runActive && isAgentStatusLive(status) ? idleAgentStatus : status)

const replaceSubagents = (
  tree: AgentStatusTree,
  subagents: ReadonlyArray<SubagentStatusEntry>
): AgentStatusTree => (subagents === tree.subagents ? tree : { root: tree.root, subagents })

const updateSubagent = (
  subagents: ReadonlyArray<SubagentStatusEntry>,
  matches: (entry: SubagentStatusEntry) => boolean,
  update: (entry: SubagentStatusEntry) => SubagentStatusEntry
): ReadonlyArray<SubagentStatusEntry> =>
  subagents.some(matches)
    ? subagents.map(entry => (matches(entry) ? update(entry) : entry))
    : subagents

const withEntryStatus = (
  entry: SubagentStatusEntry,
  status: AgentStatus,
  background = entry.background
): SubagentStatusEntry => ({
  subagentRunId: entry.subagentRunId,
  parentToolCallId: entry.parentToolCallId,
  subagentType: entry.subagentType,
  description: entry.description,
  background,
  status
})

const subagentCompletedStatus = (status: SubagentStatus, summary: string | undefined) =>
  Match.value(status).pipe(
    Match.withReturnType<AgentStatus>(),
    Match.when('running', () => busy),
    Match.when('completed', () => AgentDone.make({})),
    Match.when('error', () => AgentFailed.make({ message: summary ?? 'Subagent failed' })),
    Match.exhaustive
  )

const upsertSubagent = (
  subagents: ReadonlyArray<SubagentStatusEntry>,
  entry: SubagentStatusEntry
): ReadonlyArray<SubagentStatusEntry> =>
  subagents.some(current => current.subagentRunId === entry.subagentRunId)
    ? subagents.map(current => (current.subagentRunId === entry.subagentRunId ? entry : current))
    : [...subagents, entry]

/** Inserts or replaces one subagent entry; hosts use it for background subagents they own. */
export const withSubagentStatus = (
  tree: AgentStatusTree,
  entry: SubagentStatusEntry
): AgentStatusTree => replaceSubagents(tree, upsertSubagent(tree.subagents, entry))

/** A new run starts: the root works and subagents settled in earlier runs are dropped. */
export const startAgentStatusTree = (
  tree: AgentStatusTree,
  root: AgentStatus = busy
): AgentStatusTree => {
  const live = tree.subagents.filter(entry => isAgentStatusLive(entry.status))

  return { root, subagents: live.length === tree.subagents.length ? tree.subagents : live }
}

/**
 * The run stopped with `root` (idle, done, or failed). Inline subagents cannot outlive it, so the
 * live ones become `Idle`; background subagents stay host-owned.
 */
export const settleAgentStatusTree = (
  tree: AgentStatusTree,
  root: AgentStatus
): AgentStatusTree => ({
  root,
  subagents: updateSubagent(
    tree.subagents,
    entry => !entry.background && isAgentStatusLive(entry.status),
    entry => withEntryStatus(entry, idleAgentStatus)
  )
})

/** The host accepted the subagent call as background work and owns the child's status. */
const markBackground = (
  subagents: ReadonlyArray<SubagentStatusEntry>,
  parentToolCallId: string
): ReadonlyArray<SubagentStatusEntry> =>
  updateSubagent(
    subagents,
    entry => entry.parentToolCallId === parentToolCallId && !entry.background,
    entry => withEntryStatus(entry, entry.status, true)
  )

const nextSubagents = (
  subagents: ReadonlyArray<SubagentStatusEntry>,
  event: AgentEvent
): ReadonlyArray<SubagentStatusEntry> =>
  Match.value(event).pipe(
    Match.withReturnType<ReadonlyArray<SubagentStatusEntry>>(),
    Match.tag('SubagentStarted', current =>
      upsertSubagent(subagents, {
        subagentRunId: current.subagentRunId,
        parentToolCallId: current.parentToolCallId,
        subagentType: current.subagentType,
        description: current.description,
        background: false,
        status: busy
      })
    ),
    Match.tag('SubagentCompleted', current =>
      updateSubagent(
        subagents,
        entry => entry.subagentRunId === current.subagentRunId,
        entry => withEntryStatus(entry, subagentCompletedStatus(current.status, current.summary))
      )
    ),
    Match.tag('ToolExecutionAccepted', current => markBackground(subagents, current.call.id)),
    Match.tag('ToolExecutionCompleted', current =>
      isSubagentAcceptedToolResult(current.call.id, current.result)
        ? markBackground(subagents, current.call.id)
        : subagents
    ),
    Match.tag('ToolExecutionError', current =>
      updateSubagent(
        subagents,
        entry =>
          entry.parentToolCallId === current.call.id &&
          !entry.background &&
          isAgentStatusLive(entry.status),
        entry => withEntryStatus(entry, AgentFailed.make({ message: current.message }))
      )
    ),
    Match.orElse(() => subagents)
  )

/** Applies one event to a run's status and its subagents' statuses. */
export const nextAgentStatusTree = (tree: AgentStatusTree, event: AgentEvent): AgentStatusTree => {
  const root = nextAgentStatus(tree.root, event)

  if (Predicate.isTagged(event, 'AgentStart')) {
    return startAgentStatusTree(tree, root)
  }

  if (Predicate.isTagged(event, 'AgentEnd') || Predicate.isTagged(event, 'AgentError')) {
    return settleAgentStatusTree(tree, root)
  }

  const subagents = nextSubagents(tree.subagents, event)

  return root === tree.root && subagents === tree.subagents ? tree : { root, subagents }
}

export const agentStatusTreeFromEvents = (
  events: ReadonlyArray<AgentEvent>,
  initial: AgentStatusTree = initialAgentStatusTree
): AgentStatusTree => events.reduce(nextAgentStatusTree, initial)
