const API_URL = process.env.NEXT_PUBLIC_API_URL ?? '';
const COOKIE_NAME = 'opencrust_session';

/** Read the session token from the opencrust_session cookie (client-side) */
export function getSessionToken(): string | null {
  if (typeof document === 'undefined') return null;
  const match = document.cookie.match(new RegExp(`(?:^|;\\s*)${COOKIE_NAME}=([^;]*)`));
  return match ? decodeURIComponent(match[1]) : null;
}

/** Check whether a session token exists */
export function isAuthenticated(): boolean {
  return getSessionToken() !== null;
}

/** Return the Worker's /auth/login URL */
export function getLoginUrl(): string {
  return `${API_URL}/auth/login`;
}

/** Return the Worker's /auth/logout URL */
export function getLogoutUrl(): string {
  return `${API_URL}/auth/logout`;
}
