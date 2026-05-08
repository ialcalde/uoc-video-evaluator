import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { runBatch } from '../src/batch.mjs';

const delay = ms => new Promise(r => setTimeout(r, ms));

describe('runBatch', () => {

  it('returns results in input order', async () => {
    const results = await runBatch([1, 2, 3, 4, 5], async n => n * 2, 3);
    assert.deepEqual(results, [2, 4, 6, 8, 10]);
  });

  it('processes all entries and returns the correct count', async () => {
    const results = await runBatch([10, 20, 30], async n => n + 1, 2);
    assert.equal(results.length, 3);
    assert.deepEqual(results, [11, 21, 31]);
  });

  it('returns an empty array for empty input', async () => {
    const results = await runBatch([], delay, 3);
    assert.deepEqual(results, []);
  });

  it('respects the concurrency limit', async () => {
    let active    = 0;
    let maxActive = 0;

    const entries = Array.from({ length: 9 }, (_, i) => i);
    await runBatch(entries, async () => {
      active++;
      maxActive = Math.max(maxActive, active);
      await delay(10);
      active--;
    }, 3);

    assert.equal(maxActive, 3, `max concurrent tasks should be 3, got ${maxActive}`);
  });

  it('does not exceed limit=1 (sequential)', async () => {
    let active    = 0;
    let maxActive = 0;
    const order   = [];

    await runBatch([30, 10, 20], async ms => {
      active++;
      maxActive = Math.max(maxActive, active);
      await delay(ms);
      order.push(ms);
      active--;
    }, 1);

    assert.equal(maxActive, 1, 'sequential: never more than 1 active task');
    assert.deepEqual(order, [30, 10, 20], 'sequential: preserves submission order');
  });

  it('propagates errors thrown by tasks', async () => {
    const entries = [1, 2, 3];
    await assert.rejects(
      () => runBatch(entries, async n => {
        if (n === 2) throw new Error('task 2 exploded');
        return n;
      }, 3),
      /task 2 exploded/
    );
  });

  it('uses concurrency equal to entry count when limit exceeds length', async () => {
    let maxActive = 0;
    let active    = 0;

    await runBatch([1, 2, 3], async () => {
      active++;
      maxActive = Math.max(maxActive, active);
      await delay(10);
      active--;
    }, 100);   // limit larger than array

    assert.equal(maxActive, 3, 'should cap workers at entry count');
  });

  it('returns results in input order even when tasks finish out-of-order', async () => {
    // Tasks take 30ms, 10ms, 20ms — they complete as 2, 3, 1 but must be returned as 1, 2, 3
    const completionOrder = [];
    const results = await runBatch(
      ['slow', 'fast', 'medium'],
      async (name) => {
        const delays = { slow: 30, fast: 10, medium: 20 };
        await delay(delays[name]);
        completionOrder.push(name);
        return `${name}-done`;
      },
      3,    // all run concurrently
    );

    assert.deepEqual(completionOrder, ['fast', 'medium', 'slow'], 'completion order should be by duration');
    assert.deepEqual(results, ['slow-done', 'fast-done', 'medium-done'], 'results must match input order');
  });

  it('passes the entry index as second argument to fn', async () => {
    const indices = [];
    await runBatch(['a', 'b', 'c'], async (entry, i) => { indices.push(i); }, 1);
    assert.deepEqual(indices, [0, 1, 2]);
  });

});
