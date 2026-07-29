const API_BASE_URL = import.meta.env.VITE_API_BASE_URL ?? 'http://localhost:4000';

export function apiUrl(path: string): string {
  return `${API_BASE_URL}${path}`;
}
