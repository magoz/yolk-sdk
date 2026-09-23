import { describe, expect, it } from '@effect/vitest'
import { Effect } from 'effect'
import { resolveTools } from '@yolk-sdk/agent/tools'
import { makeConnectorToolModule } from '@yolk-sdk/connectors/agent'
import {
  createGithubAppInstallationToken,
  GithubConnector,
  githubActions,
  uploadGithubAttachment
} from '@yolk-sdk/connectors/github'
import { githubIntegration, makeGithubHost } from './github-fake.ts'

describe('GithubConnector', () => {
  it('declares access on every action and keeps host-only helpers out of actions', () => {
    const ids = GithubConnector.actions.map(action => action.id)

    expect(GithubConnector.id).toBe('github')
    expect(GithubConnector.actions).toBe(githubActions)
    expect(ids).toHaveLength(46)
    expect(new Set(ids).size).toBe(ids.length)
    expect(ids.every(id => id.startsWith('github.'))).toBe(true)

    for (const action of GithubConnector.actions) {
      expect(['read', 'write', 'destructive']).toContain(action.access)
    }

    expect(
      GithubConnector.actions
        .filter(action => action.access === 'destructive')
        .map(action => action.id)
        .sort()
    ).toEqual(['github.delete_issue_comment', 'github.merge_pull_request'])
    expect(ids.some(id => /token|upload|attachment/.test(id))).toBe(false)
    expect(createGithubAppInstallationToken).toBeTypeOf('function')
    expect(uploadGithubAttachment).toBeTypeOf('function')
  })

  it.effect('adapts to agent tools with object-root parameters and no repo inputs', () =>
    Effect.gen(function* () {
      const host = makeGithubHost()

      const resolved = yield* resolveTools(
        [
          makeConnectorToolModule(GithubConnector, {
            integration: githubIntegration(),
            layer: host.layer
          })
        ],
        {}
      )

      expect(resolved.tools).toHaveLength(46)

      for (const tool of resolved.tools) {
        expect(tool.parameters).toMatchObject({ type: 'object' })

        const serialized = JSON.stringify(tool.parameters)

        expect(serialized).not.toContain('"$ref":"#')
        expect(serialized).not.toMatch(/"(owner|repo)":/)
      }
    })
  )
})
