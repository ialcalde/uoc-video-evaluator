import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, existsSync, writeFileSync } from 'fs';
import { readFile } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';
import { Readable } from 'stream';
import { listVideos, downloadVideo, createDriveClient, authorise } from '../src/drive.mjs';

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

  it('listVideos: follows nextPageToken to retrieve all pages', async () => {
    const page1 = [{ id: 'a', name: 'alice.mp4', size: '1' }];
    const page2 = [{ id: 'b', name: 'bob.mp4',   size: '2' }];
    let calls   = 0;

    const drive = {
      files: {
        list: async params => {
          calls++;
          if (calls === 1) {
            assert.ok(!params.pageToken, 'first call should not have pageToken');
            return { data: { files: page1, nextPageToken: 'token-abc' } };
          }
          assert.equal(params.pageToken, 'token-abc', 'second call should use nextPageToken');
          return { data: { files: page2 } };
        },
      },
    };

    const result = await listVideos('folder-id', drive);
    assert.equal(calls, 2, 'should make exactly two API calls');
    assert.equal(result.length, 2, 'should return files from both pages');
    assert.equal(result[0].name, 'alice.mp4');
    assert.equal(result[1].name, 'bob.mp4');
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

  it('downloadVideo: cleans up the partial file when stream errors', async () => {
    const destName  = 'cleanup_on_error.mp4';
    const destPath  = join(tmpDir, destName);
    const errStream = new Readable({
      read() { this.push(Buffer.from('partial')); this.destroy(new Error('mid-stream failure')); },
    });
    const drive = { files: { get: async () => ({ data: errStream }) } };

    await assert.rejects(
      () => downloadVideo('id', destName, tmpDir, drive),
      /mid-stream failure/
    );

    assert.ok(!existsSync(destPath), 'partial file should be deleted after stream error');
  });

  it('downloadVideo: rejects and cleans up when the destination pipe errors (ENOTDIR)', async () => {
    // Create a FILE at the would-be destDir path so that join(destDir, fileName)
    // points to an unwritable location — the stream open itself won't fail but the
    // pipe's write-stream emits an 'error' event, exercising lines 237-239.
    const badBase = mkdtempSync(join(tmpdir(), 'uoc-drive-notdir-'));
    const fakeDir = join(badBase, 'notadir.mp4');
    writeFileSync(fakeDir, 'I am a file');   // fakeDir is now a FILE, not a directory

    try {
      const okStream = Readable.from([Buffer.from('some video data')]);
      const drive = { files: { get: async () => ({ data: okStream }) } };

      // join(fakeDir, 'video.mp4') → ENOTDIR because fakeDir is a file
      await assert.rejects(
        () => downloadVideo('id', 'video.mp4', fakeDir, drive),
        /ENOTDIR|not a directory|EISDIR|is a directory/i
      );
    } finally {
      rmSync(badBase, { recursive: true, force: true });
    }
  });

  // ── createDriveClient ───────────────────────────────────────────────────────

  it('createDriveClient: returns an object with a files property', () => {
    // We can't call the real Google API in unit tests, but we can verify the
    // factory returns an object shaped like a Drive client.
    const fakeAuth = { credentials: {} };
    const client   = createDriveClient(fakeAuth);
    assert.ok(client,               'should return a client object');
    assert.ok(client.files,         'client should have a files namespace');
    assert.ok(client.files.list,    'client.files.list should be a function');
    assert.ok(client.files.get,     'client.files.get should be a function');
  });

  // ── authorise (saved-token path) ────────────────────────────────────────────
  // The interactive OAuth2 flow (waitForAuthCode / openBrowser) requires a real
  // browser and cannot be unit-tested. The saved-token path is testable: we write
  // a fake token file, point authorise() at it via the tokenPath option, and use
  // fake GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET env vars.

  it('authorise: throws when GOOGLE_CLIENT_ID is missing', async () => {
    const savedId     = process.env.GOOGLE_CLIENT_ID;
    const savedSecret = process.env.GOOGLE_CLIENT_SECRET;
    try {
      delete process.env.GOOGLE_CLIENT_ID;
      process.env.GOOGLE_CLIENT_SECRET = 'fake-secret';
      await assert.rejects(
        () => authorise({ info: () => {} }),
        /GOOGLE_CLIENT_ID|GOOGLE_CLIENT_SECRET/
      );
    } finally {
      if (savedId     === undefined) delete process.env.GOOGLE_CLIENT_ID;
      else process.env.GOOGLE_CLIENT_ID     = savedId;
      if (savedSecret === undefined) delete process.env.GOOGLE_CLIENT_SECRET;
      else process.env.GOOGLE_CLIENT_SECRET = savedSecret;
    }
  });

  it('authorise: returns an oauth2 client from a saved token file', async () => {
    const savedId     = process.env.GOOGLE_CLIENT_ID;
    const savedSecret = process.env.GOOGLE_CLIENT_SECRET;
    const tokenBase   = mkdtempSync(join(tmpdir(), 'uoc-drive-auth-'));
    const tokenPath   = join(tokenBase, 'token.json');
    try {
      process.env.GOOGLE_CLIENT_ID     = 'fake-client-id';
      process.env.GOOGLE_CLIENT_SECRET = 'fake-client-secret';

      const fakeToken = { access_token: 'fake-access', refresh_token: 'fake-refresh', expiry_date: 9999999999999 };
      writeFileSync(tokenPath, JSON.stringify(fakeToken), 'utf8');

      const logged = [];
      const result = await authorise({ info: msg => logged.push(msg) }, { tokenPath });

      assert.ok(result,                   'should return an oauth2 client');
      assert.ok(typeof result.on === 'function', 'client should be an EventEmitter');
      assert.ok(logged.some(m => m.includes('saved')), 'should log "Using saved OAuth2 token"');

      // Fire the 'tokens' event to exercise the auto-persist callback registered
      // inside authorise() — covers the lines that merge and re-write the token file.
      result.emit('tokens', { access_token: 'refreshed-token' });
      await new Promise(r => setImmediate(r));   // let the async callback flush

      const rewritten = JSON.parse(await readFile(tokenPath, 'utf8'));
      assert.equal(rewritten.access_token, 'refreshed-token', 'callback should persist the refreshed token');
    } finally {
      rmSync(tokenBase, { recursive: true, force: true });
      if (savedId     === undefined) delete process.env.GOOGLE_CLIENT_ID;
      else process.env.GOOGLE_CLIENT_ID     = savedId;
      if (savedSecret === undefined) delete process.env.GOOGLE_CLIENT_SECRET;
      else process.env.GOOGLE_CLIENT_SECRET = savedSecret;
    }
  });

});
