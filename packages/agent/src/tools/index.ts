export type { BackgroundToolHost } from './background.ts'

export {
  EmptyToolParams,
  makeTool,
  makeToolExecutorLayer,
  modelVisibleToolError,
  modelVisibleToolErrorResult,
  modelVisibleToolErrorStructuredContent,
  ModelVisibleToolError,
  ModelVisibleToolErrorReason,
  ModelVisibleToolErrorStructuredContentSchema,
  resolveTools,
  ToolAccess,
  ToolRegistryError,
  toolJsonSchemaFromSchema
} from './registry.ts'

export { omitNullOptionalToolArguments } from './arguments.ts'

export {
  abandonedToolCallResult,
  classifyToolLedgerEntry,
  defaultToolLedgerLeaseMs,
  defaultToolLedgerMaxResultBytes,
  defaultToolLedgerMaxWaitMs,
  defaultToolLedgerPolicy,
  defaultToolLedgerPollIntervalMs,
  makeInMemoryToolLedgerStore,
  sortToolLedgerEntries,
  toolIdempotencyKey,
  ToolLedgerClaim,
  toolLedgerCompleteTimeoutMs,
  ToolLedgerEntry,
  ToolLedgerError,
  ToolLedgerFailed,
  ToolLedgerFailure,
  toolLedgerArgs,
  toolLedgerMaxArgsBytes,
  ToolLedgerOutcome,
  toolLedgerResult,
  ToolLedgerSucceeded
} from './ledger.ts'

export type {
  InMemoryToolLedgerStore,
  ToolLedgerAbandonedInput,
  ToolLedgerArgs,
  ToolLedgerClaimRequest,
  ToolLedgerDecision,
  ToolLedgerDecisionEvent,
  ToolLedgerErrorDetails,
  ToolLedgerHeartbeatRequest,
  ToolLedgerOptions,
  ToolLedgerPolicyInput,
  ToolLedgerStore
} from './ledger.ts'

export {
  defaultToolPlanMaxArgsBytes,
  defaultToolPlanMaxCalls,
  makeInMemoryToolPlanStore,
  maxToolPlanPreviewBytes,
  maxToolPlanPreviewKeys,
  StagedCall,
  stagedCallDigest,
  ToolPlan,
  ToolPlanClaimResult,
  toolPlanDigest,
  toolPlanIntegrityProblem,
  ToolPlanPreviewError,
  ToolPlanReviewParams,
  ToolPlanReviewResponse,
  ToolPlanStageError,
  ToolPlanStageErrorReason,
  ToolPlanStoreError
} from './plan.ts'

export type {
  InMemoryToolPlanStore,
  ResolvedToolPlans,
  StagedCallReceipt,
  StoredToolPlan,
  ToolPlanApplyResult,
  ToolPlanBeforeCall,
  ToolPlanBuilder,
  ToolPlanCallCounts,
  ToolPlanCallOutcome,
  ToolPlanCallStatus,
  ToolPlanFailurePolicy,
  ToolPlanOptions,
  ToolPlanOutcome,
  ToolPlanPreview,
  ToolPlanRuntime,
  ToolPlanStaging,
  ToolPlanStore,
  ToolStaging,
  ToolStagingHandlers
} from './plan.ts'

export {
  makePlanReviewTool,
  previewToolPlan,
  toolPlanReviewActionId,
  toolPlanReviewRenderer,
  toolPlanReviewToolName
} from './plan-review.ts'

export type { MakePlanReviewToolOptions } from './plan-review.ts'

export { withToolArgumentsErrorHint } from '../protocol/tool-argument-hints.ts'

export { makeInputTool, makeInputToolDef, makeInputToolModule } from './input.ts'

export type { MakeInputToolOptions, InputToolModule } from './input.ts'

export { makeInteractionTool, makeInteractionToolModule } from './interaction.ts'

export type {
  InteractionActionDefinition,
  InteractionActionExecute,
  InteractionActionResult,
  InteractionActionValidate,
  InteractionToolModule,
  MakeInteractionToolOptions
} from './interaction.ts'

export {
  makeQuestionToolDef,
  makeQuestionToolModule,
  makeQuestionToolRegistration,
  questionToolName
} from './question.ts'

export {
  formatSubagentResult,
  makeNonRecursiveSubagentToolModule,
  makeSubagentToolResult,
  makeSubagentAcceptedToolResult,
  makeSubagentToolDef,
  makeSubagentToolModule,
  makeSubagentToolRegistration,
  subagentResultFromEvents,
  subagentResultText,
  subagentToolName,
  subagentUsageFromToolResult,
  subagentToolRunId
} from './subagent.ts'

export type {
  ResolvedInputTool,
  ResolvedInteractionTool,
  ResolvedToolSet,
  SchemaToolExecutionInput,
  InteractionActionHandler,
  InteractionToolRegistration,
  ModelVisibleToolErrorInput,
  ModelVisibleToolErrorStructuredContent,
  NestedTool,
  NestedToolDescriber,
  NestedToolExecutor,
  NestedToolStagingDescription,
  ToolExecutionInput,
  ToolMetadata,
  ToolModule,
  ToolRegistration
} from './registry.ts'

export type { ToolExecutionOptions } from './registry.ts'

export type { QuestionExecutionInput, QuestionToolOptions } from './question.ts'

export type {
  SubagentExecutionInput,
  SubagentModelDefinition,
  SubagentReasoningEffortDefinition,
  SubagentRuntimeSelectionOptions,
  SubagentContext,
  SubagentDefinition,
  SubagentRunError,
  SubagentRunResult,
  SubagentRunStatus,
  SubagentToolOptions,
  SubagentToolParams,
  SubagentToolResultInput
} from './subagent.ts'
