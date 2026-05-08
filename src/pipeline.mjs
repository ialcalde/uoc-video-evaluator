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
  model           = 'claude-opus-4-7',
  thinking        = false,
  skipExisting    = false,
  log             = { info: () => {}, ok: () => {} },
  extractAudioFn  = extractAudio,
  transcribeFn    = transcribe,
  baseDelay,
}) {
  const start          = Date.now();
  const audioPath      = join(tmpDir, `${student}_${start}.mp3`);
  const studentDir     = ensureStudentDir(outputDir, student);
  const evalPath       = join(studentDir, 'evaluation.json');
  const transcriptLang = rubric.language         || 'ca';
  const feedbackLang   = rubric.feedbackLanguage || 'ca';

  if (skipExisting && existsSync(evalPath) &&
      existsSync(join(studentDir, `feedback_${feedbackLang}.txt`))) {
    try {
      const cached = JSON.parse(await readFile(evalPath, 'utf8'));
      log.info(`[${student}] Already evaluated — skipping.`);
      return { evaluation: cached, tokenUsage: null };
    } catch {
      log.warn?.(`[${student}] Cached evaluation.json is unreadable — re-evaluating.`);
    }
  }

  try {
    // 1. Extract audio
    log.info(`[${student}] Extracting audio…`);
    await extractAudioFn(videoPath, audioPath);

    // 2. Transcribe
    log.info(`[${student}] Transcribing (Whisper, lang=${transcriptLang})…`);
    const transcript = await transcribeFn(audioPath, openai, {
      language: transcriptLang,
      onRetry: ({ attempt, maxRetries, status }) =>
        log.warn?.(`[${student}] Whisper HTTP ${status} — retry ${attempt}/${maxRetries}`),
    });

    if (!transcript.text?.trim()) {
      throw new Error('Transcription is empty — does the video have audio?');
    }

    await writeTranscript(studentDir, transcript.text, transcriptLang);
    log.info(`[${student}] transcript_${transcriptLang}.txt saved (${transcript.text.length} chars).`);

    // 3. Evaluate
    log.info(`[${student}] Evaluating with Claude…`);
    let tokenUsage;
    const evaluation = await evaluate(transcript, rubric, anthropic, {
      model, thinking, baseDelay,
      onUsage:  u => { tokenUsage = u; },
      onRetry: ({ attempt, maxRetries, status }) =>
        log.warn?.(`[${student}] Claude HTTP ${status} — retry ${attempt}/${maxRetries}`),
    });
    evaluation.evaluatedAt = new Date().toISOString();

    // 4. Write output files
    await writeEvaluation(studentDir, evaluation);
    await writeFeedback(studentDir, evaluation, feedbackLang);

    const elapsedS = ((Date.now() - start) / 1000).toFixed(1);
    if (tokenUsage) {
      const { input_tokens: inp, output_tokens: out,
              cache_read_input_tokens: cacheHit = 0,
              cache_creation_input_tokens: cacheWrite = 0 } = tokenUsage;
      log.info(`[${student}] Tokens: in=${inp} out=${out}${cacheHit ? ` cache-hit=${cacheHit}` : ''}${cacheWrite ? ` cache-write=${cacheWrite}` : ''}`);
    }
    log.ok(`[${student}] Done — score: ${evaluation.weightedScore}/10  (${evaluation.grade}) — ${elapsedS}s`);
    return { evaluation, tokenUsage };

  } finally {
    if (existsSync(audioPath)) {
      try { await unlink(audioPath); } catch { /* ignore race */ }
    }
  }
}
