import Link from 'next/link'

export default function Page() {
  return (
    <main className="mx-auto flex min-h-screen max-w-3xl flex-col justify-center gap-8 p-8">
      <div className="space-y-3">
        <p className="text-sm font-medium uppercase tracking-wide text-muted-foreground">
          Agent runtime
        </p>
        <h1 className="text-4xl font-semibold tracking-tight">Choose where text runs</h1>
        <p className="text-lg text-muted-foreground">
          Same chat UI and voice option. Runtime only changes text transport/session semantics.
        </p>
      </div>

      <div className="grid gap-3 sm:grid-cols-2">
        <Link href="/agent/next" className="rounded-2xl border border-foreground/10 bg-card p-5">
          <h2 className="font-medium">Next runtime</h2>
          <p className="mt-2 text-sm text-muted-foreground">
            /api/agent, stateless transcript per turn.
          </p>
        </Link>
        <Link
          href="/agent/cloudflare"
          className="rounded-2xl border border-foreground/10 bg-card p-5"
        >
          <h2 className="font-medium">Cloudflare runtime</h2>
          <p className="mt-2 text-sm text-muted-foreground">
            Worker + Durable Object, WebSocket, append-log storage.
          </p>
        </Link>
      </div>
    </main>
  )
}
