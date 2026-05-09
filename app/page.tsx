import Link from 'next/link'

export default function Page() {
  return (
    <main className="mx-auto flex min-h-screen max-w-3xl flex-col justify-center gap-8 p-8">
      <div className="space-y-3">
        <p className="text-muted-foreground text-sm font-medium uppercase tracking-wide">Yolk</p>
        <h1 className="text-4xl font-semibold tracking-tight">Reusable agent stack</h1>
        <p className="text-muted-foreground text-lg">
          Next.js app shell with domain-free protocol, harness, runtime, and client packages.
        </p>
      </div>

      <Link
        href="/login"
        className="bg-primary text-primary-foreground w-fit rounded-md px-4 py-2 text-sm font-medium"
      >
        Sign in
      </Link>
    </main>
  )
}
