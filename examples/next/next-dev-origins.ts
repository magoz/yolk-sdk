import { getPortlessOrigin } from './portless-origin'

const localDevOrigins = ['yolk.localhost', '*.yolk.localhost', 'yolk-e2e.localhost']

export const getAllowedDevOrigins = (portlessUrl?: string): string[] => {
  if (portlessUrl === undefined) return [...localDevOrigins]

  const hostname = new URL(getPortlessOrigin(portlessUrl)).hostname
  return [...new Set([...localDevOrigins, hostname])]
}
