import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import process from 'node:process'
import { Predicate } from 'effect'
import {
  ConnectorBinaryWriteHttpClient,
  ConnectorFileTransferError,
  ConnectorBinaryHttpClient,
  ConnectorBinaryHttpError
} from '../packages/connectors/src/index.ts'
import {
  createDropboxFile,
  updateDropboxFile,
  downloadDropboxFile,
  DropboxDownloadError,
  DropboxDownloadErrorCode,
  DropboxDownloadSource
} from '../packages/connectors/src/dropbox/index.ts'
import {
  createOneDriveFile,
  updateOneDriveFile,
  downloadOutlookAttachment,
  downloadOneDriveItem,
  OneDriveDownloadError,
  OneDriveDownloadErrorCode,
  OneDriveDownloadSource
} from '../packages/connectors/src/microsoft/index.ts'

import {
  downloadGoogleDriveFile,
  exportGoogleDriveFile,
  downloadGmailAttachment,
  GoogleDriveReadonlyOAuthCredentialSlot
} from '../packages/connectors/src/google/index.ts'
import {
  downloadFortnoxInvoicePreview,
  downloadFortnoxArchiveFile,
  fortnoxListSupplierInvoiceFilesAction
} from '../packages/connectors/src/fortnox/index.ts'
import { downloadNotionFile } from '../packages/connectors/src/notion/index.ts'
import { downloadEmailAttachment } from '../packages/connectors/src/email/index.ts'
import { downloadTelegramFile } from '../packages/connectors/src/telegram/index.ts'
import {
  downloadTodoistAttachment,
  todoistListCommentsAction
} from '../packages/connectors/src/todoist/index.ts'
import {
  createGithubAppInstallationToken,
  GithubConnector,
  githubMergePullRequestAction,
  uploadGithubAttachment
} from '../packages/connectors/src/github/index.ts'
import {
  R2ObjectClient,
  getR2Object,
  createR2Object,
  updateR2Object
} from '../packages/connectors/src/r2-storage/index.ts'

type PackageExportContract = {
  readonly packageDir: string
  readonly packageName: string
  readonly expectedExports: ReadonlyArray<string>
  // 'tiny': root must be `export {}`; 'full': any root; 'none': no `.` export and no src/index.ts.
  readonly root: 'tiny' | 'full' | 'none'
}

const workspaceRoot = process.cwd()

const packageExportContracts: ReadonlyArray<PackageExportContract> = [
  {
    packageDir: 'packages/agent',
    packageName: '@yolk-sdk/agent',
    expectedExports: [
      './package.json',
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
    ],
    root: 'tiny'
  },
  {
    packageDir: 'packages/mcp',
    packageName: '@yolk-sdk/mcp',
    expectedExports: [
      './package.json',
      '.',
      './client',
      './client/node',
      './conformance',
      './core',
      './protocol',
      './server',
      './server/node'
    ],
    root: 'tiny'
  },
  {
    packageDir: 'packages/knowledge',
    packageName: '@yolk-sdk/knowledge',
    expectedExports: [
      '.',
      './package.json',
      './agent',
      './chunking',
      './context',
      './embeddings',
      './errors',
      './extraction',
      './files',
      './documents',
      './ingestion',
      './search',
      './store',
      './summarization'
    ],
    root: 'full'
  },
  {
    packageDir: 'packages/connectors',
    packageName: '@yolk-sdk/connectors',
    expectedExports: [
      './package.json',
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
      './google/conformance',
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
    ],
    root: 'full'
  },
  {
    packageDir: 'packages/sandbox',
    packageName: '@yolk-sdk/sandbox',
    expectedExports: ['./package.json', '.', './agent', './testing', './vercel'],
    root: 'full'
  },
  {
    packageDir: 'packages/vercel-workflows',
    packageName: '@yolk-sdk/vercel-workflows',
    expectedExports: ['./package.json', '.', './effect', './testing', './workflow'],
    root: 'full'
  },
  {
    packageDir: 'packages/harness',
    packageName: '@yolk-sdk/harness',
    expectedExports: [
      './package.json',
      '.',
      './coordinator',
      './store',
      './inbox',
      './driver',
      './driver/memory',
      './driver/durable-object',
      './outcome'
    ],
    root: 'tiny'
  },
  {
    packageDir: 'packages/conformance',
    packageName: '@yolk-sdk/conformance',
    expectedExports: ['./package.json', './fixture', './replay', './record', './case', './runner'],
    root: 'none'
  },
  {
    packageDir: 'packages/emulators',
    packageName: '@yolk-sdk/emulators',
    expectedExports: [
      './package.json',
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
      './mcp'
    ],
    root: 'none'
  }
]

type PackageManifest = {
  readonly name: string | undefined
  readonly type: string | undefined
  readonly sideEffects: boolean | undefined
  readonly exportKeys: ReadonlyArray<string>
}

const emptyPackageManifest: PackageManifest = {
  name: undefined,
  type: undefined,
  sideEffects: undefined,
  exportKeys: []
}

const readPackageManifest = (path: string): PackageManifest => {
  const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'))

  if (!Predicate.isObjectOrArray(parsed) || parsed === null) {
    return emptyPackageManifest
  }

  const fieldValue = (key: string) =>
    Object.entries(parsed).find(([entryKey]) => entryKey === key)?.[1]

  const name = fieldValue('name')
  const type = fieldValue('type')
  const sideEffects = fieldValue('sideEffects')
  const exportsField = fieldValue('exports')

  return {
    name: Predicate.isString(name) ? name : undefined,
    type: Predicate.isString(type) ? type : undefined,
    sideEffects: Predicate.isBoolean(sideEffects) ? sideEffects : undefined,
    exportKeys:
      Predicate.isObjectOrArray(exportsField) && exportsField !== null
        ? Object.keys(exportsField)
        : []
  }
}

const normalizedRootSource = (source: string) =>
  source
    .split('\n')
    .map(line => line.trim())
    .filter(line => line !== '' && !line.startsWith('//'))

const sorted = (values: ReadonlyArray<string>) =>
  [...values].sort((left, right) => left.localeCompare(right))

const sameMembers = (left: ReadonlyArray<string>, right: ReadonlyArray<string>) =>
  sorted(left).join('\n') === sorted(right).join('\n')

const failures = packageExportContracts.flatMap(packageExport => {
  const packageJsonPath = join(workspaceRoot, packageExport.packageDir, 'package.json')
  const packageJson = readPackageManifest(packageJsonPath)
  const exportKeys = packageJson.exportKeys

  const rootPath = join(workspaceRoot, packageExport.packageDir, 'src/index.ts')
  const packageFailures: Array<string> = []

  if (packageExport.root === 'none') {
    if (exportKeys.includes('.')) {
      packageFailures.push(`${packageExport.packageDir}/package.json must not export a root "."`)
    }

    if (existsSync(rootPath)) {
      packageFailures.push(
        `${packageExport.packageDir}/src/index.ts must not exist (no root barrel)`
      )
    }
  }

  if (packageExport.root !== 'none' && !existsSync(rootPath)) {
    packageFailures.push(`${packageExport.packageDir}/src/index.ts root entry is missing`)
  }

  const rootStatements =
    packageExport.root === 'tiny' && existsSync(rootPath)
      ? normalizedRootSource(readFileSync(rootPath, 'utf8'))
      : []

  if (packageJson.name !== packageExport.packageName) {
    packageFailures.push(
      `${packageExport.packageDir}/package.json name must be ${packageExport.packageName}`
    )
  }

  if (packageJson.type !== 'module') {
    packageFailures.push(`${packageExport.packageDir}/package.json must use type=module`)
  }

  if (packageJson.sideEffects !== false) {
    packageFailures.push(`${packageExport.packageDir}/package.json must declare sideEffects=false`)
  }

  if (!sameMembers(exportKeys, packageExport.expectedExports)) {
    packageFailures.push(
      `${packageExport.packageDir}/package.json exports mismatch: expected ${sorted(packageExport.expectedExports).join(', ')}, got ${sorted(exportKeys).join(', ')}`
    )
  }

  if (exportKeys.some(exportKey => exportKey.includes('*'))) {
    packageFailures.push(
      `${packageExport.packageDir}/package.json exports must be explicit, no wildcards`
    )
  }

  if (
    packageExport.root === 'tiny' &&
    (rootStatements.length !== 1 || rootStatements[0] !== 'export {}')
  ) {
    packageFailures.push(
      `${packageExport.packageDir}/src/index.ts root must stay tiny: only export {}`
    )
  }

  return packageFailures
})

// These additive APIs intentionally reuse the existing root, microsoft, and dropbox exports in
// both exports and publishConfig.exports; no new package subpath is needed.
if (
  !Predicate.isFunction(ConnectorBinaryHttpClient) ||
  !Predicate.isFunction(ConnectorBinaryHttpError) ||
  !Predicate.isFunction(downloadOneDriveItem) ||
  !Predicate.isFunction(OneDriveDownloadError) ||
  !Predicate.isFunction(OneDriveDownloadSource) ||
  OneDriveDownloadErrorCode === undefined ||
  !Predicate.isFunction(downloadDropboxFile) ||
  !Predicate.isFunction(DropboxDownloadError) ||
  !Predicate.isFunction(DropboxDownloadSource) ||
  DropboxDownloadErrorCode === undefined
) {
  failures.push('Connector host-only binary download runtime exports are missing')
}

// New file APIs also reuse existing explicit source/publish subpaths; manifests are unchanged.
if (
  [
    ConnectorBinaryWriteHttpClient,
    ConnectorFileTransferError,
    createDropboxFile,
    updateDropboxFile,
    createOneDriveFile,
    updateOneDriveFile,
    downloadOutlookAttachment,
    downloadGoogleDriveFile,
    exportGoogleDriveFile,
    downloadGmailAttachment,
    downloadFortnoxInvoicePreview,
    downloadFortnoxArchiveFile,
    downloadNotionFile,
    downloadEmailAttachment,
    downloadTelegramFile,
    downloadTodoistAttachment,
    createGithubAppInstallationToken,
    uploadGithubAttachment,
    R2ObjectClient,
    getR2Object,
    createR2Object,
    updateR2Object
  ].some(value => !Predicate.isFunction(value)) ||
  GoogleDriveReadonlyOAuthCredentialSlot.id !== 'google.oauth' ||
  fortnoxListSupplierInvoiceFilesAction.access !== 'read' ||
  todoistListCommentsAction.access !== 'read' ||
  githubMergePullRequestAction.access !== 'destructive' ||
  GithubConnector.actions.some(action => action.access === undefined)
) {
  failures.push('Connector file capabilities runtime exports are missing')
}

if (failures.length > 0) {
  console.error('Package export/tree-shake smoke failures:')

  for (const failure of failures) {
    console.error(`- ${failure}`)
  }

  process.exitCode = 1
}
