const API_BASE_URL = import.meta.env.VITE_API_BASE_URL ?? 'http://localhost:4000';

export function apiUrl(path: string): string {
  return `${API_BASE_URL}${path}`;
}

export const TOKEN_KEY = 'mentat_fc_token';

// Read directly from localStorage rather than importing AuthContext here --
// this module is the lower layer both AuthContext and plain fetch calls
// build on, so it can't depend back on the context that depends on it.
function authHeader(): Record<string, string> {
  const token = localStorage.getItem(TOKEN_KEY);
  return token ? { Authorization: `Bearer ${token}` } : {};
}

// useFetch (GET-only) doesn't cover mutations -- a small helper for the
// POST/PATCH/DELETE calls the bets tracker needs, mirroring useFetch's own
// "read the backend's {error} body on failure" convention so error messages
// look the same whether they came from a query or a mutation. Attaches the
// stored auth token automatically, same as authedGet below.
export async function apiRequest<T>(path: string, options: { method: string; body?: unknown }): Promise<T> {
  const res = await fetch(apiUrl(path), {
    method: options.method,
    headers: { ...authHeader(), ...(options.body !== undefined ? { 'Content-Type': 'application/json' } : {}) },
    body: options.body !== undefined ? JSON.stringify(options.body) : undefined,
  });
  if (!res.ok) {
    const body = await res.json().catch(() => null);
    throw new Error(body?.error ?? `Request failed: ${res.status}`);
  }
  if (res.status === 204) return undefined as T;
  return res.json() as Promise<T>;
}

// A GET counterpart for pages (bets) that manage their own refetch cycle
// instead of using useFetch, but still need the auth header attached.
export async function authedGet<T>(path: string): Promise<T> {
  const res = await fetch(apiUrl(path), { headers: authHeader() });
  if (!res.ok) {
    const body = await res.json().catch(() => null);
    throw new Error(body?.error ?? `Request failed: ${res.status}`);
  }
  return res.json() as Promise<T>;
}
