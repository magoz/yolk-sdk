import { Effect } from 'effect'
import { describe, expect, it } from '@effect/vitest'
import { ToolResult } from '@yolk-sdk/agent/protocol'
import { makeQuestionToolModule, questionToolName, resolveTools } from '../../src/tools'

type TestContext = {
  readonly sessionId: string
}

describe('question tool', () => {
  it.effect('resolves and executes structured user questions', () =>
    Effect.gen(function* () {
      const toolSet = yield* resolveTools(
        [
          makeQuestionToolModule<TestContext>({
            execute: ({ call, context, params }) =>
              Effect.succeed(
                ToolResult.make({
                  toolCallId: call.id,
                  content: `${context.sessionId}:${params.questions[0]?.prompt ?? ''}`
                })
              )
          })
        ],
        { sessionId: 'session_1' }
      )
      const result = yield* toolSet.execute({
        id: 'call_1',
        name: questionToolName,
        params: {
          questions: [
            {
              id: 'choice',
              prompt: 'Pick one',
              options: [{ id: 'a', label: 'A' }],
              allowCustom: true
            }
          ]
        }
      })

      expect(toolSet.tools.map(tool => tool.name)).toEqual([questionToolName])
      expect(toolSet.tools[0]?.description).toContain('Ask the user')
      expect(toolSet.tools[0]?.parameters).toMatchObject({ type: 'object' })
      expect(result.content).toBe('session_1:Pick one')
    })
  )

  it.effect('returns model-visible errors for empty question lists', () =>
    Effect.gen(function* () {
      const toolSet = yield* resolveTools(
        [
          makeQuestionToolModule<TestContext>({
            execute: ({ call }) =>
              Effect.succeed(ToolResult.make({ toolCallId: call.id, content: 'unused' }))
          })
        ],
        { sessionId: 'session_1' }
      )
      const result = yield* toolSet.execute({
        id: 'call_1',
        name: questionToolName,
        params: { questions: [] }
      })

      expect(result).toMatchObject({
        toolCallId: 'call_1',
        content: expect.stringContaining('Invalid question arguments'),
        isError: true
      })
    })
  )
})
