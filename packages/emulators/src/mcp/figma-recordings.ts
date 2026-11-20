/**
 * The synthetic Figma MCP conformance fixtures, copied as data (internal; never imported from
 * `@yolk-sdk/connectors`): the eight `WireFixture`s of `figmaMcpConformanceFixtures` in
 * `@yolk-sdk/connectors/figma/conformance`, in its order, on the provider endpoint
 * `https://mcp.figma.com/mcp` (the legacy era: an `initialize` handshake with a session, SSE
 * answers). They are synthetic placeholders, not recorded from a live service (see their notes).
 * `test/mcp.test.ts` fails when this copy drifts from the source and replays every exchange
 * against the emulator byte for byte. Every value is synthetic; no fixture records
 * `authorization`.
 *
 * @experimental
 */
import type { McpRecordedFixture } from './recordings.ts'

/** Every Figma MCP fixture, in the order of `figmaMcpConformanceFixtures`. */
export const mcpEmulatorFigmaFixtures: ReadonlyArray<McpRecordedFixture> = [
  {
    id: 'mcp.negotiation.era.figma.synthetic',
    caseId: 'mcp.negotiation.era',
    evidence: 'unverified',
    recordedAt: '2026-11-20',
    account: 'synthetic',
    endpoint: 'https://mcp.figma.com/mcp',
    note: 'server/discover answered 400 with a JSON-RPC error; the client falls back to initialize and lists tools in a session. Synthetic placeholder shaped like the MCP wire of a pre-2026 stateful server on the official SDK, on the Figma endpoint; the listing publishes known Figma tool names with synthetic schemas; not recorded from a live service.',
    exchanges: [
      {
        request: {
          method: 'POST',
          url: 'https://mcp.figma.com/mcp',
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
          url: 'https://mcp.figma.com/mcp',
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
            'mcp-session-id': 'yolk-synthetic-figma-session-0001'
          },
          chunks: [
            'event: message\ndata: {"jsonrpc":"2.0","id":0,"result":{"protocolVersion":"2025-11-25","capabilities":{"tools":{}},"serverInfo":{"name":"yolk-synthetic-figma","version":"0.0.0"}}}\n\n'
          ]
        }
      },
      {
        request: {
          method: 'POST',
          url: 'https://mcp.figma.com/mcp',
          headers: {
            accept: 'application/json, text/event-stream',
            'content-type': 'application/json',
            'mcp-protocol-version': '2025-11-25',
            'mcp-session-id': 'yolk-synthetic-figma-session-0001'
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
          url: 'https://mcp.figma.com/mcp',
          headers: {
            accept: 'text/event-stream',
            'mcp-protocol-version': '2025-11-25',
            'mcp-session-id': 'yolk-synthetic-figma-session-0001'
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
          url: 'https://mcp.figma.com/mcp',
          headers: {
            accept: 'application/json, text/event-stream',
            'content-type': 'application/json',
            'mcp-protocol-version': '2025-11-25',
            'mcp-session-id': 'yolk-synthetic-figma-session-0001'
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
            'mcp-session-id': 'yolk-synthetic-figma-session-0001'
          },
          chunks: [
            'event: message\ndata: {"jsonrpc":"2.0","id":1,"result":{"tools":[{"name":"get_design_context","description":"Synthetic placeholder description.","inputSchema":{"type":"object","properties":{"nodeId":{"type":"string"}},"required":["nodeId"],"additionalProperties":false},"annotations":{"readOnlyHint":true}},{"name":"get_metadata","description":"Synthetic placeholder description.","inputSchema":{"type":"object","properties":{"nodeId":{"type":"string"}},"required":["nodeId"],"additionalProperties":false},"annotations":{"readOnlyHint":true}},{"name":"get_screenshot","description":"Synthetic placeholder description.","inputSchema":{"type":"object","properties":{"nodeId":{"type":"string"}},"required":["nodeId"],"additionalProperties":false},"annotations":{"readOnlyHint":true}},{"name":"whoami","description":"Synthetic placeholder description.","inputSchema":{"type":"object","properties":{},"additionalProperties":false},"annotations":{"readOnlyHint":true}},{"name":"use_figma","description":"Synthetic placeholder description.","inputSchema":{"type":"object","properties":{"instructions":{"type":"string"}},"required":["instructions"],"additionalProperties":false},"annotations":{"readOnlyHint":false}},{"name":"create_new_file","description":"Synthetic placeholder description.","inputSchema":{"type":"object","properties":{"name":{"type":"string"}},"required":["name"],"additionalProperties":false},"annotations":{"readOnlyHint":false}}]}}\n\n'
          ]
        }
      }
    ]
  },
  {
    id: 'mcp.legacy.session.figma.synthetic',
    caseId: 'mcp.legacy.session',
    evidence: 'unverified',
    recordedAt: '2026-11-20',
    account: 'synthetic',
    endpoint: 'https://mcp.figma.com/mcp',
    note: 'initialize issues a synthetic session id that every later request echoes; initialized gets 202 and GET gets 405. Synthetic placeholder shaped like the MCP wire of a pre-2026 stateful server on the official SDK, on the Figma endpoint; the listing publishes known Figma tool names with synthetic schemas; not recorded from a live service.',
    exchanges: [
      {
        request: {
          method: 'POST',
          url: 'https://mcp.figma.com/mcp',
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
          url: 'https://mcp.figma.com/mcp',
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
            'mcp-session-id': 'yolk-synthetic-figma-session-0001'
          },
          chunks: [
            'event: message\ndata: {"jsonrpc":"2.0","id":0,"result":{"protocolVersion":"2025-11-25","capabilities":{"tools":{}},"serverInfo":{"name":"yolk-synthetic-figma","version":"0.0.0"}}}\n\n'
          ]
        }
      },
      {
        request: {
          method: 'POST',
          url: 'https://mcp.figma.com/mcp',
          headers: {
            accept: 'application/json, text/event-stream',
            'content-type': 'application/json',
            'mcp-protocol-version': '2025-11-25',
            'mcp-session-id': 'yolk-synthetic-figma-session-0001'
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
          url: 'https://mcp.figma.com/mcp',
          headers: {
            accept: 'text/event-stream',
            'mcp-protocol-version': '2025-11-25',
            'mcp-session-id': 'yolk-synthetic-figma-session-0001'
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
          url: 'https://mcp.figma.com/mcp',
          headers: {
            accept: 'application/json, text/event-stream',
            'content-type': 'application/json',
            'mcp-protocol-version': '2025-11-25',
            'mcp-session-id': 'yolk-synthetic-figma-session-0001'
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
            'mcp-session-id': 'yolk-synthetic-figma-session-0001'
          },
          chunks: [
            'event: message\ndata: {"jsonrpc":"2.0","id":1,"result":{"tools":[{"name":"get_design_context","description":"Synthetic placeholder description.","inputSchema":{"type":"object","properties":{"nodeId":{"type":"string"}},"required":["nodeId"],"additionalProperties":false},"annotations":{"readOnlyHint":true}},{"name":"get_metadata","description":"Synthetic placeholder description.","inputSchema":{"type":"object","properties":{"nodeId":{"type":"string"}},"required":["nodeId"],"additionalProperties":false},"annotations":{"readOnlyHint":true}},{"name":"get_screenshot","description":"Synthetic placeholder description.","inputSchema":{"type":"object","properties":{"nodeId":{"type":"string"}},"required":["nodeId"],"additionalProperties":false},"annotations":{"readOnlyHint":true}},{"name":"whoami","description":"Synthetic placeholder description.","inputSchema":{"type":"object","properties":{},"additionalProperties":false},"annotations":{"readOnlyHint":true}},{"name":"use_figma","description":"Synthetic placeholder description.","inputSchema":{"type":"object","properties":{"instructions":{"type":"string"}},"required":["instructions"],"additionalProperties":false},"annotations":{"readOnlyHint":false}},{"name":"create_new_file","description":"Synthetic placeholder description.","inputSchema":{"type":"object","properties":{"name":{"type":"string"}},"required":["name"],"additionalProperties":false},"annotations":{"readOnlyHint":false}}]}}\n\n'
          ]
        }
      }
    ]
  },
  {
    id: 'mcp.transport.response-encoding.figma.synthetic',
    caseId: 'mcp.transport.response-encoding',
    evidence: 'unverified',
    recordedAt: '2026-11-20',
    account: 'synthetic',
    endpoint: 'https://mcp.figma.com/mcp',
    note: 'Every answer to a request is text/event-stream holding the response, then the stream ends; 202 has no body. Synthetic placeholder shaped like the MCP wire of a pre-2026 stateful server on the official SDK, on the Figma endpoint; the listing publishes known Figma tool names with synthetic schemas; not recorded from a live service.',
    exchanges: [
      {
        request: {
          method: 'POST',
          url: 'https://mcp.figma.com/mcp',
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
          url: 'https://mcp.figma.com/mcp',
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
            'mcp-session-id': 'yolk-synthetic-figma-session-0001'
          },
          chunks: [
            'event: message\ndata: {"jsonrpc":"2.0","id":0,"result":{"protocolVersion":"2025-11-25","capabilities":{"tools":{}},"serverInfo":{"name":"yolk-synthetic-figma","version":"0.0.0"}}}\n\n'
          ]
        }
      },
      {
        request: {
          method: 'POST',
          url: 'https://mcp.figma.com/mcp',
          headers: {
            accept: 'application/json, text/event-stream',
            'content-type': 'application/json',
            'mcp-protocol-version': '2025-11-25',
            'mcp-session-id': 'yolk-synthetic-figma-session-0001'
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
          url: 'https://mcp.figma.com/mcp',
          headers: {
            accept: 'text/event-stream',
            'mcp-protocol-version': '2025-11-25',
            'mcp-session-id': 'yolk-synthetic-figma-session-0001'
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
          url: 'https://mcp.figma.com/mcp',
          headers: {
            accept: 'application/json, text/event-stream',
            'content-type': 'application/json',
            'mcp-protocol-version': '2025-11-25',
            'mcp-session-id': 'yolk-synthetic-figma-session-0001'
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
            'mcp-session-id': 'yolk-synthetic-figma-session-0001'
          },
          chunks: [
            'event: message\ndata: {"jsonrpc":"2.0","id":1,"result":{"tools":[{"name":"get_design_context","description":"Synthetic placeholder description.","inputSchema":{"type":"object","properties":{"nodeId":{"type":"string"}},"required":["nodeId"],"additionalProperties":false},"annotations":{"readOnlyHint":true}},{"name":"get_metadata","description":"Synthetic placeholder description.","inputSchema":{"type":"object","properties":{"nodeId":{"type":"string"}},"required":["nodeId"],"additionalProperties":false},"annotations":{"readOnlyHint":true}},{"name":"get_screenshot","description":"Synthetic placeholder description.","inputSchema":{"type":"object","properties":{"nodeId":{"type":"string"}},"required":["nodeId"],"additionalProperties":false},"annotations":{"readOnlyHint":true}},{"name":"whoami","description":"Synthetic placeholder description.","inputSchema":{"type":"object","properties":{},"additionalProperties":false},"annotations":{"readOnlyHint":true}},{"name":"use_figma","description":"Synthetic placeholder description.","inputSchema":{"type":"object","properties":{"instructions":{"type":"string"}},"required":["instructions"],"additionalProperties":false},"annotations":{"readOnlyHint":false}},{"name":"create_new_file","description":"Synthetic placeholder description.","inputSchema":{"type":"object","properties":{"name":{"type":"string"}},"required":["name"],"additionalProperties":false},"annotations":{"readOnlyHint":false}}]}}\n\n'
          ]
        }
      }
    ]
  },
  {
    id: 'mcp.tools.list.figma.synthetic',
    caseId: 'mcp.tools.list',
    evidence: 'unverified',
    recordedAt: '2026-11-20',
    account: 'synthetic',
    endpoint: 'https://mcp.figma.com/mcp',
    note: 'A listing on one tools/list page in a session: the published tool subset, use_figma and create_new_file marked readOnlyHint false. Synthetic placeholder shaped like the MCP wire of a pre-2026 stateful server on the official SDK, on the Figma endpoint; the listing publishes known Figma tool names with synthetic schemas; not recorded from a live service.',
    exchanges: [
      {
        request: {
          method: 'POST',
          url: 'https://mcp.figma.com/mcp',
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
          url: 'https://mcp.figma.com/mcp',
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
            'mcp-session-id': 'yolk-synthetic-figma-session-0001'
          },
          chunks: [
            'event: message\ndata: {"jsonrpc":"2.0","id":0,"result":{"protocolVersion":"2025-11-25","capabilities":{"tools":{}},"serverInfo":{"name":"yolk-synthetic-figma","version":"0.0.0"}}}\n\n'
          ]
        }
      },
      {
        request: {
          method: 'POST',
          url: 'https://mcp.figma.com/mcp',
          headers: {
            accept: 'application/json, text/event-stream',
            'content-type': 'application/json',
            'mcp-protocol-version': '2025-11-25',
            'mcp-session-id': 'yolk-synthetic-figma-session-0001'
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
          url: 'https://mcp.figma.com/mcp',
          headers: {
            accept: 'text/event-stream',
            'mcp-protocol-version': '2025-11-25',
            'mcp-session-id': 'yolk-synthetic-figma-session-0001'
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
          url: 'https://mcp.figma.com/mcp',
          headers: {
            accept: 'application/json, text/event-stream',
            'content-type': 'application/json',
            'mcp-protocol-version': '2025-11-25',
            'mcp-session-id': 'yolk-synthetic-figma-session-0001'
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
            'mcp-session-id': 'yolk-synthetic-figma-session-0001'
          },
          chunks: [
            'event: message\ndata: {"jsonrpc":"2.0","id":1,"result":{"tools":[{"name":"get_design_context","description":"Synthetic placeholder description.","inputSchema":{"type":"object","properties":{"nodeId":{"type":"string"}},"required":["nodeId"],"additionalProperties":false},"annotations":{"readOnlyHint":true}},{"name":"get_metadata","description":"Synthetic placeholder description.","inputSchema":{"type":"object","properties":{"nodeId":{"type":"string"}},"required":["nodeId"],"additionalProperties":false},"annotations":{"readOnlyHint":true}},{"name":"get_screenshot","description":"Synthetic placeholder description.","inputSchema":{"type":"object","properties":{"nodeId":{"type":"string"}},"required":["nodeId"],"additionalProperties":false},"annotations":{"readOnlyHint":true}},{"name":"whoami","description":"Synthetic placeholder description.","inputSchema":{"type":"object","properties":{},"additionalProperties":false},"annotations":{"readOnlyHint":true}},{"name":"use_figma","description":"Synthetic placeholder description.","inputSchema":{"type":"object","properties":{"instructions":{"type":"string"}},"required":["instructions"],"additionalProperties":false},"annotations":{"readOnlyHint":false}},{"name":"create_new_file","description":"Synthetic placeholder description.","inputSchema":{"type":"object","properties":{"name":{"type":"string"}},"required":["name"],"additionalProperties":false},"annotations":{"readOnlyHint":false}}]}}\n\n'
          ]
        }
      }
    ]
  },
  {
    id: 'mcp.tools.call-read.figma.synthetic',
    caseId: 'mcp.tools.call-read',
    evidence: 'unverified',
    recordedAt: '2026-11-20',
    account: 'synthetic',
    endpoint: 'https://mcp.figma.com/mcp',
    note: 'A listing (the readOnlyHint precondition), then get_metadata answered with a text tool result. Synthetic placeholder shaped like the MCP wire of a pre-2026 stateful server on the official SDK, on the Figma endpoint; the listing publishes known Figma tool names with synthetic schemas; not recorded from a live service.',
    exchanges: [
      {
        request: {
          method: 'POST',
          url: 'https://mcp.figma.com/mcp',
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
          url: 'https://mcp.figma.com/mcp',
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
            'mcp-session-id': 'yolk-synthetic-figma-session-0001'
          },
          chunks: [
            'event: message\ndata: {"jsonrpc":"2.0","id":0,"result":{"protocolVersion":"2025-11-25","capabilities":{"tools":{}},"serverInfo":{"name":"yolk-synthetic-figma","version":"0.0.0"}}}\n\n'
          ]
        }
      },
      {
        request: {
          method: 'POST',
          url: 'https://mcp.figma.com/mcp',
          headers: {
            accept: 'application/json, text/event-stream',
            'content-type': 'application/json',
            'mcp-protocol-version': '2025-11-25',
            'mcp-session-id': 'yolk-synthetic-figma-session-0001'
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
          url: 'https://mcp.figma.com/mcp',
          headers: {
            accept: 'text/event-stream',
            'mcp-protocol-version': '2025-11-25',
            'mcp-session-id': 'yolk-synthetic-figma-session-0001'
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
          url: 'https://mcp.figma.com/mcp',
          headers: {
            accept: 'application/json, text/event-stream',
            'content-type': 'application/json',
            'mcp-protocol-version': '2025-11-25',
            'mcp-session-id': 'yolk-synthetic-figma-session-0001'
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
            'mcp-session-id': 'yolk-synthetic-figma-session-0001'
          },
          chunks: [
            'event: message\ndata: {"jsonrpc":"2.0","id":1,"result":{"tools":[{"name":"get_design_context","description":"Synthetic placeholder description.","inputSchema":{"type":"object","properties":{"nodeId":{"type":"string"}},"required":["nodeId"],"additionalProperties":false},"annotations":{"readOnlyHint":true}},{"name":"get_metadata","description":"Synthetic placeholder description.","inputSchema":{"type":"object","properties":{"nodeId":{"type":"string"}},"required":["nodeId"],"additionalProperties":false},"annotations":{"readOnlyHint":true}},{"name":"get_screenshot","description":"Synthetic placeholder description.","inputSchema":{"type":"object","properties":{"nodeId":{"type":"string"}},"required":["nodeId"],"additionalProperties":false},"annotations":{"readOnlyHint":true}},{"name":"whoami","description":"Synthetic placeholder description.","inputSchema":{"type":"object","properties":{},"additionalProperties":false},"annotations":{"readOnlyHint":true}},{"name":"use_figma","description":"Synthetic placeholder description.","inputSchema":{"type":"object","properties":{"instructions":{"type":"string"}},"required":["instructions"],"additionalProperties":false},"annotations":{"readOnlyHint":false}},{"name":"create_new_file","description":"Synthetic placeholder description.","inputSchema":{"type":"object","properties":{"name":{"type":"string"}},"required":["name"],"additionalProperties":false},"annotations":{"readOnlyHint":false}}]}}\n\n'
          ]
        }
      },
      {
        request: {
          method: 'POST',
          url: 'https://mcp.figma.com/mcp',
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
          url: 'https://mcp.figma.com/mcp',
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
            'mcp-session-id': 'yolk-synthetic-figma-session-0001'
          },
          chunks: [
            'event: message\ndata: {"jsonrpc":"2.0","id":0,"result":{"protocolVersion":"2025-11-25","capabilities":{"tools":{}},"serverInfo":{"name":"yolk-synthetic-figma","version":"0.0.0"}}}\n\n'
          ]
        }
      },
      {
        request: {
          method: 'POST',
          url: 'https://mcp.figma.com/mcp',
          headers: {
            accept: 'application/json, text/event-stream',
            'content-type': 'application/json',
            'mcp-protocol-version': '2025-11-25',
            'mcp-session-id': 'yolk-synthetic-figma-session-0001'
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
          url: 'https://mcp.figma.com/mcp',
          headers: {
            accept: 'text/event-stream',
            'mcp-protocol-version': '2025-11-25',
            'mcp-session-id': 'yolk-synthetic-figma-session-0001'
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
          url: 'https://mcp.figma.com/mcp',
          headers: {
            accept: 'application/json, text/event-stream',
            'content-type': 'application/json',
            'mcp-protocol-version': '2025-11-25',
            'mcp-session-id': 'yolk-synthetic-figma-session-0001'
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
            'mcp-session-id': 'yolk-synthetic-figma-session-0001'
          },
          chunks: [
            'event: message\ndata: {"jsonrpc":"2.0","id":1,"result":{"tools":[{"name":"get_design_context","description":"Synthetic placeholder description.","inputSchema":{"type":"object","properties":{"nodeId":{"type":"string"}},"required":["nodeId"],"additionalProperties":false},"annotations":{"readOnlyHint":true}},{"name":"get_metadata","description":"Synthetic placeholder description.","inputSchema":{"type":"object","properties":{"nodeId":{"type":"string"}},"required":["nodeId"],"additionalProperties":false},"annotations":{"readOnlyHint":true}},{"name":"get_screenshot","description":"Synthetic placeholder description.","inputSchema":{"type":"object","properties":{"nodeId":{"type":"string"}},"required":["nodeId"],"additionalProperties":false},"annotations":{"readOnlyHint":true}},{"name":"whoami","description":"Synthetic placeholder description.","inputSchema":{"type":"object","properties":{},"additionalProperties":false},"annotations":{"readOnlyHint":true}},{"name":"use_figma","description":"Synthetic placeholder description.","inputSchema":{"type":"object","properties":{"instructions":{"type":"string"}},"required":["instructions"],"additionalProperties":false},"annotations":{"readOnlyHint":false}},{"name":"create_new_file","description":"Synthetic placeholder description.","inputSchema":{"type":"object","properties":{"name":{"type":"string"}},"required":["name"],"additionalProperties":false},"annotations":{"readOnlyHint":false}}]}}\n\n'
          ]
        }
      },
      {
        request: {
          method: 'POST',
          url: 'https://mcp.figma.com/mcp',
          headers: {
            accept: 'application/json, text/event-stream',
            'content-type': 'application/json',
            'mcp-protocol-version': '2025-11-25',
            'mcp-session-id': 'yolk-synthetic-figma-session-0001'
          },
          body: {
            jsonrpc: '2.0',
            id: 2,
            method: 'tools/call',
            params: {
              name: 'get_metadata',
              arguments: {
                nodeId: '0:1'
              }
            }
          }
        },
        response: {
          status: 200,
          headers: {
            'content-type': 'text/event-stream',
            'mcp-session-id': 'yolk-synthetic-figma-session-0001'
          },
          chunks: [
            'event: message\ndata: {"jsonrpc":"2.0","id":2,"result":{"content":[{"type":"text","text":"Synthetic metadata of node 0:1."}]}}\n\n'
          ]
        }
      }
    ]
  },
  {
    id: 'mcp.tools.call-tool-error.figma.synthetic',
    caseId: 'mcp.tools.call-tool-error',
    evidence: 'unverified',
    recordedAt: '2026-11-20',
    account: 'synthetic',
    endpoint: 'https://mcp.figma.com/mcp',
    note: 'A listing (the readOnlyHint precondition), then get_metadata with a numeric nodeId answered as a tool result with isError true and text content. Synthetic placeholder shaped like the MCP wire of a pre-2026 stateful server on the official SDK, on the Figma endpoint; the listing publishes known Figma tool names with synthetic schemas; not recorded from a live service.',
    exchanges: [
      {
        request: {
          method: 'POST',
          url: 'https://mcp.figma.com/mcp',
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
          url: 'https://mcp.figma.com/mcp',
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
            'mcp-session-id': 'yolk-synthetic-figma-session-0001'
          },
          chunks: [
            'event: message\ndata: {"jsonrpc":"2.0","id":0,"result":{"protocolVersion":"2025-11-25","capabilities":{"tools":{}},"serverInfo":{"name":"yolk-synthetic-figma","version":"0.0.0"}}}\n\n'
          ]
        }
      },
      {
        request: {
          method: 'POST',
          url: 'https://mcp.figma.com/mcp',
          headers: {
            accept: 'application/json, text/event-stream',
            'content-type': 'application/json',
            'mcp-protocol-version': '2025-11-25',
            'mcp-session-id': 'yolk-synthetic-figma-session-0001'
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
          url: 'https://mcp.figma.com/mcp',
          headers: {
            accept: 'text/event-stream',
            'mcp-protocol-version': '2025-11-25',
            'mcp-session-id': 'yolk-synthetic-figma-session-0001'
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
          url: 'https://mcp.figma.com/mcp',
          headers: {
            accept: 'application/json, text/event-stream',
            'content-type': 'application/json',
            'mcp-protocol-version': '2025-11-25',
            'mcp-session-id': 'yolk-synthetic-figma-session-0001'
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
            'mcp-session-id': 'yolk-synthetic-figma-session-0001'
          },
          chunks: [
            'event: message\ndata: {"jsonrpc":"2.0","id":1,"result":{"tools":[{"name":"get_design_context","description":"Synthetic placeholder description.","inputSchema":{"type":"object","properties":{"nodeId":{"type":"string"}},"required":["nodeId"],"additionalProperties":false},"annotations":{"readOnlyHint":true}},{"name":"get_metadata","description":"Synthetic placeholder description.","inputSchema":{"type":"object","properties":{"nodeId":{"type":"string"}},"required":["nodeId"],"additionalProperties":false},"annotations":{"readOnlyHint":true}},{"name":"get_screenshot","description":"Synthetic placeholder description.","inputSchema":{"type":"object","properties":{"nodeId":{"type":"string"}},"required":["nodeId"],"additionalProperties":false},"annotations":{"readOnlyHint":true}},{"name":"whoami","description":"Synthetic placeholder description.","inputSchema":{"type":"object","properties":{},"additionalProperties":false},"annotations":{"readOnlyHint":true}},{"name":"use_figma","description":"Synthetic placeholder description.","inputSchema":{"type":"object","properties":{"instructions":{"type":"string"}},"required":["instructions"],"additionalProperties":false},"annotations":{"readOnlyHint":false}},{"name":"create_new_file","description":"Synthetic placeholder description.","inputSchema":{"type":"object","properties":{"name":{"type":"string"}},"required":["name"],"additionalProperties":false},"annotations":{"readOnlyHint":false}}]}}\n\n'
          ]
        }
      },
      {
        request: {
          method: 'POST',
          url: 'https://mcp.figma.com/mcp',
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
          url: 'https://mcp.figma.com/mcp',
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
            'mcp-session-id': 'yolk-synthetic-figma-session-0001'
          },
          chunks: [
            'event: message\ndata: {"jsonrpc":"2.0","id":0,"result":{"protocolVersion":"2025-11-25","capabilities":{"tools":{}},"serverInfo":{"name":"yolk-synthetic-figma","version":"0.0.0"}}}\n\n'
          ]
        }
      },
      {
        request: {
          method: 'POST',
          url: 'https://mcp.figma.com/mcp',
          headers: {
            accept: 'application/json, text/event-stream',
            'content-type': 'application/json',
            'mcp-protocol-version': '2025-11-25',
            'mcp-session-id': 'yolk-synthetic-figma-session-0001'
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
          url: 'https://mcp.figma.com/mcp',
          headers: {
            accept: 'text/event-stream',
            'mcp-protocol-version': '2025-11-25',
            'mcp-session-id': 'yolk-synthetic-figma-session-0001'
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
          url: 'https://mcp.figma.com/mcp',
          headers: {
            accept: 'application/json, text/event-stream',
            'content-type': 'application/json',
            'mcp-protocol-version': '2025-11-25',
            'mcp-session-id': 'yolk-synthetic-figma-session-0001'
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
            'mcp-session-id': 'yolk-synthetic-figma-session-0001'
          },
          chunks: [
            'event: message\ndata: {"jsonrpc":"2.0","id":1,"result":{"tools":[{"name":"get_design_context","description":"Synthetic placeholder description.","inputSchema":{"type":"object","properties":{"nodeId":{"type":"string"}},"required":["nodeId"],"additionalProperties":false},"annotations":{"readOnlyHint":true}},{"name":"get_metadata","description":"Synthetic placeholder description.","inputSchema":{"type":"object","properties":{"nodeId":{"type":"string"}},"required":["nodeId"],"additionalProperties":false},"annotations":{"readOnlyHint":true}},{"name":"get_screenshot","description":"Synthetic placeholder description.","inputSchema":{"type":"object","properties":{"nodeId":{"type":"string"}},"required":["nodeId"],"additionalProperties":false},"annotations":{"readOnlyHint":true}},{"name":"whoami","description":"Synthetic placeholder description.","inputSchema":{"type":"object","properties":{},"additionalProperties":false},"annotations":{"readOnlyHint":true}},{"name":"use_figma","description":"Synthetic placeholder description.","inputSchema":{"type":"object","properties":{"instructions":{"type":"string"}},"required":["instructions"],"additionalProperties":false},"annotations":{"readOnlyHint":false}},{"name":"create_new_file","description":"Synthetic placeholder description.","inputSchema":{"type":"object","properties":{"name":{"type":"string"}},"required":["name"],"additionalProperties":false},"annotations":{"readOnlyHint":false}}]}}\n\n'
          ]
        }
      },
      {
        request: {
          method: 'POST',
          url: 'https://mcp.figma.com/mcp',
          headers: {
            accept: 'application/json, text/event-stream',
            'content-type': 'application/json',
            'mcp-protocol-version': '2025-11-25',
            'mcp-session-id': 'yolk-synthetic-figma-session-0001'
          },
          body: {
            jsonrpc: '2.0',
            id: 2,
            method: 'tools/call',
            params: {
              name: 'get_metadata',
              arguments: {
                nodeId: 1
              }
            }
          }
        },
        response: {
          status: 200,
          headers: {
            'content-type': 'text/event-stream',
            'mcp-session-id': 'yolk-synthetic-figma-session-0001'
          },
          chunks: [
            'event: message\ndata: {"jsonrpc":"2.0","id":2,"result":{"content":[{"type":"text","text":"Invalid arguments: nodeId must be a string."}],"isError":true}}\n\n'
          ]
        }
      }
    ]
  },
  {
    id: 'mcp.errors.unknown-tool.figma.synthetic',
    caseId: 'mcp.errors.unknown-tool',
    evidence: 'unverified',
    recordedAt: '2026-11-20',
    account: 'synthetic',
    endpoint: 'https://mcp.figma.com/mcp',
    note: 'A listing without the absent tool, then tools/call of it answered HTTP 200 with a JSON-RPC -32602 error event carrying the request id. Synthetic placeholder shaped like the MCP wire of a pre-2026 stateful server on the official SDK, on the Figma endpoint; the listing publishes known Figma tool names with synthetic schemas; not recorded from a live service.',
    exchanges: [
      {
        request: {
          method: 'POST',
          url: 'https://mcp.figma.com/mcp',
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
          url: 'https://mcp.figma.com/mcp',
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
            'mcp-session-id': 'yolk-synthetic-figma-session-0001'
          },
          chunks: [
            'event: message\ndata: {"jsonrpc":"2.0","id":0,"result":{"protocolVersion":"2025-11-25","capabilities":{"tools":{}},"serverInfo":{"name":"yolk-synthetic-figma","version":"0.0.0"}}}\n\n'
          ]
        }
      },
      {
        request: {
          method: 'POST',
          url: 'https://mcp.figma.com/mcp',
          headers: {
            accept: 'application/json, text/event-stream',
            'content-type': 'application/json',
            'mcp-protocol-version': '2025-11-25',
            'mcp-session-id': 'yolk-synthetic-figma-session-0001'
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
          url: 'https://mcp.figma.com/mcp',
          headers: {
            accept: 'text/event-stream',
            'mcp-protocol-version': '2025-11-25',
            'mcp-session-id': 'yolk-synthetic-figma-session-0001'
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
          url: 'https://mcp.figma.com/mcp',
          headers: {
            accept: 'application/json, text/event-stream',
            'content-type': 'application/json',
            'mcp-protocol-version': '2025-11-25',
            'mcp-session-id': 'yolk-synthetic-figma-session-0001'
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
            'mcp-session-id': 'yolk-synthetic-figma-session-0001'
          },
          chunks: [
            'event: message\ndata: {"jsonrpc":"2.0","id":1,"result":{"tools":[{"name":"get_design_context","description":"Synthetic placeholder description.","inputSchema":{"type":"object","properties":{"nodeId":{"type":"string"}},"required":["nodeId"],"additionalProperties":false},"annotations":{"readOnlyHint":true}},{"name":"get_metadata","description":"Synthetic placeholder description.","inputSchema":{"type":"object","properties":{"nodeId":{"type":"string"}},"required":["nodeId"],"additionalProperties":false},"annotations":{"readOnlyHint":true}},{"name":"get_screenshot","description":"Synthetic placeholder description.","inputSchema":{"type":"object","properties":{"nodeId":{"type":"string"}},"required":["nodeId"],"additionalProperties":false},"annotations":{"readOnlyHint":true}},{"name":"whoami","description":"Synthetic placeholder description.","inputSchema":{"type":"object","properties":{},"additionalProperties":false},"annotations":{"readOnlyHint":true}},{"name":"use_figma","description":"Synthetic placeholder description.","inputSchema":{"type":"object","properties":{"instructions":{"type":"string"}},"required":["instructions"],"additionalProperties":false},"annotations":{"readOnlyHint":false}},{"name":"create_new_file","description":"Synthetic placeholder description.","inputSchema":{"type":"object","properties":{"name":{"type":"string"}},"required":["name"],"additionalProperties":false},"annotations":{"readOnlyHint":false}}]}}\n\n'
          ]
        }
      },
      {
        request: {
          method: 'POST',
          url: 'https://mcp.figma.com/mcp',
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
          url: 'https://mcp.figma.com/mcp',
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
            'mcp-session-id': 'yolk-synthetic-figma-session-0001'
          },
          chunks: [
            'event: message\ndata: {"jsonrpc":"2.0","id":0,"result":{"protocolVersion":"2025-11-25","capabilities":{"tools":{}},"serverInfo":{"name":"yolk-synthetic-figma","version":"0.0.0"}}}\n\n'
          ]
        }
      },
      {
        request: {
          method: 'POST',
          url: 'https://mcp.figma.com/mcp',
          headers: {
            accept: 'application/json, text/event-stream',
            'content-type': 'application/json',
            'mcp-protocol-version': '2025-11-25',
            'mcp-session-id': 'yolk-synthetic-figma-session-0001'
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
          url: 'https://mcp.figma.com/mcp',
          headers: {
            accept: 'text/event-stream',
            'mcp-protocol-version': '2025-11-25',
            'mcp-session-id': 'yolk-synthetic-figma-session-0001'
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
          url: 'https://mcp.figma.com/mcp',
          headers: {
            accept: 'application/json, text/event-stream',
            'content-type': 'application/json',
            'mcp-protocol-version': '2025-11-25',
            'mcp-session-id': 'yolk-synthetic-figma-session-0001'
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
            'mcp-session-id': 'yolk-synthetic-figma-session-0001'
          },
          chunks: [
            'event: message\ndata: {"jsonrpc":"2.0","id":1,"result":{"tools":[{"name":"get_design_context","description":"Synthetic placeholder description.","inputSchema":{"type":"object","properties":{"nodeId":{"type":"string"}},"required":["nodeId"],"additionalProperties":false},"annotations":{"readOnlyHint":true}},{"name":"get_metadata","description":"Synthetic placeholder description.","inputSchema":{"type":"object","properties":{"nodeId":{"type":"string"}},"required":["nodeId"],"additionalProperties":false},"annotations":{"readOnlyHint":true}},{"name":"get_screenshot","description":"Synthetic placeholder description.","inputSchema":{"type":"object","properties":{"nodeId":{"type":"string"}},"required":["nodeId"],"additionalProperties":false},"annotations":{"readOnlyHint":true}},{"name":"whoami","description":"Synthetic placeholder description.","inputSchema":{"type":"object","properties":{},"additionalProperties":false},"annotations":{"readOnlyHint":true}},{"name":"use_figma","description":"Synthetic placeholder description.","inputSchema":{"type":"object","properties":{"instructions":{"type":"string"}},"required":["instructions"],"additionalProperties":false},"annotations":{"readOnlyHint":false}},{"name":"create_new_file","description":"Synthetic placeholder description.","inputSchema":{"type":"object","properties":{"name":{"type":"string"}},"required":["name"],"additionalProperties":false},"annotations":{"readOnlyHint":false}}]}}\n\n'
          ]
        }
      },
      {
        request: {
          method: 'POST',
          url: 'https://mcp.figma.com/mcp',
          headers: {
            accept: 'application/json, text/event-stream',
            'content-type': 'application/json',
            'mcp-protocol-version': '2025-11-25',
            'mcp-session-id': 'yolk-synthetic-figma-session-0001'
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
            'mcp-session-id': 'yolk-synthetic-figma-session-0001'
          },
          chunks: [
            'event: message\ndata: {"jsonrpc":"2.0","id":2,"error":{"code":-32602,"message":"Tool yolk_conformance_absent not found"}}\n\n'
          ]
        }
      }
    ]
  },
  {
    id: 'mcp.auth.rejected.figma.synthetic',
    caseId: 'mcp.auth.rejected',
    evidence: 'unverified',
    recordedAt: '2026-11-20',
    account: 'synthetic',
    endpoint: 'https://mcp.figma.com/mcp',
    note: 'The era probe sent with the reserved invalid credential (authorization is never recorded), answered 401 with a WWW-Authenticate challenge of the Bearer scheme. Synthetic placeholder shaped like the MCP wire of a pre-2026 stateful server on the official SDK, on the Figma endpoint; the listing publishes known Figma tool names with synthetic schemas; not recorded from a live service.',
    exchanges: [
      {
        request: {
          method: 'POST',
          url: 'https://mcp.figma.com/mcp',
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
