const RETRYABLE = new Set([429, 500, 502, 503, 504]);

/**
 * Call fn(), retrying with exponential back-off on retryable HTTP errors.
 *
 * @param {() => Promise<T>} fn
 * @param {{ maxRetries?: number, baseDelay?: number,
 *           onRetry?: ({attempt, maxRetries, status, delayMs}) => void }} opts
 * @returns {Promise<T>}
 */
export async function withRetry(fn, { maxRetries = 4, baseDelay = 1_000, onRetry } = {}) {
  for (let attempt = 0; ; attempt++) {
    try {
      return await fn();
    } catch (err) {
      const status = err.status ?? err.statusCode;
      if (attempt >= maxRetries || !RETRYABLE.has(status)) throw err;
      const jitter  = baseDelay > 0 ? Math.floor(Math.random() * 200) : 0;
      const delayMs = baseDelay * 2 ** attempt + jitter;
      onRetry?.({ attempt: attempt + 1, maxRetries, status, delayMs });
      await new Promise(r => setTimeout(r, delayMs));
    }
  }
}
