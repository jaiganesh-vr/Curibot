// The access token lives in sessionStorage: it survives a refresh but not
// closing the tab.
const TOKEN_KEY = "access_token";

export const SESSION_EXPIRED_NOTICE =
  "Your session has expired. Please sign in again.";

export function getStoredToken(): string | null {
  return sessionStorage.getItem(TOKEN_KEY);
}

export function storeToken(token: string) {
  sessionStorage.setItem(TOKEN_KEY, token);
}

export function clearStoredToken() {
  sessionStorage.removeItem(TOKEN_KEY);
}
