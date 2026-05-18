export const authSessionCookieName = (url: URL) =>
  url.protocol === 'https:' ? '__Secure-better-auth.session_token' : 'better-auth.session_token'
