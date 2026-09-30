import type { WireFixture } from '@yolk-sdk/conformance/fixture'
import { githubJson, githubRequestHeaders, githubSyntheticRepoApi } from './synthetic.ts'

/** The seeded synthetic text file: more than 45 bytes, with non-ASCII characters. */
const text =
  'Synthetic conformance notes for the practice repository: café, naïve, façade.\nSecond synthetic line.\n'

const bytes = new TextEncoder().encode(text)

/** The base64 as GitHub answers it: folded every 60 characters, with a trailing line break. */
const folded = `${(btoa(String.fromCharCode(...bytes)).match(/.{1,60}/g) ?? []).join('\n')}\n`

const sha = '5f1c0ffee5f1c0ffee5f1c0ffee5f1c0ffee0001'

/**
 * `github.get_file_contents` of the seeded text file: the contents answer with its base64 folded
 * into lines.
 *
 * Synthetic placeholder (`evidence: 'unverified'`) until a live recording replaces it.
 * `pnpm conformance:github --live --owner-approved --account <label> --record` stages a
 * replacement in a gitignored directory; see the script header for the manual scrub-and-promote
 * step.
 */
export const githubFileContentsFixture: WireFixture = {
  id: 'github.contents.base64-file.synthetic',
  caseId: 'github.contents.base64-file',
  evidence: 'unverified',
  recordedAt: '2026-09-30',
  account: 'synthetic',
  endpoint: 'https://api.github.com',
  note: 'A small UTF-8 text file with non-ASCII characters, answered as folded base64. Synthetic placeholder shaped like the GitHub REST API; not recorded from a live service.',
  exchanges: [
    {
      request: {
        method: 'GET',
        url: `${githubSyntheticRepoApi}/contents/docs/synthetic-notes.txt`,
        headers: githubRequestHeaders
      },
      response: githubJson(200, {
        name: 'synthetic-notes.txt',
        path: 'docs/synthetic-notes.txt',
        sha,
        size: bytes.byteLength,
        url: `${githubSyntheticRepoApi}/contents/docs/synthetic-notes.txt?ref=main`,
        html_url:
          'https://github.com/yolk-synthetic/conformance-practice/blob/main/docs/synthetic-notes.txt',
        git_url: `${githubSyntheticRepoApi}/git/blobs/${sha}`,
        download_url:
          'https://raw.githubusercontent.com/yolk-synthetic/conformance-practice/main/docs/synthetic-notes.txt',
        type: 'file',
        content: folded,
        encoding: 'base64'
      })
    }
  ]
}
