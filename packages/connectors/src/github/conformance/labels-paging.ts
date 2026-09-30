import type { WireFixture } from '@yolk-sdk/conformance/fixture'
import {
  githubJson,
  githubRequestHeaders,
  githubSyntheticLabel,
  githubSyntheticUrl
} from './synthetic.ts'

const labelsPath = '/repos/yolk-synthetic/conformance-practice/labels'

/** The `Link` header GitHub answers for page `page` of 3 (`per_page=2`). */
const link = (page: number) => {
  const target = (to: number) =>
    `<https://api.github.com/repositories/100000001/labels?per_page=2&page=${to}>`

  const relations = [
    page > 1 ? `${target(page - 1)}; rel="prev"` : undefined,
    page < 3 ? `${target(page + 1)}; rel="next"` : undefined,
    page < 3 ? `${target(3)}; rel="last"` : undefined,
    page > 1 ? `${target(1)}; rel="first"` : undefined
  ]

  return relations.filter(relation => relation !== undefined).join(', ')
}

const page = (number: number, labels: ReadonlyArray<ReturnType<typeof githubSyntheticLabel>>) => ({
  request: {
    method: 'GET',
    url: githubSyntheticUrl(
      labelsPath,
      number === 1 ? { per_page: '2' } : { per_page: '2', page: String(number) }
    ),
    headers: githubRequestHeaders
  },
  response: githubJson(200, labels, { link: link(number) })
})

/**
 * Three `per_page=2` pages of the practice repository's labels, each with its `Link` header (the
 * last without `rel="next"`), then the empty page after the last.
 *
 * Synthetic placeholder (`evidence: 'unverified'`) until a live recording replaces it.
 * `pnpm conformance:github --live --owner-approved --account <label> --record` stages a
 * replacement in a gitignored directory; see the script header for the manual scrub-and-promote
 * step.
 */
export const githubLabelsPagingFixture: WireFixture = {
  id: 'github.labels.list-link-paging.synthetic',
  caseId: 'github.labels.list-link-paging',
  evidence: 'unverified',
  recordedAt: '2026-09-30',
  account: 'synthetic',
  endpoint: 'https://api.github.com',
  note: 'Three label pages (five labels, per_page 2) with Link headers, the last without rel="next", then an empty fourth page. Synthetic placeholder shaped like the GitHub REST API; not recorded from a live service.',
  exchanges: [
    page(1, [
      githubSyntheticLabel(700000001, 'bug', 'd73a4a'),
      githubSyntheticLabel(700000002, 'documentation', '0075ca')
    ]),
    page(2, [
      githubSyntheticLabel(700000003, 'enhancement', 'a2eeef'),
      githubSyntheticLabel(700000004, 'question', 'd876e3')
    ]),
    page(3, [githubSyntheticLabel(700000005, 'synthetic-conformance', 'ededed')]),
    {
      request: {
        method: 'GET',
        url: githubSyntheticUrl(labelsPath, { per_page: '2', page: '4' }),
        headers: githubRequestHeaders
      },
      response: githubJson(200, [], {
        link: '<https://api.github.com/repositories/100000001/labels?per_page=2&page=3>; rel="prev", <https://api.github.com/repositories/100000001/labels?per_page=2&page=3>; rel="last", <https://api.github.com/repositories/100000001/labels?per_page=2&page=1>; rel="first"'
      })
    }
  ]
}
