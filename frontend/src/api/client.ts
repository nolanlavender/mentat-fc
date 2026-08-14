const API_BASE_URL = import.meta.env.VITE_API_BASE_URL ?? 'http://localhost:4000';

export function apiUrl(path: string): string {
  return `${API_BASE_URL}${path}`;
}

// useFetch (GET-only) doesn't cover mutations -- a small helper for the
// POST/PATCH/DELETE calls the bets tracker needs, mirroring useFetch's own
// "read the backend's {error} body on failure" convention so error messages
// look the same whether they came from a query or a mutation.
export async function apiRequest<T>(path: string, options: { method: string; body?: unknown }): Promise<T> {
  const res = await fetch(apiUrl(path), {
    method: options.method,
    headers: options.body !== undefined ? { 'Content-Type': 'application/json' } : undefined,
    body: options.body !== undefined ? JSON.stringify(options.body) : undefined,
  });
  if (!res.ok) {
    const body = await res.json().catch(() => null);
    throw new Error(body?.error ?? `Request failed: ${res.status}`);
  }
  if (res.status === 204) return undefined as T;
  return res.json() as Promise<T>;
}
