import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { collectLocalVideos, collectDriveVideos, VIDEO_EXTS } from '../src/source.mjs';

// Create an isolated temp dir for a single test, clean it up afterwards.
function withDir(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'uoc-source-test-'));
  try {
    return fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe('collectLocalVideos', () => {

  it('returns an empty array for an empty directory', () => {
    withDir(dir => {
      assert.deepEqual(collectLocalVideos(dir), []);
    });
  });

  it('discovers all five supported video extensions', () => {
    withDir(dir => {
      for (const ext of VIDEO_EXTS) {
        writeFileSync(join(dir, `student${ext}`), '');
      }
      const results = collectLocalVideos(dir);
      assert.equal(results.length, VIDEO_EXTS.size);
    });
  });

  it('ignores non-video files', () => {
    withDir(dir => {
      writeFileSync(join(dir, 'lecture.mp4'), '');
      writeFileSync(join(dir, 'notes.txt'), '');
      writeFileSync(join(dir, 'report.pdf'), '');
      writeFileSync(join(dir, 'image.jpg'), '');
      const results = collectLocalVideos(dir);
      assert.equal(results.length, 1);
    });
  });

  it('uses the filename without extension as the student name', () => {
    withDir(dir => {
      writeFileSync(join(dir, 'pau_garcia.mp4'), '');
      const [entry] = collectLocalVideos(dir);
      assert.equal(entry.student, 'pau_garcia');
    });
  });

  it('videoPath is the absolute path inside inputDir', () => {
    withDir(dir => {
      writeFileSync(join(dir, 'anna.mp4'), '');
      const [entry] = collectLocalVideos(dir);
      assert.ok(entry.videoPath.startsWith(dir));
      assert.ok(entry.videoPath.endsWith('anna.mp4'));
    });
  });

  it('sets cleanup to null for every entry', () => {
    withDir(dir => {
      writeFileSync(join(dir, 'a.mp4'), '');
      writeFileSync(join(dir, 'b.mov'), '');
      const results = collectLocalVideos(dir);
      assert.ok(results.every(r => r.cleanup === null), 'cleanup should be null for local files');
    });
  });

  it('returns entries sorted alphabetically by filename', () => {
    withDir(dir => {
      for (const name of ['charlie.mp4', 'alice.mp4', 'bob.mov']) {
        writeFileSync(join(dir, name), '');
      }
      const students = collectLocalVideos(dir).map(r => r.student);
      assert.deepEqual(students, ['alice', 'bob', 'charlie']);
    });
  });

  it('matches extensions case-insensitively', () => {
    withDir(dir => {
      writeFileSync(join(dir, 'upper.MP4'), '');
      writeFileSync(join(dir, 'mixed.Mov'), '');
      const results = collectLocalVideos(dir);
      assert.equal(results.length, 2, 'should accept uppercase/mixed-case extensions');
    });
  });

  it('VIDEO_EXTS contains the expected formats', () => {
    for (const ext of ['.mp4', '.mov', '.mkv', '.avi', '.webm']) {
      assert.ok(VIDEO_EXTS.has(ext), `expected ${ext} to be in VIDEO_EXTS`);
    }
  });

});

// ── helpers ──────────────────────────────────────────────────────────────────
const noop = async () => {};
const noLog = { info: () => {}, ok: () => {}, warn: () => {}, sep: () => {} };

describe('collectDriveVideos', () => {

  it('returns empty array when folder contains no videos', async () => {
    const tmp = mkdtempSync(join(tmpdir(), 'uoc-drive-src-'));
    try {
      const results = await collectDriveVideos('folder-id', {}, {
        tmpDir: tmp,
        log: noLog,
        listVideosFn: async () => [],
        downloadVideoFn: noop,
      });
      assert.deepEqual(results, []);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('returns one entry per file with correct shape', async () => {
    const tmp = mkdtempSync(join(tmpdir(), 'uoc-drive-src-'));
    try {
      const files = [
        { id: 'a1', name: 'alice.mp4', size: '1048576' },
        { id: 'b2', name: 'bob.mov',  size: '2097152' },
      ];
      const results = await collectDriveVideos('folder-id', {}, {
        tmpDir: tmp,
        log: noLog,
        listVideosFn: async () => files,
        downloadVideoFn: noop,
      });
      assert.equal(results.length, 2);
      assert.equal(results[0].student, 'alice');
      assert.ok(results[0].videoPath.endsWith('alice.mp4'));
      assert.ok(typeof results[0].cleanup === 'function');
      assert.equal(results[1].student, 'bob');
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('videoPath is inside tmpDir', async () => {
    const tmp = mkdtempSync(join(tmpdir(), 'uoc-drive-src-'));
    try {
      const results = await collectDriveVideos('folder-id', {}, {
        tmpDir: tmp,
        log: noLog,
        listVideosFn: async () => [{ id: 'x', name: 'test.mp4', size: '100' }],
        downloadVideoFn: noop,
      });
      assert.ok(results[0].videoPath.startsWith(tmp));
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('cleanup deletes the downloaded file', async () => {
    const tmp = mkdtempSync(join(tmpdir(), 'uoc-drive-src-'));
    try {
      const downloadFn = async (_id, name, dir) => {
        writeFileSync(join(dir, name), 'fake');
      };
      const results = await collectDriveVideos('folder-id', {}, {
        tmpDir: tmp,
        log: noLog,
        listVideosFn: async () => [{ id: 'x', name: 'vid.mp4', size: '100' }],
        downloadVideoFn: downloadFn,
      });
      assert.ok(existsSync(results[0].videoPath), 'file should exist before cleanup');
      await results[0].cleanup();
      assert.ok(!existsSync(results[0].videoPath), 'file should be gone after cleanup');
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('cleanup does not throw when file is already gone', async () => {
    const tmp = mkdtempSync(join(tmpdir(), 'uoc-drive-src-'));
    try {
      const results = await collectDriveVideos('folder-id', {}, {
        tmpDir: tmp,
        log: noLog,
        listVideosFn: async () => [{ id: 'x', name: 'vid.mp4', size: '100' }],
        downloadVideoFn: noop,
      });
      await assert.doesNotReject(() => results[0].cleanup());
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('passes the drive client to listVideosFn and downloadVideoFn', async () => {
    const tmp = mkdtempSync(join(tmpdir(), 'uoc-drive-src-'));
    const mockDrive = { tag: 'drive-client' };
    const received = [];
    try {
      await collectDriveVideos('folder-id', mockDrive, {
        tmpDir: tmp,
        log: noLog,
        listVideosFn: async (fId, drive) => { received.push(drive); return [{ id: 'x', name: 'v.mp4', size: '0' }]; },
        downloadVideoFn: async (_id, _name, _dir, drive) => { received.push(drive); },
      });
      assert.ok(received.length === 2 && received.every(d => d === mockDrive));
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('logs progress message when download crosses the 10 MB threshold', async () => {
    const tmp = mkdtempSync(join(tmpdir(), 'uoc-drive-src-'));
    const logged = [];
    const progressLog = { ...noLog, info: msg => logged.push(msg) };
    try {
      await collectDriveVideos('folder-id', {}, {
        tmpDir: tmp,
        log: progressLog,
        listVideosFn: async () => [{ id: 'x', name: 'big.mp4', size: '0' }],
        downloadVideoFn: async (_id, _name, _dir, _drive, onProgress) => {
          // Simulate progress: first call is below threshold, second crosses 10 MB
          onProgress?.(5 * 1_048_576);    // 5 MB — below 10 MB threshold, no log
          onProgress?.(11 * 1_048_576);   // 11 MB — above threshold, should log
        },
      });
      assert.ok(
        logged.some(m => m.includes('11 MB')),
        'should emit a progress log line after crossing 10 MB'
      );
      const progressLines = logged.filter(m => m.includes('MB received'));
      assert.equal(progressLines.length, 1, 'should log exactly once for a single 10 MB crossing');
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('handles missing file.size gracefully (size shown as ?)', async () => {
    const tmp = mkdtempSync(join(tmpdir(), 'uoc-drive-src-'));
    const logged = [];
    const testLog = { ...noLog, info: msg => logged.push(msg) };
    try {
      await collectDriveVideos('folder-id', {}, {
        tmpDir: tmp,
        log: testLog,
        listVideosFn: async () => [{ id: 'x', name: 'no-size.mp4' }],
        downloadVideoFn: noop,
      });
      assert.ok(logged.some(m => m.includes('? MB')), 'should show ? for unknown size');
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

});
