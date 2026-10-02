// @vitest-environment node
import { ConfigProvider, Effect, Layer, Predicate, Result, Schema } from 'effect'
import { describe, expect, it } from '@effect/vitest'
import {
  ClassifierModel,
  type ClassificationRequest,
  type ClassificationResult
} from '@yolk-sdk/agent/classification'
import {
  contentPartText,
  providerToolDefs,
  ToolCall,
  ToolResult,
  type Content
} from '@yolk-sdk/agent/protocol'
import { makeTool, type ToolModule } from '@yolk-sdk/agent/tools'
import { agentCodeModeModelOnlyTools, withAgentCodeMode } from './codemode-tool-modules.ts'
import { nodeTextToolModules } from './tools/registry.ts'
import { resolveAgentToolSet } from './tools/resolve-toolset.ts'
import type { AgentToolContext } from './tools/tool-context.ts'

const context: AgentToolContext = {
  surface: 'text',
  route: '/agent/next',
  userId: 'user_1',
  // Enables the `skill` tool.
  skillset: {
    skills: [
      {
        name: 'review-code',
        description: 'Review code carefully',
        location: '.opencode/skills/review-code/SKILL.md',
        content: 'Check types and tests.'
      }
    ],
    commands: []
  }
}

// Replaces the whole environment, so local AI Gateway credentials never leak into these tests.
const withEnv = <A, E, R>(effect: Effect.Effect<A, E, R>, env: Readonly<Record<string, string>>) =>
  Effect.provide(effect, ConfigProvider.layer(ConfigProvider.fromEnv({ env })))

const answer = (request: ClassificationRequest): ClassificationResult => ({
  model: 'synthetic/classifier',
  answers: Object.fromEntries(
    Object.keys(request.questions).map(id => [id, { type: 'boolean', probability: 0.9 }])
  ),
  usage: { inputTokens: 10, outputTokens: 0 }
})

const fakeClassifierLayer = Layer.succeed(
  ClassifierModel,
  ClassifierModel.of({ classify: request => Effect.succeed(answer(request)) })
)

const resolvedNames = (modules: ReadonlyArray<ToolModule<AgentToolContext>>) =>
  resolveAgentToolSet({ modules, context }).pipe(
    Effect.map(toolSet => toolSet.tools.map(tool => tool.name))
  )

const text = (content: Content) =>
  Predicate.isString(content) ? content : content.map(contentPartText).join('\n')

describe('withAgentCodeMode', () => {
  it.effect('returns the tool modules unchanged when the flag is absent or off', () =>
    Effect.gen(function* () {
      const envs: ReadonlyArray<Readonly<Record<string, string>>> = [
        {},
        { YOLK_CODEMODE: '' },
        { YOLK_CODEMODE: 'false' }
      ]

      for (const env of envs) {
        const modules = yield* withEnv(withAgentCodeMode(nodeTextToolModules), {
          ...env,
          AI_GATEWAY_API_KEY: 'test-key'
        })

        expect(modules).toBe(nodeTextToolModules)

        const names = yield* resolvedNames(modules)

        expect(names).not.toContain('codemode')
        expect(names).not.toContain('classify')
      }
    })
  )

  it.effect('rejects an invalid flag value', () =>
    Effect.gen(function* () {
      const result = yield* withEnv(withAgentCodeMode(nodeTextToolModules), {
        YOLK_CODEMODE: 'maybe'
      }).pipe(Effect.result)

      expect(Result.isFailure(result)).toBe(true)

      if (Result.isFailure(result)) {
        expect(result.failure._tag).toBe('AgentCodeModeConfigError')
      }
    })
  )

  it.effect('adds code mode without a classifier when AI Gateway credentials are absent', () =>
    Effect.gen(function* () {
      const modules = yield* withEnv(withAgentCodeMode(nodeTextToolModules), {
        YOLK_CODEMODE: 'true'
      })

      const toolSet = yield* resolveAgentToolSet({ modules, context })
      const names = toolSet.tools.map(tool => tool.name)

      expect(names).toContain('codemode')
      expect(names).not.toContain('classify')
      expect(names).toEqual(expect.arrayContaining(['web_fetch', 'just_bash', 'question']))

      const def = (name: string) => toolSet.tools.find(tool => tool.name === name)

      expect(def('skill')?.callableBy).toBe('model')
      expect(def('web_fetch')?.callableBy).toBeUndefined()
      expect(def('just_bash')?.callableBy).toBeUndefined()

      const description = def('codemode')?.description ?? ''

      expect(description).toContain('tools.web_fetch(args)')
      expect(description).toContain('tools.just_bash(args)')
      expect(description).not.toContain('tools.skill(')
      expect(description).not.toContain('tools.question(')
      expect(description).not.toContain('tools.compose_draft(')
    })
  )

  it.effect('marks only the model-only tools and leaves the input modules untouched', () =>
    Effect.gen(function* () {
      const modules = yield* withEnv(withAgentCodeMode(nodeTextToolModules), {
        YOLK_CODEMODE: 'true'
      })

      const changed = modules
        .flatMap(module => module.tools)
        .filter(tool => tool.def.callableBy === 'model')
        .map(tool => tool.def.name)

      expect(changed).toEqual(['skill'])
      expect(changed.every(name => agentCodeModeModelOnlyTools.has(name))).toBe(true)

      expect(
        nodeTextToolModules.flatMap(module => module.tools).map(tool => tool.def.callableBy)
      ).toEqual(nodeTextToolModules.flatMap(module => module.tools).map(() => undefined))
    })
  )

  it.effect('adds a code-mode-only classifier when AI Gateway credentials are configured', () =>
    Effect.gen(function* () {
      const envs: ReadonlyArray<Readonly<Record<string, string>>> = [
        { AI_GATEWAY_API_KEY: 'test-key' },
        { VERCEL_OIDC_TOKEN: 'oidc' }
      ]

      for (const env of envs) {
        const modules = yield* withEnv(withAgentCodeMode(nodeTextToolModules), {
          YOLK_CODEMODE: 'true',
          ...env
        })

        const toolSet = yield* resolveAgentToolSet({ modules, context })
        const names = toolSet.tools.map(tool => tool.name)

        expect(names).toEqual(expect.arrayContaining(['codemode', 'classify']))
        expect(providerToolDefs(toolSet.tools).map(tool => tool.name)).not.toContain('classify')
        expect(toolSet.tools.find(tool => tool.name === 'codemode')?.description).toContain(
          'classify'
        )
      }
    })
  )

  it.live('runs scripts with the pi executor through the resolved tool set', () =>
    Effect.gen(function* () {
      const modules = yield* withEnv(
        withAgentCodeMode(nodeTextToolModules, { classifierLayer: fakeClassifierLayer }),
        { YOLK_CODEMODE: 'true' }
      )

      const toolSet = yield* resolveAgentToolSet({ modules, context })

      const result = yield* toolSet.execute(
        ToolCall.make({
          id: 'call_1',
          name: 'codemode',
          params: {
            code: `const answer = await tools.classify({
                     state: 'Server is down',
                     questions: { urgent: { type: 'boolean', instructions: 'Is this urgent?' } }
                   })
                   let skillError = ''
                   try { await tools.skill({ name: 'review-code' }) } catch (error) { skillError = String(error) }
                   return { probability: answer.answers.urgent.probability, skillBlocked: skillError.length > 0 }`
          }
        })
      )

      expect(result.isError).toBeUndefined()
      expect(text(result.content)).toContain(
        'Return value:\n{"probability":0.9,"skillBlocked":true}'
      )
      expect(result.nestedCalls?.calls.map(call => [call.name, call.status])).toEqual([
        ['classify', 'ok']
      ])
    })
  )

  it.live('runs the run-admission guard before every nested call (Workflow stop)', () =>
    Effect.gen(function* () {
      const executed: Array<string> = []
      let stopped = false

      const Params = Schema.Struct({ step: Schema.String })

      const probeModule: ToolModule<AgentToolContext> = {
        id: 'probe',
        tools: [
          makeTool<AgentToolContext, typeof Params>({
            name: 'probe',
            description: 'Records a step',
            access: 'write',
            parameters: Params,
            execute: ({ call, params }) =>
              Effect.sync(() => {
                executed.push(params.step)
                // The user stops the run while the script is still going.
                stopped = true

                return ToolResult.make({ toolCallId: call.id, content: `did ${params.step}` })
              })
          })
        ]
      }

      const modules = yield* withEnv(
        withAgentCodeMode([probeModule], {
          beforeNestedCall: () =>
            stopped ? Effect.fail('Workflow execution is stopped or unavailable') : Effect.void
        }),
        { YOLK_CODEMODE: 'true' }
      )

      const toolSet = yield* resolveAgentToolSet({ modules, context })

      const result = yield* toolSet.execute(
        ToolCall.make({
          id: 'call_stop',
          name: 'codemode',
          params: {
            code: `await tools.probe({ step: 'first' })
                   let second = 'ran'
                   try { await tools.probe({ step: 'second' }) } catch (error) { second = String(error) }
                   return second`
          }
        })
      )

      expect(executed).toEqual(['first'])
      expect(text(result.content)).toContain('Workflow execution is stopped or unavailable')
      expect(result.nestedCalls?.calls.map(call => [call.name, call.status])).toEqual([
        ['probe', 'ok'],
        ['probe', 'error']
      ])
    })
  )
})
