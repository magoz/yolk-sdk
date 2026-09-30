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
      './providers/anthropic/conformance',
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
      './providers/opencode/conformance',
      './providers/subscription-usage',
      './providers/xai',
      './providers/xai/grok',
      './providers/xai/grok-provider',
      './providers/xai/usage',
      './providers/xai/conformance',
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
      './dropbox/conformance',
      './email',
      './email/conformance',
      './figma',
      './fortnox',
      './fortnox/conformance',
      './github',
      './github/conformance',
      './google',
      './linkedin-search',
      './microsoft',
      './microsoft/conformance',
      './notion',
      './notion/conformance',
      './r2-storage',
      './r2-storage/conformance',
      './telegram',
      './telegram/conformance',
      './todoist',
      './todoist/conformance'
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
    exports: [
      './router',
      './gateway',
      './openai',
      './anthropic',
      './codex',
      './xai',
      './opencode',
      './email',
      './node'
    ]
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
          'const anthropicConformance = await import("@yolk-sdk/agent/providers/anthropic/conformance")',
          'if (anthropicConformance.anthropicConformanceFixtures.length !== 5 || anthropicConformance.anthropicConformanceCases.length !== 5 || !anthropicConformance.anthropicConformanceCases.every(testCase => testCase.safety === "read")) throw new Error("Missing Anthropic conformance cases/fixtures")',
          'if (openAiConformance.openAiCodexConformanceFixtures.length !== 4 || openAiConformance.openAiCodexConformanceCases.length !== 4 || !openAiConformance.openAiCodexConformanceCases.every(testCase => testCase.safety === "read")) throw new Error("Missing Codex conformance cases/fixtures")',
          'const grokConformance = await import("@yolk-sdk/agent/providers/xai/conformance")',
          'if (grokConformance.xAiGrokConformanceFixtures.length !== 4 || grokConformance.xAiGrokConformanceCases.length !== 4 || !grokConformance.xAiGrokConformanceCases.every(testCase => testCase.safety === "read")) throw new Error("Missing Grok conformance cases/fixtures")',
          'const connectorBridges = await import("@yolk-sdk/connectors/conformance")',
          'for (const symbol of ["connectorHttpClientFromEffectHttpClientLayer", "connectorBinaryHttpClientFromEffectHttpClientLayer", "connectorBinaryWriteHttpClientFromEffectHttpClientLayer", "connectorHttpClientsFromEffectHttpClientLayer", "ConformanceCleanupReporter"]) { if (connectorBridges[symbol] === undefined) throw new Error(`Missing connector conformance export: ${symbol}`) }',
          'if (typeof connectorBridges.staticCredentialResolverLayer !== "function") throw new Error("Missing staticCredentialResolverLayer")',
          'const fortnoxConformance = await import("@yolk-sdk/connectors/fortnox/conformance")',
          'if (fortnoxConformance.fortnoxConformanceCases.length !== 7 || fortnoxConformance.fortnoxConformanceFixtures.length !== 7) throw new Error("Missing Fortnox conformance cases/fixtures")',
          'if (fortnoxConformance.fortnoxConformanceCases.filter(testCase => testCase.safety === "read").length !== 3 || fortnoxConformance.fortnoxConformanceCases.find(testCase => testCase.id === "fortnox.invoice.send-email")?.safety !== "write-irreversible") throw new Error("Fortnox conformance safety mismatch")',
          'if ((await import("@yolk-sdk/connectors/fortnox")).FortnoxConnector.actions.some(action => /email|send/.test(action.id))) throw new Error("Fortnox send leaked into connector actions")',
          'const microsoftConformance = await import("@yolk-sdk/connectors/microsoft/conformance")',
          'if (microsoftConformance.microsoftConformanceCases.length !== 11 || microsoftConformance.microsoftConformanceFixtures.length !== 11) throw new Error("Missing Microsoft conformance cases/fixtures")',
          'if (microsoftConformance.microsoftConformanceCases.filter(testCase => testCase.safety === "read").length !== 5 || microsoftConformance.microsoftConformanceCases.some(testCase => testCase.safety === "write-irreversible")) throw new Error("Microsoft conformance safety mismatch")',
          'if ((await import("@yolk-sdk/connectors/microsoft")).MicrosoftConnector.actions.some(action => /calendar|event/.test(action.id))) throw new Error("Microsoft conformance calendar helpers leaked into connector actions")',
          'const dropboxConformance = await import("@yolk-sdk/connectors/dropbox/conformance")',
          'if (dropboxConformance.dropboxConformanceCases.length !== 8 || dropboxConformance.dropboxConformanceFixtures.length !== 8) throw new Error("Missing Dropbox conformance cases/fixtures")',
          'if (dropboxConformance.dropboxConformanceCases.filter(testCase => testCase.safety === "read").length !== 4 || dropboxConformance.dropboxConformanceCases.some(testCase => testCase.safety === "write-irreversible")) throw new Error("Dropbox conformance safety mismatch")',
          'const notionConformance = await import("@yolk-sdk/connectors/notion/conformance")',
          'if (notionConformance.notionConformanceCases.length !== 8 || notionConformance.notionConformanceFixtures.length !== 8) throw new Error("Missing Notion conformance cases/fixtures")',
          'if (notionConformance.notionConformanceCases.filter(testCase => testCase.safety === "read").length !== 7 || notionConformance.notionConformanceCases.some(testCase => testCase.safety === "write-irreversible")) throw new Error("Notion conformance safety mismatch")',
          'const todoistConformance = await import("@yolk-sdk/connectors/todoist/conformance")',
          'if (todoistConformance.todoistConformanceCases.length !== 7 || todoistConformance.todoistConformanceFixtures.length !== 7 || typeof todoistConformance.findTodoistConformanceLeftovers !== "object") throw new Error("Missing Todoist conformance cases/fixtures")',
          'if (todoistConformance.todoistConformanceCases.filter(testCase => testCase.safety === "read").length !== 3 || todoistConformance.todoistConformanceCases.some(testCase => testCase.safety === "write-irreversible")) throw new Error("Todoist conformance safety mismatch")',
          'const telegramConformance = await import("@yolk-sdk/connectors/telegram/conformance")',
          'if (telegramConformance.telegramConformanceCases.length !== 4 || telegramConformance.telegramConformanceFixtures.length !== 4) throw new Error("Missing Telegram conformance cases/fixtures")',
          'if (telegramConformance.telegramConformanceCases.filter(testCase => testCase.safety === "read").length !== 3 || telegramConformance.telegramConformanceCases.filter(testCase => testCase.safety === "write-irreversible").map(testCase => testCase.id).join() !== "telegram.messages.send-message") throw new Error("Telegram conformance safety mismatch")',
          'const githubConformance = await import("@yolk-sdk/connectors/github/conformance")',
          'if (githubConformance.githubConformanceCases.length !== 7 || githubConformance.githubConformanceFixtures.length !== 7 || typeof githubConformance.findGithubConformanceLeftovers !== "object") throw new Error("Missing GitHub conformance cases/fixtures")',
          'if (githubConformance.githubConformanceCases.filter(testCase => testCase.safety === "read").length !== 4 || githubConformance.githubConformanceCases.filter(testCase => testCase.safety === "write-irreversible").map(testCase => testCase.id).join() !== "github.issues.lifecycle-close") throw new Error("GitHub conformance safety mismatch")',
          'const r2Conformance = await import("@yolk-sdk/connectors/r2-storage/conformance")',
          'if (r2Conformance.r2ConformanceCases.length !== 6 || r2Conformance.r2ConformanceFixtures.length !== 14 || typeof r2Conformance.r2PortsLayerFromBackend !== "function" || typeof r2Conformance.makeR2ReplayBackend !== "function" || typeof r2Conformance.findR2PortFixtureSecrets !== "function") throw new Error("Missing R2 conformance cases/fixtures/bridge")',
          'if (r2Conformance.r2ConformanceCases.filter(testCase => testCase.safety === "read").length !== 4 || r2Conformance.r2ConformanceCases.filter(testCase => testCase.safety === "write-irreversible").length !== 2) throw new Error("R2 conformance safety mismatch")',
          'const emailConformance = await import("@yolk-sdk/connectors/email/conformance")',
          'if (emailConformance.emailConformanceCases.length !== 10 || emailConformance.emailConformanceFixtures.length !== 32 || typeof emailConformance.emailClientLayerFromBackend !== "function" || typeof emailConformance.makeEmailReplayBackend !== "function") throw new Error("Missing email conformance cases/fixtures/bridge")',
          'if (emailConformance.emailConformanceCases.filter(testCase => testCase.safety === "write-irreversible").length !== 3 || emailConformance.emailConformanceCases.filter(testCase => testCase.safety === "read").length !== 3) throw new Error("Email conformance safety mismatch")',
          'await import("@yolk-sdk/emulators").then(() => { throw new Error("@yolk-sdk/emulators must not expose a root export") }, error => { if (error?.code !== "ERR_PACKAGE_PATH_NOT_EXPORTED") throw error })',
          'const emulatorRouter = await import("@yolk-sdk/emulators/router")',
          'if (typeof emulatorRouter.EmulatedHttpClient.layer !== "function" || typeof emulatorRouter.InProcessHttpClient.layer !== "function" || typeof emulatorRouter.EmulatorRoute.url !== "function") throw new Error("Missing emulator router exports")',
          'const gatewayEmulator = (await import("@yolk-sdk/emulators/gateway")).makeGatewayEmulator()',
          'const emulated = await gatewayEmulator.fetch(new Request("https://ai-gateway.vercel.sh/v1/chat/completions", { method: "POST", headers: { authorization: "Bearer synthetic", "content-type": "application/json" }, body: JSON.stringify({ model: "openai/gpt-4.1-nano", messages: [], stream: false }) }))',
          'if (emulated.status !== 200 || emulated.headers.get("x-emulator-evidence") !== null || (await emulated.json()).object !== "chat.completion") throw new Error("Gateway emulator smoke failed")',
          'const openAiEmulator = (await import("@yolk-sdk/emulators/openai")).makeOpenAiEmulator()',
          'const emulatedOpenAi = await openAiEmulator.fetch(new Request("https://api.openai.com/v1/chat/completions", { method: "POST", headers: { authorization: "Bearer synthetic", "content-type": "application/json" }, body: JSON.stringify({ model: "gpt-4.1-nano", messages: [], stream: false, max_completion_tokens: 16 }) }))',
          'if (emulatedOpenAi.status !== 200 || emulatedOpenAi.headers.get("x-emulator-evidence") !== "unverified" || (await emulatedOpenAi.json()).object !== "chat.completion" || openAiEmulator.ledger.entries()[0]?.maxCompletionTokens !== 16) throw new Error("OpenAI emulator smoke failed")',
          'const anthropicEmulator = (await import("@yolk-sdk/emulators/anthropic")).makeAnthropicEmulator()',
          'const emulatedAnthropic = await anthropicEmulator.fetch(new Request("https://api.anthropic.com/v1/messages", { method: "POST", headers: { "x-api-key": "synthetic", "anthropic-version": "2023-06-01", "content-type": "application/json" }, body: JSON.stringify({ model: "claude-haiku-4-5", max_tokens: 16, messages: [], stream: false }) }))',
          'if (emulatedAnthropic.status !== 200 || emulatedAnthropic.headers.get("x-emulator-evidence") !== "unverified" || (await emulatedAnthropic.json()).type !== "message" || anthropicEmulator.ledger.entries()[0]?.credentialHeader !== "x-api-key") throw new Error("Anthropic emulator smoke failed")',
          'const codexEmulator = (await import("@yolk-sdk/emulators/codex")).makeCodexEmulator()',
          'const emulatedCodex = await codexEmulator.fetch(new Request("https://chatgpt.com/backend-api/codex/responses", { method: "POST", headers: { authorization: "Bearer synthetic", originator: "opencode", "content-type": "application/json" }, body: JSON.stringify({ model: "gpt-5.4", input: "Hi", stream: false }) }))',
          'if (emulatedCodex.status !== 200 || emulatedCodex.headers.get("x-emulator-evidence") !== "unverified" || (await emulatedCodex.json()).status !== "completed" || codexEmulator.ledger.entries()[0]?.headers.originator !== "opencode") throw new Error("Codex emulator smoke failed")',
          'const grokEmulator = (await import("@yolk-sdk/emulators/xai")).makeXAiGrokEmulator()',
          'const grokUrl = "https://cli-chat-proxy.grok.com/v1/responses"',
          'const grokBody = JSON.stringify({ model: "grok-build", input: "Hi", stream: false, max_output_tokens: 16 })',
          'const unversionedGrok = await grokEmulator.fetch(new Request(grokUrl, { method: "POST", headers: { authorization: "Bearer synthetic", "x-xai-token-auth": "synthetic", "x-grok-model-override": "grok-build", "content-type": "application/json" }, body: grokBody }))',
          'const emulatedGrok = await grokEmulator.fetch(new Request(grokUrl, { method: "POST", headers: { authorization: "Bearer synthetic", "x-xai-token-auth": "synthetic", "x-grok-model-override": "grok-build", "x-grok-client-version": "0.0.0-synthetic", "content-type": "application/json" }, body: grokBody }))',
          'if (unversionedGrok.status !== 426 || emulatedGrok.status !== 200 || (await emulatedGrok.json()).status !== "completed" || grokEmulator.ledger.entries()[1]?.maxOutputTokens !== 16) throw new Error("Grok emulator smoke failed")',
          'const claudeUsage = await anthropicEmulator.fetch(new Request("https://api.anthropic.com/api/oauth/usage", { headers: { accept: "application/json", authorization: "Bearer synthetic", "anthropic-beta": "oauth-2025-04-20" } }))',
          'if (claudeUsage.status !== 200 || (await claudeUsage.json()).five_hour?.utilization === undefined || anthropicEmulator.usage.ledger.entries().length !== 1 || anthropicEmulator.ledger.entries().length !== 1) throw new Error("Claude usage emulator smoke failed")',
          'const goEmulator = (await import("@yolk-sdk/emulators/opencode")).makeOpenCodeGoEmulator()',
          'const goChatBody = { model: "synthetic-go-chat", messages: [{ role: "system", content: "Reply in one short sentence." }, { role: "user", content: "Say hello." }], max_tokens: 16, stream: true, stream_options: { include_usage: true } }',
          'const goChat = await goEmulator.fetch(new Request("https://opencode.ai/zen/go/v1/chat/completions", { method: "POST", headers: { authorization: "Bearer synthetic", accept: "text/event-stream", "content-type": "application/json" }, body: JSON.stringify(goChatBody) }))',
          'const goJsonChat = await goEmulator.fetch(new Request("https://opencode.ai/zen/go/v1/chat/completions", { method: "POST", headers: { authorization: "Bearer synthetic", accept: "text/event-stream", "content-type": "application/json" }, body: JSON.stringify({ ...goChatBody, stream: false }) }))',
          'const goMessages = await goEmulator.fetch(new Request("https://opencode.ai/zen/go/v1/messages", { method: "POST", headers: { authorization: "Bearer synthetic", "anthropic-version": "2023-06-01", "content-type": "application/json" }, body: JSON.stringify({ model: "synthetic-go-messages", messages: [], stream: false, max_tokens: 16 }) }))',
          'const goUsage = await goEmulator.fetch(new Request("https://opencode.ai/zen/go/v1/usage", { headers: { accept: "application/json", authorization: "Bearer synthetic" } }))',
          'if (goChat.status !== 200 || !(await goChat.text()).endsWith("data: [DONE]\\n\\n") || goJsonChat.status !== 400 || (await goJsonChat.json()).error?.type !== "not_emulated" || goMessages.status !== 400 || goUsage.status !== 200 || (await goUsage.json()).usage?.rolling?.percent === undefined || goEmulator.coverage().routes.length !== 4) throw new Error("OpenCode Go emulator smoke failed")',
          'const goConformance = await import("@yolk-sdk/agent/providers/opencode/conformance")',
          'if (goConformance.openCodeGoConformanceCases.length !== 5 || goConformance.openCodeGoConformanceFixtures.length !== 5 || !goConformance.openCodeGoConformanceCases.every(testCase => testCase.safety === "read")) throw new Error("Missing OpenCode Go conformance cases/fixtures")',
          'if (anthropicConformance.anthropicClaudeUsageConformanceCases.length !== 1 || openAiConformance.openAiCodexUsageConformanceCases.length !== 1 || grokConformance.xAiGrokUsageConformanceCases.length !== 1 || grokConformance.xAiGrokUsageConformanceFixtures.length !== 1) throw new Error("Missing subscription-usage conformance cases/fixtures")',
          'const emailEmulator = (await import("@yolk-sdk/emulators/email")).makeEmailEmulator()',
          'const emailFixture = emailConformance.emailConformanceFixtures[0]',
          'const emailReply = emailEmulator.call(emailFixture.method, emailFixture.request)',
          'const emailRefused = emailEmulator.call("listMessages", { limit: 1 })',
          'if (JSON.stringify(emailReply) !== JSON.stringify({ response: emailFixture.response }) || !("notEmulated" in emailRefused) || emailEmulator.ledger.entries().length !== 2 || emailEmulator.coverage().notEmulatedCalls !== 1) throw new Error("Email emulator smoke failed")',
          'if (typeof (await import("@yolk-sdk/emulators/node")).serveFetchHandler !== "function") throw new Error("Missing emulator node exports")'
        ].join('\n')
    )

    await import(pathToFileURL(smokeFile).href)
  } finally {
    rmSync(fixtureDir, { recursive: true, force: true })
  }
}

void main()
