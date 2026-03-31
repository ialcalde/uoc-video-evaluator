import { spawn } from 'child_process';

/**
 * Extract mono 16 kHz MP3 audio from a video file using ffmpeg.
 * @param {string} videoPath  Absolute path to the source video.
 * @param {string} audioPath  Destination path for the .mp3 file.
 * @returns {Promise<string>} Resolves with audioPath on success.
 */
export function extractAudio(videoPath, audioPath) {
  return new Promise((resolve, reject) => {
    const proc = spawn('ffmpeg', [
      '-y',                    // overwrite output
      '-i', videoPath,
      '-vn',                   // drop video stream
      '-ar', '16000',          // 16 kHz — optimal for Whisper
      '-ac', '1',              // mono
      '-c:a', 'libmp3lame',
      '-q:a', '4',
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
