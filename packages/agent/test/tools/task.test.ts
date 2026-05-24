import { Effect } from 'effect'
import { describe, expect, it } from '@effect/vitest'
import {
  AgentEnd,
  AssistantAgentMessage,
  AssistantTextPart,
  makeSubagentRunId,
  ToolResult
} from '@yolk-sdk/agent/protocol'
import {
  formatTaskResult,
  makeNonRecursiveTaskToolModule,
  makeTaskToolResult,
  makeTaskToolModule,
  resolveTools,
  subagentResultText,
  taskSubagentRunId,
  taskToolName,
  type TaskSubagentDefinition
} from '../../src/tools'

type TestContext = {
  readonly sessionId: string
  readonly subagent?: boolean
}

const subagents: ReadonlyArray<TaskSubagentDefinition> = [
  { name: 'explore', description: 'Explore code and docs.' },
  { name: 'general', description: 'Handle complex multi-step work.' }
]

describe('task tool', () => {
  it.effect('resolves task tool with subagent metadata', () =>
    Effect.gen(function* () {
      const toolSet = yield* resolveTools(
        [
          makeTaskToolModule<TestContext>({
            subagents,
            execute: ({ call }) =>
              Effect.succeed(ToolResult.make({ toolCallId: call.id, content: 'unused' }))
          })
        ],
        { sessionId: 'session_1' }
      )

      expect(toolSet.tools.map(tool => tool.name)).toEqual([taskToolName])
      expect(toolSet.tools[0]?.description).toContain('explore')
      expect(toolSet.tools[0]?.description).toContain('call this task tool multiple times')
      expect(toolSet.tools[0]?.description).toContain('runs same-turn task calls concurrently')
      expect(toolSet.tools[0]?.description).not.toContain('multi_tool_use')
      expect(toolSet.metadata).toEqual([{ moduleId: 'task', name: taskToolName, access: 'read' }])
    })
  )

  it.effect('executes a known subagent task', () =>
    Effect.gen(function* () {
      const toolSet = yield* resolveTools(
        [
          makeTaskToolModule<TestContext>({
            subagents,
            execute: ({ call, context, params }) =>
              Effect.succeed(
                ToolResult.make({
                  toolCallId: call.id,
                  content: formatTaskResult(
                    `${context.sessionId}:${params.subagent_type}:${params.description}:${params.prompt}`
                  )
                })
              )
          })
        ],
        { sessionId: 'session_1' }
      )
      const result = yield* toolSet.execute({
        id: 'call_1',
        name: taskToolName,
        params: {
          description: 'Find auth',
          prompt: 'Explore auth flow',
          subagent_type: 'explore'
        }
      })

      expect(result.content).toBe('<task_result>\nsession_1:explore:Find auth:Explore auth flow\n</task_result>')
    })
  )

  it.effect('rejects unknown subagent types', () =>
    Effect.gen(function* () {
      const toolSet = yield* resolveTools(
        [
          makeTaskToolModule<TestContext>({
            subagents,
            execute: ({ call }) =>
              Effect.succeed(ToolResult.make({ toolCallId: call.id, content: 'unused' }))
          })
        ],
        { sessionId: 'session_1' }
      )
      const result = yield* toolSet
        .execute({
          id: 'call_1',
          name: taskToolName,
          params: {
            description: 'Find auth',
            prompt: 'Explore auth flow',
            subagent_type: 'missing'
          }
        })
        .pipe(Effect.result)

      expect(result).toMatchObject({
        _tag: 'Failure',
        failure: { _tag: 'ToolError', cause: 'validation' }
      })
    })
  )

  it.effect('rejects empty prompts', () =>
    Effect.gen(function* () {
      const toolSet = yield* resolveTools(
        [
          makeTaskToolModule<TestContext>({
            subagents,
            execute: ({ call }) =>
              Effect.succeed(ToolResult.make({ toolCallId: call.id, content: 'unused' }))
          })
        ],
        { sessionId: 'session_1' }
      )
      const result = yield* toolSet
        .execute({
          id: 'call_1',
          name: taskToolName,
          params: {
            description: 'Find auth',
            prompt: ' ',
            subagent_type: 'explore'
          }
        })
        .pipe(Effect.result)

      expect(result).toMatchObject({
        _tag: 'Failure',
        failure: { _tag: 'ToolError', cause: 'validation' }
      })
    })
  )

  it.effect('can hide the task tool from subagents', () =>
    Effect.gen(function* () {
      const toolSet = yield* resolveTools(
        [
          makeNonRecursiveTaskToolModule<TestContext>({
            subagents,
            execute: ({ call }) =>
              Effect.succeed(ToolResult.make({ toolCallId: call.id, content: 'unused' }))
          })
        ],
        { sessionId: 'session_1', subagent: true }
      )

      expect(toolSet.tools).toEqual([])
    })
  )

  it.effect('composes non-recursive gating with host gating', () =>
    Effect.gen(function* () {
      const taskModule = makeNonRecursiveTaskToolModule<TestContext>({
        subagents,
        isEnabled: context => Effect.succeed(context.sessionId === 'enabled_session'),
        execute: ({ call }) =>
          Effect.succeed(ToolResult.make({ toolCallId: call.id, content: 'unused' }))
      })

      const disabledTopLevelTools = yield* resolveTools([taskModule], { sessionId: 'disabled_session' })
      const enabledTopLevelTools = yield* resolveTools([taskModule], { sessionId: 'enabled_session' })
      const enabledSubagentTools = yield* resolveTools([taskModule], {
        sessionId: 'enabled_session',
        subagent: true
      })

      expect(disabledTopLevelTools.tools).toEqual([])
      expect(enabledTopLevelTools.tools.map(tool => tool.name)).toEqual([taskToolName])
      expect(enabledSubagentTools.tools).toEqual([])
    })
  )

  it('formats structured task tool results', () => {
    const result = makeTaskToolResult({
      callId: 'call_1',
      output: 'Found docs.',
      subagentType: 'explore',
      description: 'Find docs',
      subagentRunId: taskSubagentRunId('call_1'),
      startedAtMs: 100,
      endedAtMs: 250,
      model: 'test-model'
    })

    expect(result).toMatchObject({
      toolCallId: 'call_1',
      content: '<task_result>\nFound docs.\n</task_result>',
      structuredContent: {
        subagent_run_id: 'subagent:call_1',
        subagent_type: 'explore',
        description: 'Find docs',
        duration_ms: 150,
        status: 'completed',
        model: 'test-model'
      }
    })
    expect(taskSubagentRunId('call_1')).toBe(makeSubagentRunId('call_1'))
  })

  it('extracts final subagent assistant text', () => {
    const text = subagentResultText([
      AgentEnd.make({
        messages: [
          AssistantAgentMessage.make({
            parts: [AssistantTextPart.make({ content: 'Done.' })]
          })
        ],
        turns: 1,
        usage: { input: { total: 0 }, output: { total: 0 } }
      })
    ])

    expect(text).toBe('Done.')
  })
})
