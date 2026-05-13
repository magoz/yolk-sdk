import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { Effect } from 'effect'
import { describe, expect, it } from '@effect/vitest'
import { loadProjectMcpServers } from './file-source'

const makeTempRoot = () => Effect.promise(() => mkdtemp(join(tmpdir(), 'yolk-mcp-')))

describe('MCP file source', () => {
  it.effect('loads remote MCP servers from project file', () =>
    Effect.gen(function* () {
      const root = yield* makeTempRoot()
      const directory = join(root, '.yolk')
      yield* Effect.promise(() => mkdir(directory, { recursive: true }))
      yield* Effect.promise(() =>
        writeFile(
          join(directory, 'mcp.json'),
          JSON.stringify([
            {
              name: 'docs',
              type: 'remote',
              url: 'https://example.com/mcp',
              headers: { Authorization: 'Bearer token' }
            }
          ])
        )
      )

      const servers = yield* loadProjectMcpServers(root)

      expect(servers).toEqual([
        {
          name: 'docs',
          type: 'remote',
          url: 'https://example.com/mcp',
          headers: { Authorization: 'Bearer token' }
        }
      ])
    })
  )
})
