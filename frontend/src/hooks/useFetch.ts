import { useEffect, useState } from 'react';

// Server state, not client state: this holds a copy of data the backend
// owns, with the concerns that come with that -- loading/error status, and
// guarding against a stale response landing after the URL has already
// changed (the `cancelled` flag below). Passing `null` skips fetching
// entirely, for the common "don't have an id yet" case.
interface FetchState<T> {
  data: T | null;
  error: Error | null;
  loading: boolean;
}

export function useFetch<T>(url: string | null): FetchState<T> {
  const [state, setState] = useState<FetchState<T>>({ data: null, error: null, loading: url !== null });

  useEffect(() => {
    if (!url) {
      setState({ data: null, error: null, loading: false });
      return;
    }

    let cancelled = false;
    setState({ data: null, error: null, loading: true });

    fetch(url)
      .then(async (res) => {
        if (!res.ok) {
          const body = await res.json().catch(() => null);
          throw new Error(body?.error ?? `Request failed: ${res.status}`);
        }
        return res.json() as Promise<T>;
      })
      .then((data) => {
        if (!cancelled) setState({ data, error: null, loading: false });
      })
      .catch((error: unknown) => {
        if (!cancelled) setState({ data: null, error: error instanceof Error ? error : new Error(String(error)), loading: false });
      });

    return () => {
      cancelled = true;
    };
  }, [url]);

  return state;
}
