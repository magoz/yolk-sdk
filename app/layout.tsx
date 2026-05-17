import type { Metadata } from 'next'
import { NuqsAdapter } from 'nuqs/adapters/next/app'
import { Toaster } from 'sonner'
import './globals.css'
import { Inter } from 'next/font/google'
import { AppNav } from './app-nav'

const inter = Inter({ subsets: ['latin'], variable: '--font-sans' })

export const metadata: Metadata = {
  title: 'Yolk',
  description: 'Yolk'
}

export default function RootLayout({
  children
}: Readonly<{
  children: React.ReactNode
}>) {
  return (
    <html lang="en" className={inter.variable}>
      <body className="antialiased">
        <NuqsAdapter>
          <AppNav />
          {children}
        </NuqsAdapter>
        <Toaster />
      </body>
    </html>
  )
}
