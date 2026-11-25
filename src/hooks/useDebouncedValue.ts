import { useEffect, useState } from 'react';

/**
 * Local zero-dependency debounce hook for instant in-memory / IndexedDB search inputs.
 * Immediately clears when the input becomes empty so pressing Clear (X) feels instantaneous.
 */
export function useDebouncedValue<T>(value: T, delayMs = 110): T {
  const [debounced, setDebounced] = useState<T>(value);

  useEffect(() => {
    if (delayMs <= 0 || value === '' || value === null || value === undefined) {
      setDebounced(value);
      return;
    }
    const timer = window.setTimeout(() => {
      setDebounced(value);
    }, delayMs);
    return () => window.clearTimeout(timer);
  }, [value, delayMs]);

  return debounced;
}
