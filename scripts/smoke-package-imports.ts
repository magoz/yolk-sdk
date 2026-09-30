import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { isAbsolute, join } from 'node:path'
import process from 'node:process'
import { pathToFileURL } from 'node:url'
import { execFileSync } from 'node:child_process'

type PackageManifest = {
  readonly name: string
  readonly exports: ReadonlyArray<string>
}

const packages: ReadonlyArray<PackageManifest> = [
  {
    name: '@yolk-sdk/agent',
    exports: [
      '.',
      './client',
      './compaction',
      './loop',
      './loop/testing',
      './oauth',
      './protocol',
      './providers/anthropic',
      './providers/anthropic/claude',
      './providers/anthropic/claude-provider',
      './providers/anthropic/usage',
      './providers/openai',
      './providers/openai/codex',
      './providers/openai/conformance',
      './providers/openai/codex-provider',
      './providers/openai/codex-usage',
      './providers/openai/provider',
      './providers/openai/realtime',
      './providers/openai/speech',
      './providers/vercel/ai-gateway-provider',
      './providers/vercel/conformance',
      './providers/opencode/go-provider',
      './providers/opencode/usage',
      './providers/subscription-usage',
      './providers/xai',
      './providers/xai/grok',
      './providers/xai/grok-provider',
      './providers/xai/usage',
      './react',
      './runtime',
      './skillset',
      './tools',
      './voice',
      './voice/browser',
      './voice/react'
    ]
  },
  {
    name: '@yolk-sdk/connectors',
    exports: [
      '.',
      './agent',
      './afloat',
      './conformance',
      './dropbox',
      './email',
      './figma',
      './fortnox',
      './fortnox/conformance',
      './github',
      './google',
      './linkedin-search',
      './microsoft',
      './microsoft/conformance',
      './notion',
      './r2-storage',
      './telegram',
      './todoist'
    ]
  },
  {
    name: '@yolk-sdk/knowledge',
    exports: [
      '.',
      './agent',
      './chunking',
      './context',
      './documents',
      './embeddings',
      './errors',
      './extraction',
      './files',
      './ingestion',
      './search',
      './store',
      './summarization'
    ]
  },
  {
    name: '@yolk-sdk/mcp',
    exports: ['.', './client', './client/node', './core', './protocol', './server', './server/node']
  },
  { name: '@yolk-sdk/sandbox', exports: ['.', './agent', './testing', './vercel'] },
  { name: '@yolk-sdk/vercel-workflows', exports: ['.', './effect', './testing', './workflow'] },
  {
    name: '@yolk-sdk/harness',
    exports: [
      '.',
      './coordinator',
      './store',
      './inbox',
      './driver',
      './driver/memory',
      './driver/durable-object',
      './outcome'
    ]
  },
  {
    name: '@yolk-sdk/conformance',
    exports: ['./fixture', './replay', './record', './case', './runner']
  },
  {
    name: '@yolk-sdk/emulators',
    exports: ['./router', './gateway', './openai', './node']
  }
]

const extractTarballName = (output: string) => {
  const tarballLine = output
    .split('\n')
    .map(line => line.trim())
    .findLast(line => line.endsWith('.tgz'))

  if (tarballLine === undefined) {
    throw new Error(`Could not find packed tarball in output:\n${output}`)
  }

  return tarballLine
}

const main = async () => {
  const workspaceRoot = process.cwd()
  const fixtureDir = mkdtempSync(join(tmpdir(), 'yolk-package-smoke-'))

  try {
    const tarballs = packages.map(packageManifest => {
      const output = execFileSync(
        'pnpm',
        ['--filter', packageManifest.name, 'pack', '--pack-destination', fixtureDir],
        {
          cwd: workspaceRoot,
          encoding: 'utf8',
          stdio: ['ignore', 'pipe', 'inherit']
        }
      )

      return extractTarballName(output)
    })

    const tarballPaths = tarballs.map(tarball =>
      isAbsolute(tarball) ? tarball : join(fixtureDir, tarball)
    )

    const packageJson = {
      type: 'module',
      private: true,
      dependencies: {
        '@effect/platform-node': '4.0.0-rc.115',
        '@modelcontextprotocol/client': '2.0.0',
        '@modelcontextprotocol/core': '2.0.0',
        '@modelcontextprotocol/server': '2.0.0',
        '@vercel/sandbox': '2.2.1',
        effect: '4.0.0-rc.115',
        'gpt-tokenizer': '^3.4.0',
        react: '>=19',
        workflow: '5.0.0-beta.42'
      }
    }

    writeFileSync(join(fixtureDir, 'package.json'), JSON.stringify(packageJson, null, 2))
    // pnpm 11 reads overrides from workspace config, not package.json's pnpm field.
    // Match the workspace's tested platform graph rather than a newer prerelease.
    writeFileSync(
      join(fixtureDir, 'pnpm-workspace.yaml'),
      "overrides:\n  '@effect/platform-node-shared': 4.0.0-rc.115\n"
    )
    execFileSync('pnpm', ['install', '--ignore-scripts'], {
      cwd: fixtureDir,
      stdio: 'inherit'
    })

    for (const [index, packageManifest] of packages.entries()) {
      const scopedPackageDir = join(
        fixtureDir,
        'node_modules',
        '@yolk-sdk',
        packageManifest.name.replace('@yolk-sdk/', '')
      )

      mkdirSync(scopedPackageDir, { recursive: true })
      execFileSync(
        'tar',
        ['-xzf', tarballPaths[index], '--strip-components', '1', '-C', scopedPackageDir],
        {
          cwd: fixtureDir,
          stdio: 'inherit'
        }
      )
    }

    const imports = packages.flatMap(packageManifest =>
      packageManifest.exports.map(exportPath =>
        exportPath === '.' ? packageManifest.name : `${packageManifest.name}/${exportPath.slice(2)}`
      )
    )

    const smokeFile = join(fixtureDir, 'smoke.mjs')
    writeFileSync(
      smokeFile,
      imports
        .map(
          (specifier, index) =>
            `await import(${JSON.stringify(specifier)}); console.log(${JSON.stringify(index)}, ${JSON.stringify(specifier)})`
        )
        .join('\n') +
        '\n' +
        [
          'const binary = await import("@yolk-sdk/connectors")',
          'const microsoft = await import("@yolk-sdk/connectors/microsoft")',
          'for (const symbol of ["ConnectorBinaryHttpClient", "ConnectorBinaryHttpError", "ConnectorBinaryWriteHttpClient", "ConnectorFileTransferError"]) { if (typeof binary[symbol] !== "function") throw new Error(`Missing binary export: ${symbol}`) }',
          'for (const symbol of ["downloadOneDriveItem", "OneDriveDownloadError", "OneDriveDownloadSource", "createOneDriveFile", "updateOneDriveFile", "downloadOutlookAttachment"]) { if (typeof microsoft[symbol] !== "function") throw new Error(`Missing Microsoft export: ${symbol}`) }',
          'if (microsoft.OneDriveDownloadErrorCode === undefined) throw new Error("Missing download error codes")',
          'if (microsoft.MicrosoftConnector.actions.some(action => /download|content/.test(action.id))) throw new Error("Host download leaked into default actions")',
          'for (const [subpath, symbols] of Object.entries({ google: ["downloadGoogleDriveFile", "exportGoogleDriveFile", "downloadGmailAttachment"], fortnox: ["downloadFortnoxInvoicePreview", "downloadFortnoxArchiveFile"], notion: ["downloadNotionFile"], email: ["downloadEmailAttachment"], telegram: ["downloadTelegramFile"], todoist: ["downloadTodoistAttachment"], github: ["createGithubAppInstallationToken", "uploadGithubAttachment"], "r2-storage": ["R2ObjectClient", "getR2Object", "createR2Object", "updateR2Object"] })) { const module = await import(`@yolk-sdk/connectors/${subpath}`); for (const symbol of symbols) if (typeof module[symbol] !== "function") throw new Error(`Missing file export: ${symbol}`); for (const value of Object.values(module)) if (value && Array.isArray(value.actions) && value.actions.some(action => /download|upload_bytes|create_file|update_file/.test(action.id))) throw new Error("Host bytes leaked into actions") }',
          'const dropbox = await import("@yolk-sdk/connectors/dropbox")',
          'for (const symbol of ["downloadDropboxFile", "DropboxDownloadError", "DropboxDownloadSource", "createDropboxFile", "updateDropboxFile"]) { if (typeof dropbox[symbol] !== "function") throw new Error(`Missing Dropbox export: ${symbol}`) }',
          'if (dropbox.DropboxDownloadErrorCode === undefined) throw new Error("Missing Dropbox download error codes")',
          'if (dropbox.DropboxConnector.actions.some(action => /download|content/.test(action.id))) throw new Error("Host Dropbox download leaked into default actions")',
          'await import("@yolk-sdk/conformance").then(() => { throw new Error("@yolk-sdk/conformance must not expose a root export") }, error => { if (error?.code !== "ERR_PACKAGE_PATH_NOT_EXPORTED") throw error })',
          'const replay = await import("@yolk-sdk/conformance/replay")',
          'if (typeof replay.ReplayHttpClient.layer !== "function" || typeof replay.WireFault.FailAfterChunks !== "function") throw new Error("Missing conformance replay exports")',
          'const gatewayFixtures = await import("@yolk-sdk/agent/providers/vercel/conformance")',
          'if (gatewayFixtures.vercelAiGatewayConformanceFixtures.length !== 4) throw new Error("Missing Gateway conformance fixtures")',
          'const conformanceCase = await import("@yolk-sdk/conformance/case")',
          'const runner = await import("@yolk-sdk/conformance/runner")',
          'if (typeof conformanceCase.defineConformanceCase !== "function" || typeof conformanceCase.expectEqual !== "function" || typeof runner.runConformance !== "function" || typeof runner.formatConformanceReport !== "function") throw new Error("Missing conformance case/runner exports")',
          'if (runner.conformanceSkipReason({ kind: "live", account: "synthetic" }, { id: "example.case.write", safety: "write-reversible" }) !== "writes-not-allowed") throw new Error("Conformance safety policy mismatch")',
          'if (gatewayFixtures.vercelAiGatewayConformanceCases.length !== 4 || !gatewayFixtures.vercelAiGatewayConformanceCases.every(testCase => testCase.safety === "read")) throw new Error("Missing Gateway conformance cases")',
          'const openAiConformance = await import("@yolk-sdk/agent/providers/openai/conformance")',
          'if (openAiConformance.openAiConformanceFixtures.length !== 4 || openAiConformance.openAiConformanceCases.length !== 4 || !openAiConformance.openAiConformanceCases.every(testCase => testCase.safety === "read")) throw new Error("Missing OpenAI conformance cases/fixtures")',
          'const connectorBridges = await import("@yolk-sdk/connectors/conformance")',
          'for (const symbol of ["connectorHttpClientFromEffectHttpClientLayer", "connectorBinaryHttpClientFromEffectHttpClientLayer", "connectorBinaryWriteHttpClientFromEffectHttpClientLayer", "connectorHttpClientsFromEffectHttpClientLayer"]) { if (connectorBridges[symbol] === undefined) throw new Error(`Missing connector conformance export: ${symbol}`) }',
          'if (typeof connectorBridges.staticCredentialResolverLayer !== "function") throw new Error("Missing staticCredentialResolverLayer")',
          'const fortnoxConformance = await import("@yolk-sdk/connectors/fortnox/conformance")',
          'if (fortnoxConformance.fortnoxConformanceCases.length !== 7 || fortnoxConformance.fortnoxConformanceFixtures.length !== 7) throw new Error("Missing Fortnox conformance cases/fixtures")',
          'if (fortnoxConformance.fortnoxConformanceCases.filter(testCase => testCase.safety === "read").length !== 3 || fortnoxConformance.fortnoxConformanceCases.find(testCase => testCase.id === "fortnox.invoice.send-email")?.safety !== "write-irreversible") throw new Error("Fortnox conformance safety mismatch")',
          'if ((await import("@yolk-sdk/connectors/fortnox")).FortnoxConnector.actions.some(action => /email|send/.test(action.id))) throw new Error("Fortnox send leaked into connector actions")',
          'const microsoftConformance = await import("@yolk-sdk/connectors/microsoft/conformance")',
          'if (microsoftConformance.microsoftConformanceCases.length !== 11 || microsoftConformance.microsoftConformanceFixtures.length !== 11) throw new Error("Missing Microsoft conformance cases/fixtures")',
          'if (microsoftConformance.microsoftConformanceCases.filter(testCase => testCase.safety === "read").length !== 5 || microsoftConformance.microsoftConformanceCases.some(testCase => testCase.safety === "write-irreversible")) throw new Error("Microsoft conformance safety mismatch")',
          'if ((await import("@yolk-sdk/connectors/microsoft")).MicrosoftConnector.actions.some(action => /calendar|event/.test(action.id))) throw new Error("Microsoft conformance calendar helpers leaked into connector actions")',
          'await import("@yolk-sdk/emulators").then(() => { throw new Error("@yolk-sdk/emulators must not expose a root export") }, error => { if (error?.code !== "ERR_PACKAGE_PATH_NOT_EXPORTED") throw error })',
          'const emulatorRouter = await import("@yolk-sdk/emulators/router")',
          'if (typeof emulatorRouter.EmulatedHttpClient.layer !== "function" || typeof emulatorRouter.InProcessHttpClient.layer !== "function" || typeof emulatorRouter.EmulatorRoute.url !== "function") throw new Error("Missing emulator router exports")',
          'const gatewayEmulator = (await import("@yolk-sdk/emulators/gateway")).makeGatewayEmulator()',
          'const emulated = await gatewayEmulator.fetch(new Request("https://ai-gateway.vercel.sh/v1/chat/completions", { method: "POST", headers: { authorization: "Bearer synthetic", "content-type": "application/json" }, body: JSON.stringify({ model: "openai/gpt-4.1-nano", messages: [], stream: false }) }))',
          'if (emulated.status !== 200 || emulated.headers.get("x-emulator-evidence") !== "unverified" || (await emulated.json()).object !== "chat.completion") throw new Error("Gateway emulator smoke failed")',
          'const openAiEmulator = (await import("@yolk-sdk/emulators/openai")).makeOpenAiEmulator()',
          'const emulatedOpenAi = await openAiEmulator.fetch(new Request("https://api.openai.com/v1/chat/completions", { method: "POST", headers: { authorization: "Bearer synthetic", "content-type": "application/json" }, body: JSON.stringify({ model: "gpt-4.1-nano", messages: [], stream: false, max_completion_tokens: 16 }) }))',
          'if (emulatedOpenAi.status !== 200 || emulatedOpenAi.headers.get("x-emulator-evidence") !== "unverified" || (await emulatedOpenAi.json()).object !== "chat.completion" || openAiEmulator.ledger.entries()[0]?.maxCompletionTokens !== 16) throw new Error("OpenAI emulator smoke failed")',
          'if (typeof (await import("@yolk-sdk/emulators/node")).serveFetchHandler !== "function") throw new Error("Missing emulator node exports")'
        ].join('\n')
    )

    await import(pathToFileURL(smokeFile).href)
  } finally {
    rmSync(fixtureDir, { recursive: true, force: true })
  }
}

void main()
