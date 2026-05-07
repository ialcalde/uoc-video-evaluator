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
});
