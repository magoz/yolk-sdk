# Init v4 Setup Plan

Handoff plan for applying `magoz/init` branch `v4` into this repo.

Historical plan. Do not use this as product architecture. Product/package architecture lives in `patterns/PACKAGE_ARCHITECTURE.md` and `packages/AGENTS.md`.

## Goal

Apply the init template to the current `yolk` repo, app at root, then add reusable package skeletons.

Inputs:

- Repo: `/Users/magoz/dev/repos/yolk`
- Template: `https://github.com/magoz/init`
- Branch: `v4`
- App location: root

## Constraints

- Preserve existing docs:
  - `patterns/PACKAGE_ARCHITECTURE.md`
  - `packages/AGENTS.md`
  - `COMPARISON.md`
  - `RESEARCH.md`
  - `INIT_V4_PLAN.md`
- Keep reusable packages domain-free.
- No users, teams, orgs, projects, billing, OAuth, knowledge-store specifics, or product permissions below app layer.
- Historical note: template initially avoided Turbo. Current repo uses pnpm workspaces plus `turbo.json`; see root `AGENTS.md`.

## Steps

### 1. Safety

Check current state:

```bash
git status --short --untracked-files=all
```

If docs have uncommitted changes, preserve them before copying template files.

### 2. Fetch template

Clone to temp:

```bash
git clone --depth 1 --branch v4 https://github.com/magoz/init /tmp/yolk-init-v4
```

Copy template contents into repo root. Do not blindly delete existing repo files.

### 3. Merge into root app

Root is the app shell.

Expected root after merge:

```txt
app/
lib/
public/
package.json
tsconfig.json
next.config.ts
pnpm-workspace.yaml
packages/
```

Set root `package.json` name to `yolk`.

### 4. Keep/remove template services

Keep whatever is needed for the Yolk app layer.

Likely keep:

- DB — app/auth/domain persistence
- Auth — app login/session
- Email — auth flows or notifications, if template needs it
- Telemetry — useful if already integrated cleanly

Likely remove/defer:

- S3 — use R2 later
- Telegram — optional
- Activity — remove if Telegram removed
- Template example domain code — remove

If uncertain, keep app-layer services rather than breaking template wiring. Reusable packages must not depend on them.

### 5. Add workspace packages

Create:

```txt
packages/
  protocol/
    package.json
    tsconfig.json
    src/index.ts
  agent-loop/
    package.json
    tsconfig.json
    src/index.ts
    test/
  agent-runtime/
    package.json
    tsconfig.json
    src/index.ts
    test/
  client/
    package.json
    tsconfig.json
    src/index.ts
```

Workspace config:

```yaml
packages:
  - 'packages/*'
```

### 6. Package dependency graph

Enforce:

```txt
@yolk-sdk/agent/protocol
@yolk-sdk/agent/loop    -> @yolk-sdk/agent/protocol, effect
@yolk-sdk/agent/runtime -> @yolk-sdk/agent/protocol, @yolk-sdk/agent/loop, effect
@yolk-sdk/agent/client        -> @yolk-sdk/agent/protocol
root app            -> any package
```

No reverse imports.

### 7. Scripts

Align with template conventions, but ensure root supports:

```json
{
  "dev": "next dev",
  "build": "pnpm -r build",
  "check": "pnpm -r check",
  "test": "pnpm -r test"
}
```

If template has richer scripts, preserve them and add package-recursive variants under clear names.

### 8. Install and verify

Run:

```bash
pnpm install
pnpm check
```

If full check fails due template/env setup, at minimum verify package typecheck/build scripts run for new packages.

### 9. Docs update

After setup, update docs if actual paths differ:

- `patterns/PACKAGE_ARCHITECTURE.md`
- `packages/AGENTS.md`
- `RESEARCH.md`

## First implementation after setup

Do not start with runtime. Build smallest vertical slice:

1. `@yolk-sdk/agent/protocol` message/event schemas
2. `@yolk-sdk/agent/loop` text-only loop
3. faux provider
4. one passing agent-loop test
5. runtime skeleton after loop works

## Done criteria

- Init v4 app applied at root.
- Existing docs preserved.
- `packages/*` skeleton exists.
- pnpm workspace resolves packages.
- Domain-free package boundary documented and intact.
