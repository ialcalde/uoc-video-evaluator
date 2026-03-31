import { createReadStream } from 'fs';

/**
 * Transcribe an audio file to Catalan text using OpenAI Whisper.
 * @param {string} audioPath  Path to the .mp3 file.
 * @param {import('openai').OpenAI} openai  Initialised OpenAI client.
 * @returns {Promise<{text: string, segments: Array}>}
 */
export async function transcribe(audioPath, openai) {
  const response = await openai.audio.transcriptions.create({
    file:                    createReadStream(audioPath),
    model:                   'whisper-1',
    language:                'ca',           // fixed: Catalan
    response_format:         'verbose_json',
    timestamp_granularities: ['segment'],
  });
  return response;
}
