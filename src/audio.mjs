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
 * If the resulting file exceeds MAX_AUDIO_BYTES (Whisper's upload limit),
 * a second pass re-encodes at a lower bitrate to fit within the limit.
 *
 * @param {string}   videoPath   Absolute path to the source video.
 * @param {string}   audioPath   Destination path for the .mp3 file.
 * @param {object}   [opts]
 * @param {Function} [opts.ffmpegFn]  Injected for testing (default: runFfmpeg).
 * @returns {Promise<string>} Resolves with audioPath on success.
 */
export async function extractAudio(videoPath, audioPath, { ffmpegFn = runFfmpeg } = {}) {
  await ffmpegFn(videoPath, audioPath, ['-c:a', 'libmp3lame', '-q:a', '4']);

  const { size } = statSync(audioPath);
  if (size > MAX_AUDIO_BYTES) {
    // Re-encode at 32 kbps — sufficient for speech; ~14 MB for a 60-min recording
    await ffmpegFn(videoPath, audioPath, ['-c:a', 'libmp3lame', '-b:a', '32k']);
  }

  return audioPath;
}
