import { lstatSync, readdirSync, readFileSync, realpathSync } from 'node:fs'
import { isBuiltin } from 'node:module'
import { fileURLToPath } from 'node:url'
import { dirname, join, parse, relative, resolve, sep } from 'node:path'
import process from 'node:process'
import * as ts from 'typescript'

type BoundaryRule = {
  readonly packageDir: string
  readonly forbiddenImports: ReadonlyArray<string>
  readonly excludedDirs?: ReadonlyArray<string>
}

type RetiredPackage = {
  readonly dir: string
  readonly importName: string
}

export type BoundaryViolation = {
  readonly file: string
  readonly specifier: string
  readonly forbidden: string
  readonly resolved?: string
}

export type BoundaryReport = {
  readonly violations: ReadonlyArray<BoundaryViolation>
  readonly retiredDirViolations: ReadonlyArray<RetiredPackage>
  readonly configErrors: ReadonlyArray<string>
}

const retiredPackages: ReadonlyArray<RetiredPackage> = [
  { dir: 'packages/agent-loop', importName: '@yolk-sdk/agent-loop' },
  { dir: 'packages/agent-runtime', importName: '@yolk-sdk/agent-runtime' },
  { dir: 'packages/anthropic', importName: '@yolk-sdk/anthropic' },
  { dir: 'packages/client', importName: '@yolk-sdk/client' },
  { dir: 'packages/mcp-client', importName: '@yolk-sdk/mcp-client' },
  { dir: 'packages/mcp-server', importName: '@yolk-sdk/mcp-server' },
  { dir: 'packages/oauth', importName: '@yolk-sdk/oauth' },
  { dir: 'packages/openai', importName: '@yolk-sdk/openai' },
  { dir: 'packages/protocol', importName: '@yolk-sdk/protocol' },
  { dir: 'packages/react', importName: '@yolk-sdk/react' },
  { dir: 'packages/skillset', importName: '@yolk-sdk/skillset' },
  { dir: 'packages/tool-registry', importName: '@yolk-sdk/tool-registry' },
  { dir: 'packages/vercel-workflows-runtime', importName: '@yolk-sdk/vercel-workflows-runtime' },
  { dir: 'packages/voice-runtime', importName: '@yolk-sdk/voice-runtime' }
]

const retiredImports = retiredPackages.map(retiredPackage => retiredPackage.importName)

const agentCoreForbiddenImports = [
  ...retiredImports,
  '@yolk-sdk/knowledge',
  '@yolk-sdk/mcp',
  '@yolk-sdk/agent/react',
  'next',
  'react',
  'node:'
]

const rules: ReadonlyArray<BoundaryRule> = [
  {
    packageDir: 'examples/next/app',
    forbiddenImports: [...retiredImports, '@yolk-sdk/agent$', '@yolk-sdk/mcp$']
  },
  {
    packageDir: 'examples/next/lib',
    forbiddenImports: [...retiredImports, '@yolk-sdk/agent$', '@yolk-sdk/mcp$']
  },
  {
    packageDir: 'cloudflare/agent/src',
    forbiddenImports: [...retiredImports, '@yolk-sdk/agent$', '@yolk-sdk/mcp$']
  },
  {
    packageDir: 'examples/next/e2e',
    forbiddenImports: [...retiredImports, '@yolk-sdk/agent$', '@yolk-sdk/mcp$']
  },
  {
    packageDir: 'packages/agent/src/protocol',
    forbiddenImports: agentCoreForbiddenImports
  },
  {
    packageDir: 'packages/agent/src/loop',
    forbiddenImports: agentCoreForbiddenImports
  },
  {
    packageDir: 'packages/agent/src/runtime',
    forbiddenImports: agentCoreForbiddenImports
  },
  {
    packageDir: 'packages/agent/src/client',
    forbiddenImports: agentCoreForbiddenImports
  },
  {
    packageDir: 'packages/agent/src/compaction',
    forbiddenImports: agentCoreForbiddenImports
  },
  {
    packageDir: 'packages/agent/src/tools',
    forbiddenImports: agentCoreForbiddenImports
  },
  {
    packageDir: 'packages/agent/src/oauth',
    forbiddenImports: agentCoreForbiddenImports
  },
  {
    packageDir: 'packages/agent/src/providers',
    forbiddenImports: agentCoreForbiddenImports
  },
  {
    packageDir: 'packages/agent/src/skillset',
    forbiddenImports: agentCoreForbiddenImports
  },
  {
    packageDir: 'packages/agent/src/voice',
    forbiddenImports: agentCoreForbiddenImports,
    excludedDirs: ['packages/agent/src/voice/react.ts']
  },
  {
    packageDir: 'packages/agent/src/voice/react.ts',
    forbiddenImports: [...retiredImports, '@yolk-sdk/knowledge', '@yolk-sdk/mcp', 'next', 'node:']
  },
  {
    packageDir: 'packages/agent/src/react',
    forbiddenImports: [...retiredImports, '@yolk-sdk/knowledge', '@yolk-sdk/mcp', 'next', 'node:']
  },
  {
    packageDir: 'packages/knowledge/src',
    forbiddenImports: [
      ...retiredImports,
      '@yolk-sdk/agent/react',
      '@yolk-sdk/mcp',
      'next',
      'react',
      'node:'
    ]
  },
  {
    packageDir: 'packages/sandbox/src',
    forbiddenImports: ['@vercel/sandbox'],
    excludedDirs: ['packages/sandbox/src/vercel']
  },
  {
    packageDir: 'packages/sandbox/src',
    forbiddenImports: ['@yolk-sdk/agent'],
    excludedDirs: ['packages/sandbox/src/agent.ts']
  },
  {
    packageDir: 'packages/harness/src',
    forbiddenImports: [
      ...retiredImports,
      '@yolk-sdk/agent',
      '@yolk-sdk/knowledge',
      '@yolk-sdk/mcp',
      '@yolk-sdk/sandbox',
      '@yolk-sdk/vercel-workflows',
      'next',
      'react',
      'node:'
    ],
    excludedDirs: ['packages/harness/src/outcome.ts']
  }
]

const skippedWalkDirs = new Set([
  'node_modules',
  'dist',
  '.next',
  '.turbo',
  '.source',
  '.git',
  '.repos',
  '.alchemy',
  '.well-known',
  '.workflow-vitest',
  'generated',
  'coverage',
  'test-results',
  'playwright-report'
])

const appOwnerPrefixes = ['apps/', 'examples/', 'cloudflare/']

const packagesOwnerBan = 'packages/* must not import apps/examples/cloudflare (resolved owner)'

export const violates = (specifier: string, forbidden: string): boolean => {
  if (forbidden.endsWith('$')) {
    return specifier === forbidden.slice(0, -1)
  }

  // The `node:` namespace covers every `node:`-prefixed specifier (node:fs,
  // node:fs/promises, ...) as well as bare Node builtins (fs, fs/promises),
  // resolved through the portable core policy `node:module.isBuiltin`.
  // Unrelated lookalikes (fss, next-auth) never match.
  if (forbidden === 'node:') {
    return specifier.startsWith('node:') || isBuiltin(specifier)
  }

  return specifier === forbidden || specifier.startsWith(`${forbidden}/`)
}

const isTypescriptFile = (path: string): boolean =>
  path.endsWith('.ts') || path.endsWith('.tsx') || path.endsWith('.mts') || path.endsWith('.cts')

const scriptKindForFile = (fileName: string): ts.ScriptKind => {
  if (fileName.endsWith('.tsx')) {
    return ts.ScriptKind.TSX
  }

  if (fileName.endsWith('.jsx')) {
    return ts.ScriptKind.JSX
  }

  if (fileName.endsWith('.js') || fileName.endsWith('.mjs') || fileName.endsWith('.cjs')) {
    return ts.ScriptKind.JS
  }

  return ts.ScriptKind.TS
}

export const walk = (dir: string): ReadonlyArray<string> => {
  const entries = readdirSync(dir, { withFileTypes: true })
  const files: Array<string> = []

  for (const entry of entries) {
    // Never follow symlinks: they can escape the workspace into external
    // roots or loop back into already-visited trees.
    if (entry.isSymbolicLink()) {
      continue
    }

    const path = join(dir, entry.name)

    if (entry.isDirectory()) {
      // Never walk dependency output, generated trees, or VCS metadata.
      if (skippedWalkDirs.has(entry.name) || entry.name.startsWith('.workflow-')) {
        continue
      }

      files.push(...walk(path))
    } else if (entry.isFile() && isTypescriptFile(path)) {
      files.push(path)
    }
  }

  return files
}

export type CollectedSpecifiers = {
  readonly specifiers: ReadonlyArray<string>
  readonly parseErrors: ReadonlyArray<string>
}

/**
 * Collect static module specifiers with the TypeScript AST: static imports
 * (including `import type`), re-exports (`export ... from`, including
 * `export type`), import types (`import('x')` in type positions), literal
 * dynamic imports (`import('x')`, including calls with import options such as
 * `import('x', { with: ... })`), and TS import-equals declarations
 * (`import name = require('x')`). Comments and raw string contents are never
 * visited because only real AST nodes are read. Computed or non-literal
 * dynamic imports cannot be resolved statically and are intentionally ignored;
 * see scripts/AGENTS.md. Files are parsed with the ScriptKind matching their
 * filename (.ts as TS, .tsx as TSX); syntax errors are reported through
 * parseErrors instead of silently dropping imports.
 */
const syntacticErrors = (sourceText: string, fileName: string): ReadonlyArray<string> => {
  const options: ts.CompilerOptions = {
    allowJs: true,
    noEmit: true,
    noLib: true,
    noResolve: true,
    target: ts.ScriptTarget.Latest
  }

  const host = ts.createCompilerHost(options)

  host.getSourceFile = (name, languageVersion) => {
    if (name !== fileName) {
      return undefined
    }

    return ts.createSourceFile(name, sourceText, languageVersion, true, scriptKindForFile(name))
  }

  host.fileExists = name => name === fileName

  host.readFile = name => (name === fileName ? sourceText : undefined)

  const program = ts.createProgram([fileName], options, host)
  const source = program.getSourceFile(fileName)

  if (source === undefined) {
    return [`unable to parse ${fileName}`]
  }

  return program
    .getSyntacticDiagnostics(source)
    .map(diagnostic => ts.flattenDiagnosticMessageText(diagnostic.messageText, ' '))
}

export const collectSpecifiers = (
  sourceText: string,
  fileName = 'probe.ts'
): CollectedSpecifiers => {
  const source = ts.createSourceFile(
    fileName,
    sourceText,
    ts.ScriptTarget.Latest,
    true,
    scriptKindForFile(fileName)
  )

  // transpileModule is emit-oriented and throws on declarations, so syntax
  // errors come from the syntactic diagnostics of a single-file program
  // (virtual host, noResolve, noLib) parsed with the same filename ScriptKind.
  const parseErrors = syntacticErrors(sourceText, fileName)

  const specifiers: Array<string> = []

  const visit = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) {
      const specifier = node.moduleSpecifier

      if (specifier !== undefined && ts.isStringLiteralLike(specifier)) {
        specifiers.push(specifier.text)
      }
    } else if (ts.isImportTypeNode(node)) {
      const argument = node.argument

      if (ts.isLiteralTypeNode(argument) && ts.isStringLiteralLike(argument.literal)) {
        specifiers.push(argument.literal.text)
      }
    } else if (
      ts.isImportEqualsDeclaration(node) &&
      ts.isExternalModuleReference(node.moduleReference)
    ) {
      const expression = node.moduleReference.expression

      if (ts.isStringLiteralLike(expression)) {
        specifiers.push(expression.text)
      }
    } else if (
      ts.isCallExpression(node) &&
      node.expression.kind === ts.SyntaxKind.ImportKeyword &&
      node.arguments.length >= 1
    ) {
      const [first] = node.arguments

      if (first !== undefined && ts.isStringLiteralLike(first)) {
        specifiers.push(first.text)
      }
    }

    ts.forEachChild(node, visit)
  }

  visit(source)

  return { specifiers, parseErrors }
}

type Owner = { kind: 'package'; specifier: string } | { kind: 'app' } | { kind: 'external' }

type PackageManifest = {
  readonly name: string
  readonly exportTargets: ReadonlyArray<{ subpath: string; target: string }>
}

type ManifestCacheEntry = { manifest: PackageManifest | null; error: string | null }

type ResolverContext = {
  readonly root: string
  readonly manifests: Map<string, ManifestCacheEntry>
  readonly tsconfigs: Map<string, ts.CompilerOptions | null>
  readonly configErrors: Array<string>
}

export const createResolverContext = (root: string): ResolverContext => ({
  // Resolve the caller-selected workspace once; descendants remain no-follow.
  // This also supports platform aliases such as macOS /tmp -> /private/tmp.
  root: realpathSync(root),
  manifests: new Map<string, ManifestCacheEntry>(),
  tsconfigs: new Map<string, ts.CompilerOptions | null>(),
  configErrors: []
})

const reportConfigError = (context: ResolverContext, message: string): void => {
  if (!context.configErrors.includes(message)) {
    context.configErrors.push(message)
  }
}

const gatherExportStrings = (node: ts.Expression, into: Array<string>): void => {
  if (ts.isStringLiteralLike(node)) {
    into.push(node.text)

    return
  }

  if (ts.isArrayLiteralExpression(node)) {
    for (const element of node.elements) {
      if (!ts.isSpreadElement(element)) {
        gatherExportStrings(element, into)
      }
    }

    return
  }

  if (ts.isObjectLiteralExpression(node)) {
    for (const property of node.properties) {
      if (ts.isPropertyAssignment(property)) {
        gatherExportStrings(property.initializer, into)
      }
    }
  }
}

const propertyText = (property: ts.ObjectLiteralElementLike): string | null => {
  if (!ts.isPropertyAssignment(property)) {
    return null
  }

  if (ts.isIdentifier(property.name) || ts.isStringLiteral(property.name)) {
    return property.name.text
  }

  return null
}

/**
 * Read a package manifest through the JSON AST (never a laundered annotation):
 * the `name` must be a real string literal and `exports` targets are collected
 * from string literals only. Malformed manifests produce an honest error and
 * resolve to no owner instead of silently bypassing the boundary.
 */
const readPackageManifest = (
  context: ResolverContext,
  packageDir: string
): PackageManifest | null => {
  const cached = context.manifests.get(packageDir)

  if (cached !== undefined) {
    if (cached.error !== null) {
      reportConfigError(context, cached.error)
    }

    return cached.manifest
  }

  const manifestPath = join(context.root, 'packages', packageDir, 'package.json')

  if (!isReadableWorkspacePath(context, manifestPath)) {
    const message = `${relative(context.root, manifestPath)}: refusing symlinked or escaped manifest path`

    context.manifests.set(packageDir, { manifest: null, error: message })
    reportConfigError(context, message)

    return null
  }

  const rel = relative(context.root, manifestPath)

  const fail = (detail: string): null => {
    const message = `${rel}: invalid package manifest (${detail})`

    context.manifests.set(packageDir, { manifest: null, error: message })
    reportConfigError(context, message)

    return null
  }

  let text: string

  try {
    text = readFileSync(manifestPath, 'utf8')
  } catch {
    context.manifests.set(packageDir, { manifest: null, error: null })

    return null
  }

  const source = ts.createSourceFile(
    manifestPath,
    text,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.JSON
  )

  const jsonParsed = ts.parseConfigFileTextToJson(manifestPath, text)

  if (jsonParsed.error !== undefined) {
    return fail(ts.flattenDiagnosticMessageText(jsonParsed.error.messageText, ' '))
  }

  const [statement] = source.statements

  if (statement === undefined || !ts.isExpressionStatement(statement)) {
    return fail('expected a JSON object')
  }

  if (!ts.isObjectLiteralExpression(statement.expression)) {
    return fail('expected a JSON object')
  }

  let name: string | null = null
  const exportTargets: Array<{ subpath: string; target: string }> = []

  for (const property of statement.expression.properties) {
    const key = propertyText(property)

    if (key === 'name') {
      if (ts.isPropertyAssignment(property) && ts.isStringLiteralLike(property.initializer)) {
        name = property.initializer.text
      }

      continue
    }

    if (key === 'exports' && ts.isPropertyAssignment(property)) {
      const exportsNode = property.initializer

      if (ts.isObjectLiteralExpression(exportsNode)) {
        for (const entry of exportsNode.properties) {
          const subpath = propertyText(entry)

          if (subpath === null || !ts.isPropertyAssignment(entry)) {
            continue
          }

          const strings: Array<string> = []

          gatherExportStrings(entry.initializer, strings)

          for (const target of strings) {
            exportTargets.push({
              subpath,
              target: target.startsWith('./') ? target.slice(2) : target
            })
          }
        }
      }
    }
  }

  if (name === null) {
    return fail('missing string "name"')
  }

  const manifest: PackageManifest = { name, exportTargets }

  context.manifests.set(packageDir, { manifest, error: null })

  return manifest
}

/**
 * Map a resolved workspace file to its public owner specifier using the
 * owning package's export map (longest match wins): a file exactly equal to
 * an export target, or nested under an index-entry target's directory
 * (`./src/react/index.ts` owns `src/react/*`), resolves to
 * `@yolk-sdk/<pkg><subpath>` (`.` maps to the bare package root); files with
 * no export mapping — including same-name siblings such as `src/react.ts` —
 * fall back to the bare package name.
 */
export const ownerOfFile = (context: ResolverContext, absoluteFile: string): Owner => {
  const rel = relative(context.root, absoluteFile)

  if (rel === '' || rel.startsWith('..')) {
    return { kind: 'external' }
  }

  if (rel === 'packages' || rel.startsWith('packages/')) {
    const segments = rel.split(sep)
    const packageDir = segments[1]

    if (packageDir === undefined) {
      return { kind: 'external' }
    }

    const manifest = readPackageManifest(context, packageDir)

    if (manifest === null) {
      return { kind: 'external' }
    }

    const withinPackage = segments.slice(2).join('/')

    let best: { subpath: string; target: string } | null = null
    let bestLength = -1

    for (const candidate of manifest.exportTargets) {
      const target = candidate.target
      let matchedLength = -1

      if (withinPackage === target) {
        matchedLength = target.length
      } else {
        const segments = target.split('/')
        const base = segments[segments.length - 1]

        if (base !== undefined && base.startsWith('index.')) {
          const prefix = target.slice(0, target.length - base.length)

          if (withinPackage.startsWith(prefix) && withinPackage.length > prefix.length) {
            matchedLength = prefix.length
          }
        }
      }

      if (matchedLength > bestLength) {
        best = candidate
        bestLength = matchedLength
      }
    }

    if (best === null) {
      return { kind: 'package', specifier: manifest.name }
    }

    return {
      kind: 'package',
      specifier: best.subpath === '.' ? manifest.name : `${manifest.name}${best.subpath.slice(1)}`
    }
  }

  if (appOwnerPrefixes.some(prefix => rel === prefix.slice(0, -1) || rel.startsWith(prefix))) {
    return { kind: 'app' }
  }

  return { kind: 'external' }
}

const insideRoot = (context: ResolverContext, absolutePath: string): boolean => {
  const rel = relative(context.root, absolutePath)

  return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`))
}

// Every path component from the workspace root down must be a non-symlink:
// checking only the last component would miss an intermediate link pointing
// outside the workspace. Missing tails are allowed (resolution fails safely);
// symlinks and escapes are rejected before any lookup or read.
const hasSymlinkComponent = (absolutePath: string): boolean => {
  const normalized = resolve(absolutePath)
  const root = parse(normalized).root
  let current = root

  // Check parents before children: lstat on a leaf still follows links in
  // intermediate components, even though it does not follow the leaf itself.
  for (const segment of relative(root, normalized).split(sep)) {
    current = join(current, segment)

    try {
      if (lstatSync(current).isSymbolicLink()) {
        return true
      }
    } catch {
      // No descendant can exist beneath a missing/inaccessible component.
      return false
    }
  }

  return false
}

const isReadableWorkspacePath = (context: ResolverContext, absolutePath: string): boolean =>
  insideRoot(context, absolutePath) && !hasSymlinkComponent(absolutePath)

// The compiler APIs receive a host that cannot see outside the workspace:
// file probes, reads, and directory scans return empty answers off-root, and
// realpath never follows links (results are vetted by component checks).
const resolutionHost = (context: ResolverContext): ts.ModuleResolutionHost => ({
  fileExists: file => isReadableWorkspacePath(context, file) && ts.sys.fileExists(file),
  readFile: file => (isReadableWorkspacePath(context, file) ? ts.sys.readFile(file) : undefined),
  directoryExists: dir => isReadableWorkspacePath(context, dir) && ts.sys.directoryExists(dir),
  getCurrentDirectory: () => context.root,
  realpath: file => file,
  getDirectories: dir =>
    isReadableWorkspacePath(context, dir) && ts.sys.directoryExists(dir)
      ? readdirSync(dir, { withFileTypes: true })
          .filter(entry => entry.isDirectory() && !entry.isSymbolicLink())
          .map(entry => entry.name)
      : []
})

const tsconfigOptionsForFile = (
  context: ResolverContext,
  containingFile: string
): ts.CompilerOptions | null => {
  let dir = dirname(containingFile)

  // The nearest tsconfig owns resolution for the file; when it carries no
  // path mappings there is intentionally no fallback to unrelated ancestors.
  while (insideRoot(context, dir)) {
    const candidate = join(dir, 'tsconfig.json')

    if (!isReadableWorkspacePath(context, candidate)) {
      reportConfigError(
        context,
        `${relative(context.root, candidate)}: refusing symlinked config path`
      )

      return null
    }

    try {
      if (!lstatSync(candidate).isFile()) {
        const parent = dirname(dir)

        if (parent === dir) {
          break
        }

        dir = parent
        continue
      }
    } catch {
      const parent = dirname(dir)

      if (parent === dir) {
        break
      }

      dir = parent
      continue
    }

    const cached = context.tsconfigs.get(candidate)

    if (cached !== undefined) {
      return cached
    }

    // Full compiler parsing: extends chains, relative baseUrl normalization,
    // and option validation are handled by the TypeScript API itself.

    const resolution = resolutionHost(context)

    const host: ts.ParseConfigFileHost = {
      fileExists: resolution.fileExists,
      readFile: resolution.readFile,
      directoryExists: resolution.directoryExists,
      getCurrentDirectory: () => context.root,
      useCaseSensitiveFileNames: ts.sys.useCaseSensitiveFileNames,
      // Only compiler options are needed here. Expanding include globs would
      // traverse unrelated source trees (and potentially directory symlinks).
      readDirectory: () => [],
      onUnRecoverableConfigFileDiagnostic: diagnostic => {
        reportConfigError(
          context,
          `${relative(context.root, candidate)}: ${ts.flattenDiagnosticMessageText(diagnostic.messageText, ' ')}`
        )
      }
    }

    const parsed = ts.getParsedCommandLineOfConfigFile(candidate, {}, host)

    if (parsed === undefined) {
      reportConfigError(context, `${relative(context.root, candidate)}: unable to parse tsconfig`)

      context.tsconfigs.set(candidate, null)

      return null
    }

    // 18003 means no inputs matched, expected because this options-only host
    // deliberately does not enumerate source files. All config errors remain.
    const configErrors = parsed.errors.filter(error => error.code !== 18003)

    if (configErrors.length > 0) {
      const detail = configErrors
        .map(error => ts.flattenDiagnosticMessageText(error.messageText, ' '))
        .join('; ')

      reportConfigError(context, `${relative(context.root, candidate)}: ${detail}`)

      context.tsconfigs.set(candidate, null)

      return null
    }

    // Preserve the parsed options exactly — including baseUrl-only configs
    // with no paths. An explicit moduleResolution is never overridden; when
    // absent it defaults to Bundler, the mode every repo tsconfig selects
    // while preserving explicitly configured Classic/Node modes as well.
    const options: ts.CompilerOptions = {
      moduleResolution: ts.ModuleResolutionKind.Bundler,
      ...parsed.options
    }

    context.tsconfigs.set(candidate, options)

    return options
  }

  return null
}

/**
 * Resolve a specifier to an absolute file when it is provably local: relative
 * specifiers resolve against the importing file (never following symlinks),
 * and TS path aliases resolve through the nearest scoped tsconfig (compiler
 * API). Results outside the workspace root, and bare externals that do not
 * resolve to a workspace file, return null and stay on specifier matching.
 */
export const resolveSpecifierToFile = (
  context: ResolverContext,
  specifier: string,
  containingFile: string
): string | null => {
  const host = resolutionHost(context)

  const scopedOptions = tsconfigOptionsForFile(context, containingFile) ?? {}

  const accept = (file: string): string | null =>
    isReadableWorkspacePath(context, file) ? file : null

  if (specifier.startsWith('.')) {
    const resolved = resolve(dirname(containingFile), specifier)

    try {
      const stats = lstatSync(resolved)

      if (stats.isFile() && !stats.isSymbolicLink() && insideRoot(context, resolved)) {
        return accept(resolved)
      }
    } catch {
      // Fall through to module resolution for extensionless/TS paths.
    }

    const resolvedModule = ts.resolveModuleName(
      specifier,
      containingFile,
      scopedOptions,
      host
    ).resolvedModule

    return resolvedModule === undefined ? null : accept(resolvedModule.resolvedFileName)
  }

  const options = tsconfigOptionsForFile(context, containingFile)

  if (options === null) {
    return null
  }

  const resolvedModule = ts.resolveModuleName(
    specifier,
    containingFile,
    options,
    host
  ).resolvedModule

  return resolvedModule === undefined ? null : accept(resolvedModule.resolvedFileName)
}

const fileSpecifiers = (context: ResolverContext, file: string): ReadonlyArray<string> => {
  let source: string

  try {
    source = readFileSync(file, 'utf8')
  } catch {
    reportConfigError(context, `${relative(context.root, file)}: unable to read file`)

    return []
  }

  const collected = collectSpecifiers(source, file)

  for (const parseError of collected.parseErrors) {
    reportConfigError(context, `${relative(context.root, file)}: ${parseError}`)
  }

  return collected.specifiers
}

const ownerViolationsForFile = (
  context: ResolverContext,
  file: string,
  rule: BoundaryRule
): ReadonlyArray<BoundaryViolation> => {
  const found: Array<BoundaryViolation> = []

  for (const specifier of fileSpecifiers(context, file)) {
    for (const forbidden of rule.forbiddenImports) {
      if (violates(specifier, forbidden)) {
        found.push({ file, specifier, forbidden })
      }
    }

    // A resolved owner check catches what specifier text cannot: relative or
    // TS-alias imports that land in a forbidden owner (for example a relative
    // import from packages/agent/src/voice into @yolk-sdk/mcp sources, or a
    // relative import from packages/agent/src/protocol into the
    // @yolk-sdk/agent/react export). Unresolvable or computed imports are left
    // alone rather than guessed.
    const resolved = resolveSpecifierToFile(context, specifier, file)

    if (resolved === null) {
      continue
    }

    const owner = ownerOfFile(context, resolved)

    if (owner.kind !== 'package') {
      continue
    }

    // `$`-suffixed edges ban only the bare specifier (explicit-subpath
    // discipline); they never fire on resolved owners, so legitimate deep
    // subpath reuse keeps passing exactly as specifier matching allows it.
    for (const forbidden of rule.forbiddenImports) {
      if (!forbidden.endsWith('$') && violates(owner.specifier, forbidden)) {
        found.push({ file, specifier, forbidden, resolved })
      }
    }
  }

  return found
}

const lstatKind = (path: string): 'file' | 'dir' | null => {
  try {
    const stats = lstatSync(path)

    if (stats.isSymbolicLink()) {
      return null
    }

    if (stats.isFile()) {
      return 'file'
    }

    return stats.isDirectory() ? 'dir' : null
  } catch {
    return null
  }
}

const packageExists = (workspaceRoot: string, packageDir: string): boolean => {
  const kind = lstatKind(join(workspaceRoot, packageDir))

  return kind === 'dir' || (kind === 'file' && isTypescriptFile(packageDir))
}

export const rulePathFiles = (workspaceRoot: string, packageDir: string): ReadonlyArray<string> => {
  const root = realpathSync(workspaceRoot)
  const absolutePath = resolve(root, packageDir)
  const withinRoot = relative(root, absolutePath)

  if (
    withinRoot === '..' ||
    withinRoot.startsWith(`..${sep}`) ||
    hasSymlinkComponent(absolutePath)
  ) {
    return []
  }

  const kind = lstatKind(absolutePath)

  if (kind === null) {
    return []
  }

  return kind === 'file' ? [absolutePath] : walk(absolutePath)
}

const isExcludedFile = (
  workspaceRoot: string,
  file: string,
  excludedDirs: ReadonlyArray<string> = []
): boolean =>
  excludedDirs.some(excludedDir => {
    const absoluteExcludedDir = join(workspaceRoot, excludedDir)

    return file === absoluteExcludedDir || file.startsWith(`${absoluteExcludedDir}/`)
  })

const packageDirs = (context: ResolverContext): ReadonlyArray<string> => {
  const packagesRoot = join(context.root, 'packages')

  try {
    return readdirSync(packagesRoot, { withFileTypes: true })
      .filter(entry => !entry.isSymbolicLink() && entry.isDirectory())
      .map(entry => entry.name)
      .filter(name => lstatKind(join(packagesRoot, name, 'package.json')) === 'file')
  } catch {
    reportConfigError(context, 'packages: unable to list package directories')

    return []
  }
}

/**
 * Global enforcement across every package directory: packages/* sources,
 * tests, and config files must not reach apps/examples/cloudflare owners via
 * relative or alias imports. This runs independently of the per-area rules,
 * so local exclusions (harness outcome, sandbox agent, voice react) never
 * exempt a file from the global ban.
 */
const globalOwnerViolations = (context: ResolverContext): ReadonlyArray<BoundaryViolation> => {
  const found: Array<BoundaryViolation> = []

  for (const name of packageDirs(context)) {
    // Validate every source manifest, not just resolution targets: a malformed
    // manifest in any package fails the gate instead of passing silently.
    readPackageManifest(context, name)

    for (const file of walk(join(context.root, 'packages', name))) {
      for (const specifier of fileSpecifiers(context, file)) {
        const resolved = resolveSpecifierToFile(context, specifier, file)

        if (resolved === null) {
          continue
        }

        if (ownerOfFile(context, resolved).kind === 'app') {
          found.push({ file, specifier, forbidden: packagesOwnerBan, resolved })
        }
      }
    }
  }

  return found
}

export const runCheck = (workspaceRoot: string): BoundaryReport => {
  const context = createResolverContext(workspaceRoot)
  const root = context.root

  const violations = rules.flatMap(rule => {
    if (!packageExists(root, rule.packageDir)) {
      return []
    }

    return rulePathFiles(root, rule.packageDir)
      .filter(file => !isExcludedFile(root, file, rule.excludedDirs))
      .flatMap(file => ownerViolationsForFile(context, file, rule))
  })

  violations.push(...globalOwnerViolations(context))

  const retiredDirViolations = retiredPackages.filter(retiredPackage =>
    packageExists(root, retiredPackage.dir)
  )

  return { violations, retiredDirViolations, configErrors: context.configErrors }
}

const invokedAsCli = (): boolean => {
  const invoked = process.argv[1]

  if (invoked === undefined) {
    return false
  }

  return resolve(invoked) === fileURLToPath(import.meta.url)
}

if (invokedAsCli()) {
  const workspaceRoot = process.cwd()
  const report = runCheck(workspaceRoot)

  if (report.configErrors.length > 0) {
    console.error('Boundary config errors:')

    for (const configError of report.configErrors) {
      console.error(`- ${configError}`)
    }
  }

  if (report.retiredDirViolations.length > 0) {
    console.error('Retired package directories found:')

    for (const retiredPackage of report.retiredDirViolations) {
      console.error(`- ${retiredPackage.dir} (${retiredPackage.importName})`)
    }
  }

  if (report.violations.length > 0) {
    console.error('Package boundary violations:')

    for (const violation of report.violations) {
      const target =
        violation.resolved === undefined
          ? violation.specifier
          : `${violation.specifier} -> ${relative(workspaceRoot, violation.resolved)}`

      console.error(
        `- ${relative(workspaceRoot, violation.file)} imports ${target} (forbidden: ${violation.forbidden})`
      )
    }
  }

  if (
    report.configErrors.length > 0 ||
    report.retiredDirViolations.length > 0 ||
    report.violations.length > 0
  ) {
    process.exitCode = 1
  }
}
