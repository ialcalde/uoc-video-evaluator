import { createReadStream } from 'fs';
import { withRetry } from './retry.mjs';

/**
 * Transcribe an audio file using OpenAI Whisper.
 * Automatically retries on transient HTTP errors (429, 5xx) with exponential back-off.
 *
 * @param {string} audioPath  Path to the .mp3 file.
 * @param {import('openai').OpenAI} openai  Initialised OpenAI client.
 * @param {object} [opts]
 * @param {string}   [opts.language='ca']   BCP-47 language code (e.g. 'ca', 'es', 'en').
 * @param {Function} [opts.onRetry]         Called on each retry: ({ attempt, maxRetries, status, delayMs }).
 * @param {number}   [opts.baseDelay=1000]  Base back-off delay in ms (override for tests).
 * @returns {Promise<{text: string, segments: Array}>}
 */
export async function transcribe(audioPath, openai, { language = 'ca', onRetry, baseDelay = 1_000 } = {}) {
  return withRetry(
    () => openai.audio.transcriptions.create({
      file:                    createReadStream(audioPath),
      model:                   'whisper-1',
      language,
      response_format:         'verbose_json',
      timestamp_granularities: ['segment'],
    }),
    { onRetry, baseDelay }
  );
}
