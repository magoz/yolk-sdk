---
'@yolk-sdk/sandbox': minor
---

Use `@vercel/sandbox` 3.9.1 (was 2.2.1) and let the Vercel layer create sandboxes from a Vercel
Container Registry image: `makeVercelSandboxLayer({ sandboxSessionId, image })`, where `image` is
the project's own repository or one another team shares (`team/project/repo:tag`, `@sha256:…`).
The config takes `runtime` or `image`, never both; a snapshot source still boots its own
environment. `VercelSandboxCreateInput.runtime` becomes `environment`
(`VercelSandboxEnvironment.Runtime({ runtime })` or `.Image({ image })`), so custom
`VercelSandboxClient` implementations read it there. `persistent` is still passed explicitly, so
3.x's persistent-by-default does not apply.
