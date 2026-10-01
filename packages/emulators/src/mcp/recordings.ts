/**
 * The synthetic MCP conformance fixtures, copied as data (internal; never imported from
 * `@yolk-sdk/mcp`): the sixteen `WireFixture`s of `mcpConformanceFixtures` in
 * `@yolk-sdk/mcp/conformance`, in its order, on the two synthetic servers
 * `https://mcp.example.test/modern/mcp` and `https://mcp.example.test/legacy/mcp`.
 * `test/mcp.test.ts` fails when this copy drifts from the source and replays every exchange
 * against the emulator byte for byte. Every value is synthetic; no fixture records
 * `authorization`.
 *
 * @experimental
 */
import type * as Schema from 'effect/Schema'

/** One recorded request: method, URL, the MCP routing and session headers, the JSON-RPC body. */
export type McpRecordedRequest = {
  readonly method: string
  readonly url: string
  readonly headers: Readonly<Record<string, string>>
  readonly body?: Schema.Json
}

/** One recorded answer: a whole text body, or SSE chunks (chunk boundaries kept). */
export type McpRecordedResponse =
  | {
      readonly status: number
      readonly headers: Readonly<Record<string, string>>
      readonly body: string
    }
  | {
      readonly status: number
      readonly headers: Readonly<Record<string, string>>
      readonly chunks: ReadonlyArray<string>
    }

export type McpRecordedExchange = {
  readonly request: McpRecordedRequest
  readonly response: McpRecordedResponse
}

/** A copied fixture (the `WireFixture` fields, as data). */
export type McpRecordedFixture = {
  readonly id: string
  readonly caseId: string
  readonly evidence: 'unverified'
  readonly recordedAt: string
  readonly account: string
  readonly endpoint: string
  readonly note: string
  readonly exchanges: ReadonlyArray<McpRecordedExchange>
}

/** Every synthetic MCP fixture, in the order of `mcpConformanceFixtures`. */
export const mcpEmulatorFixtures: ReadonlyArray<McpRecordedFixture> = [
  {
    id: 'mcp.negotiation.era.modern.synthetic',
    caseId: 'mcp.negotiation.era',
    evidence: 'unverified',
    recordedAt: '2026-10-01',
    account: 'synthetic',
    endpoint: 'https://mcp.example.test/modern/mcp',
    note: 'server/discover answered with supportedVersions ["2026-07-28"]; the client then lists tools statelessly. Synthetic placeholder shaped like the MCP wire the pinned SDK speaks; not recorded from a live service.',
    exchanges: [
      {
        request: {
          method: 'POST',
          url: 'https://mcp.example.test/modern/mcp',
          headers: {
            accept: 'application/json, text/event-stream',
            'content-type': 'application/json',
            'mcp-method': 'server/discover',
            'mcp-protocol-version': '2026-07-28'
          },
          body: {
            jsonrpc: '2.0',
            id: 'server-discover-probe-1',
            method: 'server/discover',
            params: {
              _meta: {
                'io.modelcontextprotocol/protocolVersion': '2026-07-28',
                'io.modelcontextprotocol/clientInfo': {
                  name: 'yolk',
                  version: '0.1.0'
                },
                'io.modelcontextprotocol/clientCapabilities': {}
              }
            }
          }
        },
        response: {
          status: 200,
          headers: {
            'content-type': 'application/json'
          },
          body: '{"jsonrpc":"2.0","id":"server-discover-probe-1","result":{"supportedVersions":["2026-07-28"],"capabilities":{"tools":{}},"resultType":"complete","ttlMs":0,"cacheScope":"private","_meta":{"io.modelcontextprotocol/serverInfo":{"name":"yolk-synthetic-mcp","version":"0.0.0"}}}}'
        }
      },
      {
        request: {
          method: 'POST',
          url: 'https://mcp.example.test/modern/mcp',
          headers: {
            accept: 'application/json, text/event-stream',
            'content-type': 'application/json',
            'mcp-method': 'tools/list',
            'mcp-protocol-version': '2026-07-28'
          },
          body: {
            jsonrpc: '2.0',
            id: 0,
            method: 'tools/list',
            params: {
              _meta: {
                'io.modelcontextprotocol/protocolVersion': '2026-07-28',
                'io.modelcontextprotocol/clientInfo': {
                  name: 'yolk',
                  version: '0.1.0'
                },
                'io.modelcontextprotocol/clientCapabilities': {}
              }
            }
          }
        },
        response: {
          status: 200,
          headers: {
            'content-type': 'application/json'
          },
          body: '{"jsonrpc":"2.0","id":0,"result":{"tools":[{"name":"get_synthetic_note","title":"Get a synthetic note","description":"Read one synthetic note by id.","inputSchema":{"type":"object","properties":{"noteId":{"type":"string"}},"required":["noteId"],"additionalProperties":false},"outputSchema":{"type":"object","properties":{"noteId":{"type":"string"},"text":{"type":"string"}},"required":["noteId","text"],"additionalProperties":false},"annotations":{"readOnlyHint":true}},{"name":"create_synthetic_note","description":"Create one synthetic note.","inputSchema":{"type":"object","properties":{"text":{"type":"string"}},"required":["text"],"additionalProperties":false},"annotations":{"readOnlyHint":false,"destructiveHint":false}}],"resultType":"complete","ttlMs":0,"cacheScope":"private"}}'
        }
      }
    ]
  },
  {
    id: 'mcp.negotiation.era.legacy.synthetic',
    caseId: 'mcp.negotiation.era',
    evidence: 'unverified',
    recordedAt: '2026-10-01',
    account: 'synthetic',
    endpoint: 'https://mcp.example.test/legacy/mcp',
    note: 'server/discover answered 400 with a JSON-RPC error; the client falls back to initialize and lists tools in a session. Synthetic placeholder shaped like the MCP wire the pinned SDK speaks; not recorded from a live service.',
    exchanges: [
      {
        request: {
          method: 'POST',
          url: 'https://mcp.example.test/legacy/mcp',
          headers: {
            accept: 'application/json, text/event-stream',
            'content-type': 'application/json',
            'mcp-method': 'server/discover',
            'mcp-protocol-version': '2026-07-28'
          },
          body: {
            jsonrpc: '2.0',
            id: 'server-discover-probe-1',
            method: 'server/discover',
            params: {
              _meta: {
                'io.modelcontextprotocol/protocolVersion': '2026-07-28',
                'io.modelcontextprotocol/clientInfo': {
                  name: 'yolk',
                  version: '0.1.0'
                },
                'io.modelcontextprotocol/clientCapabilities': {}
              }
            }
          }
        },
        response: {
          status: 400,
          headers: {
            'content-type': 'application/json'
          },
          body: '{"jsonrpc":"2.0","id":null,"error":{"code":-32000,"message":"Bad Request: Server not initialized"}}'
        }
      },
      {
        request: {
          method: 'POST',
          url: 'https://mcp.example.test/legacy/mcp',
          headers: {
            accept: 'application/json, text/event-stream',
            'content-type': 'application/json'
          },
          body: {
            jsonrpc: '2.0',
            id: 0,
            method: 'initialize',
            params: {
              protocolVersion: '2025-11-25',
              capabilities: {},
              clientInfo: {
                name: 'yolk',
                version: '0.1.0'
              }
            }
          }
        },
        response: {
          status: 200,
          headers: {
            'content-type': 'text/event-stream',
            'mcp-session-id': 'yolk-synthetic-session-0001'
          },
          chunks: [
            'event: message\nid: evt-1\ndata: {"jsonrpc":"2.0","method":"notifications/message","params":{"level":"info","data":"synthetic notification"}}\n\n',
            'event: message\nid: evt-2\ndata: {"jsonrpc":"2.0","id":0,"result":{"protocolVersion":"2025-11-25","capabilities":{"tools":{}},"serverInfo":{"name":"yolk-synthetic-mcp","version":"0.0.0"}}}\n\n'
          ]
        }
      },
      {
        request: {
          method: 'POST',
          url: 'https://mcp.example.test/legacy/mcp',
          headers: {
            accept: 'application/json, text/event-stream',
            'content-type': 'application/json',
            'mcp-protocol-version': '2025-11-25',
            'mcp-session-id': 'yolk-synthetic-session-0001'
          },
          body: {
            jsonrpc: '2.0',
            method: 'notifications/initialized'
          }
        },
        response: {
          status: 202,
          headers: {},
          body: ''
        }
      },
      {
        request: {
          method: 'GET',
          url: 'https://mcp.example.test/legacy/mcp',
          headers: {
            accept: 'text/event-stream',
            'mcp-protocol-version': '2025-11-25',
            'mcp-session-id': 'yolk-synthetic-session-0001'
          }
        },
        response: {
          status: 405,
          headers: {},
          body: ''
        }
      },
      {
        request: {
          method: 'POST',
          url: 'https://mcp.example.test/legacy/mcp',
          headers: {
            accept: 'application/json, text/event-stream',
            'content-type': 'application/json',
            'mcp-protocol-version': '2025-11-25',
            'mcp-session-id': 'yolk-synthetic-session-0001'
          },
          body: {
            jsonrpc: '2.0',
            id: 1,
            method: 'tools/list'
          }
        },
        response: {
          status: 200,
          headers: {
            'content-type': 'text/event-stream',
            'mcp-session-id': 'yolk-synthetic-session-0001'
          },
          chunks: [
            'event: message\nid: evt-1\ndata: {"jsonrpc":"2.0","method":"notifications/message","params":{"level":"info","data":"synthetic notification"}}\n\n',
            'event: message\nid: evt-2\ndata: {"jsonrpc":"2.0","id":1,"result":{"tools":[{"name":"get_synthetic_note","title":"Get a synthetic note","description":"Read one synthetic note by id.","inputSchema":{"type":"object","properties":{"noteId":{"type":"string"}},"required":["noteId"],"additionalProperties":false},"outputSchema":{"type":"object","properties":{"noteId":{"type":"string"},"text":{"type":"string"}},"required":["noteId","text"],"additionalProperties":false},"annotations":{"readOnlyHint":true}},{"name":"create_synthetic_note","description":"Create one synthetic note.","inputSchema":{"type":"object","properties":{"text":{"type":"string"}},"required":["text"],"additionalProperties":false},"annotations":{"readOnlyHint":false,"destructiveHint":false}}]}}\n\n'
          ]
        }
      }
    ]
  },
  {
    id: 'mcp.modern.stateless.modern.synthetic',
    caseId: 'mcp.modern.stateless',
    evidence: 'unverified',
    recordedAt: '2026-10-01',
    account: 'synthetic',
    endpoint: 'https://mcp.example.test/modern/mcp',
    note: 'A stateless listing and an absent-tool call: routing headers on every request, no session id, results complete. Synthetic placeholder shaped like the MCP wire the pinned SDK speaks; not recorded from a live service.',
    exchanges: [
      {
        request: {
          method: 'POST',
          url: 'https://mcp.example.test/modern/mcp',
          headers: {
            accept: 'application/json, text/event-stream',
            'content-type': 'application/json',
            'mcp-method': 'server/discover',
            'mcp-protocol-version': '2026-07-28'
          },
          body: {
            jsonrpc: '2.0',
            id: 'server-discover-probe-1',
            method: 'server/discover',
            params: {
              _meta: {
                'io.modelcontextprotocol/protocolVersion': '2026-07-28',
                'io.modelcontextprotocol/clientInfo': {
                  name: 'yolk',
                  version: '0.1.0'
                },
                'io.modelcontextprotocol/clientCapabilities': {}
              }
            }
          }
        },
        response: {
          status: 200,
          headers: {
            'content-type': 'application/json'
          },
          body: '{"jsonrpc":"2.0","id":"server-discover-probe-1","result":{"supportedVersions":["2026-07-28"],"capabilities":{"tools":{}},"resultType":"complete","ttlMs":0,"cacheScope":"private","_meta":{"io.modelcontextprotocol/serverInfo":{"name":"yolk-synthetic-mcp","version":"0.0.0"}}}}'
        }
      },
      {
        request: {
          method: 'POST',
          url: 'https://mcp.example.test/modern/mcp',
          headers: {
            accept: 'application/json, text/event-stream',
            'content-type': 'application/json',
            'mcp-method': 'tools/list',
            'mcp-protocol-version': '2026-07-28'
          },
          body: {
            jsonrpc: '2.0',
            id: 0,
            method: 'tools/list',
            params: {
              _meta: {
                'io.modelcontextprotocol/protocolVersion': '2026-07-28',
                'io.modelcontextprotocol/clientInfo': {
                  name: 'yolk',
                  version: '0.1.0'
                },
                'io.modelcontextprotocol/clientCapabilities': {}
              }
            }
          }
        },
        response: {
          status: 200,
          headers: {
            'content-type': 'application/json'
          },
          body: '{"jsonrpc":"2.0","id":0,"result":{"tools":[{"name":"get_synthetic_note","title":"Get a synthetic note","description":"Read one synthetic note by id.","inputSchema":{"type":"object","properties":{"noteId":{"type":"string"}},"required":["noteId"],"additionalProperties":false},"outputSchema":{"type":"object","properties":{"noteId":{"type":"string"},"text":{"type":"string"}},"required":["noteId","text"],"additionalProperties":false},"annotations":{"readOnlyHint":true}},{"name":"create_synthetic_note","description":"Create one synthetic note.","inputSchema":{"type":"object","properties":{"text":{"type":"string"}},"required":["text"],"additionalProperties":false},"annotations":{"readOnlyHint":false,"destructiveHint":false}}],"resultType":"complete","ttlMs":0,"cacheScope":"private"}}'
        }
      },
      {
        request: {
          method: 'POST',
          url: 'https://mcp.example.test/modern/mcp',
          headers: {
            accept: 'application/json, text/event-stream',
            'content-type': 'application/json',
            'mcp-method': 'server/discover',
            'mcp-protocol-version': '2026-07-28'
          },
          body: {
            jsonrpc: '2.0',
            id: 'server-discover-probe-1',
            method: 'server/discover',
            params: {
              _meta: {
                'io.modelcontextprotocol/protocolVersion': '2026-07-28',
                'io.modelcontextprotocol/clientInfo': {
                  name: 'yolk',
                  version: '0.1.0'
                },
                'io.modelcontextprotocol/clientCapabilities': {}
              }
            }
          }
        },
        response: {
          status: 200,
          headers: {
            'content-type': 'application/json'
          },
          body: '{"jsonrpc":"2.0","id":"server-discover-probe-1","result":{"supportedVersions":["2026-07-28"],"capabilities":{"tools":{}},"resultType":"complete","ttlMs":0,"cacheScope":"private","_meta":{"io.modelcontextprotocol/serverInfo":{"name":"yolk-synthetic-mcp","version":"0.0.0"}}}}'
        }
      },
      {
        request: {
          method: 'POST',
          url: 'https://mcp.example.test/modern/mcp',
          headers: {
            accept: 'application/json, text/event-stream',
            'content-type': 'application/json',
            'mcp-method': 'tools/list',
            'mcp-protocol-version': '2026-07-28'
          },
          body: {
            jsonrpc: '2.0',
            id: 0,
            method: 'tools/list',
            params: {
              _meta: {
                'io.modelcontextprotocol/protocolVersion': '2026-07-28',
                'io.modelcontextprotocol/clientInfo': {
                  name: 'yolk',
                  version: '0.1.0'
                },
                'io.modelcontextprotocol/clientCapabilities': {}
              }
            }
          }
        },
        response: {
          status: 200,
          headers: {
            'content-type': 'application/json'
          },
          body: '{"jsonrpc":"2.0","id":0,"result":{"tools":[{"name":"get_synthetic_note","title":"Get a synthetic note","description":"Read one synthetic note by id.","inputSchema":{"type":"object","properties":{"noteId":{"type":"string"}},"required":["noteId"],"additionalProperties":false},"outputSchema":{"type":"object","properties":{"noteId":{"type":"string"},"text":{"type":"string"}},"required":["noteId","text"],"additionalProperties":false},"annotations":{"readOnlyHint":true}},{"name":"create_synthetic_note","description":"Create one synthetic note.","inputSchema":{"type":"object","properties":{"text":{"type":"string"}},"required":["text"],"additionalProperties":false},"annotations":{"readOnlyHint":false,"destructiveHint":false}}],"resultType":"complete","ttlMs":0,"cacheScope":"private"}}'
        }
      },
      {
        request: {
          method: 'POST',
          url: 'https://mcp.example.test/modern/mcp',
          headers: {
            accept: 'application/json, text/event-stream',
            'content-type': 'application/json',
            'mcp-method': 'tools/call',
            'mcp-protocol-version': '2026-07-28',
            'mcp-name': 'yolk_conformance_absent'
          },
          body: {
            jsonrpc: '2.0',
            id: 1,
            method: 'tools/call',
            params: {
              name: 'yolk_conformance_absent',
              arguments: {},
              _meta: {
                'io.modelcontextprotocol/protocolVersion': '2026-07-28',
                'io.modelcontextprotocol/clientInfo': {
                  name: 'yolk',
                  version: '0.1.0'
                },
                'io.modelcontextprotocol/clientCapabilities': {}
              }
            }
          }
        },
        response: {
          status: 400,
          headers: {
            'content-type': 'application/json'
          },
          body: '{"jsonrpc":"2.0","id":1,"error":{"code":-32602,"message":"Tool yolk_conformance_absent not found"}}'
        }
      }
    ]
  },
  {
    id: 'mcp.legacy.session.legacy.synthetic',
    caseId: 'mcp.legacy.session',
    evidence: 'unverified',
    recordedAt: '2026-10-01',
    account: 'synthetic',
    endpoint: 'https://mcp.example.test/legacy/mcp',
    note: 'initialize issues a synthetic session id that every later request echoes; initialized gets 202 and GET gets 405. Synthetic placeholder shaped like the MCP wire the pinned SDK speaks; not recorded from a live service.',
    exchanges: [
      {
        request: {
          method: 'POST',
          url: 'https://mcp.example.test/legacy/mcp',
          headers: {
            accept: 'application/json, text/event-stream',
            'content-type': 'application/json',
            'mcp-method': 'server/discover',
            'mcp-protocol-version': '2026-07-28'
          },
          body: {
            jsonrpc: '2.0',
            id: 'server-discover-probe-1',
            method: 'server/discover',
            params: {
              _meta: {
                'io.modelcontextprotocol/protocolVersion': '2026-07-28',
                'io.modelcontextprotocol/clientInfo': {
                  name: 'yolk',
                  version: '0.1.0'
                },
                'io.modelcontextprotocol/clientCapabilities': {}
              }
            }
          }
        },
        response: {
          status: 400,
          headers: {
            'content-type': 'application/json'
          },
          body: '{"jsonrpc":"2.0","id":null,"error":{"code":-32000,"message":"Bad Request: Server not initialized"}}'
        }
      },
      {
        request: {
          method: 'POST',
          url: 'https://mcp.example.test/legacy/mcp',
          headers: {
            accept: 'application/json, text/event-stream',
            'content-type': 'application/json'
          },
          body: {
            jsonrpc: '2.0',
            id: 0,
            method: 'initialize',
            params: {
              protocolVersion: '2025-11-25',
              capabilities: {},
              clientInfo: {
                name: 'yolk',
                version: '0.1.0'
              }
            }
          }
        },
        response: {
          status: 200,
          headers: {
            'content-type': 'text/event-stream',
            'mcp-session-id': 'yolk-synthetic-session-0001'
          },
          chunks: [
            'event: message\nid: evt-1\ndata: {"jsonrpc":"2.0","method":"notifications/message","params":{"level":"info","data":"synthetic notification"}}\n\n',
            'event: message\nid: evt-2\ndata: {"jsonrpc":"2.0","id":0,"result":{"protocolVersion":"2025-11-25","capabilities":{"tools":{}},"serverInfo":{"name":"yolk-synthetic-mcp","version":"0.0.0"}}}\n\n'
          ]
        }
      },
      {
        request: {
          method: 'POST',
          url: 'https://mcp.example.test/legacy/mcp',
          headers: {
            accept: 'application/json, text/event-stream',
            'content-type': 'application/json',
            'mcp-protocol-version': '2025-11-25',
            'mcp-session-id': 'yolk-synthetic-session-0001'
          },
          body: {
            jsonrpc: '2.0',
            method: 'notifications/initialized'
          }
        },
        response: {
          status: 202,
          headers: {},
          body: ''
        }
      },
      {
        request: {
          method: 'GET',
          url: 'https://mcp.example.test/legacy/mcp',
          headers: {
            accept: 'text/event-stream',
            'mcp-protocol-version': '2025-11-25',
            'mcp-session-id': 'yolk-synthetic-session-0001'
          }
        },
        response: {
          status: 405,
          headers: {},
          body: ''
        }
      },
      {
        request: {
          method: 'POST',
          url: 'https://mcp.example.test/legacy/mcp',
          headers: {
            accept: 'application/json, text/event-stream',
            'content-type': 'application/json',
            'mcp-protocol-version': '2025-11-25',
            'mcp-session-id': 'yolk-synthetic-session-0001'
          },
          body: {
            jsonrpc: '2.0',
            id: 1,
            method: 'tools/list'
          }
        },
        response: {
          status: 200,
          headers: {
            'content-type': 'text/event-stream',
            'mcp-session-id': 'yolk-synthetic-session-0001'
          },
          chunks: [
            'event: message\nid: evt-1\ndata: {"jsonrpc":"2.0","method":"notifications/message","params":{"level":"info","data":"synthetic notification"}}\n\n',
            'event: message\nid: evt-2\ndata: {"jsonrpc":"2.0","id":1,"result":{"tools":[{"name":"get_synthetic_note","title":"Get a synthetic note","description":"Read one synthetic note by id.","inputSchema":{"type":"object","properties":{"noteId":{"type":"string"}},"required":["noteId"],"additionalProperties":false},"outputSchema":{"type":"object","properties":{"noteId":{"type":"string"},"text":{"type":"string"}},"required":["noteId","text"],"additionalProperties":false},"annotations":{"readOnlyHint":true}},{"name":"create_synthetic_note","description":"Create one synthetic note.","inputSchema":{"type":"object","properties":{"text":{"type":"string"}},"required":["text"],"additionalProperties":false},"annotations":{"readOnlyHint":false,"destructiveHint":false}}]}}\n\n'
          ]
        }
      }
    ]
  },
  {
    id: 'mcp.transport.response-encoding.modern.synthetic',
    caseId: 'mcp.transport.response-encoding',
    evidence: 'unverified',
    recordedAt: '2026-10-01',
    account: 'synthetic',
    endpoint: 'https://mcp.example.test/modern/mcp',
    note: 'Every answer is application/json holding the response to its request. Synthetic placeholder shaped like the MCP wire the pinned SDK speaks; not recorded from a live service.',
    exchanges: [
      {
        request: {
          method: 'POST',
          url: 'https://mcp.example.test/modern/mcp',
          headers: {
            accept: 'application/json, text/event-stream',
            'content-type': 'application/json',
            'mcp-method': 'server/discover',
            'mcp-protocol-version': '2026-07-28'
          },
          body: {
            jsonrpc: '2.0',
            id: 'server-discover-probe-1',
            method: 'server/discover',
            params: {
              _meta: {
                'io.modelcontextprotocol/protocolVersion': '2026-07-28',
                'io.modelcontextprotocol/clientInfo': {
                  name: 'yolk',
                  version: '0.1.0'
                },
                'io.modelcontextprotocol/clientCapabilities': {}
              }
            }
          }
        },
        response: {
          status: 200,
          headers: {
            'content-type': 'application/json'
          },
          body: '{"jsonrpc":"2.0","id":"server-discover-probe-1","result":{"supportedVersions":["2026-07-28"],"capabilities":{"tools":{}},"resultType":"complete","ttlMs":0,"cacheScope":"private","_meta":{"io.modelcontextprotocol/serverInfo":{"name":"yolk-synthetic-mcp","version":"0.0.0"}}}}'
        }
      },
      {
        request: {
          method: 'POST',
          url: 'https://mcp.example.test/modern/mcp',
          headers: {
            accept: 'application/json, text/event-stream',
            'content-type': 'application/json',
            'mcp-method': 'tools/list',
            'mcp-protocol-version': '2026-07-28'
          },
          body: {
            jsonrpc: '2.0',
            id: 0,
            method: 'tools/list',
            params: {
              _meta: {
                'io.modelcontextprotocol/protocolVersion': '2026-07-28',
                'io.modelcontextprotocol/clientInfo': {
                  name: 'yolk',
                  version: '0.1.0'
                },
                'io.modelcontextprotocol/clientCapabilities': {}
              }
            }
          }
        },
        response: {
          status: 200,
          headers: {
            'content-type': 'application/json'
          },
          body: '{"jsonrpc":"2.0","id":0,"result":{"tools":[{"name":"get_synthetic_note","title":"Get a synthetic note","description":"Read one synthetic note by id.","inputSchema":{"type":"object","properties":{"noteId":{"type":"string"}},"required":["noteId"],"additionalProperties":false},"outputSchema":{"type":"object","properties":{"noteId":{"type":"string"},"text":{"type":"string"}},"required":["noteId","text"],"additionalProperties":false},"annotations":{"readOnlyHint":true}},{"name":"create_synthetic_note","description":"Create one synthetic note.","inputSchema":{"type":"object","properties":{"text":{"type":"string"}},"required":["text"],"additionalProperties":false},"annotations":{"readOnlyHint":false,"destructiveHint":false}}],"resultType":"complete","ttlMs":0,"cacheScope":"private"}}'
        }
      }
    ]
  },
  {
    id: 'mcp.transport.response-encoding.legacy.synthetic',
    caseId: 'mcp.transport.response-encoding',
    evidence: 'unverified',
    recordedAt: '2026-10-01',
    account: 'synthetic',
    endpoint: 'https://mcp.example.test/legacy/mcp',
    note: 'Every answer to a request is text/event-stream: a notification, the response, then the stream ends; 202 has no body. Synthetic placeholder shaped like the MCP wire the pinned SDK speaks; not recorded from a live service.',
    exchanges: [
      {
        request: {
          method: 'POST',
          url: 'https://mcp.example.test/legacy/mcp',
          headers: {
            accept: 'application/json, text/event-stream',
            'content-type': 'application/json',
            'mcp-method': 'server/discover',
            'mcp-protocol-version': '2026-07-28'
          },
          body: {
            jsonrpc: '2.0',
            id: 'server-discover-probe-1',
            method: 'server/discover',
            params: {
              _meta: {
                'io.modelcontextprotocol/protocolVersion': '2026-07-28',
                'io.modelcontextprotocol/clientInfo': {
                  name: 'yolk',
                  version: '0.1.0'
                },
                'io.modelcontextprotocol/clientCapabilities': {}
              }
            }
          }
        },
        response: {
          status: 400,
          headers: {
            'content-type': 'application/json'
          },
          body: '{"jsonrpc":"2.0","id":null,"error":{"code":-32000,"message":"Bad Request: Server not initialized"}}'
        }
      },
      {
        request: {
          method: 'POST',
          url: 'https://mcp.example.test/legacy/mcp',
          headers: {
            accept: 'application/json, text/event-stream',
            'content-type': 'application/json'
          },
          body: {
            jsonrpc: '2.0',
            id: 0,
            method: 'initialize',
            params: {
              protocolVersion: '2025-11-25',
              capabilities: {},
              clientInfo: {
                name: 'yolk',
                version: '0.1.0'
              }
            }
          }
        },
        response: {
          status: 200,
          headers: {
            'content-type': 'text/event-stream',
            'mcp-session-id': 'yolk-synthetic-session-0001'
          },
          chunks: [
            'event: message\nid: evt-1\ndata: {"jsonrpc":"2.0","method":"notifications/message","params":{"level":"info","data":"synthetic notification"}}\n\n',
            'event: message\nid: evt-2\ndata: {"jsonrpc":"2.0","id":0,"result":{"protocolVersion":"2025-11-25","capabilities":{"tools":{}},"serverInfo":{"name":"yolk-synthetic-mcp","version":"0.0.0"}}}\n\n'
          ]
        }
      },
      {
        request: {
          method: 'POST',
          url: 'https://mcp.example.test/legacy/mcp',
          headers: {
            accept: 'application/json, text/event-stream',
            'content-type': 'application/json',
            'mcp-protocol-version': '2025-11-25',
            'mcp-session-id': 'yolk-synthetic-session-0001'
          },
          body: {
            jsonrpc: '2.0',
            method: 'notifications/initialized'
          }
        },
        response: {
          status: 202,
          headers: {},
          body: ''
        }
      },
      {
        request: {
          method: 'GET',
          url: 'https://mcp.example.test/legacy/mcp',
          headers: {
            accept: 'text/event-stream',
            'mcp-protocol-version': '2025-11-25',
            'mcp-session-id': 'yolk-synthetic-session-0001'
          }
        },
        response: {
          status: 405,
          headers: {},
          body: ''
        }
      },
      {
        request: {
          method: 'POST',
          url: 'https://mcp.example.test/legacy/mcp',
          headers: {
            accept: 'application/json, text/event-stream',
            'content-type': 'application/json',
            'mcp-protocol-version': '2025-11-25',
            'mcp-session-id': 'yolk-synthetic-session-0001'
          },
          body: {
            jsonrpc: '2.0',
            id: 1,
            method: 'tools/list'
          }
        },
        response: {
          status: 200,
          headers: {
            'content-type': 'text/event-stream',
            'mcp-session-id': 'yolk-synthetic-session-0001'
          },
          chunks: [
            'event: message\nid: evt-1\ndata: {"jsonrpc":"2.0","method":"notifications/message","params":{"level":"info","data":"synthetic notification"}}\n\n',
            'event: message\nid: evt-2\ndata: {"jsonrpc":"2.0","id":1,"result":{"tools":[{"name":"get_synthetic_note","title":"Get a synthetic note","description":"Read one synthetic note by id.","inputSchema":{"type":"object","properties":{"noteId":{"type":"string"}},"required":["noteId"],"additionalProperties":false},"outputSchema":{"type":"object","properties":{"noteId":{"type":"string"},"text":{"type":"string"}},"required":["noteId","text"],"additionalProperties":false},"annotations":{"readOnlyHint":true}},{"name":"create_synthetic_note","description":"Create one synthetic note.","inputSchema":{"type":"object","properties":{"text":{"type":"string"}},"required":["text"],"additionalProperties":false},"annotations":{"readOnlyHint":false,"destructiveHint":false}}]}}\n\n'
          ]
        }
      }
    ]
  },
  {
    id: 'mcp.tools.list.modern.synthetic',
    caseId: 'mcp.tools.list',
    evidence: 'unverified',
    recordedAt: '2026-10-01',
    account: 'synthetic',
    endpoint: 'https://mcp.example.test/modern/mcp',
    note: 'A listing over two tools/list pages joined by one cursor; the second page has no nextCursor. Synthetic placeholder shaped like the MCP wire the pinned SDK speaks; not recorded from a live service.',
    exchanges: [
      {
        request: {
          method: 'POST',
          url: 'https://mcp.example.test/modern/mcp',
          headers: {
            accept: 'application/json, text/event-stream',
            'content-type': 'application/json',
            'mcp-method': 'server/discover',
            'mcp-protocol-version': '2026-07-28'
          },
          body: {
            jsonrpc: '2.0',
            id: 'server-discover-probe-1',
            method: 'server/discover',
            params: {
              _meta: {
                'io.modelcontextprotocol/protocolVersion': '2026-07-28',
                'io.modelcontextprotocol/clientInfo': {
                  name: 'yolk',
                  version: '0.1.0'
                },
                'io.modelcontextprotocol/clientCapabilities': {}
              }
            }
          }
        },
        response: {
          status: 200,
          headers: {
            'content-type': 'application/json'
          },
          body: '{"jsonrpc":"2.0","id":"server-discover-probe-1","result":{"supportedVersions":["2026-07-28"],"capabilities":{"tools":{}},"resultType":"complete","ttlMs":0,"cacheScope":"private","_meta":{"io.modelcontextprotocol/serverInfo":{"name":"yolk-synthetic-mcp","version":"0.0.0"}}}}'
        }
      },
      {
        request: {
          method: 'POST',
          url: 'https://mcp.example.test/modern/mcp',
          headers: {
            accept: 'application/json, text/event-stream',
            'content-type': 'application/json',
            'mcp-method': 'tools/list',
            'mcp-protocol-version': '2026-07-28'
          },
          body: {
            jsonrpc: '2.0',
            id: 0,
            method: 'tools/list',
            params: {
              _meta: {
                'io.modelcontextprotocol/protocolVersion': '2026-07-28',
                'io.modelcontextprotocol/clientInfo': {
                  name: 'yolk',
                  version: '0.1.0'
                },
                'io.modelcontextprotocol/clientCapabilities': {}
              }
            }
          }
        },
        response: {
          status: 200,
          headers: {
            'content-type': 'application/json'
          },
          body: '{"jsonrpc":"2.0","id":0,"result":{"tools":[{"name":"get_synthetic_note","title":"Get a synthetic note","description":"Read one synthetic note by id.","inputSchema":{"type":"object","properties":{"noteId":{"type":"string"}},"required":["noteId"],"additionalProperties":false},"outputSchema":{"type":"object","properties":{"noteId":{"type":"string"},"text":{"type":"string"}},"required":["noteId","text"],"additionalProperties":false},"annotations":{"readOnlyHint":true}}],"resultType":"complete","ttlMs":0,"cacheScope":"private","nextCursor":"synthetic-cursor-0001"}}'
        }
      },
      {
        request: {
          method: 'POST',
          url: 'https://mcp.example.test/modern/mcp',
          headers: {
            accept: 'application/json, text/event-stream',
            'content-type': 'application/json',
            'mcp-method': 'tools/list',
            'mcp-protocol-version': '2026-07-28'
          },
          body: {
            jsonrpc: '2.0',
            id: 1,
            method: 'tools/list',
            params: {
              cursor: 'synthetic-cursor-0001',
              _meta: {
                'io.modelcontextprotocol/protocolVersion': '2026-07-28',
                'io.modelcontextprotocol/clientInfo': {
                  name: 'yolk',
                  version: '0.1.0'
                },
                'io.modelcontextprotocol/clientCapabilities': {}
              }
            }
          }
        },
        response: {
          status: 200,
          headers: {
            'content-type': 'application/json'
          },
          body: '{"jsonrpc":"2.0","id":1,"result":{"tools":[{"name":"create_synthetic_note","description":"Create one synthetic note.","inputSchema":{"type":"object","properties":{"text":{"type":"string"}},"required":["text"],"additionalProperties":false},"annotations":{"readOnlyHint":false,"destructiveHint":false}}],"resultType":"complete","ttlMs":0,"cacheScope":"private"}}'
        }
      }
    ]
  },
  {
    id: 'mcp.tools.list.legacy.synthetic',
    caseId: 'mcp.tools.list',
    evidence: 'unverified',
    recordedAt: '2026-10-01',
    account: 'synthetic',
    endpoint: 'https://mcp.example.test/legacy/mcp',
    note: 'A listing on one tools/list page in a session. Synthetic placeholder shaped like the MCP wire the pinned SDK speaks; not recorded from a live service.',
    exchanges: [
      {
        request: {
          method: 'POST',
          url: 'https://mcp.example.test/legacy/mcp',
          headers: {
            accept: 'application/json, text/event-stream',
            'content-type': 'application/json',
            'mcp-method': 'server/discover',
            'mcp-protocol-version': '2026-07-28'
          },
          body: {
            jsonrpc: '2.0',
            id: 'server-discover-probe-1',
            method: 'server/discover',
            params: {
              _meta: {
                'io.modelcontextprotocol/protocolVersion': '2026-07-28',
                'io.modelcontextprotocol/clientInfo': {
                  name: 'yolk',
                  version: '0.1.0'
                },
                'io.modelcontextprotocol/clientCapabilities': {}
              }
            }
          }
        },
        response: {
          status: 400,
          headers: {
            'content-type': 'application/json'
          },
          body: '{"jsonrpc":"2.0","id":null,"error":{"code":-32000,"message":"Bad Request: Server not initialized"}}'
        }
      },
      {
        request: {
          method: 'POST',
          url: 'https://mcp.example.test/legacy/mcp',
          headers: {
            accept: 'application/json, text/event-stream',
            'content-type': 'application/json'
          },
          body: {
            jsonrpc: '2.0',
            id: 0,
            method: 'initialize',
            params: {
              protocolVersion: '2025-11-25',
              capabilities: {},
              clientInfo: {
                name: 'yolk',
                version: '0.1.0'
              }
            }
          }
        },
        response: {
          status: 200,
          headers: {
            'content-type': 'text/event-stream',
            'mcp-session-id': 'yolk-synthetic-session-0001'
          },
          chunks: [
            'event: message\nid: evt-1\ndata: {"jsonrpc":"2.0","method":"notifications/message","params":{"level":"info","data":"synthetic notification"}}\n\n',
            'event: message\nid: evt-2\ndata: {"jsonrpc":"2.0","id":0,"result":{"protocolVersion":"2025-11-25","capabilities":{"tools":{}},"serverInfo":{"name":"yolk-synthetic-mcp","version":"0.0.0"}}}\n\n'
          ]
        }
      },
      {
        request: {
          method: 'POST',
          url: 'https://mcp.example.test/legacy/mcp',
          headers: {
            accept: 'application/json, text/event-stream',
            'content-type': 'application/json',
            'mcp-protocol-version': '2025-11-25',
            'mcp-session-id': 'yolk-synthetic-session-0001'
          },
          body: {
            jsonrpc: '2.0',
            method: 'notifications/initialized'
          }
        },
        response: {
          status: 202,
          headers: {},
          body: ''
        }
      },
      {
        request: {
          method: 'GET',
          url: 'https://mcp.example.test/legacy/mcp',
          headers: {
            accept: 'text/event-stream',
            'mcp-protocol-version': '2025-11-25',
            'mcp-session-id': 'yolk-synthetic-session-0001'
          }
        },
        response: {
          status: 405,
          headers: {},
          body: ''
        }
      },
      {
        request: {
          method: 'POST',
          url: 'https://mcp.example.test/legacy/mcp',
          headers: {
            accept: 'application/json, text/event-stream',
            'content-type': 'application/json',
            'mcp-protocol-version': '2025-11-25',
            'mcp-session-id': 'yolk-synthetic-session-0001'
          },
          body: {
            jsonrpc: '2.0',
            id: 1,
            method: 'tools/list'
          }
        },
        response: {
          status: 200,
          headers: {
            'content-type': 'text/event-stream',
            'mcp-session-id': 'yolk-synthetic-session-0001'
          },
          chunks: [
            'event: message\nid: evt-1\ndata: {"jsonrpc":"2.0","method":"notifications/message","params":{"level":"info","data":"synthetic notification"}}\n\n',
            'event: message\nid: evt-2\ndata: {"jsonrpc":"2.0","id":1,"result":{"tools":[{"name":"get_synthetic_note","title":"Get a synthetic note","description":"Read one synthetic note by id.","inputSchema":{"type":"object","properties":{"noteId":{"type":"string"}},"required":["noteId"],"additionalProperties":false},"outputSchema":{"type":"object","properties":{"noteId":{"type":"string"},"text":{"type":"string"}},"required":["noteId","text"],"additionalProperties":false},"annotations":{"readOnlyHint":true}},{"name":"create_synthetic_note","description":"Create one synthetic note.","inputSchema":{"type":"object","properties":{"text":{"type":"string"}},"required":["text"],"additionalProperties":false},"annotations":{"readOnlyHint":false,"destructiveHint":false}}]}}\n\n'
          ]
        }
      }
    ]
  },
  {
    id: 'mcp.tools.call-read.modern.synthetic',
    caseId: 'mcp.tools.call-read',
    evidence: 'unverified',
    recordedAt: '2026-10-01',
    account: 'synthetic',
    endpoint: 'https://mcp.example.test/modern/mcp',
    note: 'A listing (the readOnlyHint precondition), then get_synthetic_note answered with structured content matching its output schema. Synthetic placeholder shaped like the MCP wire the pinned SDK speaks; not recorded from a live service.',
    exchanges: [
      {
        request: {
          method: 'POST',
          url: 'https://mcp.example.test/modern/mcp',
          headers: {
            accept: 'application/json, text/event-stream',
            'content-type': 'application/json',
            'mcp-method': 'server/discover',
            'mcp-protocol-version': '2026-07-28'
          },
          body: {
            jsonrpc: '2.0',
            id: 'server-discover-probe-1',
            method: 'server/discover',
            params: {
              _meta: {
                'io.modelcontextprotocol/protocolVersion': '2026-07-28',
                'io.modelcontextprotocol/clientInfo': {
                  name: 'yolk',
                  version: '0.1.0'
                },
                'io.modelcontextprotocol/clientCapabilities': {}
              }
            }
          }
        },
        response: {
          status: 200,
          headers: {
            'content-type': 'application/json'
          },
          body: '{"jsonrpc":"2.0","id":"server-discover-probe-1","result":{"supportedVersions":["2026-07-28"],"capabilities":{"tools":{}},"resultType":"complete","ttlMs":0,"cacheScope":"private","_meta":{"io.modelcontextprotocol/serverInfo":{"name":"yolk-synthetic-mcp","version":"0.0.0"}}}}'
        }
      },
      {
        request: {
          method: 'POST',
          url: 'https://mcp.example.test/modern/mcp',
          headers: {
            accept: 'application/json, text/event-stream',
            'content-type': 'application/json',
            'mcp-method': 'tools/list',
            'mcp-protocol-version': '2026-07-28'
          },
          body: {
            jsonrpc: '2.0',
            id: 0,
            method: 'tools/list',
            params: {
              _meta: {
                'io.modelcontextprotocol/protocolVersion': '2026-07-28',
                'io.modelcontextprotocol/clientInfo': {
                  name: 'yolk',
                  version: '0.1.0'
                },
                'io.modelcontextprotocol/clientCapabilities': {}
              }
            }
          }
        },
        response: {
          status: 200,
          headers: {
            'content-type': 'application/json'
          },
          body: '{"jsonrpc":"2.0","id":0,"result":{"tools":[{"name":"get_synthetic_note","title":"Get a synthetic note","description":"Read one synthetic note by id.","inputSchema":{"type":"object","properties":{"noteId":{"type":"string"}},"required":["noteId"],"additionalProperties":false},"outputSchema":{"type":"object","properties":{"noteId":{"type":"string"},"text":{"type":"string"}},"required":["noteId","text"],"additionalProperties":false},"annotations":{"readOnlyHint":true}},{"name":"create_synthetic_note","description":"Create one synthetic note.","inputSchema":{"type":"object","properties":{"text":{"type":"string"}},"required":["text"],"additionalProperties":false},"annotations":{"readOnlyHint":false,"destructiveHint":false}}],"resultType":"complete","ttlMs":0,"cacheScope":"private"}}'
        }
      },
      {
        request: {
          method: 'POST',
          url: 'https://mcp.example.test/modern/mcp',
          headers: {
            accept: 'application/json, text/event-stream',
            'content-type': 'application/json',
            'mcp-method': 'server/discover',
            'mcp-protocol-version': '2026-07-28'
          },
          body: {
            jsonrpc: '2.0',
            id: 'server-discover-probe-1',
            method: 'server/discover',
            params: {
              _meta: {
                'io.modelcontextprotocol/protocolVersion': '2026-07-28',
                'io.modelcontextprotocol/clientInfo': {
                  name: 'yolk',
                  version: '0.1.0'
                },
                'io.modelcontextprotocol/clientCapabilities': {}
              }
            }
          }
        },
        response: {
          status: 200,
          headers: {
            'content-type': 'application/json'
          },
          body: '{"jsonrpc":"2.0","id":"server-discover-probe-1","result":{"supportedVersions":["2026-07-28"],"capabilities":{"tools":{}},"resultType":"complete","ttlMs":0,"cacheScope":"private","_meta":{"io.modelcontextprotocol/serverInfo":{"name":"yolk-synthetic-mcp","version":"0.0.0"}}}}'
        }
      },
      {
        request: {
          method: 'POST',
          url: 'https://mcp.example.test/modern/mcp',
          headers: {
            accept: 'application/json, text/event-stream',
            'content-type': 'application/json',
            'mcp-method': 'tools/list',
            'mcp-protocol-version': '2026-07-28'
          },
          body: {
            jsonrpc: '2.0',
            id: 0,
            method: 'tools/list',
            params: {
              _meta: {
                'io.modelcontextprotocol/protocolVersion': '2026-07-28',
                'io.modelcontextprotocol/clientInfo': {
                  name: 'yolk',
                  version: '0.1.0'
                },
                'io.modelcontextprotocol/clientCapabilities': {}
              }
            }
          }
        },
        response: {
          status: 200,
          headers: {
            'content-type': 'application/json'
          },
          body: '{"jsonrpc":"2.0","id":0,"result":{"tools":[{"name":"get_synthetic_note","title":"Get a synthetic note","description":"Read one synthetic note by id.","inputSchema":{"type":"object","properties":{"noteId":{"type":"string"}},"required":["noteId"],"additionalProperties":false},"outputSchema":{"type":"object","properties":{"noteId":{"type":"string"},"text":{"type":"string"}},"required":["noteId","text"],"additionalProperties":false},"annotations":{"readOnlyHint":true}},{"name":"create_synthetic_note","description":"Create one synthetic note.","inputSchema":{"type":"object","properties":{"text":{"type":"string"}},"required":["text"],"additionalProperties":false},"annotations":{"readOnlyHint":false,"destructiveHint":false}}],"resultType":"complete","ttlMs":0,"cacheScope":"private"}}'
        }
      },
      {
        request: {
          method: 'POST',
          url: 'https://mcp.example.test/modern/mcp',
          headers: {
            accept: 'application/json, text/event-stream',
            'content-type': 'application/json',
            'mcp-method': 'tools/call',
            'mcp-protocol-version': '2026-07-28',
            'mcp-name': 'get_synthetic_note'
          },
          body: {
            jsonrpc: '2.0',
            id: 1,
            method: 'tools/call',
            params: {
              name: 'get_synthetic_note',
              arguments: {
                noteId: 'note-0001'
              },
              _meta: {
                'io.modelcontextprotocol/protocolVersion': '2026-07-28',
                'io.modelcontextprotocol/clientInfo': {
                  name: 'yolk',
                  version: '0.1.0'
                },
                'io.modelcontextprotocol/clientCapabilities': {}
              }
            }
          }
        },
        response: {
          status: 200,
          headers: {
            'content-type': 'application/json'
          },
          body: '{"jsonrpc":"2.0","id":1,"result":{"content":[{"type":"text","text":"Synthetic note note-0001."}],"structuredContent":{"noteId":"note-0001","text":"Synthetic note note-0001."},"resultType":"complete"}}'
        }
      }
    ]
  },
  {
    id: 'mcp.tools.call-read.legacy.synthetic',
    caseId: 'mcp.tools.call-read',
    evidence: 'unverified',
    recordedAt: '2026-10-01',
    account: 'synthetic',
    endpoint: 'https://mcp.example.test/legacy/mcp',
    note: 'A listing (the readOnlyHint precondition), then get_synthetic_note answered with structured content matching its output schema. Synthetic placeholder shaped like the MCP wire the pinned SDK speaks; not recorded from a live service.',
    exchanges: [
      {
        request: {
          method: 'POST',
          url: 'https://mcp.example.test/legacy/mcp',
          headers: {
            accept: 'application/json, text/event-stream',
            'content-type': 'application/json',
            'mcp-method': 'server/discover',
            'mcp-protocol-version': '2026-07-28'
          },
          body: {
            jsonrpc: '2.0',
            id: 'server-discover-probe-1',
            method: 'server/discover',
            params: {
              _meta: {
                'io.modelcontextprotocol/protocolVersion': '2026-07-28',
                'io.modelcontextprotocol/clientInfo': {
                  name: 'yolk',
                  version: '0.1.0'
                },
                'io.modelcontextprotocol/clientCapabilities': {}
              }
            }
          }
        },
        response: {
          status: 400,
          headers: {
            'content-type': 'application/json'
          },
          body: '{"jsonrpc":"2.0","id":null,"error":{"code":-32000,"message":"Bad Request: Server not initialized"}}'
        }
      },
      {
        request: {
          method: 'POST',
          url: 'https://mcp.example.test/legacy/mcp',
          headers: {
            accept: 'application/json, text/event-stream',
            'content-type': 'application/json'
          },
          body: {
            jsonrpc: '2.0',
            id: 0,
            method: 'initialize',
            params: {
              protocolVersion: '2025-11-25',
              capabilities: {},
              clientInfo: {
                name: 'yolk',
                version: '0.1.0'
              }
            }
          }
        },
        response: {
          status: 200,
          headers: {
            'content-type': 'text/event-stream',
            'mcp-session-id': 'yolk-synthetic-session-0001'
          },
          chunks: [
            'event: message\nid: evt-1\ndata: {"jsonrpc":"2.0","method":"notifications/message","params":{"level":"info","data":"synthetic notification"}}\n\n',
            'event: message\nid: evt-2\ndata: {"jsonrpc":"2.0","id":0,"result":{"protocolVersion":"2025-11-25","capabilities":{"tools":{}},"serverInfo":{"name":"yolk-synthetic-mcp","version":"0.0.0"}}}\n\n'
          ]
        }
      },
      {
        request: {
          method: 'POST',
          url: 'https://mcp.example.test/legacy/mcp',
          headers: {
            accept: 'application/json, text/event-stream',
            'content-type': 'application/json',
            'mcp-protocol-version': '2025-11-25',
            'mcp-session-id': 'yolk-synthetic-session-0001'
          },
          body: {
            jsonrpc: '2.0',
            method: 'notifications/initialized'
          }
        },
        response: {
          status: 202,
          headers: {},
          body: ''
        }
      },
      {
        request: {
          method: 'GET',
          url: 'https://mcp.example.test/legacy/mcp',
          headers: {
            accept: 'text/event-stream',
            'mcp-protocol-version': '2025-11-25',
            'mcp-session-id': 'yolk-synthetic-session-0001'
          }
        },
        response: {
          status: 405,
          headers: {},
          body: ''
        }
      },
      {
        request: {
          method: 'POST',
          url: 'https://mcp.example.test/legacy/mcp',
          headers: {
            accept: 'application/json, text/event-stream',
            'content-type': 'application/json',
            'mcp-protocol-version': '2025-11-25',
            'mcp-session-id': 'yolk-synthetic-session-0001'
          },
          body: {
            jsonrpc: '2.0',
            id: 1,
            method: 'tools/list'
          }
        },
        response: {
          status: 200,
          headers: {
            'content-type': 'text/event-stream',
            'mcp-session-id': 'yolk-synthetic-session-0001'
          },
          chunks: [
            'event: message\nid: evt-1\ndata: {"jsonrpc":"2.0","method":"notifications/message","params":{"level":"info","data":"synthetic notification"}}\n\n',
            'event: message\nid: evt-2\ndata: {"jsonrpc":"2.0","id":1,"result":{"tools":[{"name":"get_synthetic_note","title":"Get a synthetic note","description":"Read one synthetic note by id.","inputSchema":{"type":"object","properties":{"noteId":{"type":"string"}},"required":["noteId"],"additionalProperties":false},"outputSchema":{"type":"object","properties":{"noteId":{"type":"string"},"text":{"type":"string"}},"required":["noteId","text"],"additionalProperties":false},"annotations":{"readOnlyHint":true}},{"name":"create_synthetic_note","description":"Create one synthetic note.","inputSchema":{"type":"object","properties":{"text":{"type":"string"}},"required":["text"],"additionalProperties":false},"annotations":{"readOnlyHint":false,"destructiveHint":false}}]}}\n\n'
          ]
        }
      },
      {
        request: {
          method: 'POST',
          url: 'https://mcp.example.test/legacy/mcp',
          headers: {
            accept: 'application/json, text/event-stream',
            'content-type': 'application/json',
            'mcp-method': 'server/discover',
            'mcp-protocol-version': '2026-07-28'
          },
          body: {
            jsonrpc: '2.0',
            id: 'server-discover-probe-1',
            method: 'server/discover',
            params: {
              _meta: {
                'io.modelcontextprotocol/protocolVersion': '2026-07-28',
                'io.modelcontextprotocol/clientInfo': {
                  name: 'yolk',
                  version: '0.1.0'
                },
                'io.modelcontextprotocol/clientCapabilities': {}
              }
            }
          }
        },
        response: {
          status: 400,
          headers: {
            'content-type': 'application/json'
          },
          body: '{"jsonrpc":"2.0","id":null,"error":{"code":-32000,"message":"Bad Request: Server not initialized"}}'
        }
      },
      {
        request: {
          method: 'POST',
          url: 'https://mcp.example.test/legacy/mcp',
          headers: {
            accept: 'application/json, text/event-stream',
            'content-type': 'application/json'
          },
          body: {
            jsonrpc: '2.0',
            id: 0,
            method: 'initialize',
            params: {
              protocolVersion: '2025-11-25',
              capabilities: {},
              clientInfo: {
                name: 'yolk',
                version: '0.1.0'
              }
            }
          }
        },
        response: {
          status: 200,
          headers: {
            'content-type': 'text/event-stream',
            'mcp-session-id': 'yolk-synthetic-session-0001'
          },
          chunks: [
            'event: message\nid: evt-1\ndata: {"jsonrpc":"2.0","method":"notifications/message","params":{"level":"info","data":"synthetic notification"}}\n\n',
            'event: message\nid: evt-2\ndata: {"jsonrpc":"2.0","id":0,"result":{"protocolVersion":"2025-11-25","capabilities":{"tools":{}},"serverInfo":{"name":"yolk-synthetic-mcp","version":"0.0.0"}}}\n\n'
          ]
        }
      },
      {
        request: {
          method: 'POST',
          url: 'https://mcp.example.test/legacy/mcp',
          headers: {
            accept: 'application/json, text/event-stream',
            'content-type': 'application/json',
            'mcp-protocol-version': '2025-11-25',
            'mcp-session-id': 'yolk-synthetic-session-0001'
          },
          body: {
            jsonrpc: '2.0',
            method: 'notifications/initialized'
          }
        },
        response: {
          status: 202,
          headers: {},
          body: ''
        }
      },
      {
        request: {
          method: 'GET',
          url: 'https://mcp.example.test/legacy/mcp',
          headers: {
            accept: 'text/event-stream',
            'mcp-protocol-version': '2025-11-25',
            'mcp-session-id': 'yolk-synthetic-session-0001'
          }
        },
        response: {
          status: 405,
          headers: {},
          body: ''
        }
      },
      {
        request: {
          method: 'POST',
          url: 'https://mcp.example.test/legacy/mcp',
          headers: {
            accept: 'application/json, text/event-stream',
            'content-type': 'application/json',
            'mcp-protocol-version': '2025-11-25',
            'mcp-session-id': 'yolk-synthetic-session-0001'
          },
          body: {
            jsonrpc: '2.0',
            id: 1,
            method: 'tools/list'
          }
        },
        response: {
          status: 200,
          headers: {
            'content-type': 'text/event-stream',
            'mcp-session-id': 'yolk-synthetic-session-0001'
          },
          chunks: [
            'event: message\nid: evt-1\ndata: {"jsonrpc":"2.0","method":"notifications/message","params":{"level":"info","data":"synthetic notification"}}\n\n',
            'event: message\nid: evt-2\ndata: {"jsonrpc":"2.0","id":1,"result":{"tools":[{"name":"get_synthetic_note","title":"Get a synthetic note","description":"Read one synthetic note by id.","inputSchema":{"type":"object","properties":{"noteId":{"type":"string"}},"required":["noteId"],"additionalProperties":false},"outputSchema":{"type":"object","properties":{"noteId":{"type":"string"},"text":{"type":"string"}},"required":["noteId","text"],"additionalProperties":false},"annotations":{"readOnlyHint":true}},{"name":"create_synthetic_note","description":"Create one synthetic note.","inputSchema":{"type":"object","properties":{"text":{"type":"string"}},"required":["text"],"additionalProperties":false},"annotations":{"readOnlyHint":false,"destructiveHint":false}}]}}\n\n'
          ]
        }
      },
      {
        request: {
          method: 'POST',
          url: 'https://mcp.example.test/legacy/mcp',
          headers: {
            accept: 'application/json, text/event-stream',
            'content-type': 'application/json',
            'mcp-protocol-version': '2025-11-25',
            'mcp-session-id': 'yolk-synthetic-session-0001'
          },
          body: {
            jsonrpc: '2.0',
            id: 2,
            method: 'tools/call',
            params: {
              name: 'get_synthetic_note',
              arguments: {
                noteId: 'note-0001'
              }
            }
          }
        },
        response: {
          status: 200,
          headers: {
            'content-type': 'text/event-stream',
            'mcp-session-id': 'yolk-synthetic-session-0001'
          },
          chunks: [
            'event: message\nid: evt-1\ndata: {"jsonrpc":"2.0","method":"notifications/message","params":{"level":"info","data":"synthetic notification"}}\n\n',
            'event: message\nid: evt-2\ndata: {"jsonrpc":"2.0","id":2,"result":{"content":[{"type":"text","text":"Synthetic note note-0001."}],"structuredContent":{"noteId":"note-0001","text":"Synthetic note note-0001."}}}\n\n'
          ]
        }
      }
    ]
  },
  {
    id: 'mcp.tools.call-tool-error.modern.synthetic',
    caseId: 'mcp.tools.call-tool-error',
    evidence: 'unverified',
    recordedAt: '2026-10-01',
    account: 'synthetic',
    endpoint: 'https://mcp.example.test/modern/mcp',
    note: 'A listing (the readOnlyHint precondition), then get_synthetic_note with a numeric noteId answered as a tool result with isError true and text content. Synthetic placeholder shaped like the MCP wire the pinned SDK speaks; not recorded from a live service.',
    exchanges: [
      {
        request: {
          method: 'POST',
          url: 'https://mcp.example.test/modern/mcp',
          headers: {
            accept: 'application/json, text/event-stream',
            'content-type': 'application/json',
            'mcp-method': 'server/discover',
            'mcp-protocol-version': '2026-07-28'
          },
          body: {
            jsonrpc: '2.0',
            id: 'server-discover-probe-1',
            method: 'server/discover',
            params: {
              _meta: {
                'io.modelcontextprotocol/protocolVersion': '2026-07-28',
                'io.modelcontextprotocol/clientInfo': {
                  name: 'yolk',
                  version: '0.1.0'
                },
                'io.modelcontextprotocol/clientCapabilities': {}
              }
            }
          }
        },
        response: {
          status: 200,
          headers: {
            'content-type': 'application/json'
          },
          body: '{"jsonrpc":"2.0","id":"server-discover-probe-1","result":{"supportedVersions":["2026-07-28"],"capabilities":{"tools":{}},"resultType":"complete","ttlMs":0,"cacheScope":"private","_meta":{"io.modelcontextprotocol/serverInfo":{"name":"yolk-synthetic-mcp","version":"0.0.0"}}}}'
        }
      },
      {
        request: {
          method: 'POST',
          url: 'https://mcp.example.test/modern/mcp',
          headers: {
            accept: 'application/json, text/event-stream',
            'content-type': 'application/json',
            'mcp-method': 'tools/list',
            'mcp-protocol-version': '2026-07-28'
          },
          body: {
            jsonrpc: '2.0',
            id: 0,
            method: 'tools/list',
            params: {
              _meta: {
                'io.modelcontextprotocol/protocolVersion': '2026-07-28',
                'io.modelcontextprotocol/clientInfo': {
                  name: 'yolk',
                  version: '0.1.0'
                },
                'io.modelcontextprotocol/clientCapabilities': {}
              }
            }
          }
        },
        response: {
          status: 200,
          headers: {
            'content-type': 'application/json'
          },
          body: '{"jsonrpc":"2.0","id":0,"result":{"tools":[{"name":"get_synthetic_note","title":"Get a synthetic note","description":"Read one synthetic note by id.","inputSchema":{"type":"object","properties":{"noteId":{"type":"string"}},"required":["noteId"],"additionalProperties":false},"outputSchema":{"type":"object","properties":{"noteId":{"type":"string"},"text":{"type":"string"}},"required":["noteId","text"],"additionalProperties":false},"annotations":{"readOnlyHint":true}},{"name":"create_synthetic_note","description":"Create one synthetic note.","inputSchema":{"type":"object","properties":{"text":{"type":"string"}},"required":["text"],"additionalProperties":false},"annotations":{"readOnlyHint":false,"destructiveHint":false}}],"resultType":"complete","ttlMs":0,"cacheScope":"private"}}'
        }
      },
      {
        request: {
          method: 'POST',
          url: 'https://mcp.example.test/modern/mcp',
          headers: {
            accept: 'application/json, text/event-stream',
            'content-type': 'application/json',
            'mcp-method': 'server/discover',
            'mcp-protocol-version': '2026-07-28'
          },
          body: {
            jsonrpc: '2.0',
            id: 'server-discover-probe-1',
            method: 'server/discover',
            params: {
              _meta: {
                'io.modelcontextprotocol/protocolVersion': '2026-07-28',
                'io.modelcontextprotocol/clientInfo': {
                  name: 'yolk',
                  version: '0.1.0'
                },
                'io.modelcontextprotocol/clientCapabilities': {}
              }
            }
          }
        },
        response: {
          status: 200,
          headers: {
            'content-type': 'application/json'
          },
          body: '{"jsonrpc":"2.0","id":"server-discover-probe-1","result":{"supportedVersions":["2026-07-28"],"capabilities":{"tools":{}},"resultType":"complete","ttlMs":0,"cacheScope":"private","_meta":{"io.modelcontextprotocol/serverInfo":{"name":"yolk-synthetic-mcp","version":"0.0.0"}}}}'
        }
      },
      {
        request: {
          method: 'POST',
          url: 'https://mcp.example.test/modern/mcp',
          headers: {
            accept: 'application/json, text/event-stream',
            'content-type': 'application/json',
            'mcp-method': 'tools/list',
            'mcp-protocol-version': '2026-07-28'
          },
          body: {
            jsonrpc: '2.0',
            id: 0,
            method: 'tools/list',
            params: {
              _meta: {
                'io.modelcontextprotocol/protocolVersion': '2026-07-28',
                'io.modelcontextprotocol/clientInfo': {
                  name: 'yolk',
                  version: '0.1.0'
                },
                'io.modelcontextprotocol/clientCapabilities': {}
              }
            }
          }
        },
        response: {
          status: 200,
          headers: {
            'content-type': 'application/json'
          },
          body: '{"jsonrpc":"2.0","id":0,"result":{"tools":[{"name":"get_synthetic_note","title":"Get a synthetic note","description":"Read one synthetic note by id.","inputSchema":{"type":"object","properties":{"noteId":{"type":"string"}},"required":["noteId"],"additionalProperties":false},"outputSchema":{"type":"object","properties":{"noteId":{"type":"string"},"text":{"type":"string"}},"required":["noteId","text"],"additionalProperties":false},"annotations":{"readOnlyHint":true}},{"name":"create_synthetic_note","description":"Create one synthetic note.","inputSchema":{"type":"object","properties":{"text":{"type":"string"}},"required":["text"],"additionalProperties":false},"annotations":{"readOnlyHint":false,"destructiveHint":false}}],"resultType":"complete","ttlMs":0,"cacheScope":"private"}}'
        }
      },
      {
        request: {
          method: 'POST',
          url: 'https://mcp.example.test/modern/mcp',
          headers: {
            accept: 'application/json, text/event-stream',
            'content-type': 'application/json',
            'mcp-method': 'tools/call',
            'mcp-protocol-version': '2026-07-28',
            'mcp-name': 'get_synthetic_note'
          },
          body: {
            jsonrpc: '2.0',
            id: 1,
            method: 'tools/call',
            params: {
              name: 'get_synthetic_note',
              arguments: {
                noteId: 42
              },
              _meta: {
                'io.modelcontextprotocol/protocolVersion': '2026-07-28',
                'io.modelcontextprotocol/clientInfo': {
                  name: 'yolk',
                  version: '0.1.0'
                },
                'io.modelcontextprotocol/clientCapabilities': {}
              }
            }
          }
        },
        response: {
          status: 200,
          headers: {
            'content-type': 'application/json'
          },
          body: '{"jsonrpc":"2.0","id":1,"result":{"content":[{"type":"text","text":"Invalid arguments: noteId must be a string."}],"isError":true,"resultType":"complete"}}'
        }
      }
    ]
  },
  {
    id: 'mcp.tools.call-tool-error.legacy.synthetic',
    caseId: 'mcp.tools.call-tool-error',
    evidence: 'unverified',
    recordedAt: '2026-10-01',
    account: 'synthetic',
    endpoint: 'https://mcp.example.test/legacy/mcp',
    note: 'A listing (the readOnlyHint precondition), then get_synthetic_note with a numeric noteId answered as a tool result with isError true and text content. Synthetic placeholder shaped like the MCP wire the pinned SDK speaks; not recorded from a live service.',
    exchanges: [
      {
        request: {
          method: 'POST',
          url: 'https://mcp.example.test/legacy/mcp',
          headers: {
            accept: 'application/json, text/event-stream',
            'content-type': 'application/json',
            'mcp-method': 'server/discover',
            'mcp-protocol-version': '2026-07-28'
          },
          body: {
            jsonrpc: '2.0',
            id: 'server-discover-probe-1',
            method: 'server/discover',
            params: {
              _meta: {
                'io.modelcontextprotocol/protocolVersion': '2026-07-28',
                'io.modelcontextprotocol/clientInfo': {
                  name: 'yolk',
                  version: '0.1.0'
                },
                'io.modelcontextprotocol/clientCapabilities': {}
              }
            }
          }
        },
        response: {
          status: 400,
          headers: {
            'content-type': 'application/json'
          },
          body: '{"jsonrpc":"2.0","id":null,"error":{"code":-32000,"message":"Bad Request: Server not initialized"}}'
        }
      },
      {
        request: {
          method: 'POST',
          url: 'https://mcp.example.test/legacy/mcp',
          headers: {
            accept: 'application/json, text/event-stream',
            'content-type': 'application/json'
          },
          body: {
            jsonrpc: '2.0',
            id: 0,
            method: 'initialize',
            params: {
              protocolVersion: '2025-11-25',
              capabilities: {},
              clientInfo: {
                name: 'yolk',
                version: '0.1.0'
              }
            }
          }
        },
        response: {
          status: 200,
          headers: {
            'content-type': 'text/event-stream',
            'mcp-session-id': 'yolk-synthetic-session-0001'
          },
          chunks: [
            'event: message\nid: evt-1\ndata: {"jsonrpc":"2.0","method":"notifications/message","params":{"level":"info","data":"synthetic notification"}}\n\n',
            'event: message\nid: evt-2\ndata: {"jsonrpc":"2.0","id":0,"result":{"protocolVersion":"2025-11-25","capabilities":{"tools":{}},"serverInfo":{"name":"yolk-synthetic-mcp","version":"0.0.0"}}}\n\n'
          ]
        }
      },
      {
        request: {
          method: 'POST',
          url: 'https://mcp.example.test/legacy/mcp',
          headers: {
            accept: 'application/json, text/event-stream',
            'content-type': 'application/json',
            'mcp-protocol-version': '2025-11-25',
            'mcp-session-id': 'yolk-synthetic-session-0001'
          },
          body: {
            jsonrpc: '2.0',
            method: 'notifications/initialized'
          }
        },
        response: {
          status: 202,
          headers: {},
          body: ''
        }
      },
      {
        request: {
          method: 'GET',
          url: 'https://mcp.example.test/legacy/mcp',
          headers: {
            accept: 'text/event-stream',
            'mcp-protocol-version': '2025-11-25',
            'mcp-session-id': 'yolk-synthetic-session-0001'
          }
        },
        response: {
          status: 405,
          headers: {},
          body: ''
        }
      },
      {
        request: {
          method: 'POST',
          url: 'https://mcp.example.test/legacy/mcp',
          headers: {
            accept: 'application/json, text/event-stream',
            'content-type': 'application/json',
            'mcp-protocol-version': '2025-11-25',
            'mcp-session-id': 'yolk-synthetic-session-0001'
          },
          body: {
            jsonrpc: '2.0',
            id: 1,
            method: 'tools/list'
          }
        },
        response: {
          status: 200,
          headers: {
            'content-type': 'text/event-stream',
            'mcp-session-id': 'yolk-synthetic-session-0001'
          },
          chunks: [
            'event: message\nid: evt-1\ndata: {"jsonrpc":"2.0","method":"notifications/message","params":{"level":"info","data":"synthetic notification"}}\n\n',
            'event: message\nid: evt-2\ndata: {"jsonrpc":"2.0","id":1,"result":{"tools":[{"name":"get_synthetic_note","title":"Get a synthetic note","description":"Read one synthetic note by id.","inputSchema":{"type":"object","properties":{"noteId":{"type":"string"}},"required":["noteId"],"additionalProperties":false},"outputSchema":{"type":"object","properties":{"noteId":{"type":"string"},"text":{"type":"string"}},"required":["noteId","text"],"additionalProperties":false},"annotations":{"readOnlyHint":true}},{"name":"create_synthetic_note","description":"Create one synthetic note.","inputSchema":{"type":"object","properties":{"text":{"type":"string"}},"required":["text"],"additionalProperties":false},"annotations":{"readOnlyHint":false,"destructiveHint":false}}]}}\n\n'
          ]
        }
      },
      {
        request: {
          method: 'POST',
          url: 'https://mcp.example.test/legacy/mcp',
          headers: {
            accept: 'application/json, text/event-stream',
            'content-type': 'application/json',
            'mcp-method': 'server/discover',
            'mcp-protocol-version': '2026-07-28'
          },
          body: {
            jsonrpc: '2.0',
            id: 'server-discover-probe-1',
            method: 'server/discover',
            params: {
              _meta: {
                'io.modelcontextprotocol/protocolVersion': '2026-07-28',
                'io.modelcontextprotocol/clientInfo': {
                  name: 'yolk',
                  version: '0.1.0'
                },
                'io.modelcontextprotocol/clientCapabilities': {}
              }
            }
          }
        },
        response: {
          status: 400,
          headers: {
            'content-type': 'application/json'
          },
          body: '{"jsonrpc":"2.0","id":null,"error":{"code":-32000,"message":"Bad Request: Server not initialized"}}'
        }
      },
      {
        request: {
          method: 'POST',
          url: 'https://mcp.example.test/legacy/mcp',
          headers: {
            accept: 'application/json, text/event-stream',
            'content-type': 'application/json'
          },
          body: {
            jsonrpc: '2.0',
            id: 0,
            method: 'initialize',
            params: {
              protocolVersion: '2025-11-25',
              capabilities: {},
              clientInfo: {
                name: 'yolk',
                version: '0.1.0'
              }
            }
          }
        },
        response: {
          status: 200,
          headers: {
            'content-type': 'text/event-stream',
            'mcp-session-id': 'yolk-synthetic-session-0001'
          },
          chunks: [
            'event: message\nid: evt-1\ndata: {"jsonrpc":"2.0","method":"notifications/message","params":{"level":"info","data":"synthetic notification"}}\n\n',
            'event: message\nid: evt-2\ndata: {"jsonrpc":"2.0","id":0,"result":{"protocolVersion":"2025-11-25","capabilities":{"tools":{}},"serverInfo":{"name":"yolk-synthetic-mcp","version":"0.0.0"}}}\n\n'
          ]
        }
      },
      {
        request: {
          method: 'POST',
          url: 'https://mcp.example.test/legacy/mcp',
          headers: {
            accept: 'application/json, text/event-stream',
            'content-type': 'application/json',
            'mcp-protocol-version': '2025-11-25',
            'mcp-session-id': 'yolk-synthetic-session-0001'
          },
          body: {
            jsonrpc: '2.0',
            method: 'notifications/initialized'
          }
        },
        response: {
          status: 202,
          headers: {},
          body: ''
        }
      },
      {
        request: {
          method: 'GET',
          url: 'https://mcp.example.test/legacy/mcp',
          headers: {
            accept: 'text/event-stream',
            'mcp-protocol-version': '2025-11-25',
            'mcp-session-id': 'yolk-synthetic-session-0001'
          }
        },
        response: {
          status: 405,
          headers: {},
          body: ''
        }
      },
      {
        request: {
          method: 'POST',
          url: 'https://mcp.example.test/legacy/mcp',
          headers: {
            accept: 'application/json, text/event-stream',
            'content-type': 'application/json',
            'mcp-protocol-version': '2025-11-25',
            'mcp-session-id': 'yolk-synthetic-session-0001'
          },
          body: {
            jsonrpc: '2.0',
            id: 1,
            method: 'tools/list'
          }
        },
        response: {
          status: 200,
          headers: {
            'content-type': 'text/event-stream',
            'mcp-session-id': 'yolk-synthetic-session-0001'
          },
          chunks: [
            'event: message\nid: evt-1\ndata: {"jsonrpc":"2.0","method":"notifications/message","params":{"level":"info","data":"synthetic notification"}}\n\n',
            'event: message\nid: evt-2\ndata: {"jsonrpc":"2.0","id":1,"result":{"tools":[{"name":"get_synthetic_note","title":"Get a synthetic note","description":"Read one synthetic note by id.","inputSchema":{"type":"object","properties":{"noteId":{"type":"string"}},"required":["noteId"],"additionalProperties":false},"outputSchema":{"type":"object","properties":{"noteId":{"type":"string"},"text":{"type":"string"}},"required":["noteId","text"],"additionalProperties":false},"annotations":{"readOnlyHint":true}},{"name":"create_synthetic_note","description":"Create one synthetic note.","inputSchema":{"type":"object","properties":{"text":{"type":"string"}},"required":["text"],"additionalProperties":false},"annotations":{"readOnlyHint":false,"destructiveHint":false}}]}}\n\n'
          ]
        }
      },
      {
        request: {
          method: 'POST',
          url: 'https://mcp.example.test/legacy/mcp',
          headers: {
            accept: 'application/json, text/event-stream',
            'content-type': 'application/json',
            'mcp-protocol-version': '2025-11-25',
            'mcp-session-id': 'yolk-synthetic-session-0001'
          },
          body: {
            jsonrpc: '2.0',
            id: 2,
            method: 'tools/call',
            params: {
              name: 'get_synthetic_note',
              arguments: {
                noteId: 42
              }
            }
          }
        },
        response: {
          status: 200,
          headers: {
            'content-type': 'text/event-stream',
            'mcp-session-id': 'yolk-synthetic-session-0001'
          },
          chunks: [
            'event: message\nid: evt-1\ndata: {"jsonrpc":"2.0","method":"notifications/message","params":{"level":"info","data":"synthetic notification"}}\n\n',
            'event: message\nid: evt-2\ndata: {"jsonrpc":"2.0","id":2,"result":{"content":[{"type":"text","text":"Invalid arguments: noteId must be a string."}],"isError":true}}\n\n'
          ]
        }
      }
    ]
  },
  {
    id: 'mcp.errors.unknown-tool.modern.synthetic',
    caseId: 'mcp.errors.unknown-tool',
    evidence: 'unverified',
    recordedAt: '2026-10-01',
    account: 'synthetic',
    endpoint: 'https://mcp.example.test/modern/mcp',
    note: 'A listing without the absent tool, then tools/call of it answered HTTP 400 with a JSON-RPC -32602 error carrying the request id. Synthetic placeholder shaped like the MCP wire the pinned SDK speaks; not recorded from a live service.',
    exchanges: [
      {
        request: {
          method: 'POST',
          url: 'https://mcp.example.test/modern/mcp',
          headers: {
            accept: 'application/json, text/event-stream',
            'content-type': 'application/json',
            'mcp-method': 'server/discover',
            'mcp-protocol-version': '2026-07-28'
          },
          body: {
            jsonrpc: '2.0',
            id: 'server-discover-probe-1',
            method: 'server/discover',
            params: {
              _meta: {
                'io.modelcontextprotocol/protocolVersion': '2026-07-28',
                'io.modelcontextprotocol/clientInfo': {
                  name: 'yolk',
                  version: '0.1.0'
                },
                'io.modelcontextprotocol/clientCapabilities': {}
              }
            }
          }
        },
        response: {
          status: 200,
          headers: {
            'content-type': 'application/json'
          },
          body: '{"jsonrpc":"2.0","id":"server-discover-probe-1","result":{"supportedVersions":["2026-07-28"],"capabilities":{"tools":{}},"resultType":"complete","ttlMs":0,"cacheScope":"private","_meta":{"io.modelcontextprotocol/serverInfo":{"name":"yolk-synthetic-mcp","version":"0.0.0"}}}}'
        }
      },
      {
        request: {
          method: 'POST',
          url: 'https://mcp.example.test/modern/mcp',
          headers: {
            accept: 'application/json, text/event-stream',
            'content-type': 'application/json',
            'mcp-method': 'tools/list',
            'mcp-protocol-version': '2026-07-28'
          },
          body: {
            jsonrpc: '2.0',
            id: 0,
            method: 'tools/list',
            params: {
              _meta: {
                'io.modelcontextprotocol/protocolVersion': '2026-07-28',
                'io.modelcontextprotocol/clientInfo': {
                  name: 'yolk',
                  version: '0.1.0'
                },
                'io.modelcontextprotocol/clientCapabilities': {}
              }
            }
          }
        },
        response: {
          status: 200,
          headers: {
            'content-type': 'application/json'
          },
          body: '{"jsonrpc":"2.0","id":0,"result":{"tools":[{"name":"get_synthetic_note","title":"Get a synthetic note","description":"Read one synthetic note by id.","inputSchema":{"type":"object","properties":{"noteId":{"type":"string"}},"required":["noteId"],"additionalProperties":false},"outputSchema":{"type":"object","properties":{"noteId":{"type":"string"},"text":{"type":"string"}},"required":["noteId","text"],"additionalProperties":false},"annotations":{"readOnlyHint":true}},{"name":"create_synthetic_note","description":"Create one synthetic note.","inputSchema":{"type":"object","properties":{"text":{"type":"string"}},"required":["text"],"additionalProperties":false},"annotations":{"readOnlyHint":false,"destructiveHint":false}}],"resultType":"complete","ttlMs":0,"cacheScope":"private"}}'
        }
      },
      {
        request: {
          method: 'POST',
          url: 'https://mcp.example.test/modern/mcp',
          headers: {
            accept: 'application/json, text/event-stream',
            'content-type': 'application/json',
            'mcp-method': 'server/discover',
            'mcp-protocol-version': '2026-07-28'
          },
          body: {
            jsonrpc: '2.0',
            id: 'server-discover-probe-1',
            method: 'server/discover',
            params: {
              _meta: {
                'io.modelcontextprotocol/protocolVersion': '2026-07-28',
                'io.modelcontextprotocol/clientInfo': {
                  name: 'yolk',
                  version: '0.1.0'
                },
                'io.modelcontextprotocol/clientCapabilities': {}
              }
            }
          }
        },
        response: {
          status: 200,
          headers: {
            'content-type': 'application/json'
          },
          body: '{"jsonrpc":"2.0","id":"server-discover-probe-1","result":{"supportedVersions":["2026-07-28"],"capabilities":{"tools":{}},"resultType":"complete","ttlMs":0,"cacheScope":"private","_meta":{"io.modelcontextprotocol/serverInfo":{"name":"yolk-synthetic-mcp","version":"0.0.0"}}}}'
        }
      },
      {
        request: {
          method: 'POST',
          url: 'https://mcp.example.test/modern/mcp',
          headers: {
            accept: 'application/json, text/event-stream',
            'content-type': 'application/json',
            'mcp-method': 'tools/list',
            'mcp-protocol-version': '2026-07-28'
          },
          body: {
            jsonrpc: '2.0',
            id: 0,
            method: 'tools/list',
            params: {
              _meta: {
                'io.modelcontextprotocol/protocolVersion': '2026-07-28',
                'io.modelcontextprotocol/clientInfo': {
                  name: 'yolk',
                  version: '0.1.0'
                },
                'io.modelcontextprotocol/clientCapabilities': {}
              }
            }
          }
        },
        response: {
          status: 200,
          headers: {
            'content-type': 'application/json'
          },
          body: '{"jsonrpc":"2.0","id":0,"result":{"tools":[{"name":"get_synthetic_note","title":"Get a synthetic note","description":"Read one synthetic note by id.","inputSchema":{"type":"object","properties":{"noteId":{"type":"string"}},"required":["noteId"],"additionalProperties":false},"outputSchema":{"type":"object","properties":{"noteId":{"type":"string"},"text":{"type":"string"}},"required":["noteId","text"],"additionalProperties":false},"annotations":{"readOnlyHint":true}},{"name":"create_synthetic_note","description":"Create one synthetic note.","inputSchema":{"type":"object","properties":{"text":{"type":"string"}},"required":["text"],"additionalProperties":false},"annotations":{"readOnlyHint":false,"destructiveHint":false}}],"resultType":"complete","ttlMs":0,"cacheScope":"private"}}'
        }
      },
      {
        request: {
          method: 'POST',
          url: 'https://mcp.example.test/modern/mcp',
          headers: {
            accept: 'application/json, text/event-stream',
            'content-type': 'application/json',
            'mcp-method': 'tools/call',
            'mcp-protocol-version': '2026-07-28',
            'mcp-name': 'yolk_conformance_absent'
          },
          body: {
            jsonrpc: '2.0',
            id: 1,
            method: 'tools/call',
            params: {
              name: 'yolk_conformance_absent',
              arguments: {},
              _meta: {
                'io.modelcontextprotocol/protocolVersion': '2026-07-28',
                'io.modelcontextprotocol/clientInfo': {
                  name: 'yolk',
                  version: '0.1.0'
                },
                'io.modelcontextprotocol/clientCapabilities': {}
              }
            }
          }
        },
        response: {
          status: 400,
          headers: {
            'content-type': 'application/json'
          },
          body: '{"jsonrpc":"2.0","id":1,"error":{"code":-32602,"message":"Tool yolk_conformance_absent not found"}}'
        }
      }
    ]
  },
  {
    id: 'mcp.errors.unknown-tool.legacy.synthetic',
    caseId: 'mcp.errors.unknown-tool',
    evidence: 'unverified',
    recordedAt: '2026-10-01',
    account: 'synthetic',
    endpoint: 'https://mcp.example.test/legacy/mcp',
    note: 'A listing without the absent tool, then tools/call of it answered HTTP 200 with a JSON-RPC -32602 error event carrying the request id. Synthetic placeholder shaped like the MCP wire the pinned SDK speaks; not recorded from a live service.',
    exchanges: [
      {
        request: {
          method: 'POST',
          url: 'https://mcp.example.test/legacy/mcp',
          headers: {
            accept: 'application/json, text/event-stream',
            'content-type': 'application/json',
            'mcp-method': 'server/discover',
            'mcp-protocol-version': '2026-07-28'
          },
          body: {
            jsonrpc: '2.0',
            id: 'server-discover-probe-1',
            method: 'server/discover',
            params: {
              _meta: {
                'io.modelcontextprotocol/protocolVersion': '2026-07-28',
                'io.modelcontextprotocol/clientInfo': {
                  name: 'yolk',
                  version: '0.1.0'
                },
                'io.modelcontextprotocol/clientCapabilities': {}
              }
            }
          }
        },
        response: {
          status: 400,
          headers: {
            'content-type': 'application/json'
          },
          body: '{"jsonrpc":"2.0","id":null,"error":{"code":-32000,"message":"Bad Request: Server not initialized"}}'
        }
      },
      {
        request: {
          method: 'POST',
          url: 'https://mcp.example.test/legacy/mcp',
          headers: {
            accept: 'application/json, text/event-stream',
            'content-type': 'application/json'
          },
          body: {
            jsonrpc: '2.0',
            id: 0,
            method: 'initialize',
            params: {
              protocolVersion: '2025-11-25',
              capabilities: {},
              clientInfo: {
                name: 'yolk',
                version: '0.1.0'
              }
            }
          }
        },
        response: {
          status: 200,
          headers: {
            'content-type': 'text/event-stream',
            'mcp-session-id': 'yolk-synthetic-session-0001'
          },
          chunks: [
            'event: message\nid: evt-1\ndata: {"jsonrpc":"2.0","method":"notifications/message","params":{"level":"info","data":"synthetic notification"}}\n\n',
            'event: message\nid: evt-2\ndata: {"jsonrpc":"2.0","id":0,"result":{"protocolVersion":"2025-11-25","capabilities":{"tools":{}},"serverInfo":{"name":"yolk-synthetic-mcp","version":"0.0.0"}}}\n\n'
          ]
        }
      },
      {
        request: {
          method: 'POST',
          url: 'https://mcp.example.test/legacy/mcp',
          headers: {
            accept: 'application/json, text/event-stream',
            'content-type': 'application/json',
            'mcp-protocol-version': '2025-11-25',
            'mcp-session-id': 'yolk-synthetic-session-0001'
          },
          body: {
            jsonrpc: '2.0',
            method: 'notifications/initialized'
          }
        },
        response: {
          status: 202,
          headers: {},
          body: ''
        }
      },
      {
        request: {
          method: 'GET',
          url: 'https://mcp.example.test/legacy/mcp',
          headers: {
            accept: 'text/event-stream',
            'mcp-protocol-version': '2025-11-25',
            'mcp-session-id': 'yolk-synthetic-session-0001'
          }
        },
        response: {
          status: 405,
          headers: {},
          body: ''
        }
      },
      {
        request: {
          method: 'POST',
          url: 'https://mcp.example.test/legacy/mcp',
          headers: {
            accept: 'application/json, text/event-stream',
            'content-type': 'application/json',
            'mcp-protocol-version': '2025-11-25',
            'mcp-session-id': 'yolk-synthetic-session-0001'
          },
          body: {
            jsonrpc: '2.0',
            id: 1,
            method: 'tools/list'
          }
        },
        response: {
          status: 200,
          headers: {
            'content-type': 'text/event-stream',
            'mcp-session-id': 'yolk-synthetic-session-0001'
          },
          chunks: [
            'event: message\nid: evt-1\ndata: {"jsonrpc":"2.0","method":"notifications/message","params":{"level":"info","data":"synthetic notification"}}\n\n',
            'event: message\nid: evt-2\ndata: {"jsonrpc":"2.0","id":1,"result":{"tools":[{"name":"get_synthetic_note","title":"Get a synthetic note","description":"Read one synthetic note by id.","inputSchema":{"type":"object","properties":{"noteId":{"type":"string"}},"required":["noteId"],"additionalProperties":false},"outputSchema":{"type":"object","properties":{"noteId":{"type":"string"},"text":{"type":"string"}},"required":["noteId","text"],"additionalProperties":false},"annotations":{"readOnlyHint":true}},{"name":"create_synthetic_note","description":"Create one synthetic note.","inputSchema":{"type":"object","properties":{"text":{"type":"string"}},"required":["text"],"additionalProperties":false},"annotations":{"readOnlyHint":false,"destructiveHint":false}}]}}\n\n'
          ]
        }
      },
      {
        request: {
          method: 'POST',
          url: 'https://mcp.example.test/legacy/mcp',
          headers: {
            accept: 'application/json, text/event-stream',
            'content-type': 'application/json',
            'mcp-method': 'server/discover',
            'mcp-protocol-version': '2026-07-28'
          },
          body: {
            jsonrpc: '2.0',
            id: 'server-discover-probe-1',
            method: 'server/discover',
            params: {
              _meta: {
                'io.modelcontextprotocol/protocolVersion': '2026-07-28',
                'io.modelcontextprotocol/clientInfo': {
                  name: 'yolk',
                  version: '0.1.0'
                },
                'io.modelcontextprotocol/clientCapabilities': {}
              }
            }
          }
        },
        response: {
          status: 400,
          headers: {
            'content-type': 'application/json'
          },
          body: '{"jsonrpc":"2.0","id":null,"error":{"code":-32000,"message":"Bad Request: Server not initialized"}}'
        }
      },
      {
        request: {
          method: 'POST',
          url: 'https://mcp.example.test/legacy/mcp',
          headers: {
            accept: 'application/json, text/event-stream',
            'content-type': 'application/json'
          },
          body: {
            jsonrpc: '2.0',
            id: 0,
            method: 'initialize',
            params: {
              protocolVersion: '2025-11-25',
              capabilities: {},
              clientInfo: {
                name: 'yolk',
                version: '0.1.0'
              }
            }
          }
        },
        response: {
          status: 200,
          headers: {
            'content-type': 'text/event-stream',
            'mcp-session-id': 'yolk-synthetic-session-0001'
          },
          chunks: [
            'event: message\nid: evt-1\ndata: {"jsonrpc":"2.0","method":"notifications/message","params":{"level":"info","data":"synthetic notification"}}\n\n',
            'event: message\nid: evt-2\ndata: {"jsonrpc":"2.0","id":0,"result":{"protocolVersion":"2025-11-25","capabilities":{"tools":{}},"serverInfo":{"name":"yolk-synthetic-mcp","version":"0.0.0"}}}\n\n'
          ]
        }
      },
      {
        request: {
          method: 'POST',
          url: 'https://mcp.example.test/legacy/mcp',
          headers: {
            accept: 'application/json, text/event-stream',
            'content-type': 'application/json',
            'mcp-protocol-version': '2025-11-25',
            'mcp-session-id': 'yolk-synthetic-session-0001'
          },
          body: {
            jsonrpc: '2.0',
            method: 'notifications/initialized'
          }
        },
        response: {
          status: 202,
          headers: {},
          body: ''
        }
      },
      {
        request: {
          method: 'GET',
          url: 'https://mcp.example.test/legacy/mcp',
          headers: {
            accept: 'text/event-stream',
            'mcp-protocol-version': '2025-11-25',
            'mcp-session-id': 'yolk-synthetic-session-0001'
          }
        },
        response: {
          status: 405,
          headers: {},
          body: ''
        }
      },
      {
        request: {
          method: 'POST',
          url: 'https://mcp.example.test/legacy/mcp',
          headers: {
            accept: 'application/json, text/event-stream',
            'content-type': 'application/json',
            'mcp-protocol-version': '2025-11-25',
            'mcp-session-id': 'yolk-synthetic-session-0001'
          },
          body: {
            jsonrpc: '2.0',
            id: 1,
            method: 'tools/list'
          }
        },
        response: {
          status: 200,
          headers: {
            'content-type': 'text/event-stream',
            'mcp-session-id': 'yolk-synthetic-session-0001'
          },
          chunks: [
            'event: message\nid: evt-1\ndata: {"jsonrpc":"2.0","method":"notifications/message","params":{"level":"info","data":"synthetic notification"}}\n\n',
            'event: message\nid: evt-2\ndata: {"jsonrpc":"2.0","id":1,"result":{"tools":[{"name":"get_synthetic_note","title":"Get a synthetic note","description":"Read one synthetic note by id.","inputSchema":{"type":"object","properties":{"noteId":{"type":"string"}},"required":["noteId"],"additionalProperties":false},"outputSchema":{"type":"object","properties":{"noteId":{"type":"string"},"text":{"type":"string"}},"required":["noteId","text"],"additionalProperties":false},"annotations":{"readOnlyHint":true}},{"name":"create_synthetic_note","description":"Create one synthetic note.","inputSchema":{"type":"object","properties":{"text":{"type":"string"}},"required":["text"],"additionalProperties":false},"annotations":{"readOnlyHint":false,"destructiveHint":false}}]}}\n\n'
          ]
        }
      },
      {
        request: {
          method: 'POST',
          url: 'https://mcp.example.test/legacy/mcp',
          headers: {
            accept: 'application/json, text/event-stream',
            'content-type': 'application/json',
            'mcp-protocol-version': '2025-11-25',
            'mcp-session-id': 'yolk-synthetic-session-0001'
          },
          body: {
            jsonrpc: '2.0',
            id: 2,
            method: 'tools/call',
            params: {
              name: 'yolk_conformance_absent',
              arguments: {}
            }
          }
        },
        response: {
          status: 200,
          headers: {
            'content-type': 'text/event-stream',
            'mcp-session-id': 'yolk-synthetic-session-0001'
          },
          chunks: [
            'event: message\nid: evt-1\ndata: {"jsonrpc":"2.0","method":"notifications/message","params":{"level":"info","data":"synthetic notification"}}\n\n',
            'event: message\nid: evt-2\ndata: {"jsonrpc":"2.0","id":2,"error":{"code":-32602,"message":"Tool yolk_conformance_absent not found"}}\n\n'
          ]
        }
      }
    ]
  },
  {
    id: 'mcp.auth.rejected.modern.synthetic',
    caseId: 'mcp.auth.rejected',
    evidence: 'unverified',
    recordedAt: '2026-10-01',
    account: 'synthetic',
    endpoint: 'https://mcp.example.test/modern/mcp',
    note: 'The era probe sent with the reserved invalid credential (authorization is never recorded), answered 401 with a WWW-Authenticate challenge. Synthetic placeholder shaped like the MCP wire the pinned SDK speaks; not recorded from a live service.',
    exchanges: [
      {
        request: {
          method: 'POST',
          url: 'https://mcp.example.test/modern/mcp',
          headers: {
            accept: 'application/json, text/event-stream',
            'content-type': 'application/json',
            'mcp-method': 'server/discover',
            'mcp-protocol-version': '2026-07-28'
          },
          body: {
            jsonrpc: '2.0',
            id: 'server-discover-probe-1',
            method: 'server/discover',
            params: {
              _meta: {
                'io.modelcontextprotocol/protocolVersion': '2026-07-28',
                'io.modelcontextprotocol/clientInfo': {
                  name: 'yolk',
                  version: '0.1.0'
                },
                'io.modelcontextprotocol/clientCapabilities': {}
              }
            }
          }
        },
        response: {
          status: 401,
          headers: {
            'content-type': 'application/json',
            'www-authenticate': 'Bearer error="invalid_token"'
          },
          body: '{"error":"invalid_token","error_description":"Synthetic rejection."}'
        }
      }
    ]
  },
  {
    id: 'mcp.auth.rejected.legacy.synthetic',
    caseId: 'mcp.auth.rejected',
    evidence: 'unverified',
    recordedAt: '2026-10-01',
    account: 'synthetic',
    endpoint: 'https://mcp.example.test/legacy/mcp',
    note: 'The era probe sent with the reserved invalid credential (authorization is never recorded), answered 401 with a WWW-Authenticate challenge. Synthetic placeholder shaped like the MCP wire the pinned SDK speaks; not recorded from a live service.',
    exchanges: [
      {
        request: {
          method: 'POST',
          url: 'https://mcp.example.test/legacy/mcp',
          headers: {
            accept: 'application/json, text/event-stream',
            'content-type': 'application/json',
            'mcp-method': 'server/discover',
            'mcp-protocol-version': '2026-07-28'
          },
          body: {
            jsonrpc: '2.0',
            id: 'server-discover-probe-1',
            method: 'server/discover',
            params: {
              _meta: {
                'io.modelcontextprotocol/protocolVersion': '2026-07-28',
                'io.modelcontextprotocol/clientInfo': {
                  name: 'yolk',
                  version: '0.1.0'
                },
                'io.modelcontextprotocol/clientCapabilities': {}
              }
            }
          }
        },
        response: {
          status: 401,
          headers: {
            'content-type': 'application/json',
            'www-authenticate': 'Bearer error="invalid_token"'
          },
          body: '{"error":"invalid_token","error_description":"Synthetic rejection."}'
        }
      }
    ]
  }
]
