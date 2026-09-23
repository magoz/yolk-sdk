import { Effect, Option, Predicate } from 'effect'
import * as Schema from 'effect/Schema'
import { defineAction } from '../action.ts'
import { ConnectorError } from '../error.ts'
import { decodeJsonResponse } from '../http.ts'
import type { ConnectorIntegration } from '../integration.ts'
import { ActionResult } from '../result.ts'
import {
  GithubWireUser,
  githubFailure,
  githubFileContentMaxChars,
  githubHasNextPage,
  githubHasScopeQualifier,
  githubListBodyMaxChars,
  githubPaginationFields,
  githubPaginationQuery,
  githubPatchMaxChars,
  githubRepoRequest,
  githubRequest,
  isGithubSuccess,
  resolveGithubContext,
  truncateGithubText
} from './shared.ts'

// ---------------------------------------------------------------------------
// compare_commits
// ---------------------------------------------------------------------------

export const GithubCompareCommitsInput = Schema.Struct({
  base: Schema.String.check(Schema.isMinLength(1)),
  head: Schema.String.check(Schema.isMinLength(1)),
  ...githubPaginationFields
})

export type GithubCompareCommitsInput = typeof GithubCompareCommitsInput.Type

export const GithubComparedCommit = Schema.Struct({
  sha: Schema.String,
  message: Schema.NullOr(Schema.String),
  messageTruncated: Schema.Boolean,
  author: Schema.NullOr(Schema.String),
  date: Schema.NullOr(Schema.String)
})

export type GithubComparedCommit = typeof GithubComparedCommit.Type

export const GithubComparedFile = Schema.Struct({
  filename: Schema.String,
  status: Schema.NullOr(Schema.String),
  additions: Schema.Number,
  deletions: Schema.Number,
  patch: Schema.NullOr(Schema.String),
  patchTruncated: Schema.Boolean
})

export type GithubComparedFile = typeof GithubComparedFile.Type

export const GithubCompareCommitsOutput = Schema.Struct({
  status: Schema.String,
  aheadBy: Schema.Number,
  behindBy: Schema.Number,
  totalCommits: Schema.Number,
  commits: Schema.Array(GithubComparedCommit),
  files: Schema.Array(GithubComparedFile),
  filesTruncated: Schema.Boolean,
  url: Schema.String,
  hasNextPage: Schema.Boolean
})

export type GithubCompareCommitsOutput = typeof GithubCompareCommitsOutput.Type

/** GitHub caps compare file lists; only the first page of files is normalized. */
const githubCompareMaxFiles = 100

const GithubWireCompareCommit = Schema.Struct({
  sha: Schema.String,
  commit: Schema.optional(
    Schema.Struct({
      message: Schema.optional(Schema.NullOr(Schema.String)),
      author: Schema.optional(
        Schema.NullOr(
          Schema.Struct({
            name: Schema.optional(Schema.NullOr(Schema.String)),
            date: Schema.optional(Schema.NullOr(Schema.String))
          })
        )
      ),
      committer: Schema.optional(
        Schema.NullOr(
          Schema.Struct({
            name: Schema.optional(Schema.NullOr(Schema.String)),
            date: Schema.optional(Schema.NullOr(Schema.String))
          })
        )
      )
    })
  ),
  author: Schema.optional(Schema.NullOr(GithubWireUser))
})

const GithubWireComparedFile = Schema.Struct({
  filename: Schema.String,
  status: Schema.optional(Schema.String),
  additions: Schema.optional(Schema.Number),
  deletions: Schema.optional(Schema.Number),
  patch: Schema.optional(Schema.NullOr(Schema.String))
})

const GithubCompareResponse = Schema.Struct({
  status: Schema.String,
  ahead_by: Schema.Number,
  behind_by: Schema.Number,
  total_commits: Schema.Number,
  commits: Schema.optional(Schema.Array(GithubWireCompareCommit)),
  files: Schema.optional(Schema.Array(GithubWireComparedFile)),
  html_url: Schema.optional(Schema.String),
  url: Schema.optional(Schema.String)
})

// `:` would select another fork (`user:branch`); keep compares inside the configured repo.
const invalidCompareRef = /[\s:\x00-\x1f\x7f]/

const assertGithubCompareRef = (
  field: 'base' | 'head',
  value: string,
  integration: ConnectorIntegration
) => {
  if (value.length === 0 || value.includes('..') || invalidCompareRef.test(value)) {
    return Effect.fail(
      new ConnectorError({
        cause: 'validation_failed',
        message: `GitHub compare commits requires ${field} to be a single ref or SHA in the configured repository (no '..', ':', or whitespace)`,
        connectorId: integration.connectorId,
        actionId: 'github.compare_commits'
      })
    )
  }

  return Effect.void
}

const normalizeComparedCommit = (
  commit: typeof GithubWireCompareCommit.Type
): GithubComparedCommit => {
  const rawMessage = commit.commit?.message ?? null

  const message =
    rawMessage === null
      ? { text: null, truncated: false }
      : truncateGithubText(rawMessage, githubListBodyMaxChars)

  return GithubComparedCommit.make({
    sha: commit.sha,
    message: message.text,
    messageTruncated: message.truncated,
    author: commit.author?.login ?? commit.commit?.author?.name ?? null,
    date: commit.commit?.author?.date ?? commit.commit?.committer?.date ?? null
  })
}

const normalizeComparedFile = (file: typeof GithubWireComparedFile.Type): GithubComparedFile => {
  const patch =
    file.patch === undefined || file.patch === null
      ? { text: null, truncated: false }
      : truncateGithubText(file.patch, githubPatchMaxChars)

  return GithubComparedFile.make({
    filename: file.filename,
    status: file.status ?? null,
    additions: file.additions ?? 0,
    deletions: file.deletions ?? 0,
    patch: patch.text,
    patchTruncated: patch.truncated
  })
}

export const githubCompareCommitsAction = defineAction({
  id: 'github.compare_commits',
  description:
    'Compare two refs (base...head) in the configured repository: commit list and diff file list.',
  access: 'read',
  inputSchema: GithubCompareCommitsInput,
  outputSchema: GithubCompareCommitsOutput,
  execute: ({ integration, input }) =>
    Effect.gen(function* () {
      yield* assertGithubCompareRef('base', input.base, integration)

      yield* assertGithubCompareRef('head', input.head, integration)

      const context = yield* resolveGithubContext(integration)

      const response = yield* githubRepoRequest(context, {
        method: 'GET',
        path: `/compare/${encodeURIComponent(input.base)}...${encodeURIComponent(input.head)}`,
        query: githubPaginationQuery(input)
      })

      if (!isGithubSuccess(response.status)) {
        return yield* githubFailure(response, { operation: 'compare commits' })
      }

      const compared = yield* decodeJsonResponse(GithubCompareResponse, response)

      const files = compared.files ?? []

      return ActionResult.success(
        GithubCompareCommitsOutput.make({
          status: compared.status,
          aheadBy: compared.ahead_by,
          behindBy: compared.behind_by,
          totalCommits: compared.total_commits,
          commits: (compared.commits ?? []).map(normalizeComparedCommit),
          files: files.slice(0, githubCompareMaxFiles).map(normalizeComparedFile),
          filesTruncated: files.length > githubCompareMaxFiles,
          url: compared.html_url ?? compared.url ?? '',
          hasNextPage: githubHasNextPage(response.headers)
        })
      )
    })
})

// ---------------------------------------------------------------------------
// list_releases
// ---------------------------------------------------------------------------

export const GithubListReleasesInput = Schema.Struct({
  ...githubPaginationFields
})

export type GithubListReleasesInput = typeof GithubListReleasesInput.Type

export const GithubRelease = Schema.Struct({
  id: Schema.Number,
  tagName: Schema.String,
  name: Schema.NullOr(Schema.String),
  draft: Schema.Boolean,
  prerelease: Schema.Boolean,
  author: Schema.NullOr(Schema.String),
  body: Schema.NullOr(Schema.String),
  bodyTruncated: Schema.Boolean,
  url: Schema.String,
  createdAt: Schema.String,
  publishedAt: Schema.NullOr(Schema.String)
})

export type GithubRelease = typeof GithubRelease.Type

export const GithubListReleasesOutput = Schema.Struct({
  releases: Schema.Array(GithubRelease),
  hasNextPage: Schema.Boolean
})

export type GithubListReleasesOutput = typeof GithubListReleasesOutput.Type

const GithubWireRelease = Schema.Struct({
  id: Schema.Number,
  tag_name: Schema.String,
  name: Schema.optional(Schema.NullOr(Schema.String)),
  draft: Schema.optional(Schema.Boolean),
  prerelease: Schema.optional(Schema.Boolean),
  author: Schema.optional(Schema.NullOr(GithubWireUser)),
  body: Schema.optional(Schema.NullOr(Schema.String)),
  html_url: Schema.String,
  created_at: Schema.String,
  published_at: Schema.optional(Schema.NullOr(Schema.String))
})

const GithubListReleasesResponse = Schema.Array(GithubWireRelease)

const normalizeGithubRelease = (release: typeof GithubWireRelease.Type): GithubRelease => {
  const body =
    release.body === undefined || release.body === null
      ? { text: null, truncated: false }
      : truncateGithubText(release.body, githubListBodyMaxChars)

  return GithubRelease.make({
    id: release.id,
    tagName: release.tag_name,
    name: release.name ?? null,
    draft: release.draft ?? false,
    prerelease: release.prerelease ?? false,
    author: release.author?.login ?? null,
    body: body.text,
    bodyTruncated: body.truncated,
    url: release.html_url,
    createdAt: release.created_at,
    publishedAt: release.published_at ?? null
  })
}

export const githubListReleasesAction = defineAction({
  id: 'github.list_releases',
  description: 'List releases in the configured repository.',
  access: 'read',
  inputSchema: GithubListReleasesInput,
  outputSchema: GithubListReleasesOutput,
  execute: ({ integration, input }) =>
    Effect.gen(function* () {
      const context = yield* resolveGithubContext(integration)

      const response = yield* githubRepoRequest(context, {
        method: 'GET',
        path: '/releases',
        query: githubPaginationQuery(input)
      })

      if (!isGithubSuccess(response.status)) {
        return yield* githubFailure(response, { operation: 'list releases' })
      }

      const releases = yield* decodeJsonResponse(GithubListReleasesResponse, response)

      return ActionResult.success(
        GithubListReleasesOutput.make({
          releases: releases.map(normalizeGithubRelease),
          hasNextPage: githubHasNextPage(response.headers)
        })
      )
    })
})

// ---------------------------------------------------------------------------
// get_file_contents
// ---------------------------------------------------------------------------

export const GithubGetFileContentsInput = Schema.Struct({
  path: Schema.String.check(Schema.isMinLength(1)),
  ref: Schema.optional(Schema.String.check(Schema.isMinLength(1)))
})

export type GithubGetFileContentsInput = typeof GithubGetFileContentsInput.Type

export const GithubGetFileContentsOutput = Schema.Struct({
  path: Schema.String,
  sha: Schema.String,
  size: Schema.Number,
  content: Schema.String,
  truncated: Schema.Boolean
})

export type GithubGetFileContentsOutput = typeof GithubGetFileContentsOutput.Type

const GithubContentDirectoryEntry = Schema.Struct({
  name: Schema.optional(Schema.String)
})

const GithubContentDirectory = Schema.Array(GithubContentDirectoryEntry)

const GithubContentFile = Schema.Struct({
  type: Schema.String,
  encoding: Schema.optional(Schema.String),
  size: Schema.optional(Schema.Number),
  name: Schema.optional(Schema.String),
  path: Schema.optional(Schema.String),
  sha: Schema.optional(Schema.String),
  content: Schema.optional(Schema.String)
})

const invalidContentPathChars = /[\u0000-\u001f\u007f\ud800-\udfff]/

const assertGithubContentPath = (path: string, integration: ConnectorIntegration) => {
  const segments = path.split('/')

  const invalid =
    path.length === 0 ||
    path.startsWith('/') ||
    path.includes('\\') ||
    invalidContentPathChars.test(path) ||
    segments.some(segment => segment === '' || segment === '.' || segment === '..')

  if (invalid) {
    return Effect.fail(
      new ConnectorError({
        cause: 'validation_failed',
        message:
          'GitHub get file contents requires path to be a relative file path without leading slashes, backslashes, control characters, or ./.. segments',
        connectorId: integration.connectorId,
        actionId: 'github.get_file_contents'
      })
    )
  }

  return Effect.void
}

const unsupportedContentFailure = (message: string) =>
  ActionResult.failure({ code: 'github_unsupported_content', message })

export const githubGetFileContentsAction = defineAction({
  id: 'github.get_file_contents',
  description:
    'Read a text file from the configured repository (contents API, so files over ~1 MB are rejected). Directories, symlinks, submodules, and binary files are not supported.',
  access: 'read',
  inputSchema: GithubGetFileContentsInput,
  outputSchema: GithubGetFileContentsOutput,
  execute: ({ integration, input }) =>
    Effect.gen(function* () {
      yield* assertGithubContentPath(input.path, integration)

      const context = yield* resolveGithubContext(integration)

      const encoded = input.path
        .split('/')
        .map(segment => encodeURIComponent(segment))
        .join('/')

      const response = yield* githubRepoRequest(context, {
        method: 'GET',
        path: `/contents/${encoded}`,
        query: { ref: input.ref }
      })

      if (!isGithubSuccess(response.status)) {
        return yield* githubFailure(response, { operation: 'get file contents' })
      }

      const directory = yield* decodeJsonResponse(GithubContentDirectory, response).pipe(
        Effect.option
      )

      if (Option.isSome(directory)) {
        const names = directory.value
          .flatMap(entry => (Predicate.isString(entry.name) ? [`'${entry.name}'`] : []))
          .slice(0, 50)

        return unsupportedContentFailure(
          `GitHub get file contents failed: '${input.path}' is a directory (${directory.value.length} entries): ${names.join(', ')}`
        )
      }

      const file = yield* decodeJsonResponse(GithubContentFile, response)

      if (file.type !== 'file') {
        return unsupportedContentFailure(
          `GitHub get file contents failed: '${input.path}' has unsupported content type '${file.type}' (only files are supported)`
        )
      }

      const content = file.content ?? ''

      if (file.encoding !== 'base64' || (content === '' && (file.size ?? 0) > 0)) {
        return unsupportedContentFailure(
          `GitHub get file contents failed: '${input.path}' is too large for the contents API (use the blob API for files over ~1 MB)`
        )
      }

      const bytes = yield* Effect.try({
        try: () => {
          const binary = atob(content.replace(/\s+/g, ''))
          const decoded = new Uint8Array(binary.length)

          for (let index = 0; index < binary.length; index += 1) {
            decoded[index] = binary.charCodeAt(index)
          }

          return decoded
        },
        catch: () => 'invalid-base64'
      }).pipe(Effect.option)

      if (Option.isNone(bytes) || bytes.value.includes(0)) {
        return unsupportedContentFailure(
          `GitHub get file contents failed: '${input.path}' is binary (NUL byte or invalid base64)`
        )
      }

      const text = yield* Effect.try({
        try: () => new TextDecoder('utf-8', { fatal: true }).decode(bytes.value),
        catch: () => 'invalid-utf8'
      }).pipe(Effect.option)

      if (Option.isNone(text)) {
        return unsupportedContentFailure(
          `GitHub get file contents failed: '${input.path}' is not valid UTF-8 text`
        )
      }

      const truncated = truncateGithubText(text.value, githubFileContentMaxChars)

      return ActionResult.success(
        GithubGetFileContentsOutput.make({
          path: file.path ?? input.path,
          sha: file.sha ?? '',
          size: file.size ?? 0,
          content: truncated.text,
          truncated: truncated.truncated
        })
      )
    })
})

// ---------------------------------------------------------------------------
// search_code
// ---------------------------------------------------------------------------

export const GithubSearchCodeInput = Schema.Struct({
  query: Schema.String.check(Schema.isMinLength(1)),
  ...githubPaginationFields
})

export type GithubSearchCodeInput = typeof GithubSearchCodeInput.Type

export const GithubSearchedCode = Schema.Struct({
  path: Schema.String,
  name: Schema.String,
  sha: Schema.String,
  url: Schema.String,
  fragments: Schema.Array(Schema.String),
  /** True when any fragment was cut to 500 chars or more than 3 fragments existed. */
  fragmentsTruncated: Schema.Boolean
})

export type GithubSearchedCode = typeof GithubSearchedCode.Type

export const GithubSearchCodeOutput = Schema.Struct({
  totalCount: Schema.Number,
  incompleteResults: Schema.Boolean,
  items: Schema.Array(GithubSearchedCode),
  hasNextPage: Schema.Boolean
})

export type GithubSearchCodeOutput = typeof GithubSearchCodeOutput.Type

const GithubCodeSearchItem = Schema.Struct({
  name: Schema.optional(Schema.String),
  path: Schema.optional(Schema.String),
  sha: Schema.optional(Schema.String),
  html_url: Schema.optional(Schema.String),
  repository: Schema.optional(Schema.Struct({ full_name: Schema.optional(Schema.String) })),
  text_matches: Schema.optional(
    Schema.Array(Schema.Struct({ fragment: Schema.optional(Schema.String) }))
  )
})

const GithubCodeSearchResponse = Schema.Struct({
  total_count: Schema.optional(Schema.Number),
  incomplete_results: Schema.optional(Schema.Boolean),
  items: Schema.optional(Schema.Array(GithubCodeSearchItem))
})

/** Code search accept header: includes `text_matches` fragments. */
const githubTextMatchAccept = 'application/vnd.github.text-match+json'

const assertUnscopedCodeQuery = (query: string, integration: ConnectorIntegration) => {
  const scoped = query.trim() === '' || githubHasScopeQualifier(query)

  if (scoped) {
    return Effect.fail(
      new ConnectorError({
        cause: 'validation_failed',
        message:
          'GitHub code search query must not be blank or contain repo:, org:, user:, or owner: qualifiers; search is scoped to the configured repository',
        connectorId: integration.connectorId,
        actionId: 'github.search_code'
      })
    )
  }

  return Effect.void
}

export const githubSearchCodeAction = defineAction({
  id: 'github.search_code',
  description:
    'Search code in the configured repository. Scope qualifiers (repo:, org:, user:, owner:) are rejected; the search is always scoped to the configured repository.',
  access: 'read',
  inputSchema: GithubSearchCodeInput,
  outputSchema: GithubSearchCodeOutput,
  execute: ({ integration, input }) =>
    Effect.gen(function* () {
      yield* assertUnscopedCodeQuery(input.query, integration)

      const context = yield* resolveGithubContext(integration)

      const response = yield* githubRequest(context.token, {
        method: 'GET',
        path: '/search/code',
        query: {
          q: `repo:${context.owner}/${context.repo} ${input.query}`,
          ...githubPaginationQuery(input)
        },
        accept: githubTextMatchAccept
      })

      if (!isGithubSuccess(response.status)) {
        return yield* githubFailure(response, { operation: 'search code' })
      }

      const result = yield* decodeJsonResponse(GithubCodeSearchResponse, response)

      const expected = `${context.owner}/${context.repo}`.toLowerCase()

      const items = (result.items ?? []).flatMap(item => {
        if (
          item.name === undefined ||
          item.path === undefined ||
          item.sha === undefined ||
          item.html_url === undefined ||
          item.repository?.full_name?.toLowerCase() !== expected
        ) {
          return []
        }

        const allFragments = (item.text_matches ?? []).flatMap(match =>
          Predicate.isString(match.fragment) ? [truncateGithubText(match.fragment, 500)] : []
        )

        const kept = allFragments.slice(0, 3)

        const fragments = kept.map(fragment => fragment.text)

        const fragmentsTruncated =
          allFragments.length > kept.length || kept.some(fragment => fragment.truncated)

        return [
          GithubSearchedCode.make({
            path: item.path,
            name: item.name,
            sha: item.sha,
            url: item.html_url,
            fragments,
            fragmentsTruncated
          })
        ]
      })

      return ActionResult.success(
        GithubSearchCodeOutput.make({
          totalCount: result.total_count ?? 0,
          incompleteResults: result.incomplete_results ?? false,
          items,
          hasNextPage: githubHasNextPage(response.headers)
        })
      )
    })
})

export const githubRepositoryActions = [
  githubCompareCommitsAction,
  githubListReleasesAction,
  githubGetFileContentsAction,
  githubSearchCodeAction
]
