import { existsSync } from 'fs';
import { readFile, unlink } from 'fs/promises';
import { join } from 'path';
import { extractAudio }   from './audio.mjs';
import { transcribe }     from './transcribe.mjs';
import { evaluate }       from './evaluate.mjs';
import {
  ensureStudentDir,
  writeTranscript,
  writeEvaluation,
  writeFeedback,
} from './report.mjs';

/**
 * Process a single student video through the full pipeline:
 *   extract audio → transcribe (Whisper) → evaluate (Claude) → write output files
 *
 * @param {object}   opts
 * @param {string}   opts.videoPath       Source video path.
 * @param {string}   opts.student         Student identifier (becomes the sub-directory name).
 * @param {object}   opts.anthropic       Anthropic API client.
 * @param {object}   opts.openai          OpenAI API client.
 * @param {object}   opts.rubric          Parsed rubric object.
 * @param {string}   opts.outputDir       Base output directory.
 * @param {string}   opts.tmpDir          Temporary directory for intermediate audio files.
 * @param {boolean}  [opts.skipExisting]   Return cached result when evaluation.json exists.
 * @param {object}   [opts.log]            Logger — must have .info(msg) and .ok(msg).
 * @param {Function} [opts.extractAudioFn] Override for testing (default: extractAudio).
 * @param {Function} [opts.transcribeFn]   Override for testing (default: transcribe).
 * @returns {Promise<object>}              Validated evaluation object.
 */
export async function processVideo({
  videoPath,
  student,
  anthropic,
  openai,
  rubric,
  outputDir,
  tmpDir,
  model           = 'claude-sonnet-4-6',
  skipExisting    = false,
  log             = { info: () => {}, ok: () => {} },
  extractAudioFn  = extractAudio,
  transcribeFn    = transcribe,
}) {
  const audioPath  = join(tmpDir, `${student}_${Date.now()}.mp3`);
  const studentDir = ensureStudentDir(outputDir, student);
  const evalPath   = join(studentDir, 'evaluation.json');

  if (skipExisting && existsSync(evalPath)) {
    log.info(`[${student}] Already evaluated — skipping.`);
    return JSON.parse(await readFile(evalPath, 'utf8'));
  }

  try {
    // 1. Extract audio
    log.info(`[${student}] Extracting audio…`);
    await extractAudioFn(videoPath, audioPath);

    // 2. Transcribe
    log.info(`[${student}] Transcribing (Whisper, lang=ca)…`);
    const transcript = await transcribeFn(audioPath, openai);

    if (!transcript.text?.trim()) {
      throw new Error('Transcription is empty — does the video have audio?');
    }

    await writeTranscript(studentDir, transcript.text);
    log.info(`[${student}] transcript_ca.txt saved (${transcript.text.length} chars).`);

    // 3. Evaluate
    log.info(`[${student}] Evaluating with Claude…`);
    const evaluation = await evaluate(transcript, rubric, anthropic, { model });
    evaluation.evaluatedAt = new Date().toISOString();

    // 4. Write output files
    await writeEvaluation(studentDir, evaluation);
    await writeFeedback(studentDir, evaluation);

    log.ok(`[${student}] Done — score: ${evaluation.weightedScore}/10  (${evaluation.grade})`);
    return evaluation;

  } finally {
    if (existsSync(audioPath)) {
      try { await unlink(audioPath); } catch { /* ignore race */ }
    }
  }
}
