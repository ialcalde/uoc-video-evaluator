import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, existsSync } from 'fs';
import { readFile } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';
import { Readable } from 'stream';
import { listVideos, downloadVideo } from '../src/drive.mjs';

// Build a minimal mock google.drive client.
function makeDrive({ files = [], streamChunks = [Buffer.from('data')] } = {}) {
  return {
    files: {
      list:  async ()       => ({ data: { files } }),
      get:   async ()       => ({ data: Readable.from(streamChunks) }),
    },
  };
}

describe('drive', () => {
  let tmpDir;

  before(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'uoc-drive-test-'));
  });

  after(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  // ── listVideos ──────────────────────────────────────────────────────────────

  it('listVideos: returns the files array from the API', async () => {
    const fakeFiles = [
      { id: 'abc', name: 'student1.mp4', size: '10000000' },
      { id: 'def', name: 'student2.mov', size: '8000000' },
    ];
    const drive = makeDrive({ files: fakeFiles });
    const result = await listVideos('folder123', drive);
    assert.deepEqual(result, fakeFiles);
  });

  it('listVideos: returns empty array when API returns no files key', async () => {
    const drive = { files: { list: async () => ({ data: {} }) } };
    const result = await listVideos('folder123', drive);
    assert.deepEqual(result, []);
  });

  it('listVideos: query includes the folder id and trashed=false', async () => {
    let capturedParams;
    const drive = {
      files: {
        list: async params => {
          capturedParams = params;
          return { data: { files: [] } };
        },
      },
    };
    await listVideos('my-folder-id', drive);
    assert.ok(capturedParams.q.includes('my-folder-id'), 'query should contain folder id');
    assert.ok(capturedParams.q.includes('trashed=false'),  'query should exclude trashed files');
  });

  // ── downloadVideo ───────────────────────────────────────────────────────────

  it('downloadVideo: writes stream data to destDir/fileName', async () => {
    const content = Buffer.from('fake video bytes');
    const drive   = makeDrive({ streamChunks: [content] });

    const destPath = await downloadVideo('file-id', 'video.mp4', tmpDir, drive);

    assert.ok(existsSync(destPath), 'file should exist after download');
    const written = await readFile(destPath);
    assert.ok(written.equals(content), 'file contents should match stream data');
  });

  it('downloadVideo: returns the full absolute path of the written file', async () => {
    const drive = makeDrive();
    const destPath = await downloadVideo('id', 'output.mp4', tmpDir, drive);
    assert.ok(destPath.startsWith(tmpDir),      'path should be inside destDir');
    assert.ok(destPath.endsWith('output.mp4'), 'path should end with fileName');
  });

  it('downloadVideo: calls onProgress with increasing byte counts', async () => {
    const chunks = [Buffer.from('hello'), Buffer.from(' world')];
    const drive  = makeDrive({ streamChunks: chunks });

    const progress = [];
    await downloadVideo('id', 'progress.mp4', tmpDir, drive, b => progress.push(b));

    assert.ok(progress.length >= 1, 'onProgress should be called at least once');
    assert.equal(
      progress[progress.length - 1],
      11,                         // 'hello' + ' world' = 11 bytes total
      'final progress value should equal total bytes'
    );
    for (let i = 1; i < progress.length; i++) {
      assert.ok(progress[i] >= progress[i - 1], 'progress values should be non-decreasing');
    }
  });

  it('downloadVideo: passes correct fileId and alt=media to the API', async () => {
    let capturedArgs;
    const drive = {
      files: {
        get: async (...args) => {
          capturedArgs = args;
          return { data: Readable.from([Buffer.from('x')]) };
        },
      },
    };
    await downloadVideo('my-file-id', 'test.mp4', tmpDir, drive);
    assert.equal(capturedArgs[0].fileId, 'my-file-id');
    assert.equal(capturedArgs[0].alt,    'media');
  });

  it('downloadVideo: rejects when the stream emits an error', async () => {
    const errStream = new Readable({
      read() { this.destroy(new Error('network failure')); },
    });
    const drive = { files: { get: async () => ({ data: errStream }) } };

    await assert.rejects(
      () => downloadVideo('id', 'err_test.mp4', tmpDir, drive),
      /network failure/
    );
  });

});
