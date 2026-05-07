import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { collectLocalVideos, VIDEO_EXTS } from '../src/source.mjs';

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
