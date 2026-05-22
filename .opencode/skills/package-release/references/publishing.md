# Publishing

## PR workflow

Feature PRs:

- Include code/docs/package changes.
- Add `.changeset/*.md` when public package behavior, API, runtime deps, exports, or release-facing docs change.
- Do not run `pnpm changeset:version` in feature PRs.

Release PRs:

- Start from `main` after feature PRs merge.
- Run `pnpm changeset:version` and `pnpm install`.
- Include only generated release files: package versions, changelogs, lockfile, and `.changeset/pre.json` changes.
- No feature code.
- Merge to `main`, then publish from `main` with trusted publishing.

After successful release prep:

- Inspect `git status`.
- List exact files that belong in the release PR.
- Propose a concise commit message.
- Ask before committing or pushing.
- Never include env files, generated `dist`, `.next`, `.turbo`, coverage, or unrelated local changes.

Release PR content should be mechanically reviewable: “these changesets became these versions/changelogs”.

## Manual canary flow

Use this for first canary or local release prep.

```bash
pnpm changeset:canary:enter
pnpm changeset:version
pnpm install
pnpm packages:build
pnpm packages:publint
pnpm packages:smoke
pnpm packages:check
pnpm cloudflare:check
pnpm tsc
pnpm lint
pnpm test:run
pnpm release:canary
```

Only run `pnpm release:canary` after explicit user approval.

## Actual npm push steps

1. Enter canary mode and version:

```bash
pnpm changeset:canary:enter
pnpm changeset:version
pnpm install
```

2. Verify public packages are publishable and private apps stay private, especially `@yolk-sdk/cloudflare-agent`.

3. Validate:

```bash
pnpm packages:build
pnpm packages:publint
pnpm packages:smoke
pnpm packages:check
pnpm cloudflare:check
pnpm tsc
pnpm lint
pnpm test:run
```

4. Publish:

```bash
pnpm release:canary
```

5. Verify:

```bash
npm view @yolk-sdk/agent version
npm view @yolk-sdk/agent dist-tags
```

Preconditions:

- `npm whoami` returns `magoz`.
- `npm org ls yolk-sdk` shows `magoz` as owner.
- publish target tag is `canary`.
- all public versions are lockstep.
- working tree state is understood.

## Public package gates

Before publish:

- public package names use `@yolk-sdk/*`
- versions are lockstep
- public `packages/*` are publishable; private apps stay private
- `publishConfig.access` is `public`
- `publishConfig.provenance` is `true`
- `files` includes `dist`, `src`, README, license as intended
- `publishConfig.exports` points to `dist`
- all runtime deps declared in package manifests

## Artifact validation

`pnpm packages:publint` checks package export health.

`pnpm packages:smoke` packs public packages, installs/extracts them in a temp fixture, and imports every public subpath.

If either fails, fix package exports/deps before publishing.

## Trusted publishing

Use `.github/workflows/publish.yml` for npm trusted publishing.

Configure each npm package trusted publisher:

- Provider: GitHub Actions
- Organization/user: `magoz`
- Repository: `yolk-sdk`
- Workflow filename: `publish.yml`
- Allowed action: `npm publish`

Workflow policy:

- Manual `workflow_dispatch` only.
- Uses `id-token: write` and npm OIDC auth.
- Installs/builds/tests with `pnpm`.
- Packs package artifacts with `pnpm pack`.
- Publishes tarballs with npm CLI, because npm trusted publishing is the supported OIDC path.

## CI automation model

Recommended later workflow:

- Trigger release PR on push to `main`.
- Use `changesets/action` for version PRs.
- `version`: `pnpm changeset:version && pnpm install --no-frozen-lockfile`.
- `publish`: validation + `.github/workflows/publish.yml`.
- Set `id-token: write` for npm trusted publishing/provenance.

Reference patterns:

- Effect: fixed group + `changesets/action` release PR/publish.
- MCP SDK: separate version/publish jobs + OIDC provenance.
- AI SDK: optional snapshot workflow.

## Post-publish checks

After publish:

```bash
npm view @yolk-sdk/agent version
npm view @yolk-sdk/agent dist-tags
```

Optionally run a clean external install fixture with `@canary`.

## Bad publish response

Never unpublish unless user explicitly asks and npm policy allows it.

Prefer:

- publish a fixed canary
- deprecate bad version with clear message
- update docs/changelog
