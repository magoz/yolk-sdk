import { Effect } from 'effect'
import { describe, expect, it } from '@effect/vitest'
import { makeMcpToolModule } from './mcp-tool-module'

describe('MCP tool module', () => {
  it.effect('does not read MCP config from env', () =>
    Effect.gen(function* () {
      const toolModule = yield* makeMcpToolModule([])

      expect(toolModule.tools).toEqual([])
    })
  )
})
