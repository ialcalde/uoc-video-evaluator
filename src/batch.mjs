/**
 * Process an array of entries with a bounded worker-pool concurrency.
 *
 * Creates `min(limit, entries.length)` workers that pull from a shared index.
 * Results are returned in the same order as `entries`.
 *
 * Errors thrown by `fn` propagate through Promise.all — wrap individual tasks
 * in try/catch if you want the batch to continue on failure.
 *
 * @param {Array}    entries  Items to process.
 * @param {Function} fn       async (entry, index) => result
 * @param {number}   limit    Max concurrent tasks (default 3).
 * @returns {Promise<Array>}  Results in input order.
 */
export async function runBatch(entries, fn, limit = 3) {
  if (entries.length === 0) return [];

  const results = new Array(entries.length);
  let next = 0;

  async function worker() {
    while (next < entries.length) {
      const i = next++;
      results[i] = await fn(entries[i], i);
    }
  }

  await Promise.all(
    Array.from({ length: Math.min(limit, entries.length) }, worker)
  );

  return results;
}
