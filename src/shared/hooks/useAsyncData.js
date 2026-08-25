import { useCallback, useEffect, useRef, useState } from 'react';

/**
 * Fetch async data with loading/error state for screen loads.
 *
 * Runs `fn` (a function returning a Promise) on mount (unless
 * `options.immediate === false`) and whenever `deps` or the retry counter
 * change. Keeps previously-loaded data while refetching; exposes
 * `reload()` to re-run manually (e.g. Retry button, useFocusEffect).
 *
 * @template T
 * @param {() => Promise<T>} fn async loader
 * @param {Array} deps extra deps that should trigger a refetch
 * @param {{immediate?: boolean}} [options] set immediate:false when the
 *   first fetch is driven externally (e.g. useFocusEffect)
 * @returns {{data: T|null, loading: boolean, error: Error|null, reload: () => void}}
 */
export default function useAsyncData(fn, deps = [], options = {}) {
  const { immediate = true } = options;
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(immediate);
  const [error, setError] = useState(null);
  const [tick, setTick] = useState(0);
  const skippedFirstRun = useRef(!immediate);

  const reload = useCallback(() => {
    setTick((t) => t + 1);
  }, []);

  useEffect(() => {
    if (skippedFirstRun.current) {
      skippedFirstRun.current = false;
      return;
    }
    let mounted = true;
    setLoading(true);
    setError(null);
    fn()
      .then((result) => {
        if (!mounted) return;
        setData(result);
        setLoading(false);
      })
      .catch((e) => {
        console.warn('[useAsyncData] load failed:', e?.message || e);
        if (!mounted) return;
        setError(e);
        setLoading(false);
      });
    return () => {
      mounted = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, tick]);

  return { data, loading, error, reload };
}
