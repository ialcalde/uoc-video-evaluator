import { createReadStream } from 'fs';

/**
 * Transcribe an audio file using OpenAI Whisper.
 * @param {string} audioPath  Path to the .mp3 file.
 * @param {import('openai').OpenAI} openai  Initialised OpenAI client.
 * @param {object} [opts]
 * @param {string} [opts.language='ca']  BCP-47 language code (e.g. 'ca', 'es', 'en').
 * @returns {Promise<{text: string, segments: Array}>}
 */
export async function transcribe(audioPath, openai, { language = 'ca' } = {}) {
  const response = await openai.audio.transcriptions.create({
    file:                    createReadStream(audioPath),
    model:                   'whisper-1',
    language,
    response_format:         'verbose_json',
    timestamp_granularities: ['segment'],
  });
  return response;
}
