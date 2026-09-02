// usePagedList — offset pagination over the /gym list APIs (which return a
// plain array, no total). Fetches pageSize+1 rows so the UI knows whether a
// next page exists. Search is debounced; any filter change resets to page 0.
// A failed request never clears the previous rows — the error renders while
// the stale data stays out of the way.
import { useCallback, useEffect, useRef, useState } from 'react';
import { isNetworkError } from '../components/States';

export interface PagedList<T> {
  rows: T[];
  loading: boolean;
  error: any;
  networkError: boolean;
  reload: () => void;
  page: number;
  setPage: (p: number) => void;
  hasNext: boolean;
  q: string;
  setQ: (v: string) => void;
  status: string | undefined;
  setStatus: (v: string | undefined) => void;
  extra: Record<string, string | undefined>;
  setExtra: (patch: Record<string, string | undefined>) => void;
}

export function usePagedList<T>(
  fetcher: (params: {
    q?: string; status?: string; limit: number; offset: number;
  } & Record<string, any>) => Promise<T[]>,
  pageSize = 20
): PagedList<T> {
  const [qInput, setQInput] = useState('');
  const [q, setQ] = useState('');
  const [status, setStatusState] = useState<string | undefined>(undefined);
  const [extra, setExtraState] = useState<Record<string, string | undefined>>({});
  const [page, setPage] = useState(0);
  const [rows, setRows] = useState<T[]>([]);
  const [hasNext, setHasNext] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<any>(null);
  const [tick, setTick] = useState(0);

  // debounce search input → query
  const debounceRef = useRef<ReturnType<typeof setTimeout>>();
  useEffect(() => {
    debounceRef.current = setTimeout(() => {
      setQ(qInput.trim());
      setPage(0);
    }, 400);
    return () => clearTimeout(debounceRef.current);
  }, [qInput]);

  const setStatus = (v: string | undefined) => { setStatusState(v); setPage(0); };
  const setExtra = (patch: Record<string, string | undefined>) => {
    setExtraState((prev) => ({ ...prev, ...patch }));
    setPage(0);
  };

  const fetcherRef = useRef(fetcher);
  fetcherRef.current = fetcher;
  const extraKey = JSON.stringify(extra);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoading(true);
      setError(null);
      try {
        const data = await fetcherRef.current({
          q: q || undefined,
          status,
          ...JSON.parse(extraKey),
          limit: pageSize + 1,
          offset: page * pageSize,
        });
        if (cancelled) return;
        setRows(Array.isArray(data) ? data.slice(0, pageSize) : []);
        setHasNext(Array.isArray(data) && data.length > pageSize);
      } catch (e: any) {
        if (cancelled) return;
        setError(e);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [q, status, page, pageSize, tick, extraKey]);

  const reload = useCallback(() => setTick((t) => t + 1), []);

  return {
    rows, loading, error, networkError: isNetworkError(error), reload,
    page, setPage, hasNext, q: qInput, setQ: setQInput,
    status, setStatus, extra, setExtra,
  };
}
