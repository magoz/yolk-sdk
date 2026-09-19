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
