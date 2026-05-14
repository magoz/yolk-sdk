import Link from 'next/link'

type AgentCardProps = {
  eyebrow: string
  title: string
  description: string
  duties: ReadonlyArray<string>
  accentClassName: string
}

const agents: ReadonlyArray<AgentCardProps> = [
  {
    eyebrow: '01 · App agent',
    title: 'Policy boundary',
    description: 'Next owns who can run what, which model, which tools, and where truth persists.',
    duties: ['Auth + session', 'OAuth token refresh', 'Tool policy', 'Postgres transcript'],
    accentClassName: 'from-sky-400 to-cyan-200'
  },
  {
    eyebrow: '02 · Workflow agent',
    title: 'Durable runner',
    description: 'Vercel Workflows own long-running execution, resumable streams, and step replay.',
    duties: ['Start run', 'Step loop', 'Resume stream', 'Cancel run'],
    accentClassName: 'from-orange-400 to-amber-200'
  },
  {
    eyebrow: '03 · Package agent',
    title: 'Reusable kernel',
    description: 'Yolk packages stay domain-free: protocol, runtime contracts, loop, tools, client state.',
    duties: ['Protocol events', 'Agent loop', 'Runtime adapter', 'Client replay'],
    accentClassName: 'from-lime-300 to-emerald-300'
  }
]

const flow = [
  'Browser UI',
  'Next route',
  'Vercel Workflow',
  'Workflow step',
  'Yolk runtime',
  'Provider + tools'
]

export default function Page() {
  return (
    <main className="min-h-screen overflow-hidden bg-[#080806] text-stone-100">
      <section className="relative mx-auto flex min-h-screen w-full max-w-7xl flex-col px-5 py-6 sm:px-8 lg:px-10">
        <div className="pointer-events-none absolute inset-0 -z-0 bg-[radial-gradient(circle_at_20%_15%,rgba(56,189,248,0.22),transparent_28%),radial-gradient(circle_at_82%_22%,rgba(251,146,60,0.18),transparent_30%),radial-gradient(circle_at_55%_86%,rgba(132,204,22,0.18),transparent_34%)]" />
        <div className="pointer-events-none absolute inset-x-0 top-0 -z-0 h-24 bg-gradient-to-b from-white/10 to-transparent" />

        <nav className="relative z-10 flex items-center justify-between text-sm">
          <Link href="/" className="text-stone-400 transition-colors hover:text-stone-100">
            Yolk
          </Link>
          <Link
            href="/agent"
            className="rounded-full border border-white/15 px-4 py-2 text-stone-200 transition-colors hover:border-white/30 hover:bg-white/10"
          >
            Runtime chooser
          </Link>
        </nav>

        <div className="relative z-10 grid flex-1 items-center gap-10 py-16 lg:grid-cols-[0.9fr_1.1fr] lg:py-20">
          <div className="space-y-8">
            <div className="inline-flex rounded-full border border-white/15 bg-white/5 px-3 py-1 text-xs font-medium uppercase tracking-[0.24em] text-stone-300">
              Vercel Workflows
            </div>

            <div className="space-y-5">
              <h1 className="max-w-3xl text-5xl font-semibold tracking-[-0.06em] text-balance sm:text-7xl lg:text-8xl">
                Three agents. One durable turn.
              </h1>
              <p className="max-w-2xl text-lg leading-8 text-stone-300 sm:text-xl">
                A working split for Codex OAuth: keep product policy in Next, run long turns in
                Vercel Workflows, and let Yolk packages stay portable.
              </p>
            </div>

            <div className="grid max-w-xl grid-cols-3 overflow-hidden rounded-3xl border border-white/10 bg-white/[0.04] text-center shadow-2xl shadow-black/40">
              <Metric value="3" label="boundaries" />
              <Metric value="1" label="run id" />
              <Metric value="0" label="package leaks" />
            </div>
          </div>

          <div className="relative">
            <div className="absolute -inset-4 rounded-[2rem] border border-white/10 bg-white/[0.03] blur-xl" />
            <div className="relative grid gap-4 lg:grid-cols-3">
              {agents.map(agent => (
                <AgentCard key={agent.eyebrow} {...agent} />
              ))}
            </div>
          </div>
        </div>

        <section className="relative z-10 mb-10 rounded-[2rem] border border-white/10 bg-stone-950/70 p-5 shadow-2xl shadow-black/30 backdrop-blur sm:p-6">
          <div className="mb-5 flex flex-col gap-2 sm:flex-row sm:items-end sm:justify-between">
            <div>
              <p className="text-xs font-medium uppercase tracking-[0.22em] text-stone-500">
                Execution flow
              </p>
              <h2 className="mt-2 text-2xl font-semibold tracking-tight">Package as adapter, not app</h2>
            </div>
            <p className="max-w-xl text-sm leading-6 text-stone-400">
              Extract later: stream glue, status mapping, resume helpers. Keep directives, auth,
              tools, and token refresh in app code.
            </p>
          </div>

          <ol className="grid gap-2 md:grid-cols-6">
            {flow.map((item, index) => (
              <li key={item} className="group rounded-2xl border border-white/10 bg-white/[0.03] p-4">
                <span className="text-xs text-stone-500">0{index + 1}</span>
                <p className="mt-6 text-sm font-medium text-stone-100">{item}</p>
                <div className="mt-4 h-1 rounded-full bg-white/10">
                  <div className="h-full rounded-full bg-stone-100 transition-all group-hover:w-full" />
                </div>
              </li>
            ))}
          </ol>
        </section>
      </section>
    </main>
  )
}

function AgentCard({ eyebrow, title, description, duties, accentClassName }: AgentCardProps) {
  return (
    <article className="min-h-96 rounded-[1.75rem] border border-white/10 bg-stone-950/80 p-5 shadow-2xl shadow-black/30 backdrop-blur transition-transform hover:-translate-y-1">
      <div className={`mb-8 h-2 rounded-full bg-gradient-to-r ${accentClassName}`} />
      <p className="text-xs font-medium uppercase tracking-[0.22em] text-stone-500">{eyebrow}</p>
      <h2 className="mt-4 text-2xl font-semibold tracking-tight">{title}</h2>
      <p className="mt-3 min-h-24 text-sm leading-6 text-stone-400">{description}</p>
      <ul className="mt-8 space-y-2">
        {duties.map(duty => (
          <li key={duty} className="flex items-center gap-2 text-sm text-stone-300">
            <span className="size-1.5 rounded-full bg-stone-100" />
            {duty}
          </li>
        ))}
      </ul>
    </article>
  )
}

function Metric({ value, label }: { value: string; label: string }) {
  return (
    <div className="border-r border-white/10 p-4 last:border-r-0">
      <div className="text-3xl font-semibold tracking-tight">{value}</div>
      <div className="mt-1 text-xs uppercase tracking-[0.18em] text-stone-500">{label}</div>
    </div>
  )
}
