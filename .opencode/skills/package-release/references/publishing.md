# Publishing

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

2. Remove `private: true` from public packages only:

```txt
packages/*/package.json
```

Keep private app packages private, especially `@yolk-sdk/cloudflare-agent`.

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
- `private: true` removed from public packages
- `publishConfig.access` is `public`
- `publishConfig.provenance` is `true`
- `files` includes `dist`, `src`, README, license as intended
- `publishConfig.exports` points to `dist`
- all runtime deps declared in package manifests

## Artifact validation

`pnpm packages:publint` checks package export health.

`pnpm packages:smoke` packs public packages, installs/extracts them in a temp fixture, and imports every public subpath.

If either fails, fix package exports/deps before publishing.

## CI automation model

Recommended later workflow:

- Trigger on push to `main`.
- Use `changesets/action`.
- `version`: `pnpm changeset:version && pnpm install --no-frozen-lockfile`.
- `publish`: validation + `pnpm release:canary` or stable publish script.
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
