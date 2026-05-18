'use client'

import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { cn } from '@/lib/utils'

const navItems = [
  { href: '/', label: 'Home' },
  { href: '/agent', label: 'Agent' },
  { href: '/agent/skills', label: 'Skills' },
  { href: '/storage', label: 'Storage' }
]

const hiddenPrefixes = ['/login', '/auth-error']

const isActive = (pathname: string, href: string) =>
  href === '/' ? pathname === href : pathname === href || pathname.startsWith(`${href}/`)

export function AppNav() {
  const pathname = usePathname()

  if (hiddenPrefixes.some(prefix => pathname.startsWith(prefix))) {
    return null
  }

  return (
    <header className="sticky top-0 z-10 border-b bg-background/95 backdrop-blur supports-[backdrop-filter]:bg-background/80">
      <nav className="mx-auto flex min-h-14 max-w-5xl items-center gap-4 px-4" aria-label="Main">
        <Link href="/" className="shrink-0 text-sm font-semibold tracking-tight">
          Yolk
        </Link>
        <div className="flex min-w-0 flex-1 gap-1 overflow-x-auto">
          {navItems.map(item => {
            const active = isActive(pathname, item.href)

            return (
              <Link
                key={item.href}
                href={item.href}
                aria-current={active ? 'page' : undefined}
                className={cn(
                  'inline-flex min-h-11 shrink-0 items-center rounded-md px-3 text-sm text-muted-foreground transition-[background-color,color] hover:bg-muted hover:text-foreground focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50',
                  active && 'bg-muted text-foreground'
                )}
              >
                {item.label}
              </Link>
            )
          })}
        </div>
      </nav>
    </header>
  )
}
