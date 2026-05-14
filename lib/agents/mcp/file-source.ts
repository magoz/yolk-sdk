import { NodeFileSystem, NodePath } from '@effect/platform-node'
import { Effect, FileSystem, Layer, Path } from 'effect'
import * as Schema from 'effect/Schema'
import type { McpRemoteServerConfig } from '@yolk/mcp/client'
import { McpRemoteServerConfigsSchema } from './schema'

const sourceFiles = ['.yolk/mcp.json', '.opencode/mcp.json']

const decodeMcpServers = Schema.decodeUnknownEffect(
  Schema.fromJsonString(McpRemoteServerConfigsSchema)
)

const readOptionalFile = (filePath: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem

    if (!(yield* fs.exists(filePath))) {
      return undefined
    }

    return yield* fs.readFileString(filePath)
  })

const loadProjectMcpServersFromFileSystem = (rootDirectory: string) =>
  Effect.gen(function* () {
    const path = yield* Path.Path
    const files = sourceFiles.map(file => path.join(rootDirectory, file))
    const loaded = yield* Effect.forEach(
      files,
      filePath =>
        Effect.gen(function* () {
          const content = yield* readOptionalFile(filePath)
          if (content === undefined) {
            return []
          }

          return yield* decodeMcpServers(content)
        }),
      { concurrency: 'unbounded' }
    )

    const byName = new Map<string, McpRemoteServerConfig>()
    for (const config of loaded.flat()) {
      byName.set(config.name, config)
    }

    return [...byName.values()]
  })

export const loadProjectMcpServers = (rootDirectory = process.cwd()) =>
  loadProjectMcpServersFromFileSystem(rootDirectory).pipe(
    Effect.provide(Layer.merge(NodeFileSystem.layer, NodePath.layer))
  )
