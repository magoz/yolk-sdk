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
  ToolLedgerClaimRequest,
  ToolLedgerErrorDetails,
  ToolLedgerOptions,
  ToolLedgerPolicyInput,
  ToolLedgerStore
} from './ledger.ts'

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
