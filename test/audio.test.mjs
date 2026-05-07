/**
 * Tests for src/audio.mjs
 *
 * The "happy path" (successful extraction) requires a real ffmpeg binary
 * and is skipped automatically when it is not installed.
 *
 * The error cases are verified against the rejection messages.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { execSync } from 'child_process';
import { writeFileSync, mkdtempSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { extractAudio } from '../src/audio.mjs';

// Detect ffmpeg once for the whole suite
const FFMPEG_AVAILABLE = (() => {
  try { execSync('ffmpeg -version', { stdio: 'ignore' }); return true; }
  catch { return false; }
})();

describe('extractAudio', () => {

  // ── Error: ffmpeg not in PATH ────────────────────────────────────────────────
  // We can only test this when ffmpeg IS available by temporarily patching
  // PATH, which is fragile. Instead we verify the error-path message indirectly
  // via the non-zero-exit-code test below, which exercises the same error branch.

  // ── Error: ffmpeg exits non-zero (invalid input file) ───────────────────────
  it('rejects with a message containing "ffmpeg" when the input file is invalid', async () => {
    if (!FFMPEG_AVAILABLE) {
      // Verify the rejection when the binary is missing instead
      const err = await extractAudio('/nonexistent/video.mp4', '/tmp/out.mp3').catch(e => e);
      assert.ok(err instanceof Error);
      assert.match(err.message, /ffmpeg/i);
      return;
    }

    const tmp = mkdtempSync(join(tmpdir(), 'uoc-audio-test-'));
    try {
      // Create a dummy file that is not a valid video
      const fakePath  = join(tmp, 'fake.mp4');
      const audioPath = join(tmp, 'out.mp3');
      writeFileSync(fakePath, 'this is not a video file');

      const err = await extractAudio(fakePath, audioPath).catch(e => e);
      assert.ok(err instanceof Error, 'should reject with an Error');
      assert.match(err.message, /ffmpeg/i, 'error message should mention ffmpeg');
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  // ── Happy path (skipped when ffmpeg is not installed) ───────────────────────
  it('resolves with the output audio path on a valid video file', { skip: !FFMPEG_AVAILABLE }, async () => {
    const tmp = mkdtempSync(join(tmpdir(), 'uoc-audio-test-'));
    try {
      // Generate a 1-second silent video with ffmpeg itself
      const videoPath = join(tmp, 'input.mp4');
      const audioPath = join(tmp, 'output.mp3');

      execSync(
        `ffmpeg -y -f lavfi -i anullsrc=r=16000:cl=mono -t 1 -c:a aac ${videoPath}`,
        { stdio: 'ignore' }
      );

      const result = await extractAudio(videoPath, audioPath);
      assert.equal(result, audioPath);

      // Verify the output file exists and has content
      const { statSync } = await import('fs');
      const stat = statSync(audioPath);
      assert.ok(stat.size > 0, 'output audio file should not be empty');
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});
