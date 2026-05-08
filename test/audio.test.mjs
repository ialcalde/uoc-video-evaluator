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
import { writeFileSync, mkdtempSync, rmSync, statSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { extractAudio, MAX_AUDIO_BYTES } from '../src/audio.mjs';

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
      const videoPath = join(tmp, 'input.mp4');
      const audioPath = join(tmp, 'output.mp3');

      execSync(
        `ffmpeg -y -f lavfi -i anullsrc=r=16000:cl=mono -t 1 -c:a aac ${videoPath}`,
        { stdio: 'ignore' }
      );

      const result = await extractAudio(videoPath, audioPath);
      assert.equal(result, audioPath);
      assert.ok(statSync(audioPath).size > 0, 'output audio file should not be empty');
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  // ── Size guard (mocked ffmpegFn — no real ffmpeg needed) ─────────────────────

  it('does not re-encode when file size is under the limit', async () => {
    const tmp = mkdtempSync(join(tmpdir(), 'uoc-audio-test-'));
    try {
      const audioPath = join(tmp, 'audio.mp3');
      let calls = 0;

      const mockFfmpeg = async (_src, dest) => {
        calls++;
        writeFileSync(dest, Buffer.alloc(1024));   // tiny file — under limit
      };

      await extractAudio('/fake/video.mp4', audioPath, { ffmpegFn: mockFfmpeg });

      assert.equal(calls, 1, 'should only run ffmpeg once when file is small enough');
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('re-encodes at lower bitrate when file exceeds MAX_AUDIO_BYTES', async () => {
    const tmp = mkdtempSync(join(tmpdir(), 'uoc-audio-test-'));
    try {
      const audioPath = join(tmp, 'audio.mp3');
      let calls = 0;
      const capturedFlags = [];

      const mockFfmpeg = async (_src, dest, flags) => {
        calls++;
        capturedFlags.push([...flags]);
        // First call: write an oversized file; second call: write a small one
        writeFileSync(dest, Buffer.alloc(calls === 1 ? MAX_AUDIO_BYTES + 1 : 1024));
      };

      await extractAudio('/fake/video.mp4', audioPath, { ffmpegFn: mockFfmpeg });

      assert.equal(calls, 2, 'should run ffmpeg twice when first output is too large');
      assert.ok(capturedFlags[1].includes('-b:a'), 'second pass should use -b:a flag');
      assert.ok(capturedFlags[1].includes('32k'),  'second pass should target 32 kbps');
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('runs a third pass at 16 kbps when 32 kbps pass is still over limit', async () => {
    const tmp = mkdtempSync(join(tmpdir(), 'uoc-audio-test-'));
    try {
      const audioPath = join(tmp, 'audio.mp3');
      let calls = 0;
      const capturedFlags = [];

      const mockFfmpeg = async (_src, dest, flags) => {
        calls++;
        capturedFlags.push([...flags]);
        // Pass 1 & 2 oversized, pass 3 fits
        writeFileSync(dest, Buffer.alloc(calls < 3 ? MAX_AUDIO_BYTES + 1 : 1024));
      };

      await extractAudio('/fake/video.mp4', audioPath, { ffmpegFn: mockFfmpeg });

      assert.equal(calls, 3, 'should run ffmpeg three times');
      assert.ok(capturedFlags[2].includes('16k'), 'third pass should target 16 kbps');
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('throws a descriptive error when all three passes are still over the limit', async () => {
    const tmp = mkdtempSync(join(tmpdir(), 'uoc-audio-test-'));
    try {
      const audioPath = join(tmp, 'audio.mp3');
      const mockFfmpeg = async (_src, dest) => {
        writeFileSync(dest, Buffer.alloc(MAX_AUDIO_BYTES + 1));
      };

      await assert.rejects(
        () => extractAudio('/fake/video.mp4', audioPath, { ffmpegFn: mockFfmpeg }),
        /too long to transcribe/i
      );
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('MAX_AUDIO_BYTES is exported and equals 24 MB', () => {
    assert.equal(MAX_AUDIO_BYTES, 24 * 1024 * 1024);
  });
});
