import { spawn }     from 'child_process';
import { statSync }  from 'fs';

// Whisper's file-size limit is 25 MB; stay safely below it.
export const MAX_AUDIO_BYTES = 24 * 1024 * 1024;   // 24 MB

/**
 * Spawn ffmpeg with the given source, destination, and audio codec flags.
 * Resolves with audioPath on exit-code 0, rejects otherwise.
 */
function runFfmpeg(videoPath, audioPath, audioFlags) {
  return new Promise((resolve, reject) => {
    const proc = spawn('ffmpeg', [
      '-y',
      '-i', videoPath,
      '-vn',            // drop video stream
      '-ar', '16000',   // 16 kHz — optimal for Whisper
      '-ac', '1',       // mono
      ...audioFlags,
      audioPath,
    ], { stdio: ['ignore', 'pipe', 'pipe'] });

    let stderr = '';
    proc.stderr.on('data', d => { stderr += d.toString(); });

    proc.on('close', code => {
      if (code === 0) resolve(audioPath);
      else reject(new Error(`ffmpeg exited ${code}:\n${stderr.slice(-600)}`));
    });

    proc.on('error', () =>
      reject(new Error('ffmpeg not found. Install it with: sudo apt-get install ffmpeg'))
    );
  });
}

/**
 * Extract mono 16 kHz MP3 audio from a video file using ffmpeg.
 *
 * If the resulting file exceeds MAX_AUDIO_BYTES (Whisper's 24 MB upload limit),
 * up to two additional passes re-encode at lower bitrates (32 kbps, then 16 kbps).
 * A clear error is thrown if the file is still too large after all passes.
 *
 * @param {string}   videoPath   Absolute path to the source video.
 * @param {string}   audioPath   Destination path for the .mp3 file.
 * @param {object}   [opts]
 * @param {Function} [opts.ffmpegFn]  Injected for testing (default: runFfmpeg).
 * @returns {Promise<string>} Resolves with audioPath on success.
 */
export async function extractAudio(videoPath, audioPath, { ffmpegFn = runFfmpeg } = {}) {
  await ffmpegFn(videoPath, audioPath, ['-c:a', 'libmp3lame', '-q:a', '4']);

  let { size } = statSync(audioPath);
  if (size > MAX_AUDIO_BYTES) {
    // Pass 2: 32 kbps mono — ~14 MB for a 60-min recording
    await ffmpegFn(videoPath, audioPath, ['-c:a', 'libmp3lame', '-b:a', '32k']);
    ({ size } = statSync(audioPath));
  }

  if (size > MAX_AUDIO_BYTES) {
    // Pass 3: 16 kbps mono — ~7 MB for a 60-min recording; adequate for speech recognition
    await ffmpegFn(videoPath, audioPath, ['-c:a', 'libmp3lame', '-b:a', '16k']);
    ({ size } = statSync(audioPath));
  }

  if (size > MAX_AUDIO_BYTES) {
    const mb = (size / 1_048_576).toFixed(1);
    throw new Error(
      `Audio file (${mb} MB) still exceeds Whisper's ${MAX_AUDIO_BYTES / 1_048_576} MB limit ` +
      'after re-encoding at 16 kbps. The recording is too long to transcribe.'
    );
  }

  return audioPath;
}
