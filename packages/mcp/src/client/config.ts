export type McpRemoteServerConfig = {
  readonly name: string
  readonly type: 'remote'
  readonly url: string
  readonly headers?: Readonly<Record<string, string>>
  readonly enabled?: boolean
}

export type McpLocalServerConfig = {
  readonly name: string
  readonly type: 'local'
  readonly command: ReadonlyArray<string>
  readonly environment?: Readonly<Record<string, string>>
  readonly enabled?: boolean
}

export type McpServerConfig = McpRemoteServerConfig | McpLocalServerConfig

export type McpClientInfo = {
  readonly name: string
  readonly version: string
}

export type McpSecurityPolicy = {
  readonly allowLocalServers: boolean
  readonly allowDevHttpLocalhost: boolean
}

export const defaultMcpClientInfo: McpClientInfo = {
  name: 'yolk',
  version: '0.1.0'
}

export const defaultMcpSecurityPolicy: McpSecurityPolicy = {
  allowLocalServers: false,
  allowDevHttpLocalhost: false
}
