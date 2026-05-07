const RETRYABLE = new Set([429, 500, 502, 503, 504]);

/**
 * Call fn(), retrying with exponential back-off on retryable HTTP errors.
 *
 * @param {() => Promise<T>} fn
 * @param {{ maxRetries?: number, baseDelay?: number }} opts
 * @returns {Promise<T>}
 */
export async function withRetry(fn, { maxRetries = 4, baseDelay = 1_000 } = {}) {
  for (let attempt = 0; ; attempt++) {
    try {
      return await fn();
    } catch (err) {
      const status = err.status ?? err.statusCode;
      if (attempt >= maxRetries || !RETRYABLE.has(status)) throw err;
      await new Promise(r => setTimeout(r, baseDelay * 2 ** attempt + Math.random() * 200));
    }
  }
}
