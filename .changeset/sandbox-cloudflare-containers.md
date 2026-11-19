---
'@yolk-sdk/sandbox': minor
---

Add `@yolk-sdk/sandbox/cloudflare`, a Cloudflare Containers backend for the `Sandbox` service.

- `CloudflareSandbox`: a Durable Object class the host Worker exports and binds (SQLite class, container application with the `durable_object` scheduling policy; one class can carry several images, keyed by image id in `ctx.container.images`). It is engine-only: image, resources, env, internet access, workspace root, source, and lifecycle arrive with every RPC from the layer. Subclasses can override `containerStarted()` to act on each new container (for example to intercept its outbound HTTP).
- `makeCloudflareSandboxLayer({ sandboxSessionId, namespace, image, resources?, diskMb?, lifecycle?, source?, env?, internet?, workspaceRoot?, maxOutputBytes? })` provides `Sandbox` (`run`, `writeFile`, `readFile`, `currentState`, `delete`) over a host `SandboxStateStore`. The object is named `makeSandboxName(sandboxSessionId)`; `vcpus` map to `vcpu` with 2 GiB memory each, disk defaults to 16384 MB, the workspace to `/workspace`.
- Config `env` is set on the container and on every command: `exec` does not see the image's Dockerfile `ENV`.
- The workspace lives only while the container runs. Each start has a boot id; a call answered by another boot reports `workspaceReset: true`. Disposable lifecycles are enforced by the object's alarm (idle TTL, max lifetime); persistent ones stop when idle and do not keep files (no snapshots in this adapter).
- Sources: empty, Git (cloned in the container; credentials only in that process's environment), and `.tar.gz` tarballs (downloaded by the object). No snapshot source, no preview URLs (`previewUrls` is `[]`), and no allow/deny network policy: `internet: false` turns outbound internet off.
- Timeouts SIGKILL the command and, best effort, its process tree; each stream keeps its first `maxOutputBytes` (default 1 MiB). Background commands detach in the container and return a `backgroundId` while they run.

Core changes (breaking for exhaustive consumers): `SandboxState` gains `CloudflareSandboxState` (`_tag: 'Cloudflare'`, with `bootId`), so exhaustive matches over `SandboxState` need a `Cloudflare` case; `SandboxProviderError.provider` is now `'vercel' | 'cloudflare'`; the `sandbox` tool's `SandboxToolOutput.state` is a union of the two state shapes. Also new: `makeSandboxName` (what `makeVercelSandboxName` now aliases), `touchSandboxState` keeps the state's variant, and `sandboxStateDecision` takes an optional `provider` (stored state of another provider recreates with reason `provider_mismatch`; the Vercel layer passes it).
