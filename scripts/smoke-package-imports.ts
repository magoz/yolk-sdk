import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { register } from 'node:module'
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
      './classification',
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
      './providers/vercel/ai-gateway-classifier',
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
      './afloat/conformance',
      './conformance',
      './dropbox',
      './dropbox/conformance',
      './email',
      './email/conformance',
      './figma',
      './figma/conformance',
      './fortnox',
      './fortnox/conformance',
      './github',
      './github/conformance',
      './google',
      './google/conformance',
      './kie',
      './kie/conformance',
      './linkedin-search',
      './linkedin-search/conformance',
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
    exports: [
      '.',
      './client',
      './client/node',
      './conformance',
      './core',
      './protocol',
      './server',
      './server/node'
    ]
  },
  { name: '@yolk-sdk/sandbox', exports: ['.', './agent', './cloudflare', './testing', './vercel'] },
  { name: '@yolk-sdk/files', exports: ['.'] },
  { name: '@yolk-sdk/pool', exports: ['.', './store'] },
  { name: '@yolk-sdk/codemode', exports: ['.', './cloudflare', './node'] },
  {
    name: '@yolk-sdk/extractors',
    exports: ['.', './knowledge', './node', './node/extraction-worker']
  },
  {
    name: '@yolk-sdk/vercel-workflows',
    exports: [
      '.',
      './cloudflare',
      './cloudflare/api',
      './cloudflare/directives',
      './cloudflare/vite',
      './cloudflare/workflow',
      './effect',
      './testing',
      './workflow'
    ]
  },
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
      './r2',
      './node',
      './fortnox',
      './microsoft',
      './dropbox',
      './notion',
      './todoist',
      './telegram',
      './github',
      './google',
      './linkedin-search',
      './mcp',
      './kie'
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

/**
 * Heavy dependencies that public subpaths load only on first use. Each subpath must import without
 * evaluating its dependency (`lazyImports`), and a production bundle must keep the dependency out
 * of the importer's chunk (`checkBundleSplits`).
 */
const lazyDependencies = [
  {
    subpaths: ['@yolk-sdk/knowledge/chunking', '@yolk-sdk/knowledge/ingestion'],
    entry:
      'export { KnowledgeChunker, DefaultKnowledgeChunkerLive } from "@yolk-sdk/knowledge/chunking"',
    dependency: 'gpt-tokenizer'
  },
  {
    subpaths: ['@yolk-sdk/codemode/cloudflare'],
    entry: 'export { makeDynamicWorkerCodeModeExecutor } from "@yolk-sdk/codemode/cloudflare"',
    dependency: 'sucrase'
  }
] as const

/**
 * Imports the lazy subpaths in a fresh process (the smoke above already loaded everything), with a
 * module hook recording what loads, then uses them and checks their dependencies loaded then.
 */
const checkLazyImports = (fixtureDir: string, cloudflareStub: string) => {
  const lazyFile = join(fixtureDir, 'lazy.mjs')

  writeFileSync(
    lazyFile,
    [
      'import { registerHooks } from "node:module"',
      `const stub = ${JSON.stringify(pathToFileURL(cloudflareStub).href)}`,
      'const loaded = []',
      'registerHooks({',
      '  resolve: (specifier, context, next) => specifier === "cloudflare:workers" ? { url: stub, shortCircuit: true } : next(specifier, context),',
      '  load: (url, context, next) => { loaded.push(url); return next(url, context) }',
      '})',
      'const evaluated = name => loaded.some(url => url.includes(`/node_modules/${name}/`))',
      ...lazyDependencies.flatMap(({ subpaths, dependency }) => [
        ...subpaths.map(subpath => `await import(${JSON.stringify(subpath)})`),
        `if (evaluated(${JSON.stringify(dependency)})) throw new Error(${JSON.stringify(`${subpaths.join(', ')} evaluated ${dependency} on import`)})`
      ]),
      'const { Effect } = await import("effect")',
      'const chunking = await import("@yolk-sdk/knowledge/chunking")',
      'const count = await Effect.runPromise(chunking.countKnowledgeChunkTokens("hello world"))',
      'if (count !== 2 || !evaluated("gpt-tokenizer")) throw new Error(`Lazy tokenizer smoke failed: ${count}`)',
      'const codemodeCloudflare = await import("@yolk-sdk/codemode/cloudflare")',
      'const failedLoad = await codemodeCloudflare.makeDynamicWorkerCodeModeExecutor({ loader: () => { throw new Error("no loader") } }).execute("return 1", { tools: [], globals: [], timeoutMs: 1000, memoryLimitBytes: 1048576, store: {}, signal: new AbortController().signal })',
      'if (failedLoad.ok || !evaluated("sucrase")) throw new Error("Lazy Sucrase smoke failed")'
    ].join('\n')
  )
  execFileSync(process.execPath, [lazyFile], { cwd: fixtureDir, stdio: 'inherit' })
}

/**
 * Bundles each lazy subpath's typical import with Vite (Rolldown, as Workers and browser builds
 * do) and checks the dependency lands in a chunk of its own that the entry imports dynamically.
 */
const checkBundleSplits = async (fixtureDir: string) => {
  const { build } = await import('vite')

  for (const { entry, dependency } of lazyDependencies) {
    const entryFile = join(fixtureDir, `bundle-${dependency}.mjs`)

    writeFileSync(entryFile, `${entry}\n`)

    const result = await build({
      configFile: false,
      root: fixtureDir,
      logLevel: 'silent',
      build: {
        write: false,
        minify: false,
        lib: { entry: entryFile, formats: ['es'] },
        rollupOptions: { external: ['cloudflare:workers'] }
      }
    })

    const outputs = (Array.isArray(result) ? result : [result]).flatMap(output =>
      'output' in output ? output.output : []
    )

    const chunks = outputs.flatMap(output => (output.type === 'chunk' ? [output] : []))

    const bundles = (chunk: (typeof chunks)[number]) =>
      chunk.moduleIds.some(id => id.includes(`/node_modules/${dependency}/`))

    // The chunks evaluated when the entry is imported: the entry and its static imports, transitively.
    const staticClosure = new Set<string>()

    const visit = (fileName: string) => {
      const chunk = chunks.find(candidate => candidate.fileName === fileName)

      if (chunk === undefined || staticClosure.has(fileName)) return

      staticClosure.add(fileName)
      chunk.imports.forEach(visit)
    }

    chunks.filter(chunk => chunk.isEntry).forEach(chunk => visit(chunk.fileName))

    const dependencyChunks = chunks.filter(bundles)

    if (
      staticClosure.size === 0 ||
      dependencyChunks.length === 0 ||
      dependencyChunks.some(chunk => staticClosure.has(chunk.fileName))
    ) {
      throw new Error(`${entry}: the bundle does not keep ${dependency} in a lazy chunk`)
    }

    const kilobytes = (inStaticClosure: boolean) =>
      Math.round(
        chunks
          .filter(chunk => staticClosure.has(chunk.fileName) === inStaticClosure)
          .reduce((sum, chunk) => sum + chunk.code.length, 0) / 1024
      )

    console.log(
      `bundle: ${dependency} lazy (${kilobytes(true)} KB on import, ${kilobytes(false)} KB on first use)`
    )
  }
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
        // Dependency of @yolk-sdk/codemode; tarballs are extracted, not installed.
        '@earendil-works/pi-codemode': '1.0.0',
        '@effect/platform-node': '4.1.4',
        // Dependency of @yolk-sdk/emulators (./fortnox); tarballs are extracted, not installed.
        '@emulators/core': '0.12.0',
        '@modelcontextprotocol/client': '2.0.0',
        '@modelcontextprotocol/core': '2.0.0',
        '@modelcontextprotocol/server': '2.0.0',
        '@vercel/sandbox': '2.2.1',
        // Dependency of @yolk-sdk/vercel-workflows (./cloudflare).
        devalue: '^6.0.3',
        effect: '4.1.4',
        // Dependency of @yolk-sdk/mcp (./conformance), with the MCP client's own range.
        'eventsource-parser': '^3.0.0',
        // Dependencies of @yolk-sdk/extractors (./node); SheetJS is its optional peer, installed
        // from the SheetJS CDN like consumers do (npm `xlsx` stops at the vulnerable 0.18.5).
        fflate: '^0.8.3',
        mammoth: '^1.13.0',
        unpdf: '^1.8.1',
        xlsx: 'https://cdn.sheetjs.com/xlsx-0.20.3/xlsx-0.20.3.tgz',
        'gpt-tokenizer': '^3.4.0',
        react: '>=19',
        // Dependency of @yolk-sdk/codemode (./cloudflare).
        sucrase: '^3.35.1',
        workflow: '5.0.0-beta.42'
      }
    }

    writeFileSync(join(fixtureDir, 'package.json'), JSON.stringify(packageJson, null, 2))
    // pnpm 11 reads overrides from workspace config, not package.json's pnpm field.
    // Match the workspace's tested platform graph rather than a newer release.
    writeFileSync(
      join(fixtureDir, 'pnpm-workspace.yaml'),
      "overrides:\n  '@effect/platform-node-shared': 4.1.4\n"
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

    // The `./cloudflare` subpaths import workerd's `cloudflare:workers`; Node resolves it to a
    // stub with what they import (a Worker's runtime provides the real module).
    const cloudflareStub = join(fixtureDir, 'cloudflare-workers-stub.mjs')
    writeFileSync(
      cloudflareStub,
      [
        'export class DurableObject { constructor(ctx, env) { this.ctx = ctx; this.env = env } }',
        'export class RpcTarget {}',
        'export const env = {}'
      ].join('\n')
    )

    const cloudflareHooks = [
      `const stub = ${JSON.stringify(pathToFileURL(cloudflareStub).href)}`,
      'export const resolve = (specifier, context, next) =>',
      "  specifier === 'cloudflare:workers' ? { url: stub, shortCircuit: true } : next(specifier, context)"
    ].join('\n')

    register(`data:text/javascript,${encodeURIComponent(cloudflareHooks)}`)

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
          'for (const [subpath, symbols] of Object.entries({ google: ["downloadGoogleDriveFile", "exportGoogleDriveFile", "downloadGmailAttachment"], fortnox: ["downloadFortnoxInvoicePreview", "downloadFortnoxArchiveFile", "downloadFortnoxOfferPreview", "downloadFortnoxInboxFile", "uploadFortnoxInboxFile"], notion: ["downloadNotionFile"], email: ["downloadEmailAttachment"], telegram: ["downloadTelegramFile"], todoist: ["downloadTodoistAttachment"], github: ["createGithubAppInstallationToken", "uploadGithubAttachment"], "r2-storage": ["R2ObjectClient", "getR2Object", "createR2Object", "updateR2Object"] })) { const module = await import(`@yolk-sdk/connectors/${subpath}`); for (const symbol of symbols) if (typeof module[symbol] !== "function") throw new Error(`Missing file export: ${symbol}`); for (const value of Object.values(module)) if (value && Array.isArray(value.actions) && value.actions.some(action => /download|upload_bytes|create_file|update_file/.test(action.id))) throw new Error("Host bytes leaked into actions") }',
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
          'if (gatewayFixtures.vercelAiGatewayClassifierConformanceFixtures.length !== 4 || gatewayFixtures.vercelAiGatewayClassifierConformanceCases.length !== 4 || !gatewayFixtures.vercelAiGatewayClassifierConformanceCases.every(testCase => testCase.safety === "read")) throw new Error("Missing Gateway classifier conformance cases/fixtures")',
          'const classification = await import("@yolk-sdk/agent/classification")',
          'if (typeof classification.classify !== "function" || typeof classification.ClassifierModel !== "function" || typeof classification.decodeClassifierAnswers !== "function") throw new Error("Missing classification exports")',
          'const gatewayClassifier = await import("@yolk-sdk/agent/providers/vercel/ai-gateway-classifier")',
          'if (typeof gatewayClassifier.makeVercelAiGatewayClassifierLayer !== "function" || gatewayClassifier.vercelAiGatewayClassifierDefaultModel !== "typesafe-ai/jev") throw new Error("Missing Gateway classifier exports")',
          'const openAiConformance = await import("@yolk-sdk/agent/providers/openai/conformance")',
          'if (openAiConformance.openAiConformanceFixtures.length !== 7 || openAiConformance.openAiConformanceCases.length !== 7 || !openAiConformance.openAiConformanceCases.every(testCase => testCase.safety === "read")) throw new Error("Missing OpenAI conformance cases/fixtures")',
          'const anthropicConformance = await import("@yolk-sdk/agent/providers/anthropic/conformance")',
          'if (anthropicConformance.anthropicConformanceFixtures.length !== 5 || anthropicConformance.anthropicConformanceCases.length !== 5 || !anthropicConformance.anthropicConformanceCases.every(testCase => testCase.safety === "read")) throw new Error("Missing Anthropic conformance cases/fixtures")',
          'if (openAiConformance.openAiCodexConformanceFixtures.length !== 4 || openAiConformance.openAiCodexConformanceCases.length !== 4 || !openAiConformance.openAiCodexConformanceCases.every(testCase => testCase.safety === "read")) throw new Error("Missing Codex conformance cases/fixtures")',
          'const grokConformance = await import("@yolk-sdk/agent/providers/xai/conformance")',
          'if (grokConformance.xAiGrokConformanceFixtures.length !== 4 || grokConformance.xAiGrokConformanceCases.length !== 4 || !grokConformance.xAiGrokConformanceCases.every(testCase => testCase.safety === "read")) throw new Error("Missing Grok conformance cases/fixtures")',
          'const connectorBridges = await import("@yolk-sdk/connectors/conformance")',
          'for (const symbol of ["connectorHttpClientFromEffectHttpClientLayer", "connectorBinaryHttpClientFromEffectHttpClientLayer", "connectorBinaryWriteHttpClientFromEffectHttpClientLayer", "connectorHttpClientsFromEffectHttpClientLayer", "ConformanceCleanupReporter"]) { if (connectorBridges[symbol] === undefined) throw new Error(`Missing connector conformance export: ${symbol}`) }',
          'if (typeof connectorBridges.staticCredentialResolverLayer !== "function") throw new Error("Missing staticCredentialResolverLayer")',
          'const fortnoxConformance = await import("@yolk-sdk/connectors/fortnox/conformance")',
          'if (fortnoxConformance.fortnoxConformanceCases.length !== 21 || fortnoxConformance.fortnoxConformanceFixtures.length !== 21) throw new Error("Missing Fortnox conformance cases/fixtures")',
          'if (fortnoxConformance.fortnoxConformanceCases.filter(testCase => testCase.safety === "read").length !== 17 || fortnoxConformance.fortnoxConformanceCases.find(testCase => testCase.id === "fortnox.invoice.send-email")?.safety !== "write-irreversible") throw new Error("Fortnox conformance safety mismatch")',
          'if ((await import("@yolk-sdk/connectors/fortnox")).FortnoxConnector.actions.some(action => /email|send|sent|bookkeep|cancel|delete_|_from_offer/.test(action.id) && action.access !== "destructive")) throw new Error("Fortnox send/book/cancel/delete must be destructive")',
          'const microsoftConformance = await import("@yolk-sdk/connectors/microsoft/conformance")',
          'if (microsoftConformance.microsoftConformanceCases.length !== 19 || microsoftConformance.microsoftConformanceFixtures.length !== 19) throw new Error("Missing Microsoft conformance cases/fixtures")',
          'if (microsoftConformance.microsoftConformanceCases.filter(testCase => testCase.safety === "read").length !== 12 || microsoftConformance.microsoftConformanceCases.filter(testCase => testCase.safety === "write-irreversible").map(testCase => testCase.id).join() !== "microsoft.teams.send-chat-message") throw new Error("Microsoft conformance safety mismatch")',
          'if ((await import("@yolk-sdk/connectors/microsoft")).MicrosoftConnector.actions.some(action => /calendar|event/.test(action.id))) throw new Error("Microsoft conformance calendar helpers leaked into connector actions")',
          'const dropboxConformance = await import("@yolk-sdk/connectors/dropbox/conformance")',
          'if (dropboxConformance.dropboxConformanceCases.length !== 8 || dropboxConformance.dropboxConformanceFixtures.length !== 8) throw new Error("Missing Dropbox conformance cases/fixtures")',
          'if (dropboxConformance.dropboxConformanceCases.filter(testCase => testCase.safety === "read").length !== 4 || dropboxConformance.dropboxConformanceCases.some(testCase => testCase.safety === "write-irreversible")) throw new Error("Dropbox conformance safety mismatch")',
          'const notionConformance = await import("@yolk-sdk/connectors/notion/conformance")',
          'if (notionConformance.notionConformanceCases.length !== 8 || notionConformance.notionConformanceFixtures.length !== 8) throw new Error("Missing Notion conformance cases/fixtures")',
          'if (notionConformance.notionConformanceCases.filter(testCase => testCase.safety === "read").length !== 7 || notionConformance.notionConformanceCases.some(testCase => testCase.safety === "write-irreversible")) throw new Error("Notion conformance safety mismatch")',
          'const todoistConformance = await import("@yolk-sdk/connectors/todoist/conformance")',
          'if (todoistConformance.todoistConformanceCases.length !== 8 || todoistConformance.todoistConformanceFixtures.length !== 8 || typeof todoistConformance.findTodoistConformanceLeftovers !== "object") throw new Error("Missing Todoist conformance cases/fixtures")',
          'if (todoistConformance.todoistConformanceCases.filter(testCase => testCase.safety === "read").length !== 4 || todoistConformance.todoistConformanceCases.some(testCase => testCase.safety === "write-irreversible")) throw new Error("Todoist conformance safety mismatch")',
          'const telegramConformance = await import("@yolk-sdk/connectors/telegram/conformance")',
          'if (telegramConformance.telegramConformanceCases.length !== 4 || telegramConformance.telegramConformanceFixtures.length !== 4) throw new Error("Missing Telegram conformance cases/fixtures")',
          'if (telegramConformance.telegramConformanceCases.filter(testCase => testCase.safety === "read").length !== 3 || telegramConformance.telegramConformanceCases.filter(testCase => testCase.safety === "write-irreversible").map(testCase => testCase.id).join() !== "telegram.messages.send-message") throw new Error("Telegram conformance safety mismatch")',
          'const githubConformance = await import("@yolk-sdk/connectors/github/conformance")',
          'if (githubConformance.githubConformanceCases.length !== 8 || githubConformance.githubConformanceFixtures.length !== 8 || typeof githubConformance.findGithubConformanceLeftovers !== "object") throw new Error("Missing GitHub conformance cases/fixtures")',
          'if (githubConformance.githubConformanceCases.filter(testCase => testCase.safety === "read").length !== 5 || githubConformance.githubConformanceCases.filter(testCase => testCase.safety === "write-irreversible").map(testCase => testCase.id).join() !== "github.issues.lifecycle-close") throw new Error("GitHub conformance safety mismatch")',
          'const googleConformance = await import("@yolk-sdk/connectors/google/conformance")',
          'if (googleConformance.googleConformanceCases.length !== 19 || googleConformance.googleConformanceFixtures.length !== 19 || typeof googleConformance.findGoogleConformanceLeftovers !== "object") throw new Error("Missing Google conformance cases/fixtures")',
          'if (googleConformance.googleConformanceCases.filter(testCase => testCase.safety === "read").length !== 12 || googleConformance.googleConformanceCases.filter(testCase => testCase.safety === "write-irreversible").map(testCase => testCase.id).join() !== "google.gmail.send-practice-address") throw new Error("Google conformance safety mismatch")',
          'const mcpClient = await import("@yolk-sdk/mcp/client")',
          'if (typeof mcpClient.callRemoteMcpServerToolResumable !== "function" || typeof mcpClient.resumeRemoteMcpServerToolCall !== "function" || typeof mcpClient.mcpArgumentsDigest !== "function") throw new Error("Missing MCP resumable call exports")',
          'const mcpDigestEffect = await import("effect").then(effect => effect.Effect.runPromise(mcpClient.mcpArgumentsDigest({ b: 1, a: [true, null] })))',
          'if (mcpDigestEffect !== "sha256:" + (await import("node:crypto")).createHash("sha256").update(\'{"a":[true,null],"b":1}\').digest("hex")) throw new Error("MCP argument digest mismatch")',
          'const mcpConformance = await import("@yolk-sdk/mcp/conformance")',
          'if (mcpConformance.mcpConformanceCases.length !== 9 || mcpConformance.mcpConformanceFixtures.length !== 16 || mcpConformance.mcpConformanceCases.some(testCase => testCase.safety !== "read") || typeof mcpConformance.makeMcpObservingHttpClient !== "function") throw new Error("Missing MCP conformance cases/fixtures")',
          'if (mcpConformance.selectMcpConformanceCases(mcpConformance.mcpConformanceCases, "modern").notApplicable.map(entry => entry.id).join() !== "mcp.legacy.session") throw new Error("MCP conformance era filter mismatch")',
          'if (mcpConformance.mcpElicitationDeclarationCase.id !== "mcp.elicitation.declaration" || mcpConformance.mcpElicitationDeclarationCase.safety !== "read" || mcpConformance.mcpConformanceCases.includes(mcpConformance.mcpElicitationDeclarationCase) || mcpConformance.mcpConformanceElicitationFixtures.length !== 2 || mcpConformance.mcpConformanceElicitationFixtures.some(fixture => fixture.caseId !== "mcp.elicitation.declaration")) throw new Error("Missing opt-in MCP elicitation conformance case/fixtures")',
          'if (mcpConformance.mcpServerPingCase.id !== "mcp.legacy.server-ping" || mcpConformance.mcpServerPingCase.safety !== "read" || mcpConformance.mcpConformanceCases.includes(mcpConformance.mcpServerPingCase) || mcpConformance.mcpConformanceServerPingFixtures.length !== 1 || mcpConformance.mcpConformanceServerPingFixtures.some(fixture => fixture.caseId !== "mcp.legacy.server-ping" || fixture.evidence !== "unverified") || mcpConformance.selectMcpConformanceCases([mcpConformance.mcpServerPingCase], "modern").notApplicable.length !== 1) throw new Error("Missing opt-in MCP server ping conformance case/fixture")',
          'const afloatMcpConformance = await import("@yolk-sdk/connectors/afloat/conformance")',
          'if (afloatMcpConformance.afloatMcpConformanceFixtures.length !== 8 || afloatMcpConformance.afloatMcpConformanceExpectedTools.length !== 9 || afloatMcpConformance.afloatMcpConformanceFixtures.some(fixture => fixture.endpoint !== "https://useafloat.com/mcp" || fixture.evidence !== "unverified") || afloatMcpConformance.afloatMcpConformanceNotApplicable.map(entry => entry.id).join() !== "mcp.legacy.session" || typeof afloatMcpConformance.makeAfloatMcpConformanceTarget !== "function") throw new Error("Missing Afloat MCP conformance target/fixtures")',
          'const figmaMcpConformance = await import("@yolk-sdk/connectors/figma/conformance")',
          'if (figmaMcpConformance.figmaMcpConformanceFixtures.length !== 8 || figmaMcpConformance.figmaMcpConformanceExpectedTools.length !== 6 || figmaMcpConformance.figmaMcpConformanceFixtures.some(fixture => fixture.endpoint !== "https://mcp.figma.com/mcp" || fixture.evidence !== "unverified") || figmaMcpConformance.figmaMcpConformanceNotApplicable.map(entry => entry.id).join() !== "mcp.modern.stateless" || typeof figmaMcpConformance.makeFigmaMcpConformanceTarget !== "function") throw new Error("Missing Figma MCP conformance target/fixtures")',
          'const kieConformance = await import("@yolk-sdk/connectors/kie/conformance")',
          'if (kieConformance.kieConformanceCases.length !== 6 || kieConformance.kieConformanceFixtures.length !== 6) throw new Error("Missing Kie conformance cases/fixtures")',
          'if (kieConformance.kieConformanceCases.filter(testCase => testCase.safety === "read").length !== 4 || kieConformance.kieConformanceCases.filter(testCase => testCase.safety === "write-irreversible").map(testCase => testCase.id).join() !== "kie.tasks.create-image-task,kie.tasks.create-video-task") throw new Error("Kie conformance safety mismatch")',
          'const linkedInSearchConformance = await import("@yolk-sdk/connectors/linkedin-search/conformance")',
          'if (linkedInSearchConformance.linkedInSearchConformanceCases.length !== 7 || linkedInSearchConformance.linkedInSearchConformanceFixtures.length !== 7) throw new Error("Missing LinkedIn search conformance cases/fixtures")',
          'if (linkedInSearchConformance.linkedInSearchConformanceCases.some(testCase => testCase.safety !== "read")) throw new Error("LinkedIn search conformance safety mismatch")',
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
          'const goChat = await goEmulator.fetch(new Request("https://opencode.ai/inference/go/v1/chat/completions", { method: "POST", headers: { authorization: "Bearer synthetic", accept: "text/event-stream", "content-type": "application/json" }, body: JSON.stringify(goChatBody) }))',
          'const goJsonChat = await goEmulator.fetch(new Request("https://opencode.ai/inference/go/v1/chat/completions", { method: "POST", headers: { authorization: "Bearer synthetic", accept: "text/event-stream", "content-type": "application/json" }, body: JSON.stringify({ ...goChatBody, stream: false }) }))',
          'const goMessages = await goEmulator.fetch(new Request("https://opencode.ai/inference/go/v1/messages", { method: "POST", headers: { authorization: "Bearer synthetic", "anthropic-version": "2023-06-01", "content-type": "application/json" }, body: JSON.stringify({ model: "synthetic-go-messages", messages: [], stream: false, max_tokens: 16 }) }))',
          'const goUsage = await goEmulator.fetch(new Request("https://opencode.ai/inference/go/v1/usage", { headers: { accept: "application/json", authorization: "Bearer synthetic" } }))',
          'if (goChat.status !== 200 || !(await goChat.text()).endsWith("data: [DONE]\\n\\n") || goJsonChat.status !== 400 || (await goJsonChat.json()).error?.type !== "not_emulated" || goMessages.status !== 400 || goUsage.status !== 200 || (await goUsage.json()).usage?.rolling?.percent === undefined || goEmulator.coverage().routes.length !== 4) throw new Error("OpenCode Go emulator smoke failed")',
          'const goConformance = await import("@yolk-sdk/agent/providers/opencode/conformance")',
          'if (goConformance.openCodeGoConformanceCases.length !== 5 || goConformance.openCodeGoConformanceFixtures.length !== 5 || !goConformance.openCodeGoConformanceCases.every(testCase => testCase.safety === "read")) throw new Error("Missing OpenCode Go conformance cases/fixtures")',
          'if (anthropicConformance.anthropicClaudeUsageConformanceCases.length !== 1 || openAiConformance.openAiCodexUsageConformanceCases.length !== 1 || grokConformance.xAiGrokUsageConformanceCases.length !== 1 || grokConformance.xAiGrokUsageConformanceFixtures.length !== 1) throw new Error("Missing subscription-usage conformance cases/fixtures")',
          'const emailEmulator = (await import("@yolk-sdk/emulators/email")).makeEmailEmulator()',
          'const emailFixture = emailConformance.emailConformanceFixtures[0]',
          'const emailReply = emailEmulator.call(emailFixture.method, emailFixture.request)',
          'const emailRefused = emailEmulator.call("listMessages", { limit: 1 })',
          'if (JSON.stringify(emailReply) !== JSON.stringify({ response: emailFixture.response }) || !("notEmulated" in emailRefused) || emailEmulator.ledger.entries().length !== 2 || emailEmulator.coverage().notEmulatedCalls !== 1) throw new Error("Email emulator smoke failed")',
          'const r2Emulator = (await import("@yolk-sdk/emulators/r2")).makeR2Emulator()',
          'const r2Fixture = r2Conformance.r2ConformanceFixtures[0]',
          'const r2Reply = r2Emulator.call(r2Fixture.port, r2Fixture.method, r2Fixture.request)',
          'const r2Refused = r2Emulator.call("R2ObjectClient", "get", { bucket: "yolk-synthetic-bucket", key: "k", maxBytes: 1 })',
          'if (JSON.stringify(r2Reply) !== JSON.stringify({ response: r2Fixture.response }) || !("notEmulated" in r2Refused) || r2Emulator.ledger.entries().length !== 2 || r2Emulator.coverage().notEmulatedCalls !== 1 || typeof r2Conformance.r2PortsLayerFromBackend(r2Emulator) !== "object") throw new Error("R2 emulator smoke failed")',
          'if (typeof (await import("@yolk-sdk/emulators/node")).serveFetchHandler !== "function") throw new Error("Missing emulator node exports")',
          'const codemode = await import("@yolk-sdk/codemode")',
          'for (const symbol of ["makeCodeModeTool", "makeClassifierTool", "makeClassifierConcurrencyLimiter", "codeModeStoreFromToolResults", "renderCodeModeDescription", "searchCodeModeTools", "codeModeCatalogInstruction", "summarizeCodeModeCatalog", "renderCodeModeInstructedDescription"]) { if (typeof codemode[symbol] !== "function") throw new Error(`Missing code mode export: ${symbol}`) }',
          'const exposureProtocol = await import("@yolk-sdk/agent/protocol")',
          'const exposureTools = await import("@yolk-sdk/agent/tools")',
          'const exposureLoop = await import("@yolk-sdk/agent/loop")',
          'for (const [module, symbol] of [[exposureProtocol, "declaredToolDefs"], [exposureProtocol, "activatedToolNames"], [exposureProtocol, "latestInstructionMessages"], [exposureTools, "makeToolSearchTool"], [exposureTools, "rankToolSearchDocuments"], [exposureLoop, "instructionMessages"]]) { if (typeof module[symbol] !== "function") throw new Error(`Missing tool exposure export: ${symbol}`) }',
          'const codemodeNode = await import("@yolk-sdk/codemode/node")',
          'const codemodeResult = await codemodeNode.makePiCodeModeExecutor().execute("const n: number = 2; return n * 21", { tools: [], globals: [], timeoutMs: 10000, memoryLimitBytes: 64 * 1024 * 1024, store: {}, signal: new AbortController().signal })',
          'if (!codemodeResult.ok || codemodeResult.value !== 42) throw new Error(`Code mode executor smoke failed: ${JSON.stringify(codemodeResult)}`)',
          'const codemodeCloudflare = await import("@yolk-sdk/codemode/cloudflare")',
          'const smokeLoaded = []',
          'const cloudflareExecutor = codemodeCloudflare.makeDynamicWorkerCodeModeExecutor({ loader: () => ({ load: code => { smokeLoaded.push(code); return { getEntrypoint: () => ({ run: async () => ({ ok: true, payload: "42", writes: "[[\\"k\\",\\"1\\"]]", output: [] }) }) } } }) })',
          'const cloudflareResult = await cloudflareExecutor.execute("const n: number = 2; return n * 21", { tools: [], globals: [], timeoutMs: 10000, memoryLimitBytes: 64 * 1024 * 1024, store: {}, signal: new AbortController().signal })',
          'if (!cloudflareResult.ok || cloudflareResult.value !== 42 || cloudflareResult.storeWrites.set.k !== 1 || smokeLoaded[0]?.globalOutbound !== null || smokeLoaded[0].limits?.cpuMs !== codemodeCloudflare.defaultDynamicWorkerCpuMs || !smokeLoaded[0].modules["script.js"].includes("const n = 2")) throw new Error(`Dynamic Worker executor smoke failed: ${JSON.stringify(cloudflareResult)}`)',
          'const sandboxCloudflare = await import("@yolk-sdk/sandbox/cloudflare")',
          'for (const symbol of ["CloudflareSandbox", "makeCloudflareSandboxLayer"]) { if (typeof sandboxCloudflare[symbol] !== "function") throw new Error(`Missing Cloudflare sandbox export: ${symbol}`) }',
          'const smokeStorage = { get: async () => undefined, put: async () => undefined, delete: async () => false, getAlarm: async () => null, setAlarm: async () => undefined, deleteAlarm: async () => undefined }',
          'const smokeSandbox = new sandboxCloudflare.CloudflareSandbox({ storage: smokeStorage }, {})',
          'const smokeReply = await smokeSandbox.writeFile({ container: { image: "Sandbox", instance: { vcpu: 1, memoryMib: 2048, diskMb: 8192 }, env: {}, internet: true, workspaceRoot: "/workspace", source: sandboxCloudflare.CloudflareSandboxSourceSpec.Empty(), idleTtlMs: 60000 }, fresh: false, path: "/workspace/a", bytes: new Uint8Array(0) })',
          'if (smokeReply.ok !== false || smokeReply.kind !== "config" || sandboxCloudflare.defaultCloudflareSandboxWorkspaceRoot !== "/workspace") throw new Error(`Cloudflare sandbox smoke failed: ${JSON.stringify(smokeReply)}`)',
          'const workflowsCloudflare = await import("@yolk-sdk/vercel-workflows/cloudflare")',
          'for (const symbol of ["WorkflowRun", "WorkflowExecution", "registerWorkflowModules", "makeMemoryRunStore", "makeSqliteRunStore", "serialize", "deserialize"]) { if (typeof workflowsCloudflare[symbol] !== "function") throw new Error(`Missing Cloudflare workflow export: ${symbol}`) }',
          'if (workflowsCloudflare.workflowRunsBinding !== "WORKFLOW_RUNS" || !(workflowsCloudflare.deserialize(workflowsCloudflare.serialize(new Map([[1, 2]]))) instanceof Map)) throw new Error("Cloudflare workflow runtime smoke failed")',
          'const workflowsCloudflareWorkflow = await import("@yolk-sdk/vercel-workflows/cloudflare/workflow")',
          'for (const symbol of ["createHook", "sleep", "getWritable", "getStepMetadata", "getWorkflowMetadata", "FatalError", "RetryableError"]) { if (typeof workflowsCloudflareWorkflow[symbol] !== "function") throw new Error(`Missing Cloudflare workflow module export: ${symbol}`) }',
          'const workflowsCloudflareApi = await import("@yolk-sdk/vercel-workflows/cloudflare/api")',
          'for (const symbol of ["start", "getRun", "resumeHook"]) { if (typeof workflowsCloudflareApi[symbol] !== "function") throw new Error(`Missing Cloudflare workflow API export: ${symbol}`) }',
          'const workflowsCloudflareDirectives = await import("@yolk-sdk/vercel-workflows/cloudflare/directives")',
          'const workflowsCloudflareVite = await import("@yolk-sdk/vercel-workflows/cloudflare/vite")',
          'if (typeof workflowsCloudflareDirectives.workflowStep !== "function" || typeof workflowsCloudflareDirectives.workflowEntry !== "function" || workflowsCloudflareVite.workflowDirectives().name !== "yolk:workflow-directives" || !import.meta.resolve(workflowsCloudflareVite.workflowDirectivesRuntime).endsWith("/cloudflare/directives.mjs")) throw new Error("Cloudflare workflow directives smoke failed")',
          'async function smokeWorkflow(value) { return value * 2 }',
          'workflowsCloudflareDirectives.workflowEntry(smokeWorkflow, "smoke#workflow")',
          'const smokeRunStore = workflowsCloudflare.makeMemoryRunStore()',
          'smokeRunStore.createRun({ runId: "wrun_smoke", workflowId: "smoke#workflow", args: workflowsCloudflare.serialize([21]), status: "pending", outcome: undefined, createdAt: Date.now(), completedAt: undefined })',
          'await new Promise(resolve => new workflowsCloudflare.WorkflowExecution({ store: smokeRunStore, wakeAt: () => undefined, claimHook: async () => ({ claimed: true }), chunkAppended: () => undefined, streamClosed: () => undefined, runSettled: resolve, log: () => undefined }).kick())',
          'if (smokeRunStore.readRun()?.status !== "completed" || workflowsCloudflare.deserialize(smokeRunStore.readRun().outcome) !== 42) throw new Error("Cloudflare workflow execution smoke failed")',
          'const extractors = await import("@yolk-sdk/extractors")',
          'if (typeof extractors.fileFormatFor !== "function" || extractors.fileFormatFor({ filename: "a.xlsx", mediaType: "" }) !== "xlsx" || extractors.defaultFileExtractorLimits.maxXlsxHyperlinks !== 10000 || typeof extractors.SheetJsUnavailableError !== "function") throw new Error("Missing extractors root exports")',
          'const extractorsNode = await import("@yolk-sdk/extractors/node")',
          'const extractorsKnowledge = await import("@yolk-sdk/extractors/knowledge")',
          'const { Effect: SmokeEffect, Layer: SmokeLayer } = await import("effect")',
          'const SheetJs = await import("xlsx")',
          'const smokeBook = SheetJs.utils.book_new()',
          'const smokeSheet = SheetJs.utils.aoa_to_sheet([["Acme"]])',
          'smokeSheet.A1.l = { Target: "https://acme.example/" }',
          'smokeSheet["!ref"] = "A1"',
          'SheetJs.utils.book_append_sheet(smokeBook, smokeSheet, "Links")',
          'const smokeXlsx = new Uint8Array(SheetJs.write(smokeBook, { type: "array", bookType: "xlsx" }))',
          'const extracted = await SmokeEffect.runPromise(SmokeEffect.gen(function* () { const extractor = yield* extractorsNode.FileExtractor; return yield* extractor.extract({ filename: "links.xlsx", mediaType: "", bytes: smokeXlsx }) }).pipe(SmokeEffect.provide(extractorsNode.FileExtractorLayer)))',
          'if (extracted.content !== "# Links\\nAcme <https://acme.example/>") throw new Error(`Extractor smoke failed: ${JSON.stringify(extracted)}`)',
          // The default layer parses in the packaged worker file; prove it exists and enforces its limits.
          'const { existsSync: smokeExists } = await import("node:fs")',
          'const smokeWorkerFile = new URL("./extraction-worker.mjs", import.meta.resolve("@yolk-sdk/extractors/node"))',
          'if (!smokeExists(smokeWorkerFile) || import.meta.resolve("@yolk-sdk/extractors/node/extraction-worker") !== smokeWorkerFile.href) throw new Error("Missing packaged extraction worker")',
          'const extractWithLayer = (layer, filename, bytes) => SmokeEffect.runPromise(SmokeEffect.gen(function* () { const extractor = yield* extractorsNode.FileExtractor; return yield* extractor.extract({ filename, mediaType: "", bytes }) }).pipe(SmokeEffect.provide(layer), SmokeEffect.flip))',
          'const smokeTimeout = await extractWithLayer(extractorsNode.makeFileExtractorLayer({ isolation: { timeoutMs: 1 } }), "links.xlsx", smokeXlsx)',
          'if (smokeTimeout.reason !== "timeout") throw new Error(`Extractor worker timeout smoke failed: ${JSON.stringify(smokeTimeout)}`)',
          'const heavyBook = SheetJs.utils.book_new()',
          'SheetJs.utils.book_append_sheet(heavyBook, SheetJs.utils.aoa_to_sheet(Array.from({ length: 30000 }, (_, row) => Array.from({ length: 10 }, () => row))), "Heavy")',
          'const heavyXlsx = new Uint8Array(SheetJs.write(heavyBook, { type: "array", bookType: "xlsx", compression: true }))',
          'const smokeHeap = await extractWithLayer(extractorsNode.makeFileExtractorLayer({ isolation: { maxOldGenerationSizeMb: 16 } }), "heavy.xlsx", heavyXlsx)',
          'if (smokeHeap.reason !== "resource-limit") throw new Error(`Extractor worker heap smoke failed: ${JSON.stringify(smokeHeap)}`)',
          'const smokeMissingWorker = await extractWithLayer(extractorsNode.makeFileExtractorLayer({ isolation: { workerUrl: new URL("./missing-worker.mjs", smokeWorkerFile) } }), "links.xlsx", smokeXlsx)',
          'if (smokeMissingWorker.reason !== "worker-unavailable") throw new Error(`Extractor worker spawn smoke failed: ${JSON.stringify(smokeMissingWorker)}`)',
          // The worker file is self-contained: its only imports are Node builtins and the optional
          // `xlsx` peer, and a copy beside nothing but `node_modules/xlsx` extracts every format.
          'const { cpSync: smokeCopy, mkdtempSync: smokeTempDir, readFileSync: smokeRead, realpathSync: smokeRealpath, rmSync: smokeRemove } = await import("node:fs")',
          'const workerSource = smokeRead(smokeWorkerFile, "utf8")',
          'const { isBuiltin: smokeIsBuiltin } = await import("node:module")',
          'const workerImports = [...workerSource.matchAll(/^import [^;]*?from "([^"]+)";$/gm), ...workerSource.matchAll(/^import "([^"]+)";$/gm), ...workerSource.matchAll(/^export [^;]*?from "([^"]+)";$/gm), ...workerSource.matchAll(/\\bimport\\("([^"$]+)"\\)/g), ...workerSource.matchAll(/require\\("([^"]+)"\\)/g)].map(match => match[1])',
          'if (workerImports.some(specifier => specifier !== "xlsx" && !smokeIsBuiltin(specifier)) || !workerImports.includes("xlsx")) throw new Error(`Extraction worker is not self-contained: ${workerImports.join(", ")}`)',
          'const isolatedWorkerDir = smokeTempDir(`${(await import("node:os")).tmpdir()}/yolk-extractor-worker-`)',
          'try {',
          'smokeCopy(smokeWorkerFile, `${isolatedWorkerDir}/extraction-worker.mjs`)',
          'smokeCopy(smokeRealpath(new URL("./node_modules/xlsx", import.meta.url)), `${isolatedWorkerDir}/node_modules/xlsx`, { recursive: true, dereference: true })',
          'const { strToU8: smokeText, zipSync: smokeZip } = await import("fflate")',
          'const smokeDocx = smokeZip({ "[Content_Types].xml": smokeText(\'<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>\'), "_rels/.rels": smokeText(\'<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>\'), "word/document.xml": smokeText(\'<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>Hello DOCX</w:t></w:r></w:p></w:body></w:document>\') })',
          'const smokePptx = smokeZip({ "[Content_Types].xml": smokeText("<Types/>"), "ppt/presentation.xml": smokeText("<p:presentation/>"), "ppt/slides/slide1.xml": smokeText("<a:p><a:r><a:t>Hello PPTX</a:t></a:r></a:p>") })',
          'const pdfStream = "BT /F1 24 Tf 72 720 Td (Hello PDF) Tj ET"',
          'const pdfObjects = ["1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj", "2 0 obj<</Type/Pages/Count 1/Kids[3 0 R]>>endobj", "3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 612 792]/Contents 4 0 R/Resources<</Font<</F1 5 0 R>>>>>>endobj", `4 0 obj<</Length ${pdfStream.length}>>stream\\n${pdfStream}\\nendstream endobj`, "5 0 obj<</Type/Font/Subtype/Type1/BaseFont/Helvetica>>endobj"]',
          'let pdfBody = "%PDF-1.4\\n"; const pdfOffsets = []; for (const object of pdfObjects) { pdfOffsets.push(pdfBody.length); pdfBody += `${object}\\n` }',
          'const smokePdf = new TextEncoder().encode(`${pdfBody}xref\\n0 6\\n${["0000000000 65535 f ", ...pdfOffsets.map(offset => `${String(offset).padStart(10, "0")} 00000 n `)].join("\\n")}\\ntrailer<</Size 6/Root 1 0 R>>\\nstartxref\\n${pdfBody.length}\\n%%EOF`)',
          'const isolatedLayer = extractorsNode.makeFileExtractorLayer({ isolation: { workerUrl: new URL(`file://${isolatedWorkerDir}/extraction-worker.mjs`) } })',
          'for (const [filename, bytes, expected] of [["links.xlsx", smokeXlsx, "# Links\\nAcme <https://acme.example/>"], ["brief.docx", smokeDocx, "Hello DOCX"], ["deck.pptx", smokePptx, "Hello PPTX"], ["paper.pdf", smokePdf, "Hello PDF"]]) { const isolated = await SmokeEffect.runPromise(SmokeEffect.gen(function* () { const extractor = yield* extractorsNode.FileExtractor; return yield* extractor.extract({ filename, mediaType: "", bytes }) }).pipe(SmokeEffect.provide(isolatedLayer))); if (isolated.content !== expected) throw new Error(`Self-contained extraction worker smoke failed for ${filename}: ${JSON.stringify(isolated)}`) }',
          '} finally { smokeRemove(isolatedWorkerDir, { recursive: true, force: true }) }',
          'const knowledgeExtraction = await import("@yolk-sdk/knowledge/extraction")',
          'const knowledgeDocument = await SmokeEffect.runPromise(SmokeEffect.gen(function* () { const extractor = yield* knowledgeExtraction.KnowledgeExtractor; return yield* extractor.extract({ source: { _tag: "Text" }, content: new TextEncoder().encode("hello knowledge") }) }).pipe(SmokeEffect.provide(extractorsKnowledge.FileKnowledgeExtractorLayer.pipe(SmokeLayer.provide(extractorsNode.FileExtractorLayer)))))',
          'if (knowledgeDocument.content !== "hello knowledge") throw new Error("Knowledge extractor smoke failed")',
          'const fortnoxEmulatorModule = await import("@yolk-sdk/emulators/fortnox")',
          'if (fortnoxEmulatorModule.fortnoxEmulatorRoutes.length !== 44 || !fortnoxEmulatorModule.fortnoxEmulatorRoutes.every(route => route.evidence === "unverified")) throw new Error("Fortnox emulator manifest mismatch")',
          'const fortnoxEmulator = await fortnoxEmulatorModule.makeFortnoxEmulator()',
          'const fortnoxInvoices = await fortnoxEmulator.fetch(new Request("https://api.fortnox.se/3/invoices?limit=10", { headers: { authorization: "Bearer synthetic" } }))',
          'if (fortnoxInvoices.status !== 200 || fortnoxInvoices.headers.get("x-emulator-evidence") !== "unverified" || (await fortnoxInvoices.json()).MetaInformation["@TotalResources"] !== 5) throw new Error("Fortnox emulator smoke failed")',
          'if ((await fortnoxEmulator.fetch(new Request("https://api.fortnox.se/3/orders", { headers: { authorization: "Bearer synthetic" } }))).status !== 404) throw new Error("Fortnox emulator must fail closed")',
          'await fortnoxEmulator.close()',
          'const microsoftEmulatorModule = await import("@yolk-sdk/emulators/microsoft")',
          'if (microsoftEmulatorModule.microsoftEmulatorRoutes.length !== 35 || !microsoftEmulatorModule.microsoftEmulatorRoutes.every(route => route.evidence === "unverified")) throw new Error("Microsoft emulator manifest mismatch")',
          'const microsoftEmulator = await microsoftEmulatorModule.makeMicrosoftEmulator()',
          'const microsoftMessages = await microsoftEmulator.fetch(new Request("https://graph.microsoft.com/v1.0/users/ada%40example.test/mailFolders/AAMkAGI2-synthetic-folder-0001%3D/messages?$top=2", { headers: { authorization: "Bearer synthetic", prefer: "IdType=\\"ImmutableId\\"" } }))',
          'const microsoftPage = await microsoftMessages.json()',
          'if (microsoftMessages.status !== 200 || microsoftMessages.headers.get("x-emulator-evidence") !== "unverified" || microsoftPage.value.length !== 2 || !microsoftPage["@odata.nextLink"].startsWith("https://graph.microsoft.com/v1.0/users/ada%40example.test/")) throw new Error("Microsoft emulator smoke failed")',
          'if ((await microsoftEmulator.fetch(new Request("https://graph.microsoft.com/v1.0/me/messages", { headers: { authorization: "Bearer synthetic" } }))).status !== 404) throw new Error("Microsoft emulator must fail closed")',
          'await microsoftEmulator.close()',
          'const dropboxEmulatorModule = await import("@yolk-sdk/emulators/dropbox")',
          'if (dropboxEmulatorModule.dropboxEmulatorRoutes.length !== 10 || !dropboxEmulatorModule.dropboxEmulatorRoutes.every(route => route.evidence === "unverified")) throw new Error("Dropbox emulator manifest mismatch")',
          'const dropboxEmulator = await dropboxEmulatorModule.makeDropboxEmulator()',
          'const dropboxListing = await dropboxEmulator.fetch(new Request("https://api.dropboxapi.com/2/files/list_folder", { method: "POST", headers: { authorization: "Bearer synthetic", "content-type": "application/json" }, body: JSON.stringify({ path: "/Conformance/Paging", limit: 2 }) }))',
          'const dropboxPage = await dropboxListing.json()',
          'if (dropboxListing.status !== 200 || dropboxListing.headers.get("x-emulator-evidence") !== "unverified" || dropboxPage.entries.length !== 2 || dropboxPage.has_more !== true) throw new Error("Dropbox emulator smoke failed")',
          'const dropboxMissing = await dropboxEmulator.fetch(new Request("https://api.dropboxapi.com/2/files/get_metadata", { method: "POST", headers: { authorization: "Bearer synthetic", "content-type": "application/json" }, body: JSON.stringify({ path: "/Conformance/Work/absent" }) }))',
          'if (dropboxMissing.status !== 409 || (await dropboxMissing.text()) !== dropboxEmulatorModule.dropboxEmulatorErrorBodies.notFound) throw new Error("Dropbox emulator not-found smoke failed")',
          'if ((await dropboxEmulator.fetch(new Request("https://api.dropboxapi.com/2/files/list_folder/longpoll", { method: "POST", headers: { authorization: "Bearer synthetic", "content-type": "application/json" }, body: "{}" }))).status !== 400) throw new Error("Dropbox emulator must fail closed")',
          'await dropboxEmulator.close()',
          'const notionEmulatorModule = await import("@yolk-sdk/emulators/notion")',
          'if (notionEmulatorModule.notionEmulatorRoutes.length !== 10 || !notionEmulatorModule.notionEmulatorRoutes.every(route => route.evidence === "unverified")) throw new Error("Notion emulator manifest mismatch")',
          'const notionEmulator = await notionEmulatorModule.makeNotionEmulator()',
          'const notionUser = await notionEmulator.fetch(new Request("https://api.notion.com/v1/users/me", { headers: { authorization: "Bearer synthetic", "notion-version": "2025-09-03" } }))',
          'if (notionUser.status !== 200 || notionUser.headers.get("x-emulator-evidence") !== "unverified" || (await notionUser.json()).type !== "bot") throw new Error("Notion emulator smoke failed")',
          'if ((await notionEmulator.fetch(new Request("https://api.notion.com/v1/users/me", { headers: { authorization: "Bearer synthetic", "notion-version": "2022-06-28" } }))).status !== 400) throw new Error("Notion emulator must fail closed")',
          'await notionEmulator.close()',
          'const todoistEmulatorModule = await import("@yolk-sdk/emulators/todoist")',
          'if (todoistEmulatorModule.todoistEmulatorRoutes.length !== 10 || !todoistEmulatorModule.todoistEmulatorRoutes.every(route => route.evidence === "unverified")) throw new Error("Todoist emulator manifest mismatch")',
          'const todoistEmulator = await todoistEmulatorModule.makeTodoistEmulator()',
          'const todoistTasks = await todoistEmulator.fetch(new Request("https://api.todoist.com/api/v1/tasks?project_id=6XSyntheticPage0&limit=2", { headers: { authorization: "Bearer synthetic" } }))',
          'const todoistPage = await todoistTasks.json()',
          'if (todoistTasks.status !== 200 || todoistTasks.headers.get("x-emulator-evidence") !== "unverified" || todoistPage.results.length !== 2 || todoistPage.next_cursor !== "SyntheticTaskCursor0001") throw new Error("Todoist emulator smoke failed")',
          'const todoistRefused = await todoistEmulator.fetch(new Request("https://api.todoist.com/api/v1/sections", { headers: { authorization: "Bearer synthetic" } }))',
          'if (todoistRefused.status !== 400 || (await todoistRefused.json()).error.type !== "not_emulated") throw new Error("Todoist emulator must fail closed")',
          'await todoistEmulator.close()',
          'const telegramEmulatorModule = await import("@yolk-sdk/emulators/telegram")',
          'if (telegramEmulatorModule.telegramEmulatorRoutes.length !== 4 || !telegramEmulatorModule.telegramEmulatorRoutes.every(route => route.evidence === "unverified")) throw new Error("Telegram emulator manifest mismatch")',
          'const telegramEmulator = await telegramEmulatorModule.makeTelegramEmulator()',
          'const telegramChat = await telegramEmulator.fetch(new Request("https://api.telegram.org/bot1:synthetic-smoke-token/getChat", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ chat_id: "-1001000000001" }) }))',
          'if (telegramChat.status !== 200 || (await telegramChat.json()).ok !== true) throw new Error("Telegram emulator smoke failed")',
          'const telegramRefused = await telegramEmulator.fetch(new Request("https://api.telegram.org/bot1:synthetic-smoke-token/deleteMessage", { method: "POST" }))',
          'if (telegramRefused.status !== 400 || (await telegramRefused.text()).includes("synthetic-smoke-token") || JSON.stringify(telegramEmulator.ledger.entries()).includes("synthetic-smoke-token")) throw new Error("Telegram emulator must fail closed without echoing the token")',
          'await telegramEmulator.close()',
          'const githubEmulatorModule = await import("@yolk-sdk/emulators/github")',
          'if (githubEmulatorModule.githubEmulatorRoutes.length !== 12 || !githubEmulatorModule.githubEmulatorRoutes.every(route => route.evidence === "unverified")) throw new Error("GitHub emulator manifest mismatch")',
          'const githubEmulator = await githubEmulatorModule.makeGithubEmulator()',
          'const githubHeaders = { authorization: "Bearer synthetic-smoke-token", accept: "application/vnd.github+json", "x-github-api-version": "2026-03-10" }',
          'const githubLabels = await githubEmulator.fetch(new Request("https://api.github.com/repos/yolk-synthetic/conformance-practice/labels?per_page=2", { headers: githubHeaders }))',
          'if (githubLabels.status !== 200 || githubLabels.headers.get("x-emulator-evidence") !== "unverified" || (await githubLabels.json()).length !== 2 || !(githubLabels.headers.get("link") ?? "").includes(\'rel="next"\')) throw new Error("GitHub emulator smoke failed")',
          'const githubRefused = await githubEmulator.fetch(new Request("https://api.github.com/repos/yolk-synthetic/conformance-practice/issues?state=open&q=synthetic-smoke-token", { headers: githubHeaders }))',
          'if (githubRefused.status !== 400 || (await githubRefused.text()).includes("synthetic-smoke-token") || JSON.stringify(githubEmulator.ledger.entries()).includes("synthetic-smoke-token")) throw new Error("GitHub emulator must fail closed without echoing the token")',
          'await githubEmulator.close()',
          'const googleEmulatorModule = await import("@yolk-sdk/emulators/google")',
          'if (googleEmulatorModule.googleEmulatorRoutes.length !== 27 || !googleEmulatorModule.googleEmulatorRoutes.every(route => route.evidence === "unverified")) throw new Error("Google emulator manifest mismatch")',
          'const googleEmulator = await googleEmulatorModule.makeGoogleEmulator()',
          'const googleWork = await googleEmulator.fetch(new Request("https://gmail.googleapis.com/gmail/v1/users/me/messages/18f00000000000b1?format=minimal", { headers: { authorization: "Bearer synthetic-smoke-token" } }))',
          'if (googleWork.status !== 200 || googleWork.headers.get("x-emulator-evidence") !== "unverified" || (await googleWork.json()).labelIds.join() !== "INBOX,IMPORTANT") throw new Error("Google emulator smoke failed")',
          'const googleRefused = await googleEmulator.fetch(new Request("https://gmail.googleapis.com/gmail/v1/users/me/labels?q=synthetic-smoke-token", { headers: { authorization: "Bearer synthetic-smoke-token" } }))',
          'if (googleRefused.status !== 400 || (await googleRefused.text()).includes("synthetic-smoke-token") || JSON.stringify(googleEmulator.ledger.entries()).includes("synthetic-smoke-token")) throw new Error("Google emulator must fail closed without echoing the token")',
          'await googleEmulator.close()',
          'const linkedInEmulatorModule = await import("@yolk-sdk/emulators/linkedin-search")',
          'if (linkedInEmulatorModule.linkedInSearchEmulatorRoutes.length !== 3 || !linkedInEmulatorModule.linkedInSearchEmulatorRoutes.every(route => route.evidence === "unverified" && !route.write)) throw new Error("LinkedIn search emulator manifest mismatch")',
          'const linkedInEmulator = await linkedInEmulatorModule.makeLinkedInSearchEmulator()',
          'const linkedInSearchBody = JSON.stringify({ query: "synthetic conformance engineer", category: "people", numResults: 2, type: "auto", contents: { text: true } })',
          'const linkedInFound = await linkedInEmulator.fetch(new Request("https://api.exa.ai/search", { method: "POST", headers: { authorization: "Bearer synthetic-smoke-token", "content-type": "application/json" }, body: linkedInSearchBody }))',
          'if (linkedInFound.status !== 200 || linkedInFound.headers.get("x-emulator-evidence") !== "unverified" || (await linkedInFound.json()).results.length !== 2) throw new Error("LinkedIn search emulator smoke failed")',
          'const linkedInRejected = await linkedInEmulator.fetch(new Request("https://enrichlayer.com/api/v2/profile?linkedin_profile_url=https%3A%2F%2Flinkedin.example.com%2Fin%2Fsynthetic-person-01", { headers: { authorization: "Bearer yolk-conformance-invalid-enrich-layer-key" } }))',
          'if (linkedInRejected.status !== 401 || JSON.stringify([linkedInEmulator.ledger.entries(), linkedInEmulator.snapshot()]).includes("yolk-conformance-invalid-enrich-layer-key")) throw new Error("LinkedIn search emulator must answer the recorded 401 without keeping the key")',
          'const linkedInRefused = await linkedInEmulator.fetch(new Request("https://api.exa.ai/search?q=synthetic-smoke-token", { method: "POST", headers: { authorization: "Bearer synthetic-smoke-token", "content-type": "application/json" }, body: linkedInSearchBody }))',
          'if (linkedInRefused.status !== 400 || (await linkedInRefused.text()).includes("synthetic-smoke-token") || JSON.stringify(linkedInEmulator.ledger.entries()).includes("synthetic-smoke-token")) throw new Error("LinkedIn search emulator must fail closed without echoing the key")',
          'await linkedInEmulator.close()',
          'const mcpEmulatorModule = await import("@yolk-sdk/emulators/mcp")',
          'if (mcpEmulatorModule.mcpEmulatorRoutes.length !== 21 || !mcpEmulatorModule.mcpEmulatorRoutes.some(route => route.method === "DELETE" && route.path === "https://mcp.example.test/legacy/mcp#session-end" && route.caseIds.includes("mcp.legacy.session")) || !mcpEmulatorModule.mcpEmulatorRoutes.some(route => route.path === "https://mcp.example.test/legacy/mcp#response:ping" && route.caseIds.join() === "mcp.legacy.server-ping") || mcpEmulatorModule.mcpEmulatorServerPingFixtures.length !== 1 || !mcpEmulatorModule.mcpEmulatorRoutes.every(route => route.evidence === "unverified" && !route.write)) throw new Error("MCP emulator manifest mismatch")',
          'const mcpEmulator = await mcpEmulatorModule.makeMcpEmulator()',
          'const mcpProbe = (bearer, url = "https://mcp.example.test/modern/mcp") => new Request(url, { method: "POST", headers: { authorization: `Bearer ${bearer}`, accept: "application/json, text/event-stream", "content-type": "application/json", "mcp-method": "server/discover", "mcp-protocol-version": "2026-07-28" }, body: JSON.stringify({ jsonrpc: "2.0", id: "smoke-probe", method: "server/discover", params: { _meta: { "io.modelcontextprotocol/protocolVersion": "2026-07-28", "io.modelcontextprotocol/clientInfo": { name: "yolk", version: "0.1.0" }, "io.modelcontextprotocol/clientCapabilities": {} } } }) })',
          'const mcpDiscovered = await mcpEmulator.fetch(mcpProbe("synthetic-smoke-token"))',
          'const mcpDiscoverBody = await mcpDiscovered.json()',
          'if (mcpDiscovered.status !== 200 || mcpDiscovered.headers.get("x-emulator-evidence") !== "unverified" || mcpDiscoverBody.id !== "smoke-probe" || !mcpDiscoverBody.result.supportedVersions.includes("2026-07-28")) throw new Error("MCP emulator smoke failed")',
          'const mcpRejected = await mcpEmulator.fetch(mcpProbe(mcpEmulatorModule.mcpEmulatorReservedInvalidCredential))',
          'if (mcpRejected.status !== 401 || !mcpRejected.headers.get("www-authenticate")?.startsWith("Bearer") || JSON.stringify([mcpEmulator.ledger.entries(), mcpEmulator.snapshot()]).includes(mcpEmulatorModule.mcpEmulatorReservedInvalidCredential)) throw new Error("MCP emulator must answer the recorded 401 without keeping the credential")',
          'const mcpRefused = await mcpEmulator.fetch(mcpProbe("synthetic-smoke-token", "https://mcp.example.test/modern/mcp?q=synthetic-smoke-token"))',
          'if (mcpRefused.status !== 400 || (await mcpRefused.text()).includes("synthetic-smoke-token") || JSON.stringify(mcpEmulator.ledger.entries()).includes("synthetic-smoke-token")) throw new Error("MCP emulator must fail closed without echoing the token")',
          'const afloatDiscovered = await mcpEmulator.fetch(mcpProbe("afloat_synthetic-smoke-key-0001", "https://useafloat.com/mcp"))',
          'if (afloatDiscovered.status !== 200 || (await afloatDiscovered.json()).id !== "smoke-probe") throw new Error("MCP emulator Afloat profile smoke failed")',
          'const afloatRejected = await mcpEmulator.fetch(mcpProbe(mcpEmulatorModule.mcpEmulatorAfloatReservedInvalidCredential, "https://useafloat.com/mcp"))',
          'if (afloatRejected.status !== 401 || afloatRejected.headers.get("www-authenticate") !== "Bearer") throw new Error("MCP emulator Afloat profile must answer the recorded 401")',
          'if ((await mcpEmulator.fetch(mcpProbe("synthetic-smoke-token", "https://useafloat.com/mcp"))).status !== 400 || JSON.stringify(mcpEmulator.ledger.entries()).includes("synthetic-smoke-key-0001")) throw new Error("MCP emulator Afloat profile must refuse a bearer without afloat_ and never keep the key")',
          'const figmaProbe = await mcpEmulator.fetch(mcpProbe("synthetic-smoke-token", "https://mcp.figma.com/mcp"))',
          'if (figmaProbe.status !== 400 || figmaProbe.headers.get("x-emulator-evidence") !== "unverified" || (await figmaProbe.json()).error.code !== -32000) throw new Error("MCP emulator Figma profile must answer the recorded session-less probe")',
          'const figmaRejected = await mcpEmulator.fetch(mcpProbe(mcpEmulatorModule.mcpEmulatorReservedInvalidCredential, "https://mcp.figma.com/mcp"))',
          'if (figmaRejected.status !== 401 || !figmaRejected.headers.get("www-authenticate")?.startsWith("Bearer")) throw new Error("MCP emulator Figma profile must answer the recorded 401")',
          'await mcpEmulator.close()',
          'const kieEmulatorModule = await import("@yolk-sdk/emulators/kie")',
          'if (kieEmulatorModule.kieEmulatorRoutes.length !== 2 || !kieEmulatorModule.kieEmulatorRoutes.every(route => route.evidence === "unverified") || kieEmulatorModule.kieEmulatorRoutes.filter(route => route.write).map(route => route.path).join() !== "/api/v1/jobs/createTask") throw new Error("Kie emulator manifest mismatch")',
          'const kieEmulator = await kieEmulatorModule.makeKieEmulator()',
          'const kieHeaders = { authorization: "Bearer synthetic-smoke-token", accept: "application/json" }',
          'const kieTask = await kieEmulator.fetch(new Request("https://api.kie.ai/api/v1/jobs/recordInfo?taskId=yolk_synthetic_task_success_0001", { headers: kieHeaders }))',
          'if (kieTask.status !== 200 || kieTask.headers.get("x-emulator-evidence") !== "unverified" || (await kieTask.json()).data.state !== "success") throw new Error("Kie emulator smoke failed")',
          'const kieRejected = await kieEmulator.fetch(new Request("https://api.kie.ai/api/v1/jobs/recordInfo?taskId=x", { headers: { ...kieHeaders, authorization: "Bearer yolk-conformance-invalid-kie-key" } }))',
          'if (kieRejected.status !== 401 || JSON.stringify([kieEmulator.ledger.entries(), kieEmulator.snapshot()]).includes("yolk-conformance-invalid-kie-key")) throw new Error("Kie emulator must answer the recorded 401 without keeping the key")',
          'const kieRefused = await kieEmulator.fetch(new Request("https://api.kie.ai/api/v1/jobs/recordInfo?taskId=synthetic-smoke-token", { headers: kieHeaders }))',
          'if (kieRefused.status !== 400 || (await kieRefused.text()).includes("synthetic-smoke-token") || JSON.stringify(kieEmulator.ledger.entries()).includes("synthetic-smoke-token")) throw new Error("Kie emulator must fail closed without echoing the key")',
          'await kieEmulator.close()'
        ].join('\n')
    )

    await import(pathToFileURL(smokeFile).href)

    checkLazyImports(fixtureDir, cloudflareStub)
    await checkBundleSplits(fixtureDir)
  } finally {
    rmSync(fixtureDir, { recursive: true, force: true })
  }
}

void main()
