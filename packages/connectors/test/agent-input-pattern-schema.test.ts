import { Effect, Layer } from 'effect'
import { describe, expect, it } from '@effect/vitest'
import {
  ConnectorError,
  ConnectorHttpClient,
  CredentialResolver,
  makeIntegration,
  type Connector
} from '@yolk-sdk/connectors'
import { makeConnectorToolRegistration } from '@yolk-sdk/connectors/agent'
import { DropboxConnector } from '@yolk-sdk/connectors/dropbox'
import { FortnoxConnector } from '@yolk-sdk/connectors/fortnox'
import { GithubConnector } from '@yolk-sdk/connectors/github'

// Lowering a tool never touches the host; these services fail if anything invokes them.
const unusedHost = Layer.mergeAll(
  Layer.succeed(CredentialResolver, {
    resolve: () =>
      Effect.fail(
        new ConnectorError({ cause: 'credential_missing', message: 'Unexpected credential' })
      )
  }),
  Layer.succeed(ConnectorHttpClient, {
    request: () =>
      Effect.fail(new ConnectorError({ cause: 'transport_failed', message: 'Unexpected request' }))
  })
)

// Effect 4 exports `Schema.isPattern` to JSON Schema only for Unicode-mode (`u`) regexes. These
// model-visible hints must survive tool lowering; runtime decoding stays authoritative.
const parametersOf = <E>(
  connector: Connector<CredentialResolver | ConnectorHttpClient, E>,
  connectorId: string,
  actionId: string
) =>
  makeConnectorToolRegistration(connector, actionId, {
    integration: makeIntegration({ connectorId }),
    layer: unusedHost
  }).def.parameters

describe('connector tool input pattern hints', () => {
  it('advertises the Dropbox revision pattern', () => {
    expect(parametersOf(DropboxConnector, 'dropbox', 'dropbox.delete')).toMatchObject({
      properties: {
        parentRev: { anyOf: [{ type: 'string', pattern: '^[0-9a-f]{9,}$' }, { type: 'null' }] }
      }
    })
  })

  it('advertises the GitHub commit SHA pattern', () => {
    expect(parametersOf(GithubConnector, 'github', 'github.merge_pull_request')).toMatchObject({
      properties: {
        expectedHeadSha: { type: 'string', pattern: '^[0-9a-f]{40}([0-9a-f]{24})?$' }
      }
    })
  })

  it('advertises the BMP-only Fortnox identifier pattern', () => {
    expect(parametersOf(FortnoxConnector, 'fortnox', 'fortnox.get_customer')).toMatchObject({
      properties: {
        customerNumber: {
          type: 'string',
          allOf: [{ pattern: String.raw`^(?!\.{1,2}$)[\u0020-\u007e\u0080-\ud7ff\ue000-\uffff]+$` }]
        }
      }
    })
  })
})
