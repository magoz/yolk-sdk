import { describe, expect, it } from '@effect/vitest'
import {
  CheckVerdict,
  checkVerdict,
  CoverageDrift,
  coverageDrift,
  manifestProblems,
  sha256,
  syncedManifestText,
  type ModelManifest
} from '../formal-model-manifest.ts'

const manifest: ModelManifest = {
  spec: 'Claim.tla',
  promise: 'A claim is taken at most once.',
  covers: [{ path: 'packages/agent/src/claims.ts', sha256: sha256('claim code') }],
  checks: [{ config: 'Claim.cfg' }, { config: 'ClaimUnfenced.cfg', violates: 'AtMostOnce' }]
}

describe('manifestProblems', () => {
  it('accepts a model with a configuration that must pass and one that must fail', () => {
    expect(manifestProblems(manifest)).toEqual([])
  })

  it('refuses a model that was never shown to fail, or never to pass', () => {
    expect(manifestProblems({ ...manifest, checks: [{ config: 'Claim.cfg' }] })).toEqual([
      'no configuration that must fail (a check never seen failing proves nothing)'
    ])
    expect(
      manifestProblems({ ...manifest, checks: [{ config: 'X.cfg', violates: 'AtMostOnce' }] })
    ).toEqual(['no configuration that must pass'])
  })

  it('refuses an empty promise and a model that covers no code', () => {
    expect(manifestProblems({ ...manifest, promise: '  ', covers: [] })).toEqual([
      'the promise is empty',
      'covers no code'
    ])
  })

  it('refuses a covered file listed twice', () => {
    expect(
      manifestProblems({ ...manifest, covers: [...manifest.covers, ...manifest.covers] })
    ).toEqual(['covered path `packages/agent/src/claims.ts` is listed twice'])
  })

  it('refuses paths that leave the repository or the manifest folder', () => {
    expect(
      manifestProblems({
        ...manifest,
        spec: '../Claim.tla',
        covers: [{ path: '../secrets.ts', sha256: '' }],
        checks: [{ config: 'Claim.cfg' }, { config: 'a/Claim.cfg', violates: 'AtMostOnce' }]
      })
    ).toEqual([
      'spec `../Claim.tla` is not a file name',
      'covered path `../secrets.ts` is not repository-relative',
      'config `a/Claim.cfg` is not a file name'
    ])
  })
})

describe('checkVerdict', () => {
  it('matches a pass, and only the declared violation', () => {
    expect(checkVerdict({ config: 'Claim.cfg' }, { status: 'ok', distinct: 12 })).toEqual(
      CheckVerdict.Matched({ config: 'Claim.cfg', violates: undefined, states: 12 })
    )
    expect(
      checkVerdict(
        { config: 'ClaimUnfenced.cfg', violates: 'AtMostOnce' },
        { status: 'invariant', name: 'AtMostOnce', distinct: 7 }
      )
    ).toEqual(
      CheckVerdict.Matched({ config: 'ClaimUnfenced.cfg', violates: 'AtMostOnce', states: 7 })
    )
  })

  it('reports a violation where a pass is declared, another violation, or a broken model', () => {
    expect(
      checkVerdict({ config: 'Claim.cfg' }, { status: 'invariant', name: 'AtMostOnce' })
    ).toEqual(
      CheckVerdict.Unexpected({
        config: 'Claim.cfg',
        message: 'must pass, got invariant: AtMostOnce'
      })
    )
    expect(
      checkVerdict(
        { config: 'ClaimUnfenced.cfg', violates: 'AtMostOnce' },
        { status: 'invariant', name: 'TypeOK' }
      )
    ).toEqual(
      CheckVerdict.Unexpected({
        config: 'ClaimUnfenced.cfg',
        message: 'must violate AtMostOnce, got invariant: TypeOK'
      })
    )
    expect(
      checkVerdict(
        { config: 'ClaimUnfenced.cfg', violates: 'AtMostOnce' },
        { status: 'ok', distinct: 3 }
      )
    ).toEqual(
      CheckVerdict.Unexpected({
        config: 'ClaimUnfenced.cfg',
        message: 'must violate AtMostOnce, got ok'
      })
    )
    expect(
      checkVerdict({ config: 'Claim.cfg' }, { status: 'setup-error', message: 'parse failed' })
    ).toEqual(
      CheckVerdict.Unexpected({
        config: 'Claim.cfg',
        message: 'must pass, got setup-error: parse failed'
      })
    )
  })
})

describe('coverageDrift', () => {
  const path = 'packages/agent/src/claims.ts'

  it('reports covered files that changed or disappeared since the model was confirmed', () => {
    expect(coverageDrift(manifest, [{ path, text: 'claim code' }])).toEqual([])
    expect(coverageDrift(manifest, [{ path, text: 'claim code 2' }])).toEqual([
      CoverageDrift.Changed({
        path,
        recorded: sha256('claim code'),
        current: sha256('claim code 2')
      })
    ])
    expect(coverageDrift(manifest, [{ path, text: undefined }])).toEqual([
      CoverageDrift.Missing({ path })
    ])
  })
})

describe('syncedManifestText', () => {
  const text = JSON.stringify(manifest, null, 2)

  it('replaces only the changed hash, keeping the rest of the file', () => {
    const synced = syncedManifestText(text, [
      CoverageDrift.Changed({
        path: 'packages/agent/src/claims.ts',
        recorded: sha256('claim code'),
        current: sha256('claim code 2')
      })
    ])

    expect(synced).toBe(text.replace(sha256('claim code'), sha256('claim code 2')))
  })

  it('updates the changed file by path when two files had the same content', () => {
    const shared = JSON.stringify({
      ...manifest,
      covers: [
        { path: 'packages/a.ts', sha256: sha256('same') },
        { path: 'packages/b.ts', sha256: sha256('same') }
      ]
    })

    const synced = syncedManifestText(shared, [
      CoverageDrift.Changed({ path: 'packages/b.ts', recorded: sha256('same'), current: 'new' })
    ])

    expect(synced).toBe(
      JSON.stringify({
        ...manifest,
        covers: [
          { path: 'packages/a.ts', sha256: sha256('same') },
          { path: 'packages/b.ts', sha256: 'new' }
        ]
      })
    )
  })

  it('refuses when a covered file is gone or its entry is not written path first', () => {
    expect(
      syncedManifestText(text, [CoverageDrift.Missing({ path: 'packages/agent/src/claims.ts' })])
    ).toBeUndefined()
    expect(
      syncedManifestText(
        JSON.stringify({
          covers: [{ sha256: sha256('claim code'), path: 'packages/agent/src/claims.ts' }]
        }),
        [
          CoverageDrift.Changed({
            path: 'packages/agent/src/claims.ts',
            recorded: sha256('claim code'),
            current: 'new'
          })
        ]
      )
    ).toBeUndefined()
  })
})
