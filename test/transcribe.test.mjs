import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, mkdtempSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { transcribe } from '../src/transcribe.mjs';

// Create a real temp file once for the whole module.
// It must outlive all async file-open operations that createReadStream schedules,
// so we clean it up on process exit rather than in an after() hook.
const _tmpDir    = mkdtempSync(join(tmpdir(), 'uoc-transcribe-test-'));
const _audioPath = join(_tmpDir, 'silence.mp3');
writeFileSync(_audioPath, Buffer.alloc(128));   // minimal valid file
process.on('exit', () => rmSync(_tmpDir, { recursive: true, force: true }));

function makeOpenAI(response) {
  let capturedParams;
  return {
    client: {
      audio: {
        transcriptions: {
          create: async params => {
            capturedParams = params;
            return response;
          },
        },
      },
    },
    getParams: () => capturedParams,
  };
}

describe('transcribe', () => {

  it('uses whisper-1 and forces language to "ca"', async () => {
    const { client, getParams } = makeOpenAI({ text: 'Hola món', segments: [] });
    await transcribe(_audioPath, client);

    const params = getParams();
    assert.equal(params.model,    'whisper-1');
    assert.equal(params.language, 'ca');
  });

  it('requests verbose_json with segment timestamps', async () => {
    const { client, getParams } = makeOpenAI({ text: 'Test', segments: [] });
    await transcribe(_audioPath, client);

    const params = getParams();
    assert.equal(params.response_format, 'verbose_json');
    assert.deepEqual(params.timestamp_granularities, ['segment']);
  });

  it('uses the provided language option', async () => {
    const { client, getParams } = makeOpenAI({ text: 'Hello', segments: [] });
    await transcribe(_audioPath, client, { language: 'en' });
    assert.equal(getParams().language, 'en');
  });

  it('returns the response object from the API', async () => {
    const expected = {
      text:     'Avui presentaré el projecte.',
      segments: [{ start: 0, end: 2 }],
    };
    const { client } = makeOpenAI(expected);

    const result = await transcribe(_audioPath, client);
    assert.equal(result.text, expected.text);
    assert.equal(result.segments.length, 1);
  });

  // ── Retry behaviour ────────────────────────────────────────────────────────

  it('retries on a 429 and succeeds on the second attempt', async () => {
    let calls = 0;
    const successResponse = { text: 'Hola', segments: [] };
    const client = {
      audio: {
        transcriptions: {
          create: async () => {
            calls++;
            if (calls === 1) { const e = new Error('rate limited'); e.status = 429; throw e; }
            return successResponse;
          },
        },
      },
    };

    const retries = [];
    const result = await transcribe(_audioPath, client, {
      baseDelay: 0,
      onRetry: info => retries.push(info),
    });

    assert.equal(calls, 2, 'should call Whisper twice');
    assert.equal(retries.length, 1, 'onRetry should be called once');
    assert.equal(retries[0].status, 429);
    assert.equal(result.text, 'Hola');
  });

  it('propagates non-retryable errors immediately', async () => {
    const client = {
      audio: {
        transcriptions: {
          create: async () => { const e = new Error('bad request'); e.status = 400; throw e; },
        },
      },
    };

    await assert.rejects(
      () => transcribe(_audioPath, client, { baseDelay: 0 }),
      { message: 'bad request' }
    );
  });

  it('invokes onRetry with attempt, maxRetries, status, and delayMs', async () => {
    let calls = 0;
    const client = {
      audio: {
        transcriptions: {
          create: async () => {
            calls++;
            if (calls < 3) { const e = new Error('server error'); e.status = 503; throw e; }
            return { text: 'ok', segments: [] };
          },
        },
      },
    };

    const retries = [];
    await transcribe(_audioPath, client, {
      baseDelay: 0,
      onRetry: info => retries.push({ ...info }),
    });

    assert.equal(retries.length, 2);
    assert.equal(retries[0].attempt, 1);
    assert.equal(retries[0].status, 503);
    assert.ok(typeof retries[0].delayMs === 'number', 'delayMs should be a number');
    assert.equal(retries[1].attempt, 2);
  });
});
