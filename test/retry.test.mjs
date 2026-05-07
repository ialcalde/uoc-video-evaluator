import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { withRetry } from '../src/retry.mjs';

// baseDelay: 0 keeps tests fast (no real setTimeout waits)
const FAST = { baseDelay: 0 };

function apiError(status) {
  const err = new Error(`API Error ${status}`);
  err.status = status;
  return err;
}

describe('withRetry', () => {

  it('returns the result immediately on success', async () => {
    const result = await withRetry(() => Promise.resolve(42), FAST);
    assert.equal(result, 42);
  });

  it('retries on 429 and succeeds on the second attempt', async () => {
    let calls = 0;
    const result = await withRetry(() => {
      calls++;
      if (calls < 2) throw apiError(429);
      return Promise.resolve('ok');
    }, FAST);
    assert.equal(result, 'ok');
    assert.equal(calls, 2);
  });

  it('retries on 500 server error', async () => {
    let calls = 0;
    const result = await withRetry(() => {
      calls++;
      if (calls < 3) throw apiError(500);
      return Promise.resolve('recovered');
    }, FAST);
    assert.equal(result, 'recovered');
    assert.equal(calls, 3);
  });

  it('retries on 502, 503, 504', async () => {
    for (const status of [502, 503, 504]) {
      let calls = 0;
      const result = await withRetry(() => {
        calls++;
        if (calls === 1) throw apiError(status);
        return Promise.resolve(status);
      }, FAST);
      assert.equal(result, status);
      assert.equal(calls, 2);
    }
  });

  it('does not retry on 400 bad request', async () => {
    let calls = 0;
    await assert.rejects(
      () => withRetry(() => { calls++; throw apiError(400); }, FAST),
      /API Error 400/
    );
    assert.equal(calls, 1, 'should not retry a non-retryable error');
  });

  it('does not retry on 404', async () => {
    let calls = 0;
    await assert.rejects(
      () => withRetry(() => { calls++; throw apiError(404); }, FAST),
      /API Error 404/
    );
    assert.equal(calls, 1);
  });

  it('does not retry errors without a status property', async () => {
    let calls = 0;
    await assert.rejects(
      () => withRetry(() => { calls++; throw new Error('network error'); }, FAST),
      /network error/
    );
    assert.equal(calls, 1);
  });

  it('throws after maxRetries exhausted', async () => {
    let calls = 0;
    await assert.rejects(
      () => withRetry(() => { calls++; throw apiError(429); }, { maxRetries: 3, baseDelay: 0 }),
      /API Error 429/
    );
    assert.equal(calls, 4, '1 initial + 3 retries = 4 total');
  });

  it('calls onRetry callback with attempt, maxRetries, status, and delayMs', async () => {
    const events = [];
    let calls = 0;
    await withRetry(
      () => { calls++; if (calls < 3) throw apiError(429); return Promise.resolve('ok'); },
      { baseDelay: 0, onRetry: ev => events.push(ev) }
    );
    assert.equal(events.length, 2, 'two retries → two onRetry events');
    assert.equal(events[0].attempt,    1);
    assert.equal(events[0].maxRetries, 4);
    assert.equal(events[0].status,     429);
    assert.equal(typeof events[0].delayMs, 'number');
    assert.equal(events[1].attempt, 2);
  });

  it('does not require onRetry (omitting it is safe)', async () => {
    await assert.doesNotReject(
      () => withRetry(() => Promise.resolve('ok'))
    );
  });

  it('uses statusCode as fallback when status is absent', async () => {
    let calls = 0;
    const result = await withRetry(() => {
      calls++;
      if (calls < 2) {
        const err = new Error('rate limited');
        err.statusCode = 429;   // some SDKs use statusCode instead of status
        throw err;
      }
      return Promise.resolve('ok');
    }, FAST);
    assert.equal(result, 'ok');
    assert.equal(calls, 2);
  });

});
